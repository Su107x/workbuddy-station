'use strict';
/**
 * streakredeem.js —— 连续签到里程碑奖励的自动兑换。
 *
 * 需求背景（用户原话）：
 *   「不是每日，而是达到这个期限了才能去兑换。巡检其实你可以每一周巡检一次就好了，
 *     你只要记住它当前签到日期，然后自己后台静默记住下次预计是什么时候这个号可以领
 *     对等的奖励，自己去领，领了兑换。」
 *
 * 设计要点：
 *   1. **不是每天兑，是「到档了才兑」**。三档门槛 7 / 14 / 28 天，且每档每月只能领一次
 *      （服务端 `redemption_status.tier_Nd_status` 只有 available/locked/claimed 三态）。
 *   2. **每周巡检一次**就够了：`intervalMinutes` 默认 7*24*60，用 `nextCheckAt` 控制。
 *      但为了不让「第 7 天达标」等到下周才发现，另外记 `nextEligibleAt`：
 *      按当前连续天数推算再攒几天能到下一档，到那天之后的第一次巡检就优先处理。
 *   3. **静默记住状态**：store.rt.streakRedeem = { [accId]: { days, nextEligibleAt, lastRedeemAt, tiers, lastCheckAt } }
 *   4. 兑换成功拿到的**抽奖机会立刻抽掉**（用户明确要求「抽奖，领取这个 7 天奖励就要抽了」）。
 *   5. 补登卡：有卡 + 本月有漏签 → 自动补最近一次（用户要求「补登卡用在最近一次漏签」）。
 *
 * 注意：本模块**只碰 /activity/growth/* 接口**，不涉及桌面端埋点，因此能纯 API 跑通。
 */

const STREAK = '/activity/growth/streak';
const REDEEM = '/activity/growth/redeem';
const REDEEM_SUMMARY = '/activity/growth/redeem/summary';
const LOTTERY_SUMMARY = '/activity/growth/lottery/summary';
const LOTTERY_DRAW = '/activity/growth/lottery/draw';
const MAKEUP_USE = '/activity/growth/makeup-cards/use';
const HEATMAP = '/activity/growth/heatmap';

const TIERS = [
  { tier: '7d', days: 7 },
  { tier: '14d', days: 14 },
  { tier: '28d', days: 28 },
];

function uuid() {
  return require('crypto').randomUUID();
}

class StreakRedeem {
  /**
   * 注意参数形态：调度器的 `loadModule()` 固定用 `new Ctor(store, accounts)`，
   * 所以第三个参数 wb 是可选的 —— 不传时模块内部自己 require，
   * 既兼容调度器，也方便单测时注入假的 wb。
   */
  constructor(store, accounts, wb) {
    this.store = store;
    this.accounts = accounts;
    this.wb = wb || require('./wb');
    this._running = false;
  }

  get cfg() {
    const c = (this.store.data.settings && this.store.data.settings.streakRedeem) || {};
    return {
      enabled: c.enabled !== false,
      intervalMinutes: Math.max(60, Number(c.intervalMinutes) || 7 * 24 * 60),
      autoLottery: c.autoLottery !== false,
      autoMakeup: c.autoMakeup !== false,
    };
  }

  get rt() {
    if (!this.store.data.runtime) this.store.data.runtime = {};
    if (!this.store.data.runtime.streakRedeem) this.store.data.runtime.streakRedeem = {};
    return this.store.data.runtime.streakRedeem;
  }

  /** 本轮是否到期该跑（每周一次，或某账号的 nextEligibleAt 已到） */
  isDue() {
    const st = this.rt;
    const now = Date.now();
    if (!st._lastCheckAt) return true;
    const interval = this.cfg.intervalMinutes * 60000;
    if (now - st._lastCheckAt >= interval) return true;
    // 有账号已经到「下次可兑日」，提前跑一次（不必等满一周）
    for (const id of Object.keys(st)) {
      if (id.startsWith('_')) continue;
      const rec = st[id];
      if (rec && rec.nextEligibleAt && now >= rec.nextEligibleAt) return true;
    }
    return false;
  }

  nextIn() {
    const st = this.rt;
    if (!st._lastCheckAt) return 0;
    const interval = this.cfg.intervalMinutes * 60000;
    const left = st._lastCheckAt + interval - Date.now();
    return left > 0 ? left : 0;
  }

