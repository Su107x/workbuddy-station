'use strict';
/**
 * 小喵（Buddy 旅行）业务层。
 *
 * 一句话流程：
 *   空闲(idle) → 选地点 → 派出(depart) → 旅途中(traveling) → 到达(arrived) → 领取(claim) → 回到空闲
 *
 * 设计要点（都来自官方成长中心的真实行为）：
 *   1. 一天只能派一次。上游用 HTTP 429 或 msg 含 "daily limit" 拒绝，这等价于「猫猫今天累啦」。
 *      收到就写当天的熔断标记，当天不再发起任何请求。
 *   2. 到达时间是服务端给的绝对 Unix 秒（arrive_at），同时给 server_now 用于校正本机时钟偏差，
 *      所以不要用「本地时间 + 时长」推算，直接用 arrive_at 减 server_now 的差值。
 *   3. 领奖必须等真的到达，早调会返回 "not arrived yet" / "no unclaimed travel"，
 *      这属于正常状态而非故障，不记错误。
 *   4. 每个账号的状态单独存，互不影响。
 */

const wb = require('./wb');

function todayKey(d) {
  const t = d ? new Date(d) : new Date();
  return t.toLocaleDateString('sv-SE');
}

function stateOf(acc) {
  if (!acc.meow) {
    acc.meow = {
      state: 'idle',
      locationId: '',
      locationName: '',
      departAt: 0,
      arriveAt: 0,
      serverOffsetMs: 0,
      lastRunAt: 0,
      lastClaimAt: 0,
      lastReward: 0,
      dailyLimitDate: '',
      error: '',
      errorAt: 0,
      note: '',
      letters: [],
    };
  }
  return acc.meow;
}

class Meow {
  constructor(store, accounts) {
    this.store = store;
    this.accounts = accounts;
  }

  get cfg() {
    return this.store.data.settings.meow;
  }

  /** 对外展示用：把账号里的旅行状态整理成前端直接可渲染的结构 */
  view(acc) {
    const m = stateOf(acc);
    const offset = Number(m.serverOffsetMs) || 0;
    const now = Date.now() + offset;
    const arriveMs = Number(m.arriveAt) ? Number(m.arriveAt) * 1000 : 0;
    const departMs = Number(m.departAt) ? Number(m.departAt) * 1000 : 0;
    const remainingMs = arriveMs ? Math.max(0, arriveMs - now) : 0;
    // 到点后本地会先切成 arrived，避免要等到下一次轮询才显示可领取
    const effective = m.state === 'traveling' && arriveMs && remainingMs === 0 ? 'arrived' : m.state;
    return {
      id: acc.id,
      nickname: acc.nickname,
      enabled: acc.enabled,
      hasCredential: Boolean(acc.token || acc.cookie),
      state: effective,
      locationId: m.locationId || '',
      locationName: m.locationName || '',
      departAt: m.departAt || 0,
      arriveAt: m.arriveAt || 0,
      remainingMs,
      lastRunAt: m.lastRunAt || 0,
      lastClaimAt: m.lastClaimAt || 0,
      lastReward: m.lastReward || 0,
      dailyLimitToday: m.dailyLimitDate === todayKey(),
      error: m.error || '',
      errorAt: m.errorAt || 0,
      note: m.note || '',
      letters: Array.isArray(m.letters) ? m.letters.slice(0, 20) : [],
    };
  }

  list() {
    return this.accounts.raw.map((a) => this.view(a));
  }

  summary() {
    const rows = this.list();
    const active = rows.filter((r) => r.enabled && r.hasCredential);
    return {
      total: rows.length,
      usable: active.length,
      traveling: active.filter((r) => r.state === 'traveling').length,
      arrived: active.filter((r) => r.state === 'arrived').length,
      todayClaimed: active.filter((r) => r.lastClaimAt && todayKey(r.lastClaimAt) === todayKey()).length,
      todayReward: active.reduce((s, r) => s + (r.lastClaimAt && todayKey(r.lastClaimAt) === todayKey() ? r.lastReward || 0 : 0), 0),
      limitReached: active.filter((r) => r.dailyLimitToday).length,
    };
  }

