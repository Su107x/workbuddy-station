'use strict';
/**
 * 积分体系：实时查询 + 到期倒计时 + 变动流水。
 *
 * 落库位置（都在加密库里，不需要改 store.js 的 defaultData，首次使用时惰性创建）：
 *   store.data.creditsSnapshot[账号id] = { credits, packages, nextExpireAt, nextExpireCredits, at, ... }
 *   store.data.creditsLedger = [ { at, accId, nickname, delta, before, after, reason }, ... ]  // 倒序，最多 500 条
 *   store.data.runtime.lastCreditsAt / lastCreditsResult                                    // 最近一次全量刷新
 *
 * 余额口径与 lib/wb.js snapshot() 保持一致：
 *   credits  = 上游 TotalCredits（当前可用总积分）
 *   creditsRemain = 各资源包 CycleRemainCapacity 之和
 * 两者理论上应当相等，取不到 credits 时退回 creditsRemain。
 */

const wb = require('./wb');

const LEDGER_MAX = 500;          // 流水环形上限
const REASON_WINDOW_MS = 20 * 60 * 1000; // 变动归因的时间窗：20 分钟内发生过的动作才算「元凶」
const REASONS = ['checkin', 'travel', 'task', 'refresh', 'observed'];

/** 积分是小数（可能是 20 位尾巴），统一截到 6 位，避免浮点噪声被记成「变动」 */
function round6(n) {
  return typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 1e6) / 1e6 : null;
}

/** 惰性建好三个容器，老库升级后第一次调用也能直接用 */
function ensureBuckets(store) {
  const d = store.data;
  if (!d.creditsSnapshot || typeof d.creditsSnapshot !== 'object' || Array.isArray(d.creditsSnapshot)) {
    d.creditsSnapshot = {};
  }
  if (!Array.isArray(d.creditsLedger)) d.creditsLedger = [];
  if (!d.runtime || typeof d.runtime !== 'object' || Array.isArray(d.runtime)) d.runtime = {};
  return d;
}

/** 只保留前端要用的字段，不把上游原始包塞进快照（避免库文件膨胀） */
function slimPackage(p) {
  return {
    id: p.id || '',
    name: p.name || '资源包',
    total: p.total === undefined ? null : p.total,
    used: p.used === undefined ? null : p.used,
    remain: p.remain === undefined ? null : p.remain,
    unit: p.unit || 'credits',
    expireAt: p.expireAt === undefined ? null : p.expireAt,
    daysLeft: p.daysLeft === undefined ? null : p.daysLeft,
    expired: Boolean(p.expired),
    giftTag: p.giftTag || '',
  };
}

class Credits {
  /**
   * @param {import('./store').Store} store
   * @param {import('./accounts').Accounts} accounts
   */
  constructor(store, accounts) {
    this.store = store;
    this.accounts = accounts;
  }

  /**
   * 归因：这笔变动是谁造成的。
   * 依次看签到 / 小喵领取 / 成长任务领取的时间戳，再退到日志关键字，
   * 都对不上就按触发方式给 'refresh'（手动刷新）或 'observed'（定时巡查）。
   *
   * 归因的固有上限（不是 bug，别试图用硬编码奖励表去「修正」）：
   *   1. 流水记的是「两次刷新之间的净值」，同一窗口内 +100 签到与 -50 对话会合并成 +50；
   *   2. 奖励金额只有服务端知道（claim / buddy/first 响应里的 data.credit），
   *      所以无法按金额反推是哪一笔；
   *   3. 有些到账路径不写任何时间戳，例如 first_buddy 走 /activity/growth/buddy/first
   *      而不是 tasks/{code}/claim，若它没写 lastClaimAt，只能退化到 'observed'。
   * 因此：时间戳写全 → 归因准确；写不全 → 退化但数据仍然正确。
   */
  inferReason(acc, manual) {
    const now = Date.now();
    const within = (t) => {
      const n = Number(t) || 0;
      return n > 0 && now - n >= 0 && now - n <= REASON_WINDOW_MS;
    };

    if (acc.checkin && within(acc.checkin.lastAt)) return 'checkin';
    if (acc.meow && within(acc.meow.lastClaimAt)) return 'travel';
    // 任务奖励归因：两处都认。
    // 历史原因——早期 growthtasks.list() 是整体重建 acc.growthTasks，会把 lastClaimAt 冲掉，
    // 所以 _markClaimAt 额外写了账号级的 lastTaskClaimAt 兜底。现在 list() 已改成
    // Object.assign 保留旧字段（growthtasks.js），第一个判断通常就命中；保留第二个判断
    // 是因为老数据里可能只有账号级字段，且它对任何未来的缓存重建都免疫。
    if (acc.growthTasks && within(acc.growthTasks.lastClaimAt || acc.growthTasks.claimAt)) return 'task';
    if (within(acc.lastTaskClaimAt)) return 'task';

    // 日志兜底：有些模块只写日志不写时间戳
    const logs = Array.isArray(this.store.data.logs) ? this.store.data.logs : [];
    const nick = String(acc.nickname || '');
    for (const lg of logs) {
      const t = Date.parse(lg && lg.at);
      if (!Number.isFinite(t) || now - t > REASON_WINDOW_MS) break; // 日志是倒序的，越界即可停
      const msg = String((lg && lg.message) || '');
      if (!nick || !msg.includes(nick)) continue;
      if (/签到/.test(msg)) return 'checkin';
      if (/小喵|旅行/.test(msg)) return 'travel';
      if (/任务/.test(msg)) return 'task';
    }
    return manual ? 'refresh' : 'observed';
  }

