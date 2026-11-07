'use strict';
/**
 * 账号管理：增删改查、凭证校验、额度刷新、签到执行。
 * 整个数据库已由 crypto 层加密落盘，因此账号令牌在内存结构中为明文、磁盘上为密文。
 */
const crypto = require('crypto');
const wb = require('./wb');
const { randomId } = require('./crypto');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 令牌续期失败后的退避时长：失败后这么久内不再碰同一个账号 */
const RENEW_BACKOFF_MS = 30 * 60 * 1000;

/* peekExpiryOf 的延迟加载缓存。
 * 注意：keepalive 是可选模块（server.js 用 try/catch 包着加载，缺文件也要能起服务），
 * 所以这里绝不能把 require 提到文件顶部——那会让只替换了部分文件的老部署整个起不来。
 * 拿不到判定函数时返回 null，调用方必须跳过 unknown 判定：没有证据就不下结论。
 */
let _peekExpiryOf = null;
let _peekExpiryLoaded = false;

function loadPeekExpiryOf() {
  if (_peekExpiryLoaded) return _peekExpiryOf;
  _peekExpiryLoaded = true;
  try {
    const mod = require('./keepalive');
    _peekExpiryOf = mod && typeof mod.peekExpiryOf === 'function' ? mod.peekExpiryOf : null;
  } catch (_) {
    _peekExpiryOf = null;
  }
  return _peekExpiryOf;
}

/** 备忘值格式固定为 'YYYY-MM-DD:原因'，只切第一个半角冒号（原因里可能有全角冒号/括号） */
function reasonOf(note) {
  const s = String(note || '');
  const i = s.indexOf(':');
  return i >= 0 ? s.slice(i + 1) : s;
}

const DAY_KEY = () => new Date().toLocaleDateString('sv-SE'); // YYYY-MM-DD，本地时区

function todayKey(tzOffsetMinutes) {
  if (typeof tzOffsetMinutes === 'number') {
    const t = new Date(Date.now() + tzOffsetMinutes * 60000);
    return t.toISOString().slice(0, 10);
  }
  return DAY_KEY();
}

/* ---------------- 停用语义（两档） ----------------
 * 'all'          全停：转发/对话 + 签到/保活/小喵等纯收益动作，全部停止
 * 'forward-only' 只停转发与对话：纯收益动作（签到/保活/小喵/成长）照常执行
 * 返回 '' 表示未停用，所有动作都正常。
 *
 * 向后兼容：老数据没有 pauseMode 字段，此时 enabled === false 一律按 'all' 处理；
 *          enabled === true 视为未停用。判断只允许走这里，别在业务代码里散落 if (!a.enabled)。
 */
function pauseModeOf(a) {
  if (!a || a.enabled !== false) return '';
  return a.pauseMode === 'forward-only' ? 'forward-only' : 'all';
}

/** 某类动作是否被停用。scope: 'forward'（转发/对话，默认）| 'earning'（签到/保活/小喵等纯收益） */
function isPausedFor(a, scope) {
  const mode = pauseModeOf(a);
  if (!mode) return false;
  if (scope === 'earning') return mode === 'all'; // 纯收益动作只被「全停」拦住
  return true; // 转发/对话两档都停
}

