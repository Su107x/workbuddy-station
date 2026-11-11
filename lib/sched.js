'use strict';
/**
 * 定时任务引擎：自动签到、额度定时刷新、小喵巡检、成长任务、保活续期、积分刷新。
 * 单进程内置定时器，无需 crontab；所有任务状态落库，重启不丢当天进度。
 */
const crypto = require('crypto');
const wb = require('./wb');
const { todayKey } = require('./accounts');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 错峰等待的硬上限：单次 tick 内所有账号等待加起来最多这么久。
 * tick 有 running 互斥，等待全部串在 tick 总时长里，不设上限的话
 * 「max=600 秒 × N 个账号」能把调度器憋住半小时。超出预算就直接跳过剩余等待。
 */
const PACE_BUDGET_MS = 180000;

/**
 * 错峰预算的分配方式（2026-10-30 改）。
 *
 * 原实现：总预算 180 秒，谁先等谁吃光。4 个账号（3 个间隔）+ 配置 60~240 秒时，
 * 实际变成「等 150s、等 30s、不等」—— 用户设的上限 240 秒根本兑现不了，
 * 而且后两个账号几乎同时打上游，错峰等于没做。
 *
 * 改成**按间隔均分**：每个间隔分到 预算 / 间隔数，落在 [min, max] 区间内随机。
 * 间隔数 = max(0, 账号数 - 1)。这样配置的上下限都真实生效，
 * 且账号之间一定拉开距离（哪怕预算不够，也按比例给每个间隔留一份）。
 */
function paceBudgetFor(gaps) {
  if (gaps <= 0) return 0;
  // 每份至少给 1 秒，否则间隔数一多就全被截成 0
  return Math.max(1000, Math.floor(PACE_BUDGET_MS / gaps));
}

/** 取整并夹到 [lo, hi] 区间，脏配置不至于算出荒唐的等待时长 */
function clampInt(v, lo, hi, def) {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, Math.round(n)));
}

class Scheduler {
  constructor(store, accounts, meow, growthTasks, services) {
    this.store = store;
    this.accounts = accounts;
    this.meow = meow || null;
    this.growth = growthTasks || null;
    this.timer = null;
    this.lastTick = 0;
    this.running = false;
    // credits / keepalive 实例：优先用外部注入的（和 server.js 里的路由共用同一个实例，
    // 免得各自一份重入锁），没有才在 loadModule 里延迟 require 自己造一个
    this._injected = services || {};
    this._modules = {};
    this._moduleWarnAt = {};
    // 本轮 tick 已经花掉的错峰等待时长（毫秒），每次 tick 开头清零
    this._paceUsedMs = 0;
    this._paceBudgetMs = PACE_BUDGET_MS;
  }

  /** 外部补注服务实例：scheduler.attachServices({ credits, keepalive }) */
  attachServices(services) {
    if (!services) return;
    for (const k of Object.keys(services)) {
      if (services[k]) this._injected[k] = services[k];
    }
  }

  get rt() {
    const d = this.store.data;
    if (!d.runtime) d.runtime = {};
    return d.runtime;
  }

  get cfg() {
    return this.store.data.settings;
  }

  /* ================= 错峰 =================
   * settings.schedule = {
   *   randomDelayMinutes:      0~60   同类任务每天开始时刻的随机偏移上限（分钟）
   *   accountDelayMinSeconds:  0~600  同批处理中账号之间的随机等待下限（秒）
   *   accountDelayMaxSeconds:  0~600  同批处理中账号之间的随机等待上限（秒）
   * }
   * 三项都为 0 时保持原行为：到点即跑、账号之间不额外等待。
   */
  get schedule() {
    const s = (this.cfg && this.cfg.schedule) || {};
    const randomDelayMinutes = clampInt(s.randomDelayMinutes, 0, 60, 0);
    let min = clampInt(s.accountDelayMinSeconds, 0, 600, 0);
    let max = clampInt(s.accountDelayMaxSeconds, 0, 600, 0);
    if (min > max) { const t = min; min = max; max = t; } // 填反了自动纠正，min ≤ max
    return { randomDelayMinutes, accountDelayMinSeconds: min, accountDelayMaxSeconds: max };
  }

