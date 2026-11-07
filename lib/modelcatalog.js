'use strict';
/**
 * 模型目录服务：拉 /v3/config → 建目录 → 带缓存供代理与前端共用。
 *
 * 为什么要缓存：/v3/config 返回 6 万多字节，且促销活动会随时变（有效期、时段）。
 * 但也不能缓存太久 —— 免费窗口的开始/结束必须准。
 * 取 5 分钟 TTL：窗口边界误差最大 5 分钟，够用；请求量也压得住。
 */
const wb = require('./wb');
const M = require('./models');

/** 缓存有效期：5 分钟 */
const TTL_MS = 5 * 60 * 1000;

class ModelCatalog {
  constructor(store, accounts) {
    this.store = store;
    this.accounts = accounts;
    this.cache = null;       // { at, catalog, raw }
    this.inflight = null;    // 并发去重，避免同时打上游
  }

  /** 取一个能用的账号来拉配置（配置是账号级无关的，但需要 token） */
  _pickAccount() {
    const pool = (this.accounts && this.accounts.usable) ? this.accounts.usable() : [];
    return pool[0] || null;
  }

  /**
   * 拿模型目录（带缓存）。
   * @param {object} [opts] { force: 强制刷新 }
   * @returns {Promise<object>} { ok, models, promotions, nextFreeInMs, at, error, stale }
   */
  async get(opts = {}) {
    const now = Date.now();
    if (!opts.force && this.cache && now - this.cache.at < TTL_MS) {
      return this._shape(this.cache, false);
    }
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const acc = this._pickAccount();
      if (!acc) {
        const msg = '没有可用账号，无法拉取上游模型配置';
        // 缓存过期又拉不到时，宁可用旧缓存也别让代理挂掉
        if (this.cache) return this._shape(this.cache, true, msg);
        return { ok: false, error: msg, models: [], promotions: [], nextFreeInMs: null, at: now };
      }
      const r = await wb.productConfig(acc);
      if (!r.ok) {
        const msg = '拉取上游模型配置失败：' + (r.error || '未知错误');
        if (this.cache) return this._shape(this.cache, true, msg);
        return { ok: false, error: msg, models: [], promotions: [], nextFreeInMs: null, at: now };
      }
      const data = r.data || {};
      const catalog = M.buildCatalog(data, new Date());
      this.cache = {
        at: Date.now(),
        catalog,
        raw: {
          promotions: Array.isArray(data.modelPromotions) ? data.modelPromotions : [],
        },
      };
      return this._shape(this.cache, false);
    })();

    try {
      return await this.inflight;
    } finally {
      this.inflight = null;
    }
  }

  /** 把内部缓存整理成对外形状 */
  _shape(c, stale, error) {
    const now = new Date();
    const models = c.catalog.models.map((m) => ({
      id: m.id,
      name: m.name,
      baseRate: m.baseRate,
      rate: m.rate,
      free: m.free,
      rateSource: m.rateSource,
      promotion: m.promotion,
      maxIn: m.maxIn,
      maxOut: m.maxOut,
      tools: m.tools,
      img: m.img,
      desc: m.desc,
    }));
    const promotions = (c.raw.promotions || []).map((p) => ({
      id: p.id,
      badge: p.badge && p.badge.label ? String(p.badge.label) : '',
      hover: p.hover && p.hover.textZh ? String(p.hover.textZh) : '',
      modelIds: Array.isArray(p.modelIds) ? p.modelIds : [],
      factor: p.discount && p.discount.factor !== undefined ? p.discount.factor : null,
      discountedCredits: p.discount && p.discount.discountedCredits !== undefined ? p.discount.discountedCredits : null,
      schedule: p.schedule || null,
      active: M.isPromotionActive(p, now),
      enabled: M.isPromotionEnabled(p),
      priority: p.priority ?? 0,
      kind: p.kind || '',
    }));
    return {
      ok: !error,
      stale: !!stale,
      error: error || '',
      at: c.at,
      models,
      promotions,
      nextFreeInMs: M.nextFreeWindowMs(c.raw.promotions || [], now),
    };
  }
}

module.exports = { ModelCatalog, TTL_MS };