  /**
   * 推算「下次有可能兑换」的时刻。
   * 连续天数已知、每天 +1，所以距离下一档还差 N 天 → 约 N 天后。
   * @returns {number} 毫秒时间戳；null = 本月该档已领满，等跨月
   */
  computeNextEligible(days, tierStatus) {
    const now = Date.now();
    // 先看有没有「当前已达门槛但还没领」的档
    for (const t of TIERS) {
      const st = (tierStatus && tierStatus[t.tier] && tierStatus[t.tier].status) || 'locked';
      if (st === 'available') return now;              // 现在就能领
    }
    // 找下一个还没达标的档
    for (const t of TIERS) {
      const st = (tierStatus && tierStatus[t.tier] && tierStatus[t.tier].status) || 'locked';
      if (st === 'locked') {
        const need = Math.max(1, t.days - days);
        return now + need * 86400000;
      }
    }
    return null; // 三档都 claimed → 等跨月重置
  }

  /** 处理单个账号 */
  async handleAccount(acc) {
    const out = { id: acc.id, name: acc.nickname || acc.uid, actions: [], errors: [] };

    // 1) 读连续签到状态
    let s;
    try {
      s = await this.wb.streakStatus(acc);
    } catch (err) {
      out.errors.push('streak: ' + err.message);
      return out;
    }
    if (!s || !s.ok) {
      out.errors.push('streak: 返回异常');
      return out;
    }

    const tierStatus = s.tierStatus || {};
    const prev = this.rt[acc.id] || {};

    // 2) 先补登：有卡 + 本月有漏签 → 补最近一次
    if (this.cfg.autoMakeup && s.makeupCards > 0) {
      try {
        const gap = await this.findLatestGap(acc);
        if (gap) {
          const r = await this.wb.useMakeupCard(acc, gap);
          if (r.ok) {
            out.actions.push(`补登 ${gap}（剩卡 ${r.newBalance}）`);
            // 补登后连续天数会变，重读
            s = await this.wb.streakStatus(acc).catch(() => s);
          } else {
            out.errors.push(`补登 ${gap}: ${r.msg || 'failed'}`);
          }
        }
      } catch (err) {
        out.errors.push('makeup: ' + err.message);
      }
    }

    // 3) 逐档兑换（只兑 available）
    const granted = { credit: 0, energy: 0, cards: 0, chances: 0 };
    for (const t of TIERS) {
      const st = (tierStatus[t.tier] && tierStatus[t.tier].status) || 'locked';
      if (st !== 'available') continue;
      try {
        const r = await this.wb.redeemTier(acc, t.tier);
        if (r.ok) {
          granted.credit += r.creditGranted;
          granted.energy += r.energyGranted;
          granted.cards += r.cardsGranted;
          granted.chances += r.chancesGranted;
          out.actions.push(
            `兑换 ${t.tier}: +${r.creditGranted}积分 +${r.energyGranted}能量 ` +
            `+${r.cardsGranted}补登卡 +${r.chancesGranted}抽奖`
          );
          // 兑换后该档变 claimed，本地状态同步
          tierStatus[t.tier] = { status: 'claimed' };
        } else if (r.idempotent) {
          tierStatus[t.tier] = { status: 'claimed' };
          out.actions.push(`兑换 ${t.tier}: 幂等命中（此前已领）`);
        } else if (r.alreadyClaimed) {
          tierStatus[t.tier] = { status: 'claimed' };
        } else if (r.streakNotEnough) {
          // 天数不够，保持 locked
        } else {
          out.errors.push(`兑换 ${t.tier}: ${r.msg || 'failed'}`);
        }
      } catch (err) {
        out.errors.push(`兑换 ${t.tier}: ${err.message}`);
      }
    }

    // 4) 抽奖：把手上所有机会抽掉（含兑换新得的）
    if (this.cfg.autoLottery) {
      try {
        const ls = await this.wb.lotterySummary(acc);
        const chances = (ls && ls.chances) || 0;
        if (chances > 0 && ls.moduleEnabled !== false) {
          for (let i = 0; i < chances; i++) {
            const r = await this.wb.lotteryDraw(acc);
            if (r.ok) {
              out.actions.push(`抽奖: ${r.prizeName || r.prizeCode}` + (r.creditAmount ? ` (+${r.creditAmount}积分)` : ''));
              granted.credit += r.creditAmount || 0;
            } else {
              out.errors.push('抽奖: ' + (r.msg || 'failed'));
              break;
            }
          }
        }
      } catch (err) {
        out.errors.push('lottery: ' + err.message);
      }
    }

    // 5) 记住状态（静默，跨重启保留）
    const nextEligibleAt = this.computeNextEligible(s.days, tierStatus);
    this.rt[acc.id] = {
      name: out.name,
      days: s.days,
      monthTotalDays: s.monthTotalDays,
      nextEligibleAt,
      tiers: Object.keys(tierStatus).reduce((o, k) => {
        o[k] = (tierStatus[k] && tierStatus[k].status) || 'locked';
        return o;
      }, {}),
      lastCheckAt: Date.now(),
      lastGranted: granted,
    };
    if (granted.credit || granted.energy || granted.cards || granted.chances) {
      this.rt[acc.id].lastRedeemAt = Date.now();
    }
    return out;
  }