  /**
   * 部署标识：优先用 settings.schedule.deployId 手工指定，
   * 否则首次生成一个随机值写进 runtime，之后一直复用（重启不变）。
   * 多台机器各自部署时才需要手填，避免同一天算出同一个偏移量。
   */
  deployId() {
    const s = (this.cfg && this.cfg.schedule) || {};
    if (s.deployId) return String(s.deployId);
    const rt = this.rt;
    if (!rt.deployId) {
      rt.deployId = crypto.randomBytes(6).toString('hex');
      this.store.touch();
    }
    return rt.deployId;
  }

  /**
   * 稳定哈希偏移：同一天 + 同一任务 + 同一配置时刻 + 同一部署标识 → 同一个偏移秒数。
   * 只用日期/任务类型/配置小时/部署标识做输入，不用 Math.random 直接出结果，
   * 所以同日重启、崩溃恢复都不会重抽（重启后算出来还是那个时刻）。
   */
  offsetSeconds(taskType, hh, mm) {
    const s = this.schedule;
    if (!s.randomDelayMinutes) return 0;
    const seed = [todayKey(), taskType, `${hh}:${mm}`, this.deployId()].join('|');
    const n = crypto.createHash('sha1').update(seed).digest().readUInt32BE(0);
    return n % (s.randomDelayMinutes * 60 + 1); // 0 ~ N*60 秒
  }

  /**
   * 每日一次的任务此刻是否已到点（已含错峰偏移）。
   * @returns {{due: boolean, targetAt: number}}
   */
  dailyTarget(taskType, timeStr) {
    const [hh, mm] = String(timeStr || '08:30').split(':').map(Number);
    const now = new Date();
    const target = new Date(now);
    target.setHours(hh || 0, mm || 0, 0, 0);
    target.setTime(target.getTime() + this.offsetSeconds(taskType, hh || 0, mm || 0) * 1000);
    return { due: now.getTime() >= target.getTime(), targetAt: target.getTime() };
  }

  /**
   * 账号之间的随机等待；两项都为 0（或只有一个账号）时立即返回，不改变旧行为。
   * 带预算保护：单次 tick 的累计等待不超过 _paceBudgetMs（默认 180 秒），
   * 预算耗尽后剩余账号不再等待，只跳过等待、不跳过账号本身。
   *
   * @param {number} index 当前账号下标（0 = 第一个，不等）
   * @param {number} [total] 本批账号总数。给定时按「间隔均分」预算，
   *   避免第一个间隔把预算吃光、后面的账号间隔归零（2026-10-30 实测过这个坑）。
   */
  async paceAccount(index, total) {
    if (index <= 0) return;
    const s = this.schedule;
    if (!s.accountDelayMaxSeconds) return;
    const left = this._paceBudgetMs - this._paceUsedMs;
    if (left <= 0) return;
    const lo = s.accountDelayMinSeconds;
    const hi = s.accountDelayMaxSeconds;
    // 均分预算：gaps = 从本次起还剩几个间隔（含本次）
    const gaps = Math.max(1, (Number(total) || 0) - index);
    const share = paceBudgetFor(gaps);
    let ms = Math.round((lo + Math.random() * Math.max(0, hi - lo)) * 1000);
    // 单次不超过自己那一份，也不越过剩余总预算
    const cap = Math.min(share, left);
    if (ms > cap) ms = cap;
    if (ms <= 0) return;
    this._paceUsedMs += ms;
    await sleep(ms);
  }

