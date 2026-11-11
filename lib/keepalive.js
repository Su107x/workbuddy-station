'use strict';
/**
 * keepalive.js —— 账号保活体系：令牌自动续期 + 每日轻量对话。
 *
 * 设计原则（都是踩坑换来的）：
 *   1. 续期有成本 —— 每次刷新 token 都是一次可疑的凭证操作，能被风控统计到。
 *      所以只在「剩余天数 < 阈值」时才真正刷新，正常情况下一次请求都不发。
 *   2. 有效期必须真实可查 —— 拿不到就如实返回 null，绝不猜字段名硬编码，
 *      更不会拿「套餐到期时间」冒充「令牌到期时间」。
 *   3. 「活跃上报」这件事已经换实现：上游**没有**心跳/在线接口
 *      （2026-10-30 实测 4 个常见命名全部 404），所以改为**每天发一句轻量对话**，
 *      让账号保有真实调用记录。仍然遵守「不伪造成功」：发不通就返回真实错误。
 *      ★ 它不能点亮成长热力图 —— 热力图由桌面端本地埋点驱动，实测 API 对话 100 秒内
 *        score 恒为 0，详见 reportActive() 的注释。
 *
 * 依赖的既有能力（lib/wb.js，不重写）：
 *   wb.renewToken(acc)   -> { token, refreshToken, expiresIn } | null
 *   wb.whoami(acc)       -> { uid, nickname, enterpriseId, sources, errors }
 *   wb.snapshot(acc)     -> 额度快照（expireAt 是套餐到期，不是令牌到期）
 *   wb.chatSimple(acc)   -> 一次最小对话（每日轻量对话用）
 */

const wb = require('./wb');

const DAY_MS = 86400000;

/** 等待指定毫秒，用于账号间错峰 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 令牌有效期可能出现的字段名。分两档：身份接口可以用泛化名，额度接口只认带 token 的，避免误读套餐到期 */
const TOKEN_EXPIRY_KEYS = ['tokenExpiresAt', 'tokenExpireAt', 'token_expires_at', 'tokenExpireTime', 'expiresAt', 'expireAt', 'expire_at'];
const SNAPSHOT_EXPIRY_KEYS = ['tokenExpiresAt', 'tokenExpireAt', 'token_expires_at', 'tokenExpireTime'];

/** 时间值归一：秒 / 毫秒 / ISO 字符串 → 毫秒时间戳；无法识别返回 0 */
function toMs(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return 0;
    // 1e12 约等于 2001-09，小于它的当作秒级
    return v > 1e12 ? Math.round(v) : Math.round(v * 1000);
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (/^\d+$/.test(s)) return toMs(Number(s));
    const t = Date.parse(s);
    return Number.isFinite(t) && t > 0 ? t : 0;
  }
  return 0;
}

/** 从 JWT 里取 exp（秒）→ 毫秒。令牌不是 JWT 时返回 0 */
function jwtExpiry(token) {
  const t = String(token || '');
  const parts = t.split('.');
  if (parts.length !== 3) return 0;
  try {
    const payload = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const obj = JSON.parse(payload);
    const exp = Number(obj && (obj.exp || obj.expires_at || obj.expireAt) || 0);
    return exp > 0 ? exp * 1000 : 0;
  } catch (_) {
    return 0;
  }
}

/** 深度扫描一个对象里是否带有效期字段（深度上限 4，防止上游返回巨大结构时递归失控） */
function scanExpiry(node, keys, depth, seen) {
  if (!node || typeof node !== 'object' || depth > 4) return { ms: 0, key: '' };
  if (seen.has(node)) return { ms: 0, key: '' };
  seen.add(node);
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(node, k)) {
      const ms = toMs(node[k]);
      if (ms) return { ms, key: k };
    }
  }
  for (const k of Object.keys(node)) {
    const child = node[k];
    if (child && typeof child === 'object') {
      const hit = scanExpiry(child, keys, depth + 1, seen);
      if (hit.ms) return hit;
    }
  }
  return { ms: 0, key: '' };
}