function publicAccount(a) {
  const q = a.quota || {};
  const c = a.checkin || {};
  const pauseMode = pauseModeOf(a);
  return {
    id: a.id,
    nickname: a.nickname,
    uid: a.uid,
    // uid 是数字 uin（主键/去重靠它）；uuid 才是桌面客户端的身份，埋点上报必须用这个
    uuid: a.uuid || '',
    hasToken: Boolean(a.token),
    tokenTail: a.token ? a.token.slice(-6) : '',
    hasRefresh: Boolean(a.refreshToken),
    tokenExpiresAt: a.tokenExpiresAt || 0,
    hasCookie: Boolean(a.cookie),
    cookieCount: a.cookie ? String(a.cookie).split(';').filter((x) => x.includes('=')).length : 0,
    cookieAt: a.cookieAt || 0,
    authMode: a.token ? (a.cookie ? 'both' : 'token') : (a.cookie ? 'cookie' : 'none'),
    phoneMasked: a.phone ? String(a.phone).slice(0, 3) + '****' + String(a.phone).slice(-4) : '',
    enabled: Boolean(a.enabled),
    // 停用语义：paused 表示转发已下线；pauseMode 区分停用档位（''=未停用）
    paused: Boolean(pauseMode),
    pauseMode,
    pausedAt: a.pausedAt || 0,
    note: a.note || '',
    tags: a.tags || [],
    endpoint: a.endpoint || wb.DEFAULT_ENDPOINT,
    enterpriseId: a.enterpriseId || '',
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
    credits: q.credits === undefined ? null : q.credits,
    creditsRemain: q.creditsRemain === undefined ? null : q.creditsRemain,
    creditsTotal: q.creditsTotal === undefined ? null : q.creditsTotal,
    creditsUsed: q.creditsUsed === undefined ? null : q.creditsUsed,
    checkinCredits: q.checkinCredits === undefined ? null : q.checkinCredits,
    creditGroups: (q.creditGroups || []).slice(0, 8),
    planName: q.planName || '',
    expireAt: q.expireAt || null,
    daysLeft: q.daysLeft === undefined ? null : q.daysLeft,
    quotaAt: q.at || 0,
    packages: (q.packages || []).slice(0, 12),
    checkin: {
      todayDone: c.date === todayKey() ? Boolean(c.done) : false,
      date: c.date || '',
      streakDays: c.streakDays || 0,
      dailyCredit: c.dailyCredit || 0,
      totalCredits: c.totalCredits === undefined ? null : c.totalCredits,
      lastAt: c.lastAt || 0,
      lastResult: c.lastResult || '',
      checkinDates: (c.dates || []).slice(-90),
    },
    // 连登里程碑（活跃地图）：本月连登天数、三档兑换状态、补登卡余额、抽奖机会
    streak: a.streak || null,
    lotteryChances: typeof a.lotteryChances === 'number' ? a.lotteryChances : null,
    lastError: a.lastError || '',
    lastErrorAt: a.lastErrorAt || 0,
    healthy: !a.lastError,
  };
}

class Accounts {
  constructor(store) {
    this.store = store;
  }

  get raw() {
    return this.store.data.accounts;
  }

  list() {
    return this.raw.map(publicAccount);
  }

  find(id) {
    return this.raw.find((a) => a.id === id) || null;
  }

  /** 代理转发与自动化用：拿到含明文凭证的内部对象 */
  usable() {
    return this.raw.filter((a) => a.enabled && (a.token || a.cookie));
  }

  /* ---------------- 停用语义（两档） ---------------- */

  /** 全部停用档位：'all' | 'forward-only' | ''（未停用） */
  pauseModeOf(acc) {
    return pauseModeOf(acc);
  }

  /** 转发/对话是否停用：两档都算停 */
  isPaused(acc) {
    return isPausedFor(acc, 'forward');
  }

  /** 纯收益动作（签到/保活/小喵/成长/额度刷新）是否停用：只有 'all' 才算停 */
  isEarningPaused(acc) {
    return isPausedFor(acc, 'earning');
  }

  /** 是否处于「仅停转发」档：转发下线但签到保活照常 */
  isForwardOnly(acc) {
    return pauseModeOf(acc) === 'forward-only';
  }

  /** 纯收益动作的账号池：排除「全停」账号，保留「仅停转发」账号 */
  earningPool() {
    return this.raw.filter((a) => !this.isEarningPaused(a) && (a.token || a.cookie));
  }

  /**
   * 停用账号。mode: 'all'（默认，全停）| 'forward-only'（只停转发与对话）
   * 内部统一落到 enabled=false + pauseMode，转发侧仍然只看 enabled，无需改其它模块。
   */
  pause(id, mode) {
    const acc = this.find(id);
    if (!acc) throw new Error('账号不存在');
    const m = mode === 'forward-only' ? 'forward-only' : 'all';
    acc.enabled = false;
    acc.pauseMode = m;
    acc.pausedAt = Date.now();
    acc.updatedAt = new Date().toISOString();
    this.store.log('info', `${acc.nickname} 已停用（${m === 'all' ? '全部' : '仅转发与对话'}）`);
    this.store.touch();
    return publicAccount(acc);
  }

  /** 恢复账号：转发与所有定时动作一起恢复 */
  resume(id) {
    const acc = this.find(id);
    if (!acc) throw new Error('账号不存在');
    acc.enabled = true;
    acc.pauseMode = '';
    acc.pausedAt = 0;
    acc.updatedAt = new Date().toISOString();
    this.store.log('info', `${acc.nickname} 已恢复`);
    this.store.touch();
    return publicAccount(acc);
  }

