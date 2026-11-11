'use strict';
/**
 * OpenAI 兼容反向代理：/v1/models、/v1/chat/completions
 * 调度策略：balance（余额优先）/ expiry（过期优先）/ roundrobin（轮询）/ drain（集中消耗）
 * 支持粘性会话、失败换号、SSE 流式透传。
 */
const crypto = require('crypto');
const wb = require('./wb');
const { safeEqual } = require('./crypto');
const { parseSSE, findErrorFrame, aggregateChunks } = require('./sse');

function json(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  });
  res.end(text);
}

/**
 * 规范化一个 OpenAI Chat Completions 的流式 chunk（就地修改并返回）。
 *
 * 上游（WorkBuddy）返回的 chunk 有三处不合 OpenAI 规范，严格客户端（如 Qoder）
 * 会直接抛异常：
 *   1. 非结束帧的 `choices[].finish_reason` 是空字符串 `""`，规范要求 `null`。
 *      严格客户端按枚举反序列化，`""` 不是合法值 → 解析失败。
 *   2. `choices[].delta` 里带私有字段 `extra_fields`（上游扩展），规范里没有此字段。
 *   3. `delta` 里出现值为 null 的 `function_call` / `refusal` / `tool_calls`，
 *      部分客户端对 null 的处理有 bug（期望字段缺失而非 null）。
 *
 * 注意：这是**输出前**的规范化，不改上游、不影响其他通道；解析失败时调用方
 * 必须原样透传原帧，绝不能吞帧。
 */
function normalizeChunk(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  const choices = Array.isArray(obj.choices) ? obj.choices : null;
  if (choices) {
    for (const c of choices) {
      if (!c || typeof c !== 'object') continue;
      // ① finish_reason：空字符串 → null（规范要求）
      if (c.finish_reason === '' || c.finish_reason === undefined) c.finish_reason = null;
      const d = c.delta;
      if (d && typeof d === 'object') {
        // ② 删掉上游私有字段
        delete d.extra_fields;
        // ③ 值为 null 的可选字段直接摘掉（规范中「无此字段」比「字段为 null」更安全）
        for (const k of ['function_call', 'refusal', 'tool_calls', 'reasoning_content']) {
          if (k in d && d[k] === null) delete d[k];
        }
        /* ④ ★关键：上游会发 function_call = {name:"", arguments:""} 这种"空壳"。
         * 严格客户端（Qoder）会把它当成一次真实的函数调用去解析，name 为空导致
         * 解析失败，最终把参数当正文渲染 —— 表现就是回答被拆成一个个孤立字符/换行。
         * 规范里「没有函数调用」应当是字段缺失，所以空壳一律摘掉。 */
        const fc = d.function_call;
        if (fc && typeof fc === 'object') {
          const noName = !fc.name || String(fc.name).trim() === '';
          const noArgs = fc.arguments === '' || fc.arguments === null || fc.arguments === undefined;
          if (noName && noArgs) delete d.function_call;
        }
        // ⑤ refusal 空串同样摘掉（规范中只有拒绝时才出现，且是字符串内容）
        if (typeof d.refusal === 'string' && d.refusal === '') delete d.refusal;
        // ⑥ tool_calls 空数组摘掉
        if (Array.isArray(d.tool_calls) && d.tool_calls.length === 0) delete d.tool_calls;
        // ⑦ reasoning_content 空串保留是安全的，但为空时统一摘掉更贴近官方客户端输出
        if (typeof d.reasoning_content === 'string' && d.reasoning_content === '') delete d.reasoning_content;
      }
    }
  }
  // ⑧ usage 里的上游私有额度信息（quota）不属于 OpenAI 规范，剥掉
  if (obj.usage && typeof obj.usage === 'object' && 'quota' in obj.usage) {
    delete obj.usage.quota;
  }
  return obj;
}

/** 单行 `data: {...}` 帧规范化；不是可解析 JSON 时返回 null（调用方原样透传） */
function normalizeSSELine(line) {
  if (!line.startsWith('data:')) return null;
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return null;
  try {
    const obj = JSON.parse(payload);
    if (!obj || typeof obj !== 'object') return null;
    normalizeChunk(obj);
    return 'data: ' + JSON.stringify(obj);
  } catch (_) {
    return null; // 解析失败 → 交给调用方原样透传
  }
}

