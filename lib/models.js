'use strict';
/**
 * 模型目录 + 促销时段求值。
 *
 * 上游唯一同时下发「模型倍率」+「时段促销」+「会员分层」的端点是：
 *   GET https://www.workbuddy.cn/v3/config
 * 必须带官方三段式 UA，否则 400 code=12403（"check ua, get coding copilot version error"）：
 *   WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0
 *
 * 重要：data/models.json（product.json@5.9.3 静态快照）**已过期**，
 * 里面若干模型 credits 为空串，上游实时其实有值（如 glm-5.0 x0.80 / glm-4.7 x0.23）。
 * 用旧表判断「哪个最省」会全判错 —— 一律以 /v3/config 实时数据为准。
 *
 * 促销判定语义严格对齐客户端 app.asar 里的 isPromotionActive / selectPrimaryPromotion，
 * 逐条依据见每处注释。**不要凭直觉改这里的边界语义。**
 */

/** 官方客户端 UA：/v3/config 校验 UA，用普通 UA 会 400。 */
const OFFICIAL_UA = 'WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0';

/**
 * 解析 "x0.51 credits" / "0.05" / "x0.00" 这类倍率字符串。
 * 返回倍率数值；无倍率信息返回 null（ABSENT，不是 0 —— 0 是「免费」）。
 * @param {*} raw credits 字段原值
 * @returns {number|null}
 */
function parseCreditsRate(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // 客户端 formatCredits 的口径：取第一个数字
  const m = s.match(/(\d+(?:\.\d+)?)/);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

/**
 * 解析 "HH:mm" → 当天分钟数。
 * 非法格式返回 undefined（与客户端 parseHHmm 一致）。
 * @param {string} s
 * @returns {number|undefined}
 */
function parseHHmm(s) {
  if (typeof s !== 'string') return undefined;
  const t = s.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!t) return undefined;
  const h = Number(t[1]);
  const m = Number(t[2]);
  if (h < 0 || h > 23 || m < 0 || m > 59) return undefined;
  return h * 60 + m;
}

/**
 * 取指定时区下的「当天第几分钟」。
 * 有 timezone 用 Intl 取该时区时分；没有或 Intl 抛错则回落到本机本地时间。
 * @param {Date} d
 * @param {string} [timezone]
 * @returns {number} 分钟数（0~1439）
 */
function zonedMinuteOfDay(d, timezone) {
  if (timezone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: timezone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).formatToParts(d);
      const get = (type) => Number(parts.find((p) => p.type === type)?.value ?? '0');
      const h = get('hour') % 24;
      const m = get('minute');
      return h * 60 + m;
    } catch (_) {
      /* 非法时区 → 回落本地时间 */
    }
  }
  return d.getHours() * 60 + d.getMinutes();
}

/**
 * 单个每日窗口是否命中。
 * 语义严格对齐客户端 isDailyWindowActive：
 *   - start === end → 视为整天命中
 *   - start < end   → [start, end)  左闭右开
 *   - start > end   → 跨午夜环绕，命中 [start, 1440) ∪ [0, end)
 * @param {number} start 分钟
 * @param {number} end 分钟
 * @param {number} now 分钟
 * @returns {boolean}
 */
function isDailyWindowActive(start, end, now) {
  if (start === end) return true;
  if (start < end) return now >= start && now < end;
  return now >= start || now < end;
}

/**
 * 促销当前是否生效。语义严格对齐客户端 isPromotionActive：
 *   1. validFrom / validUntil 与 daily 是 **AND**（先判日期窗口，不满足直接 false）
 *   2. daily 为空数组 → 只看日期窗口（通过即 true）
 *   3. daily 多条之间是 **OR**（任一命中即 true）
 *   4. validUntil 边界算已过期（用 >=）
 * @param {object} promo modelPromotions[] 里的一条
 * @param {Date} now
 * @returns {boolean}
 */
function isPromotionActive(promo, now) {
  const sch = promo && promo.schedule;
  const t = now.getTime();
  if (sch && sch.validFrom) {
    const v = Date.parse(sch.validFrom);
    if (!Number.isNaN(v) && t < v) return false;
  }
  if (sch && sch.validUntil) {
    const v = Date.parse(sch.validUntil);
    if (!Number.isNaN(v) && t >= v) return false;
  }
  const daily = sch && Array.isArray(sch.daily) ? sch.daily : [];
  if (!daily.length) return true;
  const minute = zonedMinuteOfDay(now, sch.timezone);
  for (const w of daily) {
    const s = parseHHmm(w && w.start);
    const e = parseHHmm(w && w.end);
    if (s !== undefined && e !== undefined && isDailyWindowActive(s, e, minute)) return true;
  }
  return false;
}