  pick(id) {
    const acc = this.accounts.find(id);
    if (!acc) {
      const e = new Error('账号不存在');
      e.statusCode = 404;
      throw e;
    }
    if (!acc.token && !acc.cookie) {
      const e = new Error('该账号没有可用凭证，请先补访问令牌或 Cookie');
      e.statusCode = 400;
      throw e;
    }
    return acc;
  }

  /** 把上游状态同步进账号记录 */
  apply(acc, st) {
    const m = stateOf(acc);
    m.state = st.state || 'idle';
    m.departAt = st.departAt || 0;
    m.arriveAt = st.arriveAt || 0;
    m.serverOffsetMs = st.serverOffsetMs || 0;
    if (st.location) {
      const lid = st.location.id;
      if (lid !== null && lid !== undefined && lid !== '') m.locationId = lid;
      m.locationName = st.location.name || m.locationName;
    }
    if (m.state === 'idle') {
      m.locationId = '';
      m.locationName = '';
      m.departAt = 0;
      m.arriveAt = 0;
    }
    if (st.dailyLimitReached) m.dailyLimitDate = todayKey();
    m.error = '';
    m.errorAt = 0;
    this.store.touch();
    return this.view(acc);
  }

  markError(acc, err) {
    const m = stateOf(acc);
    const code = err.travelCode || wb.classifyTravelError(err.message, err.status);
    m.error = err.message || String(err);
    m.errorAt = Date.now();
    if (code === 'LIMIT') {
      m.dailyLimitDate = todayKey();
      m.note = '今日已达上限，明天再来';
    }
    if (code === 'AUTH') this.accounts.setError(acc, '凭证失效，旅行接口鉴权失败');
    this.store.touch();
    return code;
  }

  /** 拉一次远端真实状态 */
  async sync(id) {
    const acc = this.pick(id);
    const m = stateOf(acc);
    m.lastRunAt = Date.now();
    try {
      const st = await wb.travelStatus(acc);
      return { ok: true, travel: this.apply(acc, st) };
    } catch (err) {
      const code = this.markError(acc, err);
      return { ok: false, code, error: err.message, travel: this.view(acc) };
    }
  }

  /** 地点配置（含策略推荐） */
  async config(id) {
    const acc = this.pick(id);
    try {
      const c = await wb.travelConfig(acc);
      return { ok: true, ...c, recommended: this.recommend(c.locations) };
    } catch (err) {
      const code = this.markError(acc, err);
      return { ok: false, code, error: err.message, enabled: false, locations: [], recommended: '' };
    }
  }

  /**
   * 按策略选地点。
   *   longest  时长最长（一趟拿得久，适合一天一次的场景）
   *   shortest 时长最短（最快能到达并领取，巡检间隔大时更稳）
   *   rotate   轮换（每次换一个，避免审美疲劳）
   *   fixed    用配置里指定的 locationId
   */
  recommend(locations, strategy, fixedId) {
    if (!locations || !locations.length) return '';
    const s = strategy || this.cfg.strategy || 'shortest';
    if (s === 'fixed') {
      // 固定地点 id 允许填数字 id 或 code，比较时统一按字符串比对
      const want = String(fixedId || this.cfg.fixedLocationId || '').trim();
      if (want) {
        const hit = locations.find((l) => String(l.id) === want || (l.code && String(l.code) === want));
        if (hit) return hit.id;
      }
      // 配置里的 id 对不上就退回自动选，避免整个流程卡死
    }
    if (s === 'rotate') {
      const idx = Number(this.store.data.settings.meow.rotateIndex || 0) % locations.length;
      this.store.data.settings.meow.rotateIndex = (idx + 1) % locations.length;
      this.store.touch();
      return locations[idx].id;
    }
    const withDur = locations.filter((l) => typeof l.durationMin === 'number' && l.durationMin > 0);
    if (!withDur.length) return locations[0].id;
    withDur.sort((a, b) => (s === 'longest' ? b.durationMin - a.durationMin : a.durationMin - b.durationMin));
    return withDur[0].id;
  }

