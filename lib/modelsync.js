'use strict';
/**
 * 模型目录自动同步（Model Sync）
 *
 * 解决什么问题：
 *   官方会随时新增 / 下架模型、调整倍率。原来只在打开页面时实时拉一次，
 *   看得到但**不留记录**，用户配好的白名单会慢慢腐烂：
 *     - 白名单里留着已经下架的模型 → 自动选型时可能选中一个调不通的
 *     - 新上线的免费模型没人知道 → 白送了省钱机会
 *
 * 本模块做的事：
 *   1. 定时（默认每天一次）拉官方目录，落库为快照
 *   2. 与上一次快照做 diff：新增 / 下架 / 倍率变动
 *   3. 自动维护白名单：
 *        · 新增的「免费」（倍率 0）模型 → 自动加入白名单
 *        · 已下架的模型 → 自动从白名单移除
 *        · 倍率变动的 → 只记录，不改白名单（用户的选择不该被覆盖）
 *   4. 保留最近 N 次变更记录，界面可查
 *
 * 注意：只在「已配置账号」时才能拉到数据（/v3/config 需要账号 token）。
 */
const path = require('path');

const DAY_MS = 24 * 60 * 60 * 1000;
const KEEP_CHANGES = 50;         // 保留最近 50 条变更记录
const KEEP_SNAPSHOTS = 7;        // 保留最近 7 次快照

class ModelSync {
  constructor(store, catalog) {
    this.store = store;
    this.catalog = catalog;
    this.running = false;
  }

  get cfg() {
    return (this.store.data.settings && this.store.data.settings.modelSync) || {};
  }

  get state() {
    if (!this.store.data.modelSync) {
      this.store.data.modelSync = {
        lastAt: 0,
        lastResult: null,
        snapshot: null,      // { at, models: {id: {name, rate, free}} }
        changes: [],         // 最近变更
        enabled: true,
      };
    }
    return this.store.data.modelSync;
  }

  /** 是否到了该同步的时间 */
  isDue() {
    const st = this.state;
    if (st.enabled === false) return false;
    const intervalH = Number(this.cfg.intervalHours || 24);
    const gap = Math.max(1, intervalH) * 3600000;
    return Date.now() - (st.lastAt || 0) >= gap;
  }

  /**
   * 执行一次同步。
   * @param {object} [opts] { force:true 忽略间隔 }
   * @returns {Promise<object>} 同步结果
   */
  async run(opts = {}) {
    if (this.running) return { ok: false, error: '同步正在进行中' };
    this.running = true;
    const st = this.state;
    try {
      const c = await this.catalog.get({ force: true }).catch((e) => ({ ok: false, error: e.message }));
      if (!c || !c.ok || !Array.isArray(c.models) || !c.models.length) {
        const err = (c && c.error) || '拉取模型目录失败（可能未添加账号）';
        st.lastAt = Date.now();
        st.lastResult = { ok: false, error: err, at: Date.now() };
        this.store.touch();
        this.store.log('warn', `[模型同步] 失败：${err}`);
        return { ok: false, error: err };
      }

      // 归一化成 { id: {name, rate, free} }
      const now = {};
      for (const m of c.models) {
        if (!m || !m.id) continue;
        now[String(m.id)] = {
          name: String(m.name || m.id),
          rate: (m.rate === null || m.rate === undefined) ? null : Number(m.rate),
          free: m.free === true || Number(m.rate) === 0,
        };
      }

      const prev = (st.snapshot && st.snapshot.models) || null;
      const diff = this._diff(prev, now);
      const wlChange = this._applyWhitelist(diff, now);

      // 存快照
      st.snapshot = { at: Date.now(), models: now };
      st.lastAt = Date.now();
      st.lastResult = {
        ok: true,
        at: Date.now(),
        total: Object.keys(now).length,
        added: diff.added.length,
        removed: diff.removed.length,
        rateChanged: diff.rateChanged.length,
        whitelistAdded: wlChange.added,
        whitelistRemoved: wlChange.removed,
      };

      // 有变更才记历史
      if (diff.added.length || diff.removed.length || diff.rateChanged.length) {
        st.changes.unshift({
          at: Date.now(),
          added: diff.added,
          removed: diff.removed,
          rateChanged: diff.rateChanged,
          whitelistAdded: wlChange.added,
          whitelistRemoved: wlChange.removed,
        });
        st.changes = st.changes.slice(0, KEEP_CHANGES);
      }

      this._trimSnapshots();
      this.store.touch();

      const msg = `模型同步完成：共 ${st.lastResult.total} 个，`
        + `新增 ${diff.added.length}、下架 ${diff.removed.length}、倍率变动 ${diff.rateChanged.length}`;
      this.store.log('info', '[模型同步] ' + msg);
      return { ok: true, result: st.lastResult, diff };
    } catch (e) {
      st.lastAt = Date.now();
      st.lastResult = { ok: false, error: e.message, at: Date.now() };
      this.store.touch();
      this.store.log('warn', `[模型同步] 异常：${e.message}`);
      return { ok: false, error: e.message };
    } finally {
      this.running = false;
    }
  }