/** enabled !== false 才算启用（客户端 isPromotionEnabled）。 */
function isPromotionEnabled(promo) {
  return !promo || promo.enabled !== false;
}

/**
 * 为某个模型选出「当前生效」的那条促销。
 * 对齐客户端 selectPrimaryPromotion：
 *   - 先在「enabled 且当前 active」的促销里选 priority 最大的一条
 *   - 一条都不 active 时，回落到「enabled 里 priority 最大」的那条（此时不产生折扣）
 * @param {object[]} promos 该模型关联的所有促销
 * @param {Date} now
 * @returns {object|null}
 */
function selectPrimaryPromotion(promos, now) {
  if (!Array.isArray(promos) || !promos.length) return null;
  let fallback = null;
  let active = null;
  for (const p of promos) {
    if (!isPromotionEnabled(p)) continue;
    const pri = p.priority ?? 0;
    if (!fallback || pri > (fallback.priority ?? 0)) fallback = p;
    if (isPromotionActive(p, now) && (!active || pri > (active.priority ?? 0))) active = p;
  }
  return active ?? fallback;
}

/**
 * 算出折后倍率。
 * 对齐客户端 formatDiscountCredits：
 *   - discount.discountedCredits 存在 → **优先**用它（绝对折后倍率，如 "0x" / "0.50x"）
 *   - 只有 discount.factor 时 → factor × 基础倍率；factor<=0 或 >=1 时算不出（返回 null）
 *   - 促销没生效 → 返回基础倍率
 * @param {number|null} baseRate 基础倍率
 * @param {object|null} promo 当前生效的促销
 * @returns {{rate:number|null, free:boolean, source:string}}
 */
function effectiveRate(baseRate, promo) {
  const base = baseRate === null || baseRate === undefined ? null : baseRate;
  const active = promo && isPromotionActive(promo, new Date()) ? promo : null;
  if (!active || active.kind !== 'discount' || !active.discount) {
    return { rate: base, free: base === 0, source: 'base' };
  }
  const d = active.discount;
  // 上游对 factor=0 一律同时下发 discountedCredits（"0x" / "0.00x"），
  // 因为客户端 formatDiscountCredits 在 factor<=0 时会直接 return，必须靠它才能显示免费。
  if (d.discountedCredits !== undefined && d.discountedCredits !== null) {
    const explicit = parseCreditsRate(d.discountedCredits);
    if (explicit !== null) {
      return { rate: explicit, free: explicit === 0, source: 'promotion:' + (active.id || '') };
    }
  }
  const f = Number(d.factor);
  if (Number.isFinite(f) && f > 0 && f < 1 && base !== null) {
    const r = base * f;
    return { rate: r, free: false, source: 'promotion:' + (active.id || '') };
  }
  return { rate: base, free: base === 0, source: 'base' };
}

/**
 * 把 /v3/config 的 data 整成一份「模型 → 倍率/促销」的目录。
 * @param {object} data /v3/config 的 data 字段
 * @param {Date} now
 * @returns {object} { models: [...], at: number }
 */