  /** 延迟加载队友模块：文件可能还没落地，缺失只告警跳过，绝不让 tick 崩掉 */
  loadModule(name, file, cls, label) {
    if (this._modules[name]) return this._modules[name];
    if (this._injected[name]) return this._injected[name]; // 外部已注入，直接复用
    try {
      const mod = require(file);
      const Ctor = mod && mod[cls];
      if (typeof Ctor !== 'function') throw new Error(`未导出 ${cls}`);
      const inst = new Ctor(this.store, this.accounts);
      this._modules[name] = inst;
      return inst;
    } catch (err) {
      // 同一模块每小时最多告警一次，避免每 30 秒刷屏
      const now = Date.now();
      if (now - (this._moduleWarnAt[name] || 0) > 3600000) {
        this._moduleWarnAt[name] = now;
        this.store.log('warn', `${label || name}模块暂不可用，已跳过：${err.message}`);
      }
      return null;
    }
  }

  /** 单个子任务异常隔离：报错只记日志，不拖垮整个 tick */
  async safeRun(name, fn) {
    try {
      await fn();
    } catch (err) {
      this.store.log('warn', `${name}调度异常：${err.message}`);
    }
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick().catch(() => {}), 30000);
    this.timer.unref?.();
    this.tick().catch(() => {});
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status() {
    const rt = this.rt;
    return {
      lastCheckinDate: rt.lastCheckinDate || '',
      lastCheckinAt: rt.lastCheckinAt || 0,
      lastCheckinResult: rt.lastCheckinResult || '',
      lastQuotaAt: rt.lastQuotaAt || 0,
      lastMeowAt: rt.lastMeowAt || 0,
      lastGrowthAt: rt.lastGrowthAt || 0,
      lastGrowthResult: rt.lastGrowthResult || '',
      growthNextIn: this.growthNextIn(),
      // 保活 / 积分
      lastKeepAliveAt: rt.lastKeepAliveAt || 0,
      lastKeepAliveResult: rt.lastKeepAliveResult || '',
      keepaliveNextIn: this.keepaliveNextIn(),
      lastCreditsAt: rt.lastCreditsAt || 0,
      lastCreditsResult: rt.lastCreditsResult || '',
      creditsNextIn: this.creditsNextIn(),
      // 错峰：当前部署今天给签到任务算出的偏移秒数（重启不变）
      scheduleOffsetSeconds: this.checkinOffsetSeconds(),
      meowState: rt.meowState || 'idle',
      meowNote: rt.meowNote || '',
      meowBreakerDate: rt.meowBreakerDate || '',
      meowNextIn: this.meowNextIn(),
      nextCheckinIn: this.secondsToCheckin(),
    };
  }

  /** 签到任务当天的错峰偏移（秒），供状态展示用 */
  checkinOffsetSeconds() {
    const [hh, mm] = String((this.cfg.checkin && this.cfg.checkin.time) || '08:30').split(':').map(Number);
    return this.offsetSeconds('checkin', hh || 0, mm || 0);
  }

  secondsToCheckin() {
    // 错峰：倒计时按「配置时刻 + 当天稳定偏移」算，与实际触发时刻一致
    const { targetAt } = this.dailyTarget('checkin', (this.cfg.checkin && this.cfg.checkin.time) || '08:30');
    let diff = (targetAt - Date.now()) / 1000;
    if (diff < 0) diff += 86400;
    return Math.round(diff);
  }

  /**
   * 授权闸门：授权无效时，所有定时任务（签到/成长/保活/积分/小喵）一律不跑。
   *
   * 为什么必须在 tick 开头拦：
   *   这些任务是**服务端定时器**驱动的，跟"用户有没有在用"无关。
   *   授权到期后如果不拦，后台仍会持续用买家的账号打上游接口 ——
   *   既违背授权约定，也会让买家以为"到期了还能继续用"。
   *
   * @returns {Promise<{ok:boolean, reason:string}>}
   */
  async checkLicence() {
    const core = this.proxy && this.proxy.core;
    if (!core || !core.enabled()) {
      // 自用模式（没配 coreUrl）：不设门禁，行为与以前一致
      return { ok: true, reason: 'no_core_configured' };
    }
    const st = await core.licenceStatus().catch(() => null);
    if (st && st.valid) return { ok: true, reason: '' };
    return { ok: false, reason: (st && st.reason) || 'invalid' };
  }