  /** 记一条流水，超上限自动丢最老的 */
  pushLedger(entry) {
    const d = ensureBuckets(this.store);
    const list = d.creditsLedger;
    list.unshift({
      at: entry.at,
      accId: entry.accId,
      nickname: entry.nickname || '',
      delta: round6(entry.delta),
      before: round6(entry.before),
      after: round6(entry.after),
      reason: REASONS.includes(entry.reason) ? entry.reason : 'observed',
    });
    if (list.length > LEDGER_MAX) list.length = LEDGER_MAX;
    this.store.touch();
    return list[0];
  }

  /**
   * 刷新单个账号：查实时积分 → 写缓存 → 余额有变化就记流水。
   * @param {object|string} accOrId 账号内部对象或账号 id
   * @param {{manual?: boolean, reason?: string}} [opts]
   * @returns {Promise<object>} { ok, accId, nickname, credits, delta, expireAt, daysLeft, error? }
   */
  async refreshAccount(accOrId, opts) {
    const o = opts || {};
    const acc = typeof accOrId === 'string'
      ? (this.accounts ? this.accounts.find(accOrId) : null)
      : accOrId;
    if (!acc) return { ok: false, error: '账号不存在' };
    if (!acc.token && !acc.cookie) return { ok: false, accId: acc.id, nickname: acc.nickname, error: '缺少凭证' };

    let snap;
    try {
      snap = await wb.snapshot(acc);
    } catch (err) {
      return { ok: false, accId: acc.id, nickname: acc.nickname, error: err.message };
    }

    const after = round6(snap.credits !== null && snap.credits !== undefined ? snap.credits : snap.creditsRemain);
    if (after === null) {
      const first = (snap.errors && snap.errors[0]) || null;
      return {
        ok: false,
        accId: acc.id,
        nickname: acc.nickname,
        error: (first && first.message) || '上游未返回积分',
      };
    }

    const d = ensureBuckets(this.store);
    const prev = d.creditsSnapshot[acc.id] || null;
    const before = prev ? round6(prev.credits) : null;
    const delta = before === null ? null : round6(after - before);

    const at = Date.now();
    d.creditsSnapshot[acc.id] = {
      credits: after,
      creditsTotal: round6(snap.creditsTotal),
      creditsRemain: round6(snap.creditsRemain),
      creditsUsed: round6(snap.creditsUsed),
      planName: snap.planName || '',
      packages: Array.isArray(snap.packages) ? snap.packages.map(slimPackage) : [],
      creditGroups: Array.isArray(snap.creditGroups) ? snap.creditGroups : [],
      nextExpireAt: snap.nextExpireAt === undefined ? null : snap.nextExpireAt,
      nextExpireCredits: snap.nextExpireCredits === undefined ? null : snap.nextExpireCredits,
      nextExpirePackageId: snap.nextExpirePackageId || '',
      nextExpirePackageName: snap.nextExpirePackageName || '',
      expireAt: snap.expireAt === undefined ? null : snap.expireAt,
      daysLeft: snap.daysLeft === undefined ? null : snap.daysLeft,
      at,
    };

    // 兼容老界面：accounts 表里的 quota 也同步一份（取不到时保留上次的值，别把界面清空）
    const keep = acc.quota || {};
    acc.quota = {
      credits: after,
      creditsRemain: snap.creditsRemain === null || snap.creditsRemain === undefined ? (keep.creditsRemain ?? null) : snap.creditsRemain,
      creditsTotal: snap.creditsTotal === null || snap.creditsTotal === undefined ? (keep.creditsTotal ?? null) : snap.creditsTotal,
      creditsUsed: snap.creditsUsed === null || snap.creditsUsed === undefined ? (keep.creditsUsed ?? null) : snap.creditsUsed,
      checkinCredits: snap.checkinCredits === null || snap.checkinCredits === undefined ? (keep.checkinCredits ?? null) : snap.checkinCredits,
      creditGroups: snap.creditGroups && snap.creditGroups.length ? snap.creditGroups : (keep.creditGroups || []),
      planName: snap.planName || keep.planName || '',
      expireAt: snap.expireAt === null || snap.expireAt === undefined ? (keep.expireAt ?? null) : snap.expireAt,
      daysLeft: snap.daysLeft === null || snap.daysLeft === undefined ? (keep.daysLeft ?? null) : snap.daysLeft,
      packages: snap.packages && snap.packages.length ? snap.packages : (keep.packages || []),
      at,
    };
    this.store.touch();

    if (delta !== null && delta !== 0) {
      this.pushLedger({
        at,
        accId: acc.id,
        nickname: acc.nickname,
        delta,
        before,
        after,
        reason: o.reason || this.inferReason(acc, Boolean(o.manual)),
      });
    }

    return {
      ok: true,
      accId: acc.id,
      nickname: acc.nickname,
      credits: after,
      before,
      delta,
      creditsTotal: round6(snap.creditsTotal),
      creditsRemain: round6(snap.creditsRemain),
      packages: d.creditsSnapshot[acc.id].packages,
      expireAt: d.creditsSnapshot[acc.id].expireAt,
      daysLeft: d.creditsSnapshot[acc.id].daysLeft,
      nextExpireAt: d.creditsSnapshot[acc.id].nextExpireAt,
      nextExpireCredits: d.creditsSnapshot[acc.id].nextExpireCredits,
    };
  }