function buildCatalog(data, now) {
  const d = data && typeof data === 'object' ? data : {};
  const rawModels = Array.isArray(d.models) ? d.models : [];
  const rawPromos = Array.isArray(d.modelPromotions) ? d.modelPromotions : [];

  // 促销按 modelIds 挂到模型上（客户端 attachModelPromotions 的同一思路）
  const byModel = new Map();
  for (const p of rawPromos) {
    const ids = Array.isArray(p && p.modelIds) ? p.modelIds : [];
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      if (!byModel.has(id)) byModel.set(id, []);
      byModel.get(id).push(p);
    }
  }

  const models = [];
  for (const m of rawModels) {
    if (!m || typeof m.id !== 'string' || !m.id.trim()) continue;
    if (m.disabled === true) continue; // 客户端 projectModelCatalog：disabled 跳过
    const id = m.id.trim();
    const baseRate = parseCreditsRate(m.credits);
    const promo = selectPrimaryPromotion(byModel.get(id) || [], now);
    const eff = effectiveRate(baseRate, promo);
    const promoActive = promo ? isPromotionActive(promo, now) : false;
    // 「免费」只能由实际倍率 0 判定。
    // 注意：上游有不少**纯角标**促销（kind=discount 但没有 discount 字段，
    // 例如 ds-discount-daytime-badge-202608），它只负责挂个 badge，
    // 并不改变计费 —— 不能因为「促销 active」就当成免费，否则自动选型会错选。
    const isFree = eff.rate === 0;
    models.push({
      id,
      name: (m.name && String(m.name).trim()) || id,
      baseRate,                       // 基础倍率（null = 上游没标，不是免费）
      rate: eff.rate,                 // 当前实际倍率
      free: isFree,                   // 当前是否零成本（按实际倍率判定）
      rateSource: eff.source,
      promotion: promo && promoActive ? {
        id: promo.id,
        badge: promo.badge && promo.badge.label ? String(promo.badge.label) : '',
        hover: promo.hover && promo.hover.textZh ? String(promo.hover.textZh) : '',
        factor: promo.discount && promo.discount.factor !== undefined ? promo.discount.factor : null,
        schedule: promo.schedule || null,
      } : null,
      maxIn: m.maxInputTokens || m.contextWindow || 0,
      maxOut: m.maxOutputTokens || 0,
      tools: m.supportsToolCall !== false,
      img: m.supportsImages === true,
      desc: m.descriptionZh || m.descriptionEn || '',
    });
  }

  models.sort((a, b) => {
    const ra = a.rate === null ? Number.POSITIVE_INFINITY : a.rate;
    const rb = b.rate === null ? Number.POSITIVE_INFINITY : b.rate;
    if (ra !== rb) return ra - rb;
    return a.id.localeCompare(b.id);
  });

  return { models, at: now.getTime() };
}

/**
 * 求「下一个免费窗口开始」的毫秒数，用于倒计时展示。
 * 扫所有启用的促销里带 daily 的那些，找下一个 start 边界。
 * @param {object[]} rawPromos
 * @param {Date} now
 * @returns {number|null} 距下个免费窗口开始的毫秒数；找不到返回 null
 */
function nextFreeWindowMs(rawPromos, now) {
  if (!Array.isArray(rawPromos)) return null;
  let best = null;
  for (const p of rawPromos) {
    if (!isPromotionEnabled(p)) continue;
    const sch = p && p.schedule;
    const daily = sch && Array.isArray(sch.daily) ? sch.daily : [];
    if (!daily.length) continue;
    const isFree = p.kind === 'discount' && p.discount
      && (Number(p.discount.factor) === 0 || parseCreditsRate(p.discount.discountedCredits) === 0);
    if (!isFree) continue;
    // 日期窗口已整体过期就不再考虑
    if (sch.validUntil) {
      const v = Date.parse(sch.validUntil);
      if (!Number.isNaN(v) && now.getTime() >= v) continue;
    }
    const minute = zonedMinuteOfDay(now, sch.timezone);
    for (const w of daily) {
      const s = parseHHmm(w && w.start);
      if (s === undefined) continue;
      const e = parseHHmm(w && w.end);
      if (s === e) continue;                 // 全天命中，没有边界
      // 「下一个边界」= start 与 end 里离现在最近的那个。
      // 跨午夜窗口（s>e，如 23:00→08:00）在白天时，下一个边界是今晚的 start；
      // 在深夜（如 03:00）时，下一个边界是今早的 end。两个都要算，取更近的。
      const cand = [];
      if (e !== undefined) {
        let d = e - minute;
        if (d <= 0) d += 1440;
        cand.push(d);
      }
      let ds = s - minute;
      if (ds <= 0) ds += 1440;
      cand.push(ds);
      const deltaMin = Math.min.apply(null, cand);
      const ms = deltaMin * 60000;
      if (best === null || ms < best) best = ms;
    }
  }
  return best;
}

module.exports = {
  OFFICIAL_UA,
  parseCreditsRate,
  parseHHmm,
  zonedMinuteOfDay,
  isDailyWindowActive,
  isPromotionActive,
  isPromotionEnabled,
  selectPrimaryPromotion,
  effectiveRate,
  buildCatalog,
  nextFreeWindowMs,
};