  /** 派出旅行。locationId 不传则按策略自动选 */
  async depart(id, opts) {
    const acc = this.pick(id);
    const m = stateOf(acc);
    if (m.dailyLimitDate === todayKey()) {
      return { ok: false, code: 'LIMIT', error: '今日已达上限，明天再来', travel: this.view(acc) };
    }
    let locationId = (opts && opts.locationId) || '';
    let locationName = '';
    if (!locationId) {
      const cfgOut = await this.config(id);
      if (!cfgOut.ok) return { ok: false, code: cfgOut.code, error: cfgOut.error, travel: this.view(acc) };
      if (!cfgOut.locations.length) {
        return { ok: false, code: 'DISABLED', error: '成长中心没有开放可选地点，可能活动未开启', travel: this.view(acc) };
      }
      locationId = this.recommend(cfgOut.locations, opts && opts.strategy);
      const hit = cfgOut.locations.find((l) => String(l.id) === String(locationId));
      locationName = hit ? hit.name : '';
    }
    m.lastRunAt = Date.now();
    try {
      const st = await wb.travelDepart(acc, locationId);
      if (locationName) st.location = st.location || { id: locationId, name: locationName };
      // ★ note 要在 apply 之前写：apply() 返回的是状态快照，顺序反了返回对象里会带着
      //   上一次的旧 note（比如「还没有 Buddy，先去开盲盒」），界面上看着像失败。
      m.note = `已派出：${locationName || locationId}`;
      m.error = '';
      m.errorAt = 0;
      const travel = this.apply(acc, st);
      this.store.bumpStat(todayKey(), 'meow', 1);
      this.store.log('info', `小喵出发 ${acc.nickname} → ${travel.locationName || locationId}`);
      return { ok: true, travel, locationId };
    } catch (err) {
      const code = this.markError(acc, err);
      if (code === 'ALREADY_TRAVELING') {
        const r = await this.sync(id);
        return { ok: false, code, error: '已经在旅行中，已刷新状态', travel: r.travel };
      }
      if (code === 'NO_BUDDY') m.note = '还没有 Buddy，先去开盲盒';
      return { ok: false, code, error: err.message, travel: this.view(acc) };
    }
  }

  /** 领取旅行奖励 */
  async claim(id) {
    const acc = this.pick(id);
    const m = stateOf(acc);
    try {
      const r = await wb.travelClaim(acc);
      m.state = 'idle';
      m.departAt = 0;
      m.arriveAt = 0;
      m.locationId = '';
      m.locationName = '';
      m.lastClaimAt = Date.now();
      m.lastReward = r.rewardCredit || 0;
      m.error = '';
      m.errorAt = 0;
      m.note = r.rewardCredit ? `领取 +${r.rewardCredit} 积分` : '已领取';
      if (r.letter) {
        m.letters = [{ at: Date.now(), letter: r.letter }, ...(m.letters || [])].slice(0, 20);
      }
      this.store.bumpStat(todayKey(), 'meowClaim', 1);
      this.store.bumpStat(todayKey(), 'credits', r.rewardCredit || 0);
      this.store.log('info', `小喵领取 ${acc.nickname}：+${r.rewardCredit || 0}`);
      this.store.touch();
      // 领到积分顺手刷新额度，页面上的积分数字不会滞后
      if (this.cfg.autoCollect) {
        try { await this.accounts.refreshAll(); } catch (_) { /* 刷新失败不影响领取结果 */ }
      }
      return { ok: true, rewardCredit: r.rewardCredit, letter: r.letter, travel: this.view(acc) };
    } catch (err) {
      const code = this.markError(acc, err);
      if (code === 'NOT_ARRIVED') {
        m.error = '';
        m.errorAt = 0;
        m.note = '还没到达，继续等';
        this.store.touch();
        return { ok: false, code, error: '还没到达，稍后再试', travel: this.view(acc) };
      }
      return { ok: false, code, error: err.message, travel: this.view(acc) };
    }
  }