  async tick() {
    if (this.running) return;
    this.running = true;
    const t0 = Date.now();
    this._paceUsedMs = 0; // 每轮 tick 重置错峰等待预算

    // 授权闸门：无效则整轮跳过，一个任务都不跑
    try {
      const lic = await this.checkLicence();
      if (!lic.ok) {
        this.lastLicenceBlock = { at: Date.now(), reason: lic.reason };
        if (!this._licWarnedAt || Date.now() - this._licWarnedAt > 600000) {
          this._licWarnedAt = Date.now();
          this.store.log('warn', `授权无效（${lic.reason}），定时任务已暂停。请在「设置」中填入有效授权码。`);
        }
        return;
      }
      this.lastLicenceBlock = null;
    } catch (_) {
      /* 闸门自身出错不阻塞（避免因授权服务抖动导致自用也停摆） */
    }

    try {
      // 每个子任务单独隔离：任何一个报错只记日志，后面的照常跑
      await this.safeRun('签到', () => this.maybeAutoCheckin());
      await this.safeRun('额度刷新', () => this.maybeRefreshQuota());
      await this.safeRun('小喵', () => this.maybeMeow());
      await this.safeRun('成长任务', () => this.maybeGrowth());
      // 新模块：保活、积分刷新（队友并行开发，缺失时自动跳过）
      await this.safeRun('保活', () => this.maybeKeepAlive());
      await this.safeRun('积分', () => this.maybeCredits());
      // 模型目录同步：官方新增/下架/改倍率时维护白名单（默认每天一次）
      await this.safeRun('模型同步', () => this.maybeModelSync());
    } finally {
      this.running = false;
      this.lastTick = Date.now();
      if (t0) { /* 保留时间戳供诊断 */ }
    }
  }

  async maybeAutoCheckin() {
    const c = this.cfg.checkin;
    if (!c.autoEnabled) return;
    const day = todayKey();
    if (this.rt.lastCheckinDate === day) return;
    // 错峰：到点时刻按「日期+任务类型+配置时刻+部署标识」稳定偏移，同日重启不重抽
    if (!this.dailyTarget('checkin', c.time || '08:30').due) return;

    // 停用语义：签到是纯收益动作，跳过「全停」，但「仅停转发」的账号照常签到
    const accounts = this.accounts.earningPool();
    if (!accounts.length) return;

    this.store.log('info', `定时签到开始，共 ${accounts.length} 个账号`);
    const results = [];
    const retry = Math.max(0, Number(c.retry || 0));
    for (let i = 0; i < accounts.length; i++) {
      const acc = accounts[i];
      // 错峰：账号之间随机等待，避免同一秒打满上游
      await this.paceAccount(i, accounts.length);
      let ok = false;
      let msg = '';
      for (let attempt = 0; attempt <= retry && !ok; attempt++) {
        try {
          const r = await this.accounts.checkinOne(acc.id);
          ok = true;
          msg = r.skipped ? r.reason : `+${r.credit || 0}`;
        } catch (err) {
          msg = err.message;
          if (attempt < retry) await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        }
      }
      results.push(`${acc.nickname}:${ok ? msg : '失败(' + msg + ')'}`);
    }
    this.rt.lastCheckinDate = day;
    this.rt.lastCheckinAt = Date.now();
    this.rt.lastCheckinResult = results.join(' | ').slice(0, 500);
    this.store.log('info', `定时签到完成：${this.rt.lastCheckinResult}`);

    if (c.refreshQuotaAfter) {
      await this.accounts.refreshAll().catch(() => {});
      this.rt.lastQuotaAt = Date.now();
    }
  }