  /**
   * 刷新所有可用账号：单个失败不影响其它，最后汇总写 runtime。
   * 账号池优先用 accounts.earningPool()（排除「全停」，保留「仅停转发」——
   * 额度刷新属于只读收益动作），老版本没有该方法时退回 usable()。
   * @returns {Promise<{at:number,total:number,ok:number,failed:number,results:object[]}>}
   */
  async refreshAll() {
    let list = [];
    if (this.accounts && typeof this.accounts.earningPool === 'function') {
      list = this.accounts.earningPool();
    } else if (this.accounts && typeof this.accounts.usable === 'function') {
      list = this.accounts.usable();
    }
    const results = [];
    for (const acc of list) {
      try {
        const r = await this.refreshAccount(acc, { manual: false });
        results.push({
          id: acc.id,
          nickname: acc.nickname,
          ok: Boolean(r.ok),
          credits: r.credits === undefined ? null : r.credits,
          delta: r.delta === undefined ? null : r.delta,
          error: r.error || '',
        });
      } catch (err) {
        results.push({ id: acc.id, nickname: acc.nickname, ok: false, error: err.message });
      }
      // 错峰：别把上游打出节流
      await new Promise((r) => setTimeout(r, 300 + Math.floor(Math.random() * 500)));
    }

    const at = Date.now();
    const summary = {
      at,
      total: results.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      results,
    };
    const d = ensureBuckets(this.store);
    d.runtime.lastCreditsAt = at;
    d.runtime.lastCreditsResult = summary;
    this.store.touch();
    return summary;
  }

  /** 读缓存；staleSeconds 告诉调用方这份数据多久没刷新了 */
  getAccount(accId) {
    const d = ensureBuckets(this.store);
    const snap = d.creditsSnapshot[accId];
    if (!snap) return null;
    return {
      ...snap,
      staleSeconds: Math.max(0, Math.round((Date.now() - (Number(snap.at) || 0)) / 1000)),
    };
  }

  /** 流水，倒序（最新的在前） */
  ledger(limit) {
    const d = ensureBuckets(this.store);
    const n = Number(limit);
    const cap = Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), LEDGER_MAX) : 100;
    return d.creditsLedger.slice(0, cap);
  }
}

module.exports = { Credits, REASONS, LEDGER_MAX };