  /** 计算差异 */
  _diff(prev, now) {
    const added = [];
    const removed = [];
    const rateChanged = [];
    if (!prev) return { added: [], removed: [], rateChanged: [] };   // 首次只建基线，不算变更

    for (const id of Object.keys(now)) {
      if (!(id in prev)) {
        added.push({ id, name: now[id].name, rate: now[id].rate, free: now[id].free });
      } else {
        const a = prev[id].rate;
        const b = now[id].rate;
        if (a !== b && !(a === null && b === null)) {
          rateChanged.push({ id, name: now[id].name, from: a, to: b });
        }
      }
    }
    for (const id of Object.keys(prev)) {
      if (!(id in now)) removed.push({ id, name: prev[id].name, rate: prev[id].rate });
    }
    return { added, removed, rateChanged };
  }

  /**
   * 按差异维护白名单：
   *   - 新增且免费 → 加入
   *   - 已下架 → 移除
   * 用户手动加的非免费模型不动。
   */
  _applyWhitelist(diff, now) {
    const p = this.store.data.settings.proxy;
    const wl = Array.isArray(p.modelWhitelist) ? p.modelWhitelist.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (!wl.length) return { added: [], removed: [] };   // 空白名单 = 全部保留，不干预

    const set = new Set(wl);
    const added = [];
    const removed = [];

    // 下架的移除
    for (const r of diff.removed) {
      if (set.has(r.id)) { set.delete(r.id); removed.push(r.id); }
    }
    // 新增免费的加入（仅当原本白名单非空，说明用户在用白名单策略）
    for (const a of diff.added) {
      if (a.free && !set.has(a.id)) { set.add(a.id); added.push(a.id); }
    }

    if (added.length || removed.length) {
      p.modelWhitelist = Array.from(set);
      this.store.log('info',
        `[模型同步] 白名单已更新：+${added.length}${added.length ? '(' + added.join(',') + ')' : ''} `
        + `-${removed.length}${removed.length ? '(' + removed.join(',') + ')' : ''}`);
    }
    return { added, removed };
  }

  /** 只保留最近 N 次快照（当前只存最新一份，这里留扩展位） */
  _trimSnapshots() {
    const st = this.state;
    if (Array.isArray(st.history) && st.history.length > KEEP_SNAPSHOTS) {
      st.history = st.history.slice(0, KEEP_SNAPSHOTS);
    }
  }

  /** 给界面用的摘要 */
  summary() {
    const st = this.state;
    return {
      enabled: st.enabled !== false,
      lastAt: st.lastAt || 0,
      lastResult: st.lastResult || null,
      totalModels: st.snapshot ? Object.keys(st.snapshot.models).length : 0,
      changes: (st.changes || []).slice(0, 20),
      intervalHours: Number(this.cfg.intervalHours || 24),
      nextAt: (st.lastAt || 0) + Math.max(1, Number(this.cfg.intervalHours || 24)) * 3600000,
    };
  }
}

module.exports = { ModelSync, DAY_MS };