/**
 * 令牌有效期的「本地判定」纯函数：不发任何网络请求。
 *   1. 账号上的 tokenExpiresAt —— 本项目权威字段，renewToken / 登录流程都会写它
 *   2. 令牌本身是 JWT 时的 exp
 *
 * @param {object} acc 账号（null/undefined 直接返回 null）
 * @returns {{ms:number, daysLeft:number, source:'field'|'jwt'}|null}
 *   返回 null 即「unknown」：既没有 tokenExpiresAt，JWT 也解不出 exp。
 *
 * 为什么不返回 { source: 'unknown' } 这种真值对象：调用方（checkTokenExpiry、renewIfNeeded）
 * 都是按「有值 / 无值」分支的，返回真值会把两条关键路径破坏掉 ——
 *   1. checkTokenExpiry 的第三级兜底（whoami / snapshot）会被短路，再也不会去问上游；
 *   2. renewIfNeeded 会从「有效期未知则跳过」误跳到「真刷新」分支，对上游发出无谓刷新。
 * 所以 unknown 用 null 表达，判断方式就是 `Boolean(acc.token && !peekExpiryOf(acc))`。
 *
 * 供 lib/accounts.js 的续期健康度聚合复用：判定顺序只此一份，不允许各抄一遍。
 */
function peekExpiryOf(acc) {
  if (!acc) return null;
  const local = toMs(acc.tokenExpiresAt);
  if (local) {
    return { ms: local, daysLeft: Math.ceil((local - Date.now()) / DAY_MS), source: 'field' };
  }
  const fromJwt = jwtExpiry(acc.token);
  if (fromJwt) {
    return { ms: fromJwt, daysLeft: Math.ceil((fromJwt - Date.now()) / DAY_MS), source: 'jwt' };
  }
  return null;
}

/** 账号展示名：昵称优先，没昵称就用打码手机号，两者都没有退回 id */
function labelOf(acc) {
  if (!acc) return '未知账号';
  if (acc.nickname) return String(acc.nickname);
  const p = String(acc.phone || '');
  if (p.length >= 7) return p.slice(0, 3) + '****' + p.slice(-4);
  return String(acc.id || '未知账号');
}

class KeepAlive {
  constructor(store, accounts) {
    this.store = store;
    this.accounts = accounts || null;
    this._running = false;
  }

  /** 运行时状态都挂在 store.data.runtime 下，和 sched.js 共用一个区域 */
  get rt() {
    const d = this.store.data;
    if (!d.runtime) d.runtime = {};
    return d.runtime;
  }

  /**
   * 可用账号池。
   * 优先 earningPool()：保活属于「赚积分」行为，只停转发的账号（enabled=false + pauseMode='forward-only'）
   * 仍要续期，用 usable() 会把这类账号漏掉。老版本 accounts 没有 earningPool 时逐级降级。
   */
  list() {
    const A = this.accounts;
    if (A && typeof A.earningPool === 'function') return A.earningPool();
    if (A && typeof A.usable === 'function') return A.usable();
    const all = Array.isArray(this.store.data.accounts) ? this.store.data.accounts : [];
    return all.filter((a) => a.enabled && (a.token || a.cookie));
  }

  /**
   * 失败日志去重：同一账号 + 同一原因，每天只写 1 条 warn。
   * 阈值 3 天时，临近过期那几天会每轮都失败；sched 30 秒一轮，一天 2880 条红日志会把日志页冲掉，
   * 也会掩盖真正的新问题。所以只压日志，不压 lastRenewResult —— 界面每轮照常看到当前状态。
   * @returns {boolean} true 表示本次应当写日志
   */
  noteFailure(acc, reason) {
    const day = new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD，本地时区
    const key = String((acc && (acc.id || acc.nickname)) || 'unknown');
    const memo = this.rt.renewFailNoted || (this.rt.renewFailNoted = {});
    const sig = day + ':' + String(reason || '').slice(0, 80);
    if (memo[key] === sig) return false;
    memo[key] = sig;
    this.store.touch();
    return true;
  }

  /** 续期成功后清掉该账号的失败备忘，下次真出问题还能重新报警 */
  clearFailureNote(acc) {
    const memo = this.rt.renewFailNoted;
    const key = String((acc && (acc.id || acc.nickname)) || 'unknown');
    if (memo && memo[key]) {
      delete memo[key];
      this.store.touch();
    }
  }

  /**
   * 只看本地可得的信息（方法版，内部委托给模块级纯函数，方便 accounts.js 复用同一份判定）。
   * 取不到返回 null。
   */
  peekExpiry(acc) {
    return peekExpiryOf(acc);
  }