  async maybeRefreshQuota() {
    const minutes = Number(this.cfg.quota.autoRefreshMinutes || 0);
    if (minutes <= 0) return;
    if (Date.now() - (this.rt.lastQuotaAt || 0) < minutes * 60000) return;
    // 停用语义：额度刷新是只读收益动作，含「仅停转发」账号
    if (!this.accounts.earningPool().length) return;

    /* 去重让位：credits.refreshAccount 内部同样调 wb.snapshot()，而且已经把 acc.quota 写全，
     * 两处都跑等于把上游请求翻倍（snapshot 现在每次 2 个请求：summary + paid-packages）。
     * 但 accounts.refresh() 里还兼着「60 秒红线令牌续期」这个副作用，整体让位会把它丢掉，
     * 所以这里不是什么都不做，而是改调 renewExpiringTokens()：只续期、不产生 snapshot。
     * 三个条件缺一个就回退到原来的 refreshAll()。 */
    const c = this.creditsPlan();
    if (c.enabled && c.refreshMinutes <= minutes && this.loadModule('credits', './credits', 'Credits', '积分')) {
      const s = this.schedule;
      const r = await this.accounts.renewExpiringTokens({
        delayMinMs: s.accountDelayMinSeconds * 1000,
        delayMaxMs: s.accountDelayMaxSeconds * 1000,
        budgetMs: Math.max(0, this._paceBudgetMs - this._paceUsedMs),
        // 提前续期窗口 = 一个刷新周期 + 5 分钟余量：
        // 只留 60 秒红线的话，30 分钟一轮的命中率只有 3.3%，等于「过期之后才补续」。
        windowMs: minutes * 60000 + 5 * 60000,
      }).catch(() => null);
      if (r) this._paceUsedMs += r.spentMs || 0;
      this.rt.lastQuotaAt = Date.now();
      this.store.touch();
      return;
    }

    await this.accounts.refreshAll().catch(() => {});
    this.rt.lastQuotaAt = Date.now();
    this.store.touch();
  }

  /* ---------------- 小喵巡检 ----------------
   * 接口已确认为官方成长中心同款：
   *   GET  /activity/growth/buddy/travel/status
   *   GET  /activity/growth/buddy/travel/config
   *   POST /activity/growth/buddy/travel/depart  { location_id }
   *   POST /activity/growth/buddy/travel/claim   {}
   * 巡检对每个可用账号各跑一次：到达就领，空闲就派，旅途中不动。
   * 单账号触发「今日上限」只影响它自己，不影响其它账号。
   *
   * 两个开关是分开的：
   *   meow.enabled  自动派出（会消耗每日一次额度，默认关）
   *   meow.autoClaim 回来自动领积分（纯收益，默认开）
   * 只开 autoClaim 时，巡检只查状态 + 领积分，空闲的账号不会被派出。
   */
  meowPlan() {
    const m = this.cfg.meow;
    const autoDepart = Boolean(m.enabled);
    const autoClaim = m.autoClaim !== false;
    // 开自动派出就用主间隔；只开自动领取就用更短的领取间隔，保证到点后不久就能领到
    const interval = autoDepart
      ? Number(m.intervalMinutes || 60)
      : Number(m.claimIntervalMinutes || 5);
    return { autoDepart, autoClaim, interval };
  }