  create(input) {
    const nickname = String(input.nickname || '').trim();
    let uid = String(input.uid || '').trim();
    const token = String(input.token || '').trim();
    const cookie = String(input.cookie || '').trim();
    if (!uid) {
      // 扫码登录拿到的是 Cookie 会话，UID 可能一时问不到；用 Cookie 摘要做稳定主键，后续可补
      if (!cookie) throw new Error('缺少 UID');
      uid = 'ck_' + crypto.createHash('sha1').update(cookie).digest('hex').slice(0, 12);
    }
    if (!token && !cookie) throw new Error('缺少访问令牌或 Cookie');
    if (this.raw.some((a) => a.uid === uid)) throw new Error('该 UID 已存在，请直接更新');
    const now = new Date().toISOString();
    const acc = {
      id: randomId(8),
      nickname: nickname || ('账号-' + uid.slice(0, 8)),
      uid,
      uuid: String(input.uuid || '').trim(),
      uuidAt: input.uuid ? Date.now() : 0,
      token,
      refreshToken: String(input.refreshToken || '').trim(),
      tokenExpiresAt: Number(input.tokenExpiresAt || 0) || 0,
      cookie,
      ua: String(input.ua || '').trim(),
      cookieAt: cookie ? Date.now() : 0,
      endpoint: input.endpoint || wb.DEFAULT_ENDPOINT,
      enterpriseId: input.enterpriseId || '',
      domain: input.domain || '',
      note: input.note || '',
      tags: Array.isArray(input.tags) ? input.tags.slice(0, 8) : [],
      enabled: input.enabled !== false,
      // 停用语义：新建时默认未停用；显式传 enabled=false 视为「全停」
      pauseMode: input.enabled === false ? (input.pauseMode === 'forward-only' ? 'forward-only' : 'all') : '',
      pausedAt: input.enabled === false ? Date.now() : 0,
      createdAt: now,
      updatedAt: now,
      quota: { credits: null, packages: [], at: 0 },
      checkin: {},
      lastError: '',
      lastErrorAt: 0,
    };
    this.raw.push(acc);
    this.store.touch();
    return publicAccount(acc);
  }

  update(id, patch) {
    const acc = this.find(id);
    if (!acc) throw new Error('账号不存在');
    if (patch.nickname !== undefined) acc.nickname = String(patch.nickname).trim().slice(0, 40) || acc.nickname;
    if (patch.token !== undefined && String(patch.token).trim()) acc.token = String(patch.token).trim();
    if (patch.refreshToken !== undefined && String(patch.refreshToken).trim()) {
      acc.refreshToken = String(patch.refreshToken).trim();
    }
    if (patch.tokenExpiresAt !== undefined) acc.tokenExpiresAt = Number(patch.tokenExpiresAt) || 0;
    if (patch.cookie !== undefined) {
      const ck = String(patch.cookie).trim();
      if (ck) { acc.cookie = ck; acc.cookieAt = Date.now(); }
      else if (ck === '') { acc.cookie = ''; acc.cookieAt = 0; }
    }
    if (patch.uid !== undefined && String(patch.uid).trim()) acc.uid = String(patch.uid).trim();
    if (patch.uuid !== undefined && String(patch.uuid).trim()) acc.uuid = String(patch.uuid).trim();
    if (patch.uuid !== undefined) acc.uuidAt = Date.now();
    if (patch.note !== undefined) acc.note = String(patch.note).slice(0, 200);
    if (patch.tags !== undefined && Array.isArray(patch.tags)) acc.tags = patch.tags.slice(0, 8);
    // 停用语义：pauseMode 优先；老调用方只传 enabled 时按「全停 / 恢复」处理
    if (patch.pauseMode !== undefined) {
      const m = String(patch.pauseMode || '');
      if (m === 'all' || m === 'forward-only') {
        acc.enabled = false;
        acc.pauseMode = m;
        acc.pausedAt = acc.pausedAt || Date.now();
      } else {
        acc.enabled = true;
        acc.pauseMode = '';
        acc.pausedAt = 0;
      }
    } else if (patch.enabled !== undefined) {
      const on = Boolean(patch.enabled);
      acc.enabled = on;
      if (on) {
        acc.pauseMode = '';
        acc.pausedAt = 0;
      } else {
        // 已经是「仅停转发」就保持不变，否则默认全停
        acc.pauseMode = acc.pauseMode === 'forward-only' ? 'forward-only' : 'all';
        acc.pausedAt = acc.pausedAt || Date.now();
      }
    }
    if (patch.endpoint !== undefined && String(patch.endpoint).trim()) acc.endpoint = String(patch.endpoint).trim();
    if (patch.enterpriseId !== undefined) acc.enterpriseId = String(patch.enterpriseId).trim();
    if (patch.domain !== undefined) acc.domain = String(patch.domain).trim();
    if (patch.ua !== undefined) acc.ua = String(patch.ua || '').trim();
    acc.updatedAt = new Date().toISOString();
    this.store.touch();
    return publicAccount(acc);
  }