  /**
   * 这个账号这一轮是否真的要发刷新请求（用于决定值不值得为它错峰等待）。
   * 与 renewIfNeeded 的判定保持同一口径：有令牌 + 有 refreshToken + 有效期已知且低于阈值。
   * 不会发网络请求。
   */
  needsRefresh(acc, thresholdDays) {
    if (!acc || !acc.token) return false;
    // 没有 refreshToken 时 renewIfNeeded 直接报错返回，不会发请求
    if (!acc.refreshToken) return false;
    const exp = this.peekExpiry(acc);
    return Boolean(exp && exp.daysLeft < thresholdDays);
  }

  /**
   * 取令牌有效期。
   * 查找顺序（命中即返回，避免无谓的网络请求）：
   *   1. 账号上已存的 tokenExpiresAt —— 本项目权威字段，renewToken / 登录流程都会写它
   *   2. 令牌本身是 JWT 时的 exp
   *   3. 仍取不到才去问 whoami / snapshot（目前这两个接口都不返回此类字段，属于兜底）
   * 全都没有返回 null —— 不编造。
   */
  async checkTokenExpiry(acc) {
    if (!acc) return null;

    const local = this.peekExpiry(acc);
    if (local) return local;

    // 兜底：问上游。whoami 是身份接口，可以用泛化字段名
    try {
      const me = await wb.whoami(acc);
      const hit = scanExpiry(me, TOKEN_EXPIRY_KEYS, 0, new Set());
      if (hit.ms) {
        // 顺手把上游给的有效期记到账号上，下次就不用再问
        acc.tokenExpiresAt = hit.ms;
        this.store.touch();
        return { ms: hit.ms, daysLeft: Math.ceil((hit.ms - Date.now()) / DAY_MS), source: 'whoami.' + hit.key, raw: hit.key };
      }
    } catch (_) {}

    // 额度接口里的 expireAt 是套餐到期，只认带 token 的字段名
    try {
      const snap = await wb.snapshot(acc);
      const hit = scanExpiry(snap, SNAPSHOT_EXPIRY_KEYS, 0, new Set());
      if (hit.ms) {
        acc.tokenExpiresAt = hit.ms;
        this.store.touch();
        return { ms: hit.ms, daysLeft: Math.ceil((hit.ms - Date.now()) / DAY_MS), source: 'snapshot.' + hit.key, raw: hit.key };
      }
    } catch (_) {}

    return null;
  }

  /**
   * 按需续期：剩余天数 < thresholdDays 才真正刷新。
   * 有效期未知时不刷新（避免无谓刷新触发风控），如实报告跳过原因。
   * @returns {{renewed:boolean, skipped:boolean, before:number|null, after:number|null, daysLeft:number|null, daysAdded:number, error:string|null, reason:string}}
   */
  async renewIfNeeded(acc, thresholdDays = 3) {
    const out = { renewed: false, skipped: false, before: null, after: null, daysLeft: null, daysAdded: 0, error: null, reason: '' };
    if (!acc) {
      out.error = '账号为空';
      return out;
    }

    const exp = await this.checkTokenExpiry(acc);
    if (exp) {
      out.before = exp.ms;
      out.daysLeft = exp.daysLeft;
      if (exp.daysLeft >= thresholdDays) {
        out.skipped = true;
        out.after = exp.ms;
        out.reason = `剩余${exp.daysLeft}天`;
        return out;
      }
    } else if (acc.token) {
      out.skipped = true;
      out.reason = '有效期未知';
      return out;
    }

    if (!acc.token && acc.cookie) {
      // 纯 Cookie 会话没有 accessToken 可续，靠 Cookie 自身时效维持
      out.skipped = true;
      out.reason = 'Cookie 会话无需续期';
      return out;
    }

    if (!acc.refreshToken) {
      out.error = '缺少 refreshToken，无法续期';
      return out;
    }

    let renewed = null;
    try {
      renewed = await wb.renewToken(acc);
    } catch (err) {
      out.error = '续期请求异常：' + err.message;
      return out;
    }
    if (!renewed || !renewed.token) {
      out.error = '上游未返回新令牌（refreshToken 可能已失效）';
      return out;
    }

    // 回写凭证：和 accounts.refresh 的做法保持一致
    acc.token = renewed.token;
    if (renewed.refreshToken) acc.refreshToken = renewed.refreshToken;
    acc.tokenAt = Date.now();
    acc.tokenExpiresAt = renewed.expiresIn ? Date.now() + renewed.expiresIn * 1000 : 0;
    this.store.touch();

    out.renewed = true;
    out.after = acc.tokenExpiresAt || null;
    out.daysAdded = renewed.expiresIn ? Math.round(renewed.expiresIn / 86400) : 0;
    if (out.after) out.daysLeft = Math.ceil((out.after - Date.now()) / DAY_MS);
    return out;
  }