  async maybeMeow() {
    if (!this.meow) return;
    const plan = this.meowPlan();
    if (!plan.autoDepart && !plan.autoClaim) return;
    if (Date.now() - (this.rt.lastMeowAt || 0) < plan.interval * 60000) return;

    // 停用语义：小喵属于纯收益动作，跳过「全停」，「仅停转发」照常巡检
    const pool = this.accounts.earningPool();
    if (!pool.length) {
      this.rt.meowState = 'no-account';
      this.rt.meowNote = '没有可用凭证的账号';
      return;
    }

    this.rt.lastMeowAt = Date.now();
    const tally = { departed: 0, claimed: 0, waiting: 0, idle: 0, limit: 0, failed: 0 };
    for (let i = 0; i < pool.length; i++) {
      const acc = pool[i];
      // 错峰：账号之间随机等待
      await this.paceAccount(i, pool.length);
      let r;
      try {
        r = await this.meow.runOnce(acc.id, { autoDepart: plan.autoDepart });
      } catch (err) {
        r = { ok: false, action: 'error', error: err.message };
      }
      if (r.action === 'departed') tally.departed += 1;
      else if (r.action === 'claimed') tally.claimed += 1;
      else if (r.action === 'waiting') tally.waiting += 1;
      else if (r.action === 'idle-only') tally.idle += 1;
      else if (r.action === 'skip-limit') tally.limit += 1;
      else tally.failed += 1;
      await new Promise((res) => setTimeout(res, 1200));
    }

    this.rt.meowState = tally.failed && !tally.departed && !tally.claimed ? 'error' : 'ok';
    this.rt.meowNote = `派出 ${tally.departed} / 领取 ${tally.claimed} / 旅行中 ${tally.waiting} / 空闲 ${tally.idle} / 上限 ${tally.limit} / 失败 ${tally.failed}`;
    this.store.log(tally.failed ? 'warn' : 'info', `小喵巡检：${this.rt.meowNote}`);
    this.store.touch();
    if (tally.claimed) {
      await this.accounts.refreshAll().catch(() => {});
      this.rt.lastQuotaAt = Date.now();
    }
  }

  meowNextIn() {
    const plan = this.meowPlan();
    if (!plan.autoDepart && !plan.autoClaim) return null;
    const last = this.rt.lastMeowAt || 0;
    const due = last + plan.interval * 60000;
    return Math.max(0, Math.round((due - Date.now()) / 1000));
  }

  /* ---------------- 成长任务巡检 ----------------
   * 接口（官方成长中心）：
   *   GET  /v2/activity/growth/tasks            任务列表
   *   POST /activity/growth/tasks/{code}/claim  领取奖励
   *
   * 领取在上游是幂等的：已领取的任务会返回 { already_claimed: true, credit: 0 }，
   * 所以定时巡检重复跑不会重复发积分、也不会把任务状态改坏。
   * 只领「已完成未领取」的任务，不碰进行中的。
   */
  async maybeGrowth() {
    // 注意：点亮类动作（completeAll/_lightUp*）禁止在此调用，只能由手动接口触发。
    if (!this.growth) return;
    const g = this.cfg.growth || {};
    if (!g.autoEnabled) return;
    const interval = Math.max(1, Number(g.intervalMinutes || 30));
    if (Date.now() - (this.rt.lastGrowthAt || 0) < interval * 60000) return;

    // 停用语义：成长任务属纯收益动作，跳过「全停」，「仅停转发」照常领取
    const pool = this.accounts.earningPool();
    if (!pool.length) return;

    this.rt.lastGrowthAt = Date.now();
    const tally = { claimed: 0, tasks: 0, failed: 0, credit: 0 };
    const notes = [];
    for (let i = 0; i < pool.length; i++) {
      const acc = pool[i];
      await this.paceAccount(i, pool.length); // 错峰：账号之间随机等待
      try {
        const r = await this.growth.claimAll(acc.id);
        if (!r.ok) { tally.failed += 1; notes.push(`${acc.nickname}:失败(${r.error})`); continue; }
        tally.claimed += r.success || 0;
        tally.tasks += r.count || 0;
        tally.credit += r.credit || 0;
        notes.push(`${acc.nickname}:领${r.success || 0}/${r.count || 0}`);
      } catch (err) {
        tally.failed += 1;
        notes.push(`${acc.nickname}:异常(${err.message})`);
      }
      await new Promise((res) => setTimeout(res, 1000));
    }

    this.rt.lastGrowthResult = notes.join(' | ').slice(0, 500);
    this.store.log(tally.failed ? 'warn' : 'info', `成长任务巡检：${this.rt.lastGrowthResult}`);
    this.store.touch();
    if (tally.credit) {
      await this.accounts.refreshAll().catch(() => {});
      this.rt.lastQuotaAt = Date.now();
    }
  }