  /** 扫码登录成功后落库：同 UID 覆盖，否则新增 */
  commitCredential(cred) {
    const uid = String((cred && cred.uid) || '').trim();
    const cookie = String((cred && cred.cookie) || '').trim();
    const token = String((cred && cred.token) || '').trim();
    const refreshToken = String((cred && cred.refreshToken) || '').trim();
    const tokenExpiresAt = Number((cred && cred.tokenExpiresAt) || 0) || 0;
    if (!cookie && !token) throw new Error('扫码结果里没有可用凭证');
    let acc = uid ? this.raw.find((a) => a.uid === uid) : null;
    if (!acc && token) acc = this.raw.find((a) => a.token === token);
    if (acc) {
      this.update(acc.id, {
        cookie: cookie || undefined,
        token: token || undefined,
        refreshToken: refreshToken || undefined,
        tokenExpiresAt: tokenExpiresAt || undefined,
        nickname: (cred && cred.nickname) || undefined,
        phone: (cred && cred.phone) || undefined,
        ua: (cred && cred.ua) || undefined,
        enterpriseId: (cred && cred.enterpriseId) || undefined,
        uuid: (cred && cred.uuid) || undefined,
      });
      return { created: false, account: this.find(acc.id) };
    }
    this.create({
      uid,
      uuid: cred && cred.uuid,
      cookie,
      token,
      refreshToken,
      tokenExpiresAt,
      nickname: cred && cred.nickname,
      phone: cred && cred.phone,
      ua: cred && cred.ua,
      enterpriseId: cred && cred.enterpriseId,
    });
    return { created: true, account: this.find(this.raw[this.raw.length - 1].id) };
  }

  remove(id) {
    const i = this.raw.findIndex((a) => a.id === id);
    if (i < 0) throw new Error('账号不存在');
    const [acc] = this.raw.splice(i, 1);
    this.store.log('info', `删除账号 ${acc.nickname}`);
    return { removed: acc.nickname };
  }

  setError(acc, message) {
    acc.lastError = String(message || '').slice(0, 200);
    acc.lastErrorAt = Date.now();
    this.store.touch();
  }

  clearError(acc) {
    if (!acc.lastError) return;
    acc.lastError = '';
    acc.lastErrorAt = 0;
    this.store.touch();
  }

  /**
   * 令牌续期（仅续期，不打 snapshot）。
   * 判定口径与改造前 refresh() 里那段完全一致：有 refreshToken，且 token 缺失或 60 秒内过期。
   * 只报告结果、不写日志——日志策略由调用方决定（refresh 静默，批量续期写去重后的 warn）。
   * @param {object} [opts] opts.force=true 跳过本地判定直接续期；opts.windowMs 自定义提前续期窗口（默认 60000）
   * @returns {Promise<{renewed: boolean, error: string}>}
   */
  async renewExpiringToken(acc, opts) {
    if (!acc) return { renewed: false, error: '' };
    const force = Boolean(opts && opts.force);
    // 窗口默认 60 秒（与改造前完全一致，refresh() 不传 opts 所以行为不变）；
    // 定时批量层会传「一个刷新周期 + 余量」，否则 30 分钟一轮 × 60 秒窗口只有 3.3% 命中率，
    // 绝大多数令牌会「过期之后」才被发现。下限夹 60 秒，不允许调到比原来更窄。
    const windowMs = Math.max(60 * 1000, Number((opts && opts.windowMs) || 0));
    // ↓↓↓ 以下判断条件与改造前 refresh() 里的那段逐字一致，未改口径、未改 60 秒红线
    //     （force / windowMs 只由批量层传入，refresh() 不传 opts，行为不变）
    if (acc.refreshToken && (force || !acc.token || (acc.tokenExpiresAt && acc.tokenExpiresAt < Date.now() + windowMs))) {
      let renewed = null;
      try {
        renewed = await wb.renewToken(acc);
      } catch (err) {
        return { renewed: false, error: err.message || String(err) };
      }
      if (renewed) {
        acc.token = renewed.token;
        if (renewed.refreshToken) acc.refreshToken = renewed.refreshToken;
        acc.tokenAt = Date.now();
        acc.tokenExpiresAt = renewed.expiresIn ? Date.now() + renewed.expiresIn * 1000 : 0;
        this.store.touch();
        // 短 TTL 告警（错峰新增）：只在「真的续了」之后判断，上游给的有效期不足 1 天说明该账号
        // 可能被每轮重复续期。按「账号+日期」每天只写 1 条，避免短 TTL 账号把日志刷满。
        if (renewed.expiresIn && renewed.expiresIn < 86400) {
          const rt = this.store.data.runtime || (this.store.data.runtime = {});
          const noted = rt.tokenShortTtlNoted || (rt.tokenShortTtlNoted = {});
          const day = todayKey();
          if (noted[acc.id] !== day) {
            noted[acc.id] = day;
            this.store.log('warn', `令牌有效期偏短 ${acc.nickname}：${Math.round(renewed.expiresIn / 60)} 分钟，可能被每轮重复续期`);
          }
        }
        return { renewed: true, error: '' };
      }
    }
    // ↑↑↑ 以上为纯搬运：仅把 .catch(() => null) 改成 try/catch 以便把错误交给调用方记录
    return { renewed: false, error: '' };
  }