  /**
   * 全部可用账号走一遍续期（内部实现，不加锁，只由 renewAll / runAll 调用）。
   * @param {number} thresholdDays 剩余天数低于该值才真正刷新
   * @param {{delayMinMs?:number, delayMaxMs?:number}} opts 账号间随机延迟，用于错峰
   */
  async _doRenewAll(thresholdDays, opts) {
    const delayMin = Math.max(0, Number(opts && opts.delayMinMs) || 0);
    const delayMax = Math.max(delayMin, Number(opts && opts.delayMaxMs) || 0);
    const list = this.list();
    const parts = [];
    const items = [];

    for (let i = 0; i < list.length; i++) {
      const acc = list[i];
      // 账号级错峰：第一个账号立即执行，之后每个账号前随机等一会儿，
      // 避免多账号在同一秒集中刷新令牌（最容易被风控注意到的形态）。
      // 只在「这个账号确实要发刷新请求」时才等 —— 调度层给的时间预算有限，
      // 为一批本来就跳过的账号白白睡掉几十秒，会把整轮 tick 拖长。
      if (i > 0 && delayMax > 0 && this.needsRefresh(acc, thresholdDays)) {
        await sleep(delayMin + Math.random() * (delayMax - delayMin));
      }
      const name = labelOf(acc);
      let r;
      try {
        r = await this.renewIfNeeded(acc, thresholdDays);
      } catch (err) {
        r = { renewed: false, skipped: false, before: null, after: null, daysLeft: null, daysAdded: 0, error: err.message };
      }
      items.push({ id: acc.id, name, ...r });

      let text;
      if (r.renewed) {
        text = r.daysAdded > 0 ? `+${r.daysAdded}天` : '已续期';
        this.clearFailureNote(acc);
        this.store.log('info', `保活续期成功 ${name}：${text}`);
      } else if (r.error) {
        // 结果串每轮都更新，日志按「同账号同原因每天一条」去重
        text = `失败(${r.error})`;
        if (this.noteFailure(acc, r.error)) {
          this.store.log('warn', `保活续期失败 ${name}：${r.error}`);
        }
      } else {
        text = `跳过(${r.reason || '无需续期'})`;
        this.clearFailureNote(acc);
        this.store.log('info', `保活续期跳过 ${name}：${r.reason || '无需续期'}`);
      }
      parts.push(`${name}:${text}`);
    }

    if (!list.length) {
      this.store.log('warn', '保活续期：没有可用账号');
    }

    const result = parts.join(' | ') || '无可用账号';
    this.rt.lastRenewAt = Date.now();
    this.rt.lastRenewResult = result;
    this.store.touch();
    return { at: this.rt.lastRenewAt, result, items };
  }

  /**
   * 只续期。和 runAll 共用同一把重入锁，防止「手工触发 + 定时任务」同时开跑，
   * 把同一账号连刷两次（那是最容易被风控盯上的形态）。
   * @param {number} thresholdDays 剩余天数低于该值才真正刷新
   * @param {{delayMinMs?:number, delayMaxMs?:number}} opts 账号间随机延迟
   */
  async renewAll(thresholdDays = 3, opts = {}) {
    if (this._running) return { ok: false, busy: true, at: 0, result: '', items: [], reason: '上一轮保活尚未结束' };
    this._running = true;
    try {
      const out = await this._doRenewAll(thresholdDays, opts);
      return { ok: true, ...out };
    } finally {
      this._running = false;
    }
  }