  /**
   * 一步到位：先看状态，能领就领，空着就派，旅行中什么都不做。
   * 这是定时巡检和「一键托管」共用的入口。
   *
   * 顺序很重要：
   *   1. 先查远端状态 —— 领取不受「一天一次」限制，必须先判；
   *   2. 到点了就领（哪怕今天已经派过一次）；
   *   3. 还在路上就等；
   *   4. 只有「空闲且要派出」这一步才检查每日上限。
   * 之前把每日上限检查放在最前面，导致猫回来了也永远领不到积分。
   *
   * opts.autoDepart === false 时只领不派（自动领取独立于自动派出）。
   */
  async runOnce(id, opts) {
    const acc = this.pick(id);
    const m = stateOf(acc);
    m.lastRunAt = Date.now();
    let st;
    try {
      st = await wb.travelStatus(acc);
    } catch (err) {
      const code = this.markError(acc, err);
      return { ok: false, action: 'error', code, error: err.message, travel: this.view(acc) };
    }
    const travel = this.apply(acc, st);

    // 1) 到点了 → 领取（不看每日上限）
    const arrived = st.state === 'arrived'
      || (st.state === 'traveling' && st.arriveAt && (st.arriveAt * 1000 + st.serverOffsetMs) <= Date.now());
    if (arrived) {
      const r = await this.claim(id);
      return { ...r, action: r.ok ? 'claimed' : 'claim-failed', travel: r.travel };
    }
    // 2) 还在路上 → 等
    if (st.state === 'traveling') {
      return { ok: true, action: 'waiting', note: '旅行中', travel };
    }
    // 3) 空闲 → 先看是不是「只领不派」模式，再检查每日上限
    if (opts && opts.autoDepart === false) {
      return { ok: true, action: 'idle-only', note: '空闲（未开启自动派出）', travel };
    }
    if (m.dailyLimitDate === todayKey() && !(opts && opts.force)) {
      return { ok: true, action: 'skip-limit', note: '今日已达上限', travel };
    }
    if (st.dailyLimitReached) {
      return { ok: true, action: 'skip-limit', note: '上游标记今日已达上限', travel };
    }
    // 4) 空闲且允许派出 → 出发
    const r = await this.depart(id, opts);
    return { ...r, action: r.ok ? 'departed' : 'depart-failed', travel: r.travel };
  }

  /** 全部账号跑一遍 */
  async runAll(opts) {
    const pool = this.accounts.raw.filter((a) => a.enabled && (a.token || a.cookie));
    const out = [];
    for (const acc of pool) {
      try {
        out.push({ id: acc.id, nickname: acc.nickname, ...(await this.runOnce(acc.id, opts)) });
      } catch (err) {
        out.push({ id: acc.id, nickname: acc.nickname, ok: false, action: 'error', error: err.message });
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    return out;
  }

  /** 旅行记录（直通上游分页） */
  async records(id, page, size) {
    const acc = this.pick(id);
    try {
      return { ok: true, ...(await wb.travelRecords(acc, page, size)) };
    } catch (err) {
      return { ok: false, code: this.markError(acc, err), error: err.message, list: [], total: 0, totalPage: 1 };
    }
  }

  /** Buddy 信息 */
  async buddy(id) {
    const acc = this.pick(id);
    try {
      return { ok: true, ...(await wb.buddyInfo(acc)) };
    } catch (err) {
      return { ok: false, code: this.markError(acc, err), error: err.message, current: null };
    }
  }
}

module.exports = { Meow, todayKey, stateOf };