  /**
   * 批量令牌续期：只对「token 缺失 / 60 秒内过期」的账号发 renewToken，不产生 snapshot 请求。
   * 用于「额度刷新让位给积分刷新」时补回续期能力，保证让位前后续期能力等价。
   * 三重保护：命中账号之间随机等待（节流）、失败退避 30 分钟、同账号同原因每天只写 1 条 warn。
   * @param {{delayMinMs?:number, delayMaxMs?:number, budgetMs?:number}} opts
   * @returns {Promise<{done:string[], failed:object[], spentMs:number}>}
   */
  async renewExpiringTokens(opts) {
    const o = opts || {};
    const min = Math.max(0, Number(o.delayMinMs) || 0);
    const max = Math.max(min, Number(o.delayMaxMs) || 0);
    const budget = Math.max(0, Number(o.budgetMs) || 0); // 0 表示不设总预算
    // 提前续期窗口：定时批量层传「刷新周期 + 5 分钟余量」，保证每一轮都把「撑不到下一轮」的令牌续掉。
    // 不传时退回 60 秒（与改造前的红线一致）。
    const windowMs = Math.max(60 * 1000, Number(o.windowMs) || 0);
    const data = this.store.data;
    if (!data.runtime) data.runtime = {};
    const rt = data.runtime;
    if (!rt.tokenRenewFailAt) rt.tokenRenewFailAt = {};
    if (!rt.tokenRenewFailNoted) rt.tokenRenewFailNoted = {};
    const day = todayKey();

    const done = [];
    const failed = [];
    let spent = 0;
    let hits = 0;
    const peek = loadPeekExpiryOf();

    for (const acc of this.raw) {
      if (this.isEarningPaused(acc)) continue;
      if (!acc.refreshToken) continue;
      // 资格判定三段与：token 缺失、本地有效期临期、**JWT 里解出的有效期临期** 都算。
      // 只认本地字段会漏掉「tokenExpiresAt 没记、但 JWT 有 exp 且马上到期」的账号——
      // 那类账号 JWT 明明能算出生效期，却因为本地没记而被整批跳过，续期根本不触发。
      let nearExpire = !acc.token || Boolean(acc.tokenExpiresAt && acc.tokenExpiresAt < Date.now() + windowMs);
      let jwtNear = false;
      if (!nearExpire && peek) {
        try {
          const exp = peek(acc);
          jwtNear = Boolean(exp && exp.ms && exp.ms < Date.now() + windowMs);
          nearExpire = jwtNear;
        } catch (_) {
          jwtNear = false;
        }
      }
      if (!nearExpire) continue;
      // 退避：失败过的账号 30 分钟内不再碰，避免小间隔配置下反复打上游
      if (rt.tokenRenewFailAt[acc.id] && Date.now() - rt.tokenRenewFailAt[acc.id] < RENEW_BACKOFF_MS) continue;

      // 节流：命中续期的账号之间随机等待，避免同批导入、有效期一致的账号同一秒集中刷新
      if (hits > 0 && max > 0) {
        let ms = Math.round(min + Math.random() * Math.max(0, max - min));
        if (budget > 0) ms = Math.min(ms, Math.max(0, budget - spent));
        if (ms > 0) { spent += ms; await sleep(ms); }
      }
      hits += 1;

      const r = await this.renewExpiringToken(acc, { force: jwtNear, windowMs });
      if (r.renewed) {
        done.push(acc.nickname);
        delete rt.tokenRenewFailAt[acc.id];
        delete rt.tokenRenewFailNoted[acc.id];
        continue;
      }
      if (!r.error) continue; // 条件不满足，压根没发请求
      failed.push({ id: acc.id, nickname: acc.nickname, error: r.error });
      rt.tokenRenewFailAt[acc.id] = Date.now();
      const key = `${day}:${String(r.error).slice(0, 60)}`;
      if (rt.tokenRenewFailNoted[acc.id] !== key) {
        rt.tokenRenewFailNoted[acc.id] = key;
        this.store.log('warn', `${acc.nickname} 令牌续期失败：${r.error}`);
      }
    }

    if (done.length) this.store.log('info', `令牌续期成功：${done.join('、')}`);
    if (done.length || failed.length) this.store.touch();
    return { done, failed, spentMs: spent };
  }