  /**
   * 活跃上报。
   *
   * 2026-10-30 实测结论（tools/probe_active.js）：上游没有独立的「活跃 / 在线 / 心跳」接口。
   *   GET  /v2/user/active     -> 404
   *   POST /v2/user/active     -> 404
   *   GET  /v2/user/presence   -> 404
   *   GET  /v2/user/online     -> 404
   *   POST /v2/user/heartbeat  -> 404
   * 唯一返回 200 的 POST /v2/report 是成长任务的行为埋点通道，
   * 空事件数组虽然返回 {code:0}，但不携带任何事件、对账号活跃度没有任何作用，
   * 拿它冒充「上报成功」就是伪造结果，所以这里明确跳过。
   */
  /**
   * 每日轻量对话（原来是 reportActive，上游没有活跃接口所以一直是空转）。
   *
   * 2026-10-30 实测：上游**没有**独立的「活跃 / 在线 / 心跳」接口
   *   /v2/user/{active,presence,online,heartbeat} 全部 404。
   *
   * 2026-11-11 改为发一句真实对话（GET 一次 chat/completions），用途：
   *   ① 让账号每天有真实的调用记录，避免长期零流量的死号特征；
   *   ② 顺带刷新 token 的活跃时间，降低被判僵尸号的风险；
   *   ③ 为「每天有对话」类成长任务（RichMeow_Chat 等）提供真实计数。
   *
   * ★ 明确边界：**它不能点亮成长热力图 / 不能修复 streak 断签**。
   *   实测对 180 号连发 2 次对话（均 200 OK），100 秒内 heatmap score 恒为 0；
   *   而 score 涨的号（夫君 17→22）是它自己桌面客户端在用。
   *   热力图由桌面端本地埋点驱动，纯服务端 API 伪造不出来 —— 不要在这里假装能点亮。
   *
   * 幂等：按北京时间自然日记录 lastDailyChatDate，同一天只发一次。
   */
  async reportActive(acc) {
    const cfg = (this.store.data.settings && this.store.data.settings.keepalive) || {};
    if (cfg.dailyChat === false) {
      return { ok: false, skipped: true, reason: '每日轻量对话已关闭' };
    }
    // 北京时间当天
    const now = new Date(Date.now() + 8 * 3600 * 1000);
    const today = now.toISOString().slice(0, 10);
    if (acc._dailyChatDate === today) {
      return { ok: false, skipped: true, reason: '今天已发过（' + today + '）' };
    }
    try {
      const r = await wb.chatSimple(acc, {
        prompt: cfg.dailyChatPrompt || '你好，请回复一个字：好',
        maxTokens: 16,
      });
      acc._dailyChatDate = today;
      acc._dailyChatAt = Date.now();
      this.store.touch();
      return { ok: true, at: Date.now(), chars: String(r.text || '').length };
    } catch (err) {
      return { ok: false, skipped: false, reason: err.message };
    }
  }

  /**
   * 保活总入口：续期 + 每日轻量对话，汇总一行。
   * @param {number} thresholdDays 透传给续期，控制提前续期天数
   * @param {{delayMinMs?:number, delayMaxMs?:number}} opts 账号间随机延迟（错峰）
   */
  async runAll(thresholdDays = 3, opts = {}) {
    if (this._running) return { ok: false, busy: true, reason: '上一轮保活尚未结束' };
    this._running = true;
    try {
      const renew = await this._doRenewAll(thresholdDays, opts);

      const list = this.list();
      const active = [];
      for (const acc of list) {
        let r;
        try {
          r = await this.reportActive(acc);
        } catch (err) {
          r = { ok: false, skipped: false, reason: err.message };
        }
        active.push({ id: acc.id, name: labelOf(acc), ...r });
      }
      const activeSkipped = active.every((a) => a.skipped);
      // 跳过就写「跳过」+ 真实原因，绝不在结果串里美化成「已发送」
      const activeText = activeSkipped
        ? `每日对话:全部跳过(${(active[0] && active[0].reason) || '已关闭'})`
        : `每日对话:${active.filter((a) => a.ok).length}/${active.length}`;

      const result = `续期:${renew.result} || ${activeText}`;
      this.rt.lastKeepAliveAt = Date.now();
      this.rt.lastKeepAliveResult = result;
      this.store.touch();
      this.store.log('info', `保活巡检完成：${result}`);

      return { ok: true, at: this.rt.lastKeepAliveAt, result, renew, active };
    } finally {
      this._running = false;
    }
  }
}

module.exports = { KeepAlive, peekExpiryOf };