function shortText(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** 渠道风控（11128）静默重发上限：上游是概率性拦截，重发两次足够覆盖绝大多数情况 */
const CHANNEL_RETRY = 3;

/**
 * 判断上游响应是否为「渠道校验拦截」。
 * 上游原文（实测 2026-11-02）：
 *   code:11128 / msg:"Illegal API invocation from an unapproved channel"
 *   displayTips 中文：「这次调用没通过渠道校验，可能不是官方客户端发出的。请用官方版本重新发送。」
 * 特征：概率性触发（同模型同账号同请求头连发 6 次全 200），重发即可通过。
 */
function isChannelBlocked(text) {
  const s = String(text || '');
  return s.indexOf('11128') >= 0
    || /unapproved channel/i.test(s)
    || /没通过渠道校验/.test(s)
    || /not sent from an official client/i.test(s);
}

/**
 * 上游「模型提供方临时不可用」（实测 2026-11-07）：
 *   HTTP 500 + code:11134 / msg:"the model provider is temporarily unavailable,
 *   please retry or switch to another model"
 * 特征：提供方秒级抖动，同一请求退避几秒后重发即可恢复，不该直接对外 502。
 */
function isProviderBusy(text) {
  const s = String(text || '');
  return s.indexOf('11134') >= 0
    || /temporarily unavailable/i.test(s)
    || /model provider/i.test(s);
}

function openAiError(res, status, message, type, code) {
  json(res, status, {
    error: {
      message,
      type: type || 'upstream_error',
      code: code || null,
    },
  });
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (_) { reject(new Error('请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

class Proxy {
  constructor(store, accounts, modelsFile) {
    this.store = store;
    this.accounts = accounts;
    this.modelsFile = modelsFile;
    this.rrIndex = 0;
    this.sticky = new Map();
    this.modelCache = null;
    // 模型目录服务（上游 /v3/config：倍率 + 时段促销）。由 server.js 注入。
    this.catalog = null;
    // 核心决策服务客户端（远端 core-server）。由 server.js 注入。
    // 未注入或未配置 coreUrl 时，所有决策走本地实现（自用场景行为不变）。
    this.core = null;
  }

  /** 是否启用远端 core 决策 */
  coreOn() {
    return !!(this.core && this.core.enabled());
  }

  /** 当前配置快照，供发给 core 做决策 */
  async _coreConfig() {
    if (!this.catalog) return null;
    const c = await this.catalog.get().catch(() => null);
    if (!c || !c.ok) return null;
    // core 需要的是「原始 data」，这里用 catalog 缓存的 raw（若没有 raw 就现造一份最小结构）
    if (c.raw && (c.raw.models || c.raw.modelPromotions)) return c.raw;
    return {
      models: (c.models || []).map((m) => ({ id: m.id, credits: m.baseRate === null ? null : 'x' + m.baseRate })),
      modelPromotions: [],
    };
  }

  get cfg() {
    return this.store.data.settings.proxy;
  }

  loadModels() {
    if (this.modelCache) return this.modelCache;
    try {
      const fs = require('fs');
      const raw = JSON.parse(fs.readFileSync(this.modelsFile, 'utf8'));
      this.modelCache = raw.models || [];
    } catch (_) {
      this.modelCache = [{ id: 'default', name: 'Default', credits: '', maxIn: 0, maxOut: 0, tools: true, img: false, desc: '' }];
    }
    return this.modelCache;
  }

  /**
   * 可见模型目录（供 /v1/models 暴露给客户端）。
   * 优先用上游实时目录（带真实倍率与免费状态），拿不到才回落静态快照。
   * 白名单为空 = 不做过滤。
   */
  async visibleModels() {
    const wl = this.whitelist();
    let list = null;
    if (this.catalog) {
      const c = await this.catalog.get().catch(() => null);
      if (c && c.ok && c.models && c.models.length) {
        list = c.models.map((m) => ({
          id: m.id,
          name: m.name,
          credits: m.rate === null ? '' : 'x' + m.rate + ' credits',
          maxIn: m.maxIn || 0,
          maxOut: m.maxOut || 0,
          tools: m.tools !== false,
          img: !!m.img,
          desc: m.desc || '',
          _rate: m.rate,
          _free: !!m.free,
          _promotion: m.promotion || null,
        }));
      }
    }
    if (!list) {
      list = this.loadModels().map((m) => Object.assign({}, m));
    }
    if (wl.length) {
      const set = new Set(wl);
      const filtered = list.filter((m) => set.has(m.id));
      // 白名单里的模型上游可能还没上（如活动下线），至少保留它们，
      // 否则客户端会报「模型不存在」而完全不能用。
      for (const id of wl) {
        if (!filtered.some((m) => m.id === id)) {
          filtered.push({ id, name: id, credits: '', maxIn: 0, maxOut: 0, tools: true, img: false, desc: '' });
        }
      }
      // 自定义模型名（modelMap 的键）也要暴露，否则客户端模型选择器里看不到，
      // 用户配了却用不了。目标模型的上游信息用目标的，名字用自己的。
      const map = (this.cfg.modelMap && typeof this.cfg.modelMap === 'object') ? this.cfg.modelMap : {};
      for (const alias of Object.keys(map)) {
        const target = map[alias];
        if (!alias || filtered.some((m) => m.id === alias)) continue;
        const src = filtered.find((m) => m.id === target);
        filtered.push(Object.assign({}, src || { maxIn: 0, maxOut: 0, tools: true, img: false, desc: '' }, {
          id: alias,
          name: alias,
          _aliasTarget: target,
        }));
      }
      return filtered;
    }
    return list;
  }

  /** 白名单（模型 id 数组） */
  whitelist() {
    const w = this.cfg.modelWhitelist;
    if (!Array.isArray(w)) return [];
    return w.map((x) => String(x || '').trim()).filter(Boolean);
  }

  /**
   * 自动选型：在白名单里挑当前最省的模型。
   * ① 有 0 倍率（真免费）→ 用它（免费优先）
   * ② 否则挑倍率最低的（无倍率标注的模型排除，它们不是「便宜」而是「没标」）
   * @returns {Promise<string|null>} 模型 id；选不出来返回 null
   */
  async pickCheapest() {
    const wl = this.whitelist();
    if (!this.catalog) return null;
    const c = await this.catalog.get().catch(() => null);
    if (!c || !c.ok || !c.models || !c.models.length) return null;
    const set = wl.length ? new Set(wl) : null;
    const pool = c.models.filter((m) => (!set || set.has(m.id)) && m.rate !== null && m.rate !== undefined);
    if (!pool.length) return null;
    // 免费优先
    const free = pool.filter((m) => m.rate === 0);
    if (free.length) return free[0].id;
    // 其次倍率最低；同倍率取 id 字典序，保证结果稳定可预期
    pool.sort((a, b) => (a.rate - b.rate) || a.id.localeCompare(b.id));
    return pool[0].id;
  }

  authorize(req) {
    if (this.cfg.allowAnonymous) return true;
    const key = this.cfg.accessKey;
    if (!key) return false;
    const given = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    return safeEqual(given, key);
  }

  stickyKey(req, body) {
    const first = body && Array.isArray(body.messages) && body.messages[0];
    const seed = (first && typeof first.content === 'string') ? first.content.slice(0, 200) : '';
    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString().split(',')[0].trim();
    return crypto.createHash('sha1').update(seed || ip).digest('hex').slice(0, 16);
  }

  resolveSticky(key) {
    const rec = this.sticky.get(key);
    if (!rec) return null;
    if (rec.exp < Date.now()) {
      this.sticky.delete(key);
      return null;
    }
    return rec.id;
  }

  remember(key, id) {
    const ttl = Number(this.cfg.stickyTtlMin || 0) * 60000;
    if (ttl <= 0) return;
    this.sticky.set(key, { id, exp: Date.now() + ttl });
  }

  /**
   * 计算一个账号的「积分过期压力」= 未来会蒸发掉的积分速率（分/天）。
   *
   * 为什么不是简单按「最早到期」排序：
   *   一个只剩 3 积分、明天到期的号排在最前，为它启号反而浪费换号名额和延迟；
   *   而 5000 积分 / 20 天到期的号每天蒸发 250 分，才是真正的浪费源头。
   *   所以按「剩余积分 / 剩余天数」求日蒸发速率，速率高的优先消耗。
   *
   * 数据来源优先级：
   *   ① acc.quota.packages[]（每个包有 remain + expireAt，最精确）
   *   ② 退到 acc.quota.expireAt + credits（整号只有一个到期时刻时的粗估）
   *   两者都拿不到 → 0（不参与优先，但也不会被排到最后，按原余额逻辑兜底）
   *
   * @param {object} acc 账号
   * @returns {{rate:number, nextExpireAt:number|null, creditsAtRisk:number}}
   */
  expiryPressure(acc) {
    const now = Date.now();
    const q = acc.quota || {};
    let rate = 0;
    let nextAt = null;
    let atRisk = 0;

    const pkgs = Array.isArray(q.packages) ? q.packages : [];
    for (const p of pkgs) {
      if (!p) continue;
      if (p.expired) continue;
      const remain = typeof p.remain === 'number' ? p.remain : null;
      if (remain === null || remain <= 0) continue;
      const exp = p.expireAt;
      if (typeof exp !== 'number' || !isFinite(exp) || exp <= now) continue;
      const days = (exp - now) / 86400000;
      // 不足 1 小时按 1/24 天算，避免除零放大成无穷大
      const d = Math.max(days, 1 / 24);
      rate += remain / d;
      atRisk += remain;
      if (nextAt === null || exp < nextAt) nextAt = exp;
    }

    // 没有任何包级到期信息时，退回账号级 expireAt 粗估
    if (rate === 0) {
      const exp = q.expireAt;
      const credits = typeof q.credits === 'number' ? q.credits : 0;
      if (typeof exp === 'number' && isFinite(exp) && exp > now && credits > 0) {
        const d = Math.max((exp - now) / 86400000, 1 / 24);
        rate = credits / d;
        atRisk = credits;
        nextAt = exp;
      }
    }

    return { rate, nextExpireAt: nextAt, creditsAtRisk: atRisk };
  }

  /** 按策略生成候选账号列表（含故障转移顺序） */
  candidates(stickyId) {
    const pool = this.accounts.usable();
    if (!pool.length) return [];
    const creditsOf = (a) => (a.quota && typeof a.quota.credits === 'number' ? a.quota.credits : 0);
    let ordered = pool.slice();

    if (this.cfg.strategy === 'roundrobin') {
      this.rrIndex = (this.rrIndex + 1) % pool.length;
      ordered = pool.slice(this.rrIndex).concat(pool.slice(0, this.rrIndex));
    } else if (this.cfg.strategy === 'drain') {
      ordered.sort((a, b) => creditsOf(a) - creditsOf(b));
    } else if (this.cfg.strategy === 'expiry') {
      // 过期优先：日蒸发速率高的先消耗；速率相同再比谁更早到期；都相同退到余额多的优先
      ordered.sort((a, b) => {
        const pa = this.expiryPressure(a);
        const pb = this.expiryPressure(b);
        if (pb.rate !== pa.rate) return pb.rate - pa.rate;
        const na = pa.nextExpireAt === null ? Infinity : pa.nextExpireAt;
        const nb = pb.nextExpireAt === null ? Infinity : pb.nextExpireAt;
        if (na !== nb) return na - nb;
        return creditsOf(b) - creditsOf(a);
      });
    } else {
      ordered.sort((a, b) => creditsOf(b) - creditsOf(a));
    }

    if (stickyId) {
      const i = ordered.findIndex((a) => a.id === stickyId);
      if (i > 0) ordered = [ordered[i]].concat(ordered.slice(0, i), ordered.slice(i + 1));
    }
    return ordered;
  }

  /**
   * 「已知 id」集合 = 静态快照 ∪ 白名单 ∪ 上游实时目录。
   *
   * 为什么不能只用静态快照（data/models.json）：
   *   那份快照是 product.json@5.9.3 的静态拷贝（58 个），已经落后于上游。
   *   白名单里的 hy3-b / hy3-c / kimi-k3-1 / space-bunny 都不在快照里，
   *   客户端点名它们时会被解析成 'default' → 再被自动选型改写成别的模型，
   *   「点了 A 却用 B」。实测确认过。
   */
  async knownIds() {
    if (this._knownIdsCache && Date.now() - this._knownIdsCache.at < 60000) {
      return this._knownIdsCache.set;
    }
    const set = new Set(this.loadModels().map((m) => m.id));
    for (const id of this.whitelist()) set.add(id);
    if (this.catalog) {
      const c = await this.catalog.get().catch(() => null);
      if (c && c.ok && Array.isArray(c.models)) {
        for (const m of c.models) if (m && m.id) set.add(m.id);
      }
    }
    this._knownIdsCache = { at: Date.now(), set };
    return set;
  }

  /**
   * 客户端请求的模型名 → 上游真实模型 ID。
   * @param {string} requested
   * @param {Set<string>} [knownOverride] 已知的 id 集合（异步版用）
   */
  resolveUpstreamModel(requested, knownOverride) {
    const want = String(requested || '').trim();
    const known = knownOverride || new Set(this.loadModels().map((m) => m.id));

    // 客户端可能带自定义前缀（如 custom:xxx），剥掉后再比对
    const stripped = want.replace(/^custom(-local)?:/i, '');
    const candidates = [want, stripped];

    for (const c of candidates) {
      if (known.has(c)) return c;
    }
    // 别名表：settings.proxy.modelMap = { "客户端模型名": "上游模型ID" }
    const map = (this.cfg.modelMap && typeof this.cfg.modelMap === 'object') ? this.cfg.modelMap : {};
    for (const c of candidates) {
      if (map[c]) return map[c];
    }
    // 兜底：配置的默认别名，再兜底 default
    const alias = String(this.cfg.modelAlias || '').trim();
    if (alias && known.has(alias)) return alias;
    return 'default';
  }

  /**
   * 真正发出去的上游模型 ID。
   *
   * ★ 优先级（2026-10-30 修正，用户诉求：只留常用模型 + 自定义模型必须算数）：
   *   ① 客户端显式点名的模型（白名单内 / modelMap 自定义映射 / 上游真实 id）
   *      → **原样使用，绝不改写**
   *   ② 客户端什么都没指定（model 为空或 'default'/'auto' 这类占位）
   *      → 才走自动选型：有 0 倍率用免费，否则白名单内倍率最低
   *   ③ 自动选型不可用 → 回落到 modelAlias → default
   *
   * 之前把「白名单外的点名」也交给自动选型接管，导致：
   *   · modelMap 映射到白名单外的自定义名 → 被静默改写成别的模型
   *   · 白名单内但不在过期静态快照里的 id（hy3-b/kimi-k3-1 等）→ 也被改写
   * 两者都是「点了 A 却用 B」，属于静默串模型，必须修。
   */
  async resolveFinalModel(requested) {
    const known = await this.knownIds();
    const base = this.resolveUpstreamModel(requested, known);
    const wl = this.whitelist();
    const auto = this.cfg.autoSelectModel === true;

    // 优先问远端 core（交付版只有这条路；自用未配置 core 时走下面本地实现）
    if (this.coreOn()) {
      const cfg = await this._coreConfig().catch(() => null);
      const r = await this.core.decide({
        requested,
        whitelist: wl,
        modelMap: (this.cfg.modelMap && typeof this.cfg.modelMap === 'object') ? this.cfg.modelMap : {},
        modelAlias: String(this.cfg.modelAlias || '').trim(),
        autoSelect: auto,
        knownIds: Array.from(known),
        config: cfg,
      }).catch(() => null);
      if (r && r.model) {
        if (r.model !== base) {
          this.store.log('info', `[core] 模型决策：${requested || '(auto)'} -> ${r.model}（${r.reason}）`);
        }
        return r.model;
      }
      // core 不可用：允许回落就继续走本地，否则报错（交付版应设 coreFallback=false）
      if (!this.core.allowFallback()) {
        throw new Error('核心决策服务不可用，且未允许本地回落（请检查 settings.proxy.coreUrl）');
      }
      this.store.log('warn', '[core] 决策失败，回落本地实现');
    }

    const want = String(requested || '').trim();
    const stripped = want.replace(/^custom(-local)?:/i, '');
    const map = (this.cfg.modelMap && typeof this.cfg.modelMap === 'object') ? this.cfg.modelMap : {};
    // 占位名：客户端没指定具体模型，用了这些名字就走自动选型
    const PLACEHOLDERS = new Set(['', 'default', 'auto', 'default-1.1', 'default-1.2']);
    const isPlaceholder = PLACEHOLDERS.has(want.toLowerCase()) || PLACEHOLDERS.has(stripped.toLowerCase());

    // ① 显式点名了真实存在的模型 → 原样使用（modelMap 自定义映射也走这里）
    const explicitlyNamed = !isPlaceholder && (known.has(want) || known.has(stripped) || !!map[want] || !!map[stripped]);
    if (explicitlyNamed) {
      const resolved = this.resolveUpstreamModel(requested, known);
      // modelMap 映射的目标如果不在白名单，只要它在上游真实目录里就照样用
      // （用户自己定义的自定义模型，不该被白名单二次裁决）
      return resolved;
    }

    // ② 没指定具体模型（或指定的是占位名）→ 自动选型
    if (auto) {
      const picked = await this.pickCheapest();
      if (picked) return picked;
    }

    // ③ 回落
    if (wl.length) {
      const alias = String(this.cfg.modelAlias || '').trim();
      if (alias && wl.indexOf(alias) >= 0) return alias;
      const firstKnown = wl.find((id) => known.has(id));
      if (firstKnown) return firstKnown;
    }
    return base;
  }

  async handleModels(req, res) {
    if (!this.authorize(req)) return openAiError(res, 401, '访问密钥无效', 'authentication_error', 'invalid_api_key');
    const models = (await this.visibleModels()).map((m) => ({
      id: m.id,
      object: 'model',
      owned_by: 'workbuddy',
      created: 0,
      context_window: m.maxIn || null,
      max_output_tokens: m.maxOut || null,
    }));
    return json(res, 200, { object: 'list', data: models });
  }

  /**
   * 扩展模型目录：除 id 外带上**实时倍率、免费状态、是否在保留列表**。
   *
   * 为什么单独开一个端点而不是改 /v1/models：
   *   /v1/models 是 OpenAI 兼容标准格式，多加非标准字段会让某些严格客户端解析失败。
   *   这个端点用**同一个网关 API Key** 鉴权（非管理员 session），
   *   供 tools/gen_client_models.js 生成桌面端配置时读取，
   *   这样客户端列表与服务端保留列表 / 实时倍率永远一致。
   */
  async handleModelCatalog(req, res) {
    if (!this.authorize(req)) return openAiError(res, 401, '访问密钥无效', 'authentication_error', 'invalid_api_key');
    const wl = this.whitelist();
    const set = wl.length ? new Set(wl) : null;
    let models = [];
    let at = 0;
    if (this.catalog) {
      const c = await this.catalog.get().catch(() => null);
      if (c && c.ok) {
        at = c.at || 0;
        models = c.models.map((m) => ({
          id: m.id,
          name: m.name,
          rate: m.rate,
          baseRate: m.baseRate,
          free: !!m.free,
          rateSource: m.rateSource,
          maxIn: m.maxIn,
          maxOut: m.maxOut,
          tools: m.tools !== false,
          img: !!m.img,
          desc: m.desc || '',
          kept: set ? set.has(m.id) : true,
        }));
      }
    }
    // 上游目录拿不到 → 回落静态快照，至少保证工具能生成配置
    if (!models.length) {
      models = this.loadModels().map((m) => ({
        id: m.id,
        name: m.name,
        rate: null,
        baseRate: null,
        free: false,
        rateSource: 'static',
        maxIn: m.maxIn,
        maxOut: m.maxOut,
        tools: m.tools !== false,
        img: !!m.img,
        desc: m.desc || '',
        kept: set ? set.has(m.id) : true,
      }));
    }
    return json(res, 200, {
      ok: true,
      at,
      stale: !at,
      whitelist: wl,
      autoSelect: this.cfg.autoSelectModel === true,
      models,
    });
  }

  /**
   * 记录每次代理请求的用量明细。
   * 上游 usage 里的 credit 是真实计费值，客户端界面显示的「共消耗」就来自它。
   * 这里把 prompt/completion/reasoning/cache 各段拆开存，方便定位积分花在哪。
   */
  recordUsage(model, account, usage, streamed) {
    const day = new Date().toISOString().slice(0, 10);
    const u = usage || {};
    const det = u.completion_tokens_details || {};
    const total = Number(u.total_tokens) || 0;
    const credit = Number(u.credit) || 0;

    if (total) this.store.bumpStat(day, 'tokens', total);
    if (credit) this.store.bumpStat(day, 'credits', credit);

    const entry = {
      at: Date.now(),
      model,
      account,
      stream: !!streamed,
      prompt: Number(u.prompt_tokens) || 0,
      completion: Number(u.completion_tokens) || 0,
      reasoning: Number(det.reasoning_tokens) || 0,
      cacheHit: Number(u.prompt_cache_hit_tokens) || 0,
      cacheMiss: Number(u.prompt_cache_miss_tokens) || 0,
      total,
      credit,
    };
    if (!Array.isArray(this.store.data.usageLog)) this.store.data.usageLog = [];
    this.store.data.usageLog.unshift(entry);
    if (this.store.data.usageLog.length > 200) this.store.data.usageLog.length = 200;

    this.store.log(
      'info',
      `用量 ${model}@${account} prompt=${entry.prompt}(命中缓存${entry.cacheHit}) `
      + `输出=${entry.completion}(思考${entry.reasoning}) 积分=${credit}`
    );
  }

  /**
   * 缓存友好化处理。
   *
   * 上游有提示词缓存：system prompt + tools 定义完全一致时，后续请求的
   * prompt_cache_hit_tokens 会命中大部分，积分降到 1/20。
   * 但 WorkBuddy 桌面端每次请求的 system prompt 会在 45183/45435 字符之间
   * 波动（工具集按需裁剪），tools 数组顺序也不稳定，导致缓存前缀反复断裂、
   * 每次都按「全量未命中」计费。
   *
   * 这里做两件事：
   *   1) tools 按 function.name 稳定排序 —— 保证前缀字节完全一致；
   *   2) system prompt 里的日期时间戳归一化 —— 让同一段前缀始终相同。
   * 两者都只影响「发给上游的字节」，不改变语义。
   */
  makeCacheFriendly(body) {
    if (!body || typeof body !== 'object') return body;
    const out = { ...body };

    // 1) tools 稳定排序
    if (Array.isArray(out.tools) && out.tools.length > 1) {
      out.tools = out.tools
        .map((t, i) => ({ t, i }))
        .sort((a, b) => {
          const an = String((a.t && a.t.function && a.t.function.name) || '');
          const bn = String((b.t && b.t.function && b.t.function.name) || '');
          return an === bn ? a.i - b.i : (an < bn ? -1 : 1);
        })
        .map((x) => x.t);
    }

    // 2) system prompt 里的时间戳归一化
    const msgs = out.messages;
    if (Array.isArray(msgs)) {
      out.messages = msgs.map((m) => {
        if (!m || typeof m !== 'object' || m.role !== 'system' || typeof m.content !== 'string') return m;
        const norm = m.content
          // ISO 时间戳：2026-10-29T17:03:52.123Z / +08:00
          .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})?/g, '<TIMESTAMP>')
          // 日期：2026-10-29 / 2026/10/29
          .replace(/\d{4}[-/]\d{2}[-/]\d{2}/g, '<DATE>')
          // 时间：17:03:52
          .replace(/\b\d{2}:\d{2}:\d{2}\b/g, '<TIME>');
        return norm === m.content ? m : { ...m, content: norm };
      });
    }
    return out;
  }

  async handleChat(req, res) {
    if (!this.authorize(req)) return openAiError(res, 401, '访问密钥无效', 'authentication_error', 'invalid_api_key');

    let body;
    try {
      body = await readBody(req);
    } catch (err) {
      return openAiError(res, 400, err.message, 'invalid_request_error');
    }
    if (!body || !Array.isArray(body.messages)) {
      return openAiError(res, 400, '缺少 messages 字段', 'invalid_request_error');
    }

    const clientWantsStream = body.stream === true;
    // 应用「白名单 + 自动选型」：客户端要的非白名单模型会被换成当前最省的那个。
    const upstreamModel = await this.resolveFinalModel(body.model);
    // 上游只接受 stream:true，这里统一强制流式，再按客户端需要决定是否聚合
    const cacheFriendly = this.cfg.cacheFriendly !== false;

    const key = this.stickyKey(req, body);
    const stickyId = this.resolveSticky(key);
    const list = this.candidates(stickyId);
    if (!list.length) {
      return openAiError(res, 503, '没有可用账号：请先在控制台添加并启用至少一个账号', 'service_unavailable', 'no_account');
    }

    const maxTry = Math.min(list.length, Number(this.cfg.maxFailover || 2) + 1);
    const errors = [];

    /* 上游 429 是「按账号 × 按模型」独立计数的：所有账号对同一模型都被限时，
       只换账号必然全败 → 对外 502。上游原话也给了出路「可以切换其他模型继续使用」。
       所以先按首选模型跑一轮账号；若全员 429，再换白名单里的下一个模型重跑。 */
    const modelQueue = await this.buildModelQueue(upstreamModel);
    let upstream = null;
    let upstreamModelUsed = upstreamModel;
    let successAcc = null;

    for (let mi = 0; mi < modelQueue.length && !upstream; mi++) {
      const tryModel = modelQueue[mi];
      const upstreamBody = {
        ...(cacheFriendly ? this.makeCacheFriendly(body) : body),
        model: tryModel,
        stream: true,
      };
      // 兼容模式：补齐上游渠道校验指纹（x-domain/x-product/x-request-id…），
      // 否则 deepseek harness 等第三方客户端会被上游判为 unapproved channel (11128)。
      const reqId = `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      /* conversation-id 必须对「同一次客户端对话」稳定：用它驱动本次请求的
       * 首条消息 hash 派生（stickyKey 已是同样思路），而不是每轮随机生成。
       * 同一 requestId 的多次重试复用同一个 conv，形状才和官方客户端一致。 */
      const convId = 'wb2api-conv-' + key.slice(0, 20);
      let allThrottled = true;
      // 渠道风控（11128）静默重发计数：整条请求共享，最多 CHANNEL_RETRY 次
      let channelRetry = 0;
      // 提供方临时不可用（11134）静默重发计数：同上，共享上限
      let busyRetry = 0;
      // 本轮失败是否属于「值得整体再试一轮」的类型（5xx / 超时 / 网络错）
      let sawRetryableFail = false;
      // 全账号 5xx/超时失败后，整体退避重试的轮数上限
      let retryRound = 0;

      for (let i = 0; i < maxTry; i++) {
        const acc = list[i];
        let rsp;
        try {
          // TTFB 首字节超时：响应头 45s 没回来就快速失败换号，避免一个挂起的上游
          // 拖满总超时（300s）—— 实测「选工作站等 3 分半」就是这种场景。
          rsp = await wb.chat(acc, upstreamBody, { ttfbTimeout: Number(this.cfg.ttfbTimeoutMs) || 45000, requestId: reqId, conversationId: convId });
        } catch (err) {
          allThrottled = false;
          sawRetryableFail = true; // 超时/网络错：值得整体退避后再试一轮
          errors.push(`${acc.nickname}[${tryModel}]: ${err.message}`);
          continue;
        }

        const status = rsp.status;
        if (status === 401 || status === 403) {
          allThrottled = false;
          const text = await rsp.text().catch(() => '');
          errors.push(`${acc.nickname}[${tryModel}]: 令牌失效 ${status} ${shortText(text)}`.trim());
          this.accounts.setError(acc, `令牌失效（${status}），请更新令牌`);
          continue;
        }
        if (status === 429 || status >= 500) {
          const text = await rsp.text().catch(() => '');
          /* 11134 提供方临时不可用（HTTP 500 携带）：秒级抖动，退避重发同账号即可，
           * 不消耗 failover 名额。与 11128 同思路：上游原话就是 "please retry"。 */
          if (isProviderBusy(text) && busyRetry < CHANNEL_RETRY) {
            busyRetry += 1;
            const wait = 1500 * Math.pow(2, busyRetry - 1); // 1.5s / 3s / 6s
            this.store.log('warn', `上游模型提供方临时不可用 11134（${tryModel}/${acc.nickname}）第 ${busyRetry} 次，${wait}ms 后重发`);
            await new Promise((r) => setTimeout(r, wait));
            i -= 1;
            continue;
          }
          errors.push(`${acc.nickname}[${tryModel}]: 上游 ${status} ${shortText(text)}`.trim());
          if (status === 429) acc._throttledAt = Date.now();
          else { allThrottled = false; sawRetryableFail = true; }
          continue;
        }
        if (!rsp.ok) {
          const text = await rsp.text().catch(() => '');

          /* 上游渠道风控 11128「Illegal API invocation from an unapproved channel」：
           * 上游原文 displayTips 明确写「这次调用没通过渠道校验…请用官方版本重新发送」，
           * 实测是**概率性动态风控**（同模型同账号同头连发 6 次全 200），不是固定规则。
           * 因此这里静默重发（最多 CHANNEL_RETRY 次），而不是把 400 抛给用户。
           * 重发之间换新的 x-request-id，避免被同一 requestId 关联限流。 */
          if (isChannelBlocked(text) && channelRetry < CHANNEL_RETRY) {
            channelRetry += 1;
            /* 退避策略：上游 displayTips 原文就是「请求被拦截，请重新发送」，
             * 实测重发大概率通过（01:11:43 失败 → 01:13:29 成功）。
             * 逐次加长等待：0.8s / 1.6s / 3.2s，像人在重试，而不是机器猛打。 */
            const wait = 800 * Math.pow(2, channelRetry - 1);
            this.store.log('warn', `上游渠道风控 11128（${tryModel}/${acc.nickname}）第 ${channelRetry} 次，${wait}ms 后重发`);
            await new Promise((r) => setTimeout(r, wait));
            i -= 1; // 同账号同模型重试，不消耗 failover 名额
            continue;
          }

          // 上游 4xx 直接透传前先留全量线索（模型/账号/上游原文），渠道类拒绝
          // （如 11128 unapproved channel）只有这里能看到完整 displayMsg。
          // 渠道被拦时额外记录请求体结构摘要：排查「同样的模型/账号，curl 能过、
          // 客户端不能过」的差异，唯一变量就在 body 里。
          if (isChannelBlocked(text)) {
            try {
              const keys = Object.keys(body || {});
              const msgs = Array.isArray(body.messages) ? body.messages : [];
              const digest = {
                keys,
                model: body.model,
                stream: body.stream,
                msgCount: msgs.length,
                msgLens: msgs.map((m) => ({ r: m && m.role, n: typeof (m && m.content) === 'string' ? m.content.length : -1 })),
                tools: Array.isArray(body.tools) ? body.tools.length : 0,
                toolNames: (body.tools || []).map((t) => (t && t.function && t.function.name) || (t && t.name)).slice(0, 40),
                clientUA: String(req.headers['user-agent'] || '').slice(0, 120),
                clientHdrKeys: Object.keys(req.headers).filter((k) => !/^(cookie|authorization)$/i.test(k)).slice(0, 40),
              };
              this.store.log('warn', '渠道被拦请求摘要（' + tryModel + '）：' + JSON.stringify(digest));
              // 完整头单独一条，避免与摘要一起被截断
              this.store.log('warn', '渠道被拦客户端头（' + tryModel + '）：' + JSON.stringify(req.headers));
            } catch (_) { /* 摘要失败不影响主流程 */ }
          }
          this.store.log('warn', `上游 ${status}（${tryModel}/${acc.nickname}）：${text.slice(0, 500)}`);
          // 同时打到 stdout（进 journald），便于在不读加密库的情况下排查
          console.error('[proxy-fail] ' + status + ' ' + tryModel + ' ' + acc.nickname + ' ' + shortText(text).slice(0, 200));
          return openAiError(res, status, `上游错误：${shortText(text)}`, 'upstream_error', 'upstream_' + status);
        }

        // 拿到可用上游：记下账号与模型，跳出所有循环
        upstream = rsp;
        upstreamModelUsed = tryModel;
        successAcc = acc;
        if (process.env.WB_DEBUG_OUTHDR === '1') console.error('[proxy-ok] ' + tryModel + ' ' + acc.nickname + ' status=' + rsp.status);
        break;
      }

      // 不是「全员限流」（如 401/500/网络错），换模型也无益
      if (!upstream && !allThrottled) {
        /* 全账号都因 5xx / 超时 / 网络错失败（如 11134 提供方故障窗口 +
         * 其余账号 TTFB 超时）：可能是秒级故障，等 4s 整体重试一轮再放弃。
         * channelRetry/busyRetry 跨轮共享上限，不会无限重试。 */
        if (retryRound < 1 && sawRetryableFail) {
          retryRound += 1;
          this.store.log('warn', `全账号上游失败（5xx/超时），4000ms 后整体重试第 ${retryRound} 轮`);
          await new Promise((r) => setTimeout(r, 4000));
          mi = -1; // 下一次迭代 mi++ 回到 0，重走整个模型队列
          allThrottled = true;
          errors.length = 0;
          continue;
        }
        break;
      }
      if (!upstream && allThrottled && errors.length) {
        this.store.log('warn', `模型 ${tryModel} 全员限流，尝试切换下一个模型`);
      }
    }

    if (!upstream) {
      this.store.data.stats.proxyFail += 1;
      this.store.bumpStat(new Date().toISOString().slice(0, 10), 'fail', 1);
      this.store.log('warn', `代理请求全部失败：${errors.join(' | ')}`.slice(0, 300));
      return openAiError(res, 502, `所有账号均失败：${errors.join(' | ').slice(0, 400)}`, 'upstream_error', 'all_failed');
    }
    {
      const acc = successAcc;
      const upstreamModel = upstreamModelUsed;
      // 实际命中的模型与队列首选不同 = 发生过限流切换，留日志便于排查
      if (upstreamModelUsed !== modelQueue[0]) {
        this.store.log('info', `限流切换模型：${modelQueue[0]} -> ${upstreamModel}`);
      }

      this.remember(key, acc.id);
      this.store.data.stats.proxyTotal += 1;
      this.store.bumpStat(new Date().toISOString().slice(0, 10), 'proxy', 1);
      this.store.log('info', `代理请求 -> ${acc.nickname}（${upstreamModel}${clientWantsStream ? ' 流式' : ' 非流式'}）`);

      const ctype = upstream.headers.get('content-type') || '';

      /* ---- 客户端要流式：直接透传上游 SSE ---- */
      if (clientWantsStream) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-wb-account': encodeURIComponent(acc.nickname),
          'x-wb-model': encodeURIComponent(upstreamModel),
        });
        const reader = upstream.body.getReader();
        let usage = null;
        let pending = '';
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            /* ★ 逐行规范化后写出（原先是 res.write(value) 原样透传）。
             * 上游 chunk 的 finish_reason 是 ""、delta 里带 extra_fields，
             * 严格客户端（Qoder）会因此抛「系统发生异常」。
             * 这里按行拆分：能解析成 JSON 的帧重写，其余（注释行 / 空行 /
             * 不完整帧 / [DONE]）原样输出，保证不破坏 SSE 结构。 */
            pending += Buffer.from(value).toString('utf8');
            let nl;
            while ((nl = pending.indexOf('\n')) >= 0) {
              const line = pending.slice(0, nl);
              pending = pending.slice(nl + 1);
              const norm = normalizeSSELine(line);
              res.write((norm === null ? line : norm) + '\n');
              // usage 仍然从原帧里取（规范化不影响 usage 字段，但保持原逻辑位置）
              if (line.startsWith('data:')) {
                const payload = line.slice(5).trim();
                if (payload && payload !== '[DONE]' && payload.indexOf('"usage"') >= 0) {
                  try {
                    const obj = JSON.parse(payload);
                    if (obj && obj.usage) usage = obj.usage;
                  } catch (_) { /* 忽略 */ }
                }
              }
            }
          }
          /* 末尾可能残留没有换行符的半帧：规范化后补写（不加换行，保持原样） */
          if (pending) {
            const norm = normalizeSSELine(pending);
            res.write(norm === null ? pending : norm);
            pending = '';
          }
        } catch (_) {
          /* 客户端断开时静默收尾 */
        }
        res.end();
        this.recordUsage(upstreamModel, acc.nickname, usage || {}, clientWantsStream);
        return undefined;
      }

      /* ---- 客户端要非流式：读干上游 SSE，聚合为标准 chat.completion ---- */
      let raw = '';
      try {
        raw = await upstream.text();
      } catch (err) {
        errors.push(`${acc.nickname}: 读取上游响应失败 ${err.message}`);
        return openAiError(res, 502, `读取上游响应失败：${err.message}`, 'upstream_error', 'read_failed');
      }
      const parsed = parseSSE(raw);
      const errFrame = findErrorFrame(parsed.frames);
      if (errFrame) {
        const msg = errFrame.msg || errFrame.message || shortText(JSON.stringify(errFrame));
        errors.push(`${acc.nickname}: 上游业务错误 ${msg}`.slice(0, 200));
        return openAiError(res, 502, `上游业务错误：${msg}`, 'upstream_error', 'business_error');
      }
      const aggregated = aggregateChunks(parsed.frames, { model: upstreamModel });
      if (!aggregated.choices[0].message.content && !aggregated.choices[0].message.tool_calls
        && !aggregated.choices[0].message.reasoning_content) {
        errors.push(`${acc.nickname}: 上游返回空响应`.slice(0, 200));
        return openAiError(res, 502, '上游返回空响应', 'upstream_error', 'empty_response');
      }
      const text = JSON.stringify(aggregated);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'x-wb-account': encodeURIComponent(acc.nickname),
        'x-wb-model': encodeURIComponent(upstreamModel),
        'cache-control': 'no-store',
      });
      res.end(text);
      this.recordUsage(upstreamModel, acc.nickname, aggregated.usage || {}, clientWantsStream);
      return undefined;
    }
  }

  /**
   * 构造模型候选队列：首选模型在前，其后是白名单里其他可用模型（按当前倍率从省到贵）。
   * 用于「上游 429 全员限流时切换模型重试」。上限 4 个，避免一次请求打太多轮。
   */
  async buildModelQueue(primary) {
    // 优先问远端 core 要队列（交付版不含本地排序策略）
    if (this.coreOn()) {
      const cfg = await this._coreConfig().catch(() => null);
      const q = await this.core.queue(primary, this.whitelist(), cfg, 4).catch(() => null);
      if (q && q.length) return q;
      if (!this.core.allowFallback()) {
        this.store.log('warn', '[core] 队列获取失败，使用仅含首选的队列');
        return [String(primary || '').trim()].filter(Boolean);
      }
      this.store.log('warn', '[core] 队列获取失败，回落本地实现');
    }

    const out = [];
    const seen = new Set();
    const push = (id) => {
      const v = String(id || '').trim();
      if (!v || seen.has(v)) return;
      seen.add(v);
      out.push(v);
    };
    push(primary);
    try {
      const wl = this.whitelist();
      if (wl.length) {
        let catalog = null;
        if (this.catalog) catalog = await this.catalog.get().catch(() => null);
        const rateOf = (id) => {
          if (!catalog || !catalog.ok || !catalog.models) return Number.MAX_SAFE_INTEGER;
          const m = catalog.models.find((x) => x.id === id);
          return m && m.rate !== null && m.rate !== undefined ? m.rate : Number.MAX_SAFE_INTEGER;
        };
        const rest = wl.filter((id) => id !== primary).sort((a, b) => rateOf(a) - rateOf(b));
        for (const id of rest) push(id);
      }
    } catch (e) { /* 队列构造失败就只用首选模型 */ }
    return out.slice(0, 4);
  }
}

module.exports = { Proxy, readBody, json, openAiError };