  /**
   * 续期健康度：把「两条续期路径」的失败状态和「本地判不出有效期」的账号合成一个出口，
   * 让状态页不用自己去拼 runtime 里的多个键。只读，不写任何字段。
   *
   * 三类，failing 与 unknown 分开计数（unknown 不是故障，不该染红）：
   *   expiring  临期续期失败 —— 60 秒红线路径，30 分钟退避内的失败
   *   patrol    保活巡检失败 —— 3 天阈值路径，下次巡检成功即自动清除
   *   unknown   本地未记录有效期（巡检时会再确认）—— 不是「不能续」，是「现在还判不出」
   */
  renewHealth() {
    const rt = this.store.data.runtime || {};
    const failAt = rt.tokenRenewFailAt || {};
    const myNotes = rt.tokenRenewFailNoted || {};
    const patrolNotes = rt.renewFailNoted || {};
    const peek = loadPeekExpiryOf();

    const rows = [];
    for (const acc of this.raw) {
      const at = failAt[acc.id] || 0;
      const note = patrolNotes[acc.id] || '';
      let kind = '';
      let reason = '';
      if (at) {
        kind = 'expiring';
        reason = reasonOf(myNotes[acc.id]) || '临期续期失败';
      } else if (note) {
        kind = 'patrol';
        reason = reasonOf(note) || '保活巡检失败';
      } else if (peek && acc.refreshToken && !acc.tokenExpiresAt) {
        // 三段与：有 refreshToken + 本地没记有效期 + JWT 也解不出，三条缺一不判 unknown。
        // JWT 里能解出 exp 的账号其实可以正常续期，只按「本地没记」判 unknown 就是误报。
        let source = 'unknown';
        try {
          const exp = peek(acc);
          source = (exp && exp.source) || 'unknown';
        } catch (_) {
          source = 'unknown';
        }
        if (source === 'unknown') {
          kind = 'unknown';
          reason = '本地未记录有效期（巡检时会再确认）';
        }
      }
      if (!kind) continue;
      rows.push({ id: acc.id, nickname: acc.nickname, kind, at, note, reason });
    }

    return {
      failing: rows.filter((r) => r.kind !== 'unknown').length,
      unknown: rows.filter((r) => r.kind === 'unknown').length,
      rows,
    };
  }

  /** 刷新单个账号额度 */
  async refresh(id) {
    const acc = this.find(id);
    if (!acc) throw new Error('账号不存在');
    // token 即将过期或缺失时，先尝试用 refreshToken 续期；续不了就退回纯 Cookie 会话
    await this.renewExpiringToken(acc);
    const snap = await wb.snapshot(acc);
    const keep = acc.quota || {};
    // 刷新失败时上游给 null，此时保留上一次的有效数字，避免界面被清空
    acc.quota = {
      credits: snap.credits === null || snap.credits === undefined ? (keep.credits ?? null) : snap.credits,
      creditsRemain: snap.creditsRemain === null || snap.creditsRemain === undefined ? (keep.creditsRemain ?? null) : snap.creditsRemain,
      creditsTotal: snap.creditsTotal === null || snap.creditsTotal === undefined ? (keep.creditsTotal ?? null) : snap.creditsTotal,
      creditsUsed: snap.creditsUsed === null || snap.creditsUsed === undefined ? (keep.creditsUsed ?? null) : snap.creditsUsed,
      checkinCredits: snap.checkinCredits === null || snap.checkinCredits === undefined ? (keep.checkinCredits ?? null) : snap.checkinCredits,
      creditGroups: snap.creditGroups && snap.creditGroups.length ? snap.creditGroups : (keep.creditGroups || []),
      planName: snap.planName || keep.planName || '',
      expireAt: snap.expireAt || keep.expireAt || null,
      daysLeft: snap.daysLeft === null || snap.daysLeft === undefined ? (keep.daysLeft ?? null) : snap.daysLeft,
      packages: snap.packages && snap.packages.length ? snap.packages : (keep.packages || []),
      at: Date.now(),
    };
    if (snap.checkin) {
      const ck = snap.checkin;
      acc.checkin = {
        ...acc.checkin,
        todayDone: ck.todayCheckedIn,
        done: ck.todayCheckedIn,
        date: todayKey(),
        streakDays: ck.streakDays,
        dailyCredit: ck.dailyCredit,
        totalCredits: ck.totalCredits,
        dates: ck.checkinDates,
        lastAt: acc.checkin.lastAt || 0,
        lastResult: acc.checkin.lastResult || '',
      };
    }
    const authErr = snap.errors.find((e) => e.kind === 'auth');
    if (authErr) this.setError(acc, authErr.message);
    else this.clearError(acc);
    await this.ensureDesktopId(acc);
    this.store.touch();
    return { account: publicAccount(acc), errors: snap.errors };
  }