  growthNextIn() {
    const g = this.cfg.growth || {};
    if (!g.autoEnabled) return null;
    const interval = Math.max(1, Number(g.intervalMinutes || 30));
    const due = (this.rt.lastGrowthAt || 0) + interval * 60000;
    return Math.max(0, Math.round((due - Date.now()) / 1000));
  }

  /* ---------------- 保活（令牌续期 + 活跃上报） ----------------
   * settings.keepalive = {
   *   enabled: false,            总开关，默认关
   *   renewDaysThreshold: 3,     剩余天数低于此值才续期
   *   activeReport: false,       是否做活跃上报
   *   intervalMinutes: 720,      巡检间隔（默认 12 小时）
   * }
   * 模块由 keepalive.js 提供（class KeepAlive），缺失时只告警跳过。
   */
  keepalivePlan() {
    const k = (this.cfg && this.cfg.keepalive) || {};
    return {
      enabled: Boolean(k.enabled),
      renewDaysThreshold: Math.max(0, Number(k.renewDaysThreshold === undefined ? 3 : k.renewDaysThreshold) || 0),
      activeReport: Boolean(k.activeReport),
      intervalMinutes: Math.max(1, Number(k.intervalMinutes || 720)),
    };
  }

  /**
   * 把 settings.schedule 的账号间隔换算成保活模块要的毫秒区间（错峰）。
   * 保活是整批入口、sleep 发生在模块内部，这边没法逐次记账，
   * 所以按「本轮剩余预算 ÷ 需要等待的账号数」封顶，并把剩余预算一次性标记为用尽，
   * 保证单次 tick 的累计等待仍然不超过 _paceBudgetMs。
   * 返回 undefined 表示不等待（配置为 0 或预算已耗尽），与旧行为完全一致。
   */
  keepaliveDelayOptions() {
    const s = this.schedule;
    if (!s.accountDelayMaxSeconds) return undefined;
    const gaps = Math.max(0, this.accounts.earningPool().length - 1); // 第一个账号不等待
    if (!gaps) return undefined;
    const leftMs = this._paceBudgetMs - this._paceUsedMs;
    if (leftMs <= 0) return undefined;
    const capSec = Math.floor(leftMs / 1000 / gaps);
    if (capSec <= 0) return undefined;
    const lo = Math.min(s.accountDelayMinSeconds, capSec);
    const hi = Math.min(s.accountDelayMaxSeconds, capSec);
    if (hi <= 0) return undefined;
    this._paceUsedMs = this._paceBudgetMs; // 剩余预算交给模块内部消耗
    return { delayMinMs: lo * 1000, delayMaxMs: Math.max(lo, hi) * 1000 };
  }