  /** 找本月最近一次「漏签（未活跃）且早于今天」的日期 */
  async findLatestGap(acc) {
    const r = await this.wb.rawRequest(acc, 'GET', HEATMAP, undefined, {});
    const body = r.json || {};
    const d = (body && body.data) || {};
    const cells = Array.isArray(d.cells) ? d.cells : [];
    const today = (d.today && d.today.date) || '';
    if (!today) return null;
    const month = today.slice(0, 7);
    const gaps = cells
      .filter((c) => String(c.date || '').startsWith(month) && c.date < today && (!c.score || c.score === 0))
      .map((c) => c.date)
      .sort()
      .reverse();
    return gaps[0] || null;
  }

  /** 每周巡检入口 */
  async runOnce(opts = {}) {
    const o = opts || {};
    if (this._running) return { ok: false, busy: true, reason: '上一轮兑换巡检尚未结束' };
    if (!this.cfg.enabled) return { ok: false, skipped: true, reason: '兑换巡检已关闭' };
    if (!o.force && !this.isDue()) {
      return { ok: true, skipped: true, reason: '未到巡检时间', nextIn: this.nextIn() };
    }

    this._running = true;
    try {
      const list = (this.accounts.usable ? this.accounts.usable() : [])
        .filter((a) => !(this.accounts.isEarningPaused && this.accounts.isEarningPaused(a)));
      const results = [];
      for (const acc of list) {
        try {
          results.push(await this.handleAccount(acc));
        } catch (err) {
          results.push({ id: acc.id, name: acc.nickname || acc.uid, actions: [], errors: [err.message] });
        }
      }

      const totalActions = results.reduce((n, r) => n + r.actions.length, 0);
      const totalErrors = results.reduce((n, r) => n + r.errors.length, 0);
      this.rt._lastCheckAt = Date.now();
      this.rt._lastResult = `${totalActions} 个动作 / ${totalErrors} 个错误`;
      this.store.touch();

      if (totalActions) {
        const detail = results
          .filter((r) => r.actions.length)
          .map((r) => `${r.name}: ${r.actions.join('、')}`)
          .join(' | ');
        this.store.log('info', `签到里程碑兑换：${detail}`);
      }
      if (totalErrors) {
        const detail = results
          .filter((r) => r.errors.length)
          .map((r) => `${r.name}: ${r.errors.join('、')}`)
          .join(' | ');
        this.store.log('warn', `签到里程碑兑换部分失败：${detail}`);
      }

      return {
        ok: true,
        at: this.rt._lastCheckAt,
        actions: totalActions,
        errors: totalErrors,
        nextIn: this.nextIn(),
        results,
      };
    } finally {
      this._running = false;
    }
  }

  /** 面板展示用 */
  summary() {
    const st = this.rt;
    const rows = [];
    const now = Date.now();
    for (const id of Object.keys(st)) {
      if (id.startsWith('_')) continue;
      const r = st[id];
      if (!r) continue;
      rows.push({
        id,
        name: r.name || '',
        days: r.days || 0,
        tiers: r.tiers || {},
        nextEligibleAt: r.nextEligibleAt || null,
        nextEligibleIn: r.nextEligibleAt ? Math.max(0, r.nextEligibleAt - now) : null,
        lastRedeemAt: r.lastRedeemAt || 0,
        lastGranted: r.lastGranted || null,
      });
    }
    return {
      enabled: this.cfg.enabled,
      intervalMinutes: this.cfg.intervalMinutes,
      lastCheckAt: st._lastCheckAt || 0,
      lastResult: st._lastResult || '',
      nextIn: this.nextIn(),
      rows,
    };
  }
}

module.exports = { StreakRedeem, STREAK_TIERS: TIERS };