  /**
   * 保证账号有桌面身份 UUID（acc.uuid）。
   *
   * ★ 为什么必须在**服务进程内**做，不能靠一次性脚本回填：
   *   服务持有 store.data 的内存副本，任何一次 store.saveNow() 都会把整个内存快照写回
   *   db.enc。一次性脚本改完 db.enc，服务下一次落盘就把它覆盖回滚了 ——
   *   2026-10-30 实测：fill_uuid.js 写进去后不到半小时，4 个账号的 uuid 全被抹掉。
   *   所以 uuid 必须由服务自己维护，才不会被自己的保存逻辑吃掉。
   *
   * ★ 为什么缺 uuid 是致命的：
   *   埋点 /v2/report 的 userId 认的是 UUID（桌面客户端 account.uid），
   *   数字 uin 会被服务端静默丢弃（200 + code 0 但不归账）。
   *
   * 频率控制：只在缺失时、或距上次确认超过 12 小时时才问上游一次 /console/accounts。
   */
  async ensureDesktopId(acc, opts) {
    const o = opts || {};
    const force = Boolean(o.force);
    const now = Date.now();
    const TTL = 12 * 3600 * 1000;
    const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!acc) return { ok: false, reason: '账号不存在' };
    if (!force && uuidRe.test(String(acc.uuid || '')) && now - Number(acc.uuidAt || 0) < TTL) {
      return { ok: true, uuid: acc.uuid, cached: true };
    }
    try {
      const me = await wb.whoami(acc);
      if (me && me.uuid) {
        const changed = me.uuid !== acc.uuid;
        acc.uuid = me.uuid;
        acc.uuidAt = now;
        if (changed) this.store.touch();
        return { ok: true, uuid: me.uuid, changed };
      }
      // 没拿到 UUID 但拿到了数字 uid —— 也记一下，省得每次都问
      if (me && me.uid && !acc.uid) acc.uid = me.uid;
      return { ok: false, reason: '上游返回里没有 UUID 形态的用户标识' };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  async refreshAll() {
    const results = [];
    for (const acc of this.raw) {
      if (!acc.token && !acc.cookie) {
        results.push({ id: acc.id, nickname: acc.nickname, ok: false, message: '缺少凭证' });
        continue;
      }
      try {
        const r = await this.refresh(acc.id);
        results.push({ id: acc.id, nickname: acc.nickname, ok: true, credits: r.account.credits });
      } catch (err) {
        this.setError(acc, err.message);
        results.push({ id: acc.id, nickname: acc.nickname, ok: false, message: err.message });
      }
    }
    return results;
  }

  /** 单账号签到：先查状态，已签则跳过；不依赖上游错误码 */
  async checkinOne(id, options) {
    const acc = this.find(id);
    if (!acc) throw new Error('账号不存在');
    if (!acc.token && !acc.cookie) throw new Error('该账号没有可用凭证');
    const opts = options || {};
    // 停用语义：签到属于纯收益动作，只被「全停」拦住，「仅停转发」照常签到
    if (this.isEarningPaused(acc) && !opts.force) {
      return { skipped: true, reason: '账号已停用' };
    }

    const before = await wb.checkinStatus(acc);
    // 连登里程碑 + 抽奖机会（只读，失败不影响签到主流程）
    let streak = null, lottery = null;
    try { streak = await wb.streakStatus(acc); } catch (_) {}
    try { lottery = await wb.lotterySummary(acc); } catch (_) {}
    if (streak && streak.ok) acc.streak = {
      days: streak.days,
      monthTotalDays: streak.monthTotalDays,
      monthConsumedDays: streak.monthConsumedDays,
      nextTier: streak.nextTier,
      nextTierRemaining: streak.nextTierRemaining,
      makeupDates: streak.makeupDates,
      makeupCards: streak.makeupCards,
      makeupCardsMax: streak.makeupCardsMax,
      tiers: streak.tiers,
      tierStatus: streak.tierStatus,
      at: Date.now(),
    };
    if (lottery && lottery.ok) acc.lotteryChances = lottery.chances;
    if (before.todayCheckedIn && !opts.force) {
      acc.checkin = {
        ...acc.checkin,
        date: todayKey(),
        done: true,
        streakDays: before.streakDays,
        dailyCredit: before.dailyCredit,
        totalCredits: before.totalCredits,
        dates: before.checkinDates,
      };
      this.store.touch();
      return { skipped: true, reason: '今天已经签到过', streakDays: before.streakDays, credits: before.totalCredits };
    }

    let claimed = null;
    let already = false;
    try {
      claimed = await wb.claimCheckin(acc);
    } catch (err) {
      const msg = String(err.message || '');
      if (err.kind === 'auth') {
        this.setError(acc, msg);
        throw err;
      }
      if (/already|已签|重复|签过|上限|limit/i.test(msg)) {
        already = true;
      } else {
        this.setError(acc, msg);
        throw err;
      }
    }

    const after = await wb.checkinStatus(acc).catch(() => null);
    let streak2 = null, lottery2 = null;
    try { streak2 = await wb.streakStatus(acc); } catch (_) {}
    try { lottery2 = await wb.lotterySummary(acc); } catch (_) {}
    if (streak2 && streak2.ok) acc.streak = {
      days: streak2.days,
      monthTotalDays: streak2.monthTotalDays,
      monthConsumedDays: streak2.monthConsumedDays,
      nextTier: streak2.nextTier,
      nextTierRemaining: streak2.nextTierRemaining,
      makeupDates: streak2.makeupDates,
      makeupCards: streak2.makeupCards,
      makeupCardsMax: streak2.makeupCardsMax,
      tiers: streak2.tiers,
      tierStatus: streak2.tierStatus,
      at: Date.now(),
    };
    if (lottery2 && lottery2.ok) acc.lotteryChances = lottery2.chances;
    const streakDaysAcc = (claimed && claimed.streakDays) || (after && after.streakDays) || before.streakDays;
    acc.checkin = {
      date: todayKey(),
      done: true,
      streakDays: streakDaysAcc,
      dailyCredit: (claimed && claimed.credit) || before.dailyCredit,
      totalCredits: after ? after.totalCredits : before.totalCredits,
      dates: after ? after.checkinDates : before.checkinDates,
      lastAt: Date.now(),
      lastResult: already ? '上游提示已签到' : '签到成功',
    };
    this.clearError(acc);
    this.store.bumpStat(todayKey(), 'checkin', 1);
    this.store.bumpStat(todayKey(), 'credits', (claimed && claimed.credit) || 0);
    this.store.log('info', `${acc.nickname} 签到${already ? '（已签）' : '成功'}，+${(claimed && claimed.credit) || 0} 积分`);
    this.store.touch();
    return {
      skipped: false,
      already,
      credit: (claimed && claimed.credit) || 0,
      streakDays: streak,
      totalCredits: acc.checkin.totalCredits,
    };
  }

  async checkinAll() {
    const results = [];
    for (const acc of this.raw) {
      // 停用语义：批量签到只跳过「全停」账号
      if (this.isEarningPaused(acc)) continue;
      try {
        const r = await this.checkinOne(acc.id);
        results.push({ id: acc.id, nickname: acc.nickname, ok: true, ...r });
      } catch (err) {
        results.push({ id: acc.id, nickname: acc.nickname, ok: false, message: err.message });
      }
    }
    return results;
  }

  summary() {
    const accounts = this.raw;
    const enabled = accounts.filter((a) => a.enabled);
    // 停用语义：earning 为「参与纯收益动作」的账号（含仅停转发），used 区分两档
    const earning = accounts.filter((a) => !isPausedFor(a, 'earning'));
    const forwardOnly = accounts.filter((a) => pauseModeOf(a) === 'forward-only');
    const pausedAll = accounts.filter((a) => pauseModeOf(a) === 'all');
    const withToken = accounts.filter((a) => a.token || a.cookie);
    const creditsKnown = accounts.map((a) => (a.quota && typeof a.quota.credits === 'number' ? a.quota.credits : null)).filter((v) => v !== null);
    const remainKnown = accounts.map((a) => (a.quota && typeof a.quota.creditsRemain === 'number' ? a.quota.creditsRemain : null)).filter((v) => v !== null);
    const todayDone = accounts.filter((a) => a.checkin && a.checkin.date === todayKey() && a.checkin.done).length;
    return {
      total: accounts.length,
      enabled: enabled.length,
      earning: earning.length,
      forwardOnly: forwardOnly.length,
      pausedAll: pausedAll.length,
      withToken: withToken.length,
      withCookie: accounts.filter((a) => a.cookie).length,
      todayDone,
      pending: Math.max(0, earning.filter((a) => a.token || a.cookie).length - todayDone),
      credits: creditsKnown.reduce((s, v) => s + v, 0),
      creditsKnownCount: creditsKnown.length,
      creditsRemain: remainKnown.reduce((s, v) => s + v, 0),
      errored: accounts.filter((a) => a.lastError).length,
      today: todayKey(),
    };
  }
}

module.exports = { Accounts, publicAccount, todayKey, pauseModeOf, isPausedFor, hashUid: (s) => crypto.createHash('sha1').update(String(s)).digest('hex') };