  async maybeKeepAlive() {
    const plan = this.keepalivePlan();
    if (!plan.enabled) return;
    if (Date.now() - (this.rt.lastKeepAliveAt || 0) < plan.intervalMinutes * 60000) return;
    // 停用语义：保活属纯收益动作，跳过「全停」，「仅停转发」照常续期
    if (!this.accounts.earningPool().length) return;

    const ka = this.loadModule('keepalive', './keepalive', 'KeepAlive', '保活');
    if (!ka) return;

    // 错峰：和签到/小喵共用同一套 settings.schedule 配置与同一份 tick 等待预算
    const spendBefore = this._paceUsedMs;
    const delay = this.keepaliveDelayOptions();
    // runAll 内部已经是「续期 + 活跃上报」，只在需要活跃上报时用它，否则单独调 renewAll
    const threshold = plan.renewDaysThreshold;
    let r;
    if (plan.activeReport && typeof ka.runAll === 'function') {
      r = await ka.runAll(threshold, delay);
    } else if (typeof ka.renewAll === 'function') {
      r = await ka.renewAll(threshold, delay);
    }
    // 重入保护：上一轮没跑完会返回 busy，不算异常，
    // 本轮不打时间戳，下个 tick 再试，免得白等一整个 interval。
    // 注意 busy 分支只有 {ok,busy,reason}，没有 result，必须先判断再读。
    if (r && r.busy) {
      // 本轮压根没进入等待，把预扣的预算退回去，不影响同轮后续批次
      this._paceUsedMs = spendBefore;
      this.store.log('info', `保活巡检：上一轮尚未结束，本轮跳过`);
      return;
    }
    const note = (r && r.result) || (r && r.error) || '无动作';
    this.rt.lastKeepAliveAt = Date.now();
    this.rt.lastKeepAliveResult = String(note).slice(0, 500);
    this.store.log(r && r.ok === false ? 'warn' : 'info', `保活巡检：${this.rt.lastKeepAliveResult}`);
    this.store.touch();
  }

  keepaliveNextIn() {
    const plan = this.keepalivePlan();
    if (!plan.enabled) return null;
    const due = (this.rt.lastKeepAliveAt || 0) + plan.intervalMinutes * 60000;
    return Math.max(0, Math.round((due - Date.now()) / 1000));
  }

  /* ---------------- 积分刷新 ----------------
   * settings.credits = { enabled: true, refreshMinutes: 30 }
   * 模块由 credits.js 提供（class Credits），缺失时只告警跳过。
   */
  creditsPlan() {
    const c = (this.cfg && this.cfg.credits) || {};
    return {
      enabled: c.enabled !== false, // 默认开
      refreshMinutes: Math.max(1, Number(c.refreshMinutes || 30)),
    };
  }

  /**
   * 模型目录同步（默认每 24 小时一次）。
   * 官方会新增/下架模型、调整倍率；这里定期拉一次并维护白名单：
   *   - 新增的免费模型自动加入白名单
   *   - 已下架的模型自动从白名单剔除
   *   - 倍率变动只记录，不覆盖用户手动选择
   */
  async maybeModelSync() {
    if (!this.modelSync) return;
    if (!this.modelSync.isDue()) return;
    // 拉目录需要账号 token
    if (!this.accounts.earningPool().length) return;
    await this.modelSync.run();
  }

  
  async maybeCredits() {
    const plan = this.creditsPlan();
    if (!plan.enabled) return;
    if (Date.now() - (this.rt.lastCreditsAt || 0) < plan.refreshMinutes * 60000) return;
    // 停用语义：积分刷新属只读收益动作，含「仅停转发」账号
    if (!this.accounts.earningPool().length) return;

    const cr = this.loadModule('credits', './credits', 'Credits', '积分');
    if (!cr) return;

    // refreshAll() 返回 { at, total, ok, failed, results }
    const r = (await cr.refreshAll()) || {};
    const total = Number(r.total || 0);
    const ok = Number(r.ok || 0);
    this.rt.lastCreditsAt = Date.now();
    this.rt.lastCreditsResult = `刷新 ${total} 个账号，成功 ${ok} 个，失败 ${Math.max(0, total - ok)} 个`.slice(0, 500);
    this.store.log('info', `积分刷新：${this.rt.lastCreditsResult}`);
    this.store.touch();
  }

  creditsNextIn() {
    const plan = this.creditsPlan();
    if (!plan.enabled) return null;
    const due = (this.rt.lastCreditsAt || 0) + plan.refreshMinutes * 60000;
    return Math.max(0, Math.round((due - Date.now()) / 1000));
  }
}

module.exports = { Scheduler };
