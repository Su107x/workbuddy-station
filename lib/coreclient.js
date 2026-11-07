'use strict';
/**
 * core-server 轻客户端：把「决策」转发给远端 core，本地不再保留决策算法。
 *
 * 设计要点：
 *   1. 未配置 core（settings.proxy.coreUrl 为空）→ 所有方法返回 null，
 *      调用方回落到本地实现（自用场景不受影响）。
 *   2. 配置了 core → 调远端；失败时按 coreFallback 决定是否回落本地。
 *   3. 响应验签（x-core-sign），防止中间人篡改决策结果。
 *
 * 交付给买家的版本会删掉本地的 lib/models.js / decide 相关，
 * 此时 coreUrl 必填，core 不可用就直接报错（不静默降级）。
 */
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

class CoreClient {
  constructor(store) {
    this.store = store;
    this._cache = new Map(); // 简单结果缓存：key -> {at, val}
  }

  get cfg() {
    return (this.store.data.settings && this.store.data.settings.proxy) || {};
  }

  /** core 是否已配置 */
  enabled() {
    return !!(this.cfg.coreUrl && String(this.cfg.coreUrl).trim());
  }

  /** 是否允许 core 失败时回落本地 */
  allowFallback() {
    return this.cfg.coreFallback !== false;
  }

  /**
   * 发一个请求到 core。
   * @param {string} path
   * @param {object} body
   * @returns {Promise<object|null>} 成功返回解析后的 JSON；任何失败返回 null
   */
  async request(path, body) {
    if (!this.enabled()) return null;
    const base = String(this.cfg.coreUrl).trim().replace(/\/+$/, '');
    const url = new URL(base + path);
    const lib = url.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body || {});

    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
      accept: 'application/json',
    };
    const token = String(this.cfg.coreLicence || '').trim();
    if (token) headers['x-core-licence'] = token;

    // 请求签名（防重放）：有 coreSecret 才签（交付版一般不带 secret，靠 licence 就够）
    const secret = String(this.cfg.coreSecret || '').trim();
    if (secret.length >= 32) {
      const ts = String(Date.now());
      const nonce = crypto.randomBytes(8).toString('hex');
      headers['x-core-ts'] = ts;
      headers['x-core-nonce'] = nonce;
      headers['x-core-sign'] = crypto.createHmac('sha256', secret)
        .update(ts + '\n' + nonce + '\n' + payload)
        .digest('hex');
    }

    return new Promise((resolve) => {
      const req = lib.request({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search,
        method: 'POST',
        headers,
        timeout: Number(this.cfg.coreTimeoutMs || 8000),
      }, (res) => {
        let raw = '';
        res.on('data', (c) => { raw += c; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            this._log('warn', `core ${path} -> HTTP ${res.statusCode} ${raw.slice(0, 160)}`);
            return resolve(null);
          }
          // 验签（core 配了 secret 才会签，这里只在有 secret 时校验）
          const sig = res.headers['x-core-sign'];
          if (secret.length >= 32 && sig) {
            const expect = crypto.createHmac('sha256', secret).update('resp\n\n' + raw).digest('hex');
            // core 端 signResponse 用的是 signRequest(SECRET,'resp','',body)，即 HMAC('resp\n\n'+body)
            // 注：若与 core 实现不一致会验不过，此时按 allowFallback 处理
            if (expect !== sig) {
              this._log('warn', `core ${path} 响应签名不符，丢弃`);
              return resolve(null);
            }
          } else if (sig && secret.length < 32) {
            // 没配 secret 时无法验签，仅记录一次，不影响使用
            this._logOnce('nosign', 'info', 'core 返回了签名但本地未配置 coreSecret，跳过验签');
          }
          try {
            resolve(JSON.parse(raw));
          } catch (e) {
            this._log('warn', `core ${path} 返回非 JSON`);
            resolve(null);
          }
        });
      });
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.on('error', (e) => {
        this._log('warn', `core ${path} 请求失败: ${e.message}`);
        resolve(null);
      });
      req.write(payload);
      req.end();
    });
  }

  _log(level, msg) {
    try { this.store.log(level, '[core] ' + msg); } catch (_) { /* 忽略 */ }
  }

  _logOnce(key, level, msg) {
    if (!this._once) this._once = new Set();
    if (this._once.has(key)) return;
    this._once.add(key);
    this._log(level, msg);
  }

  /**
   * 决策：最终用哪个模型。
   * @param {object} req { requested, whitelist, modelMap, modelAlias, autoSelect, config, knownIds }
   * @returns {Promise<{model:string, reason:string}|null>} core 不可用返回 null
   */
  async decide(req) {
    const r = await this.request('/v1/core/decide', req);
    if (!r || r.ok !== true || !r.model) return null;
    return { model: String(r.model), reason: String(r.reason || 'core') };
  }

  /**
   * 限流切换队列。
   * @returns {Promise<string[]|null>}
   */
  async queue(primary, whitelist, config, limit) {
    const r = await this.request('/v1/core/queue', { primary, whitelist, config, limit });
    if (!r || r.ok !== true || !Array.isArray(r.queue) || !r.queue.length) return null;
    return r.queue.map((x) => String(x));
  }

  /**
   * 查询授权状态（带 60 秒缓存，避免每次请求都打 core）。
   * @param {object} [opts] { force:true 跳过缓存 }
   * @returns {Promise<{valid:boolean, reason:string, expireAt:number, deviceId:string, plan:string, checkedAt:number}>}
   */
  async licenceStatus(opts) {
    const now = Date.now();
    if (!opts || !opts.force) {
      if (this._lic && now - this._lic.checkedAt < 60000) return this._lic;
    }
    const token = String(this.cfg.coreLicence || '').trim();
    const base = String(this.cfg.coreUrl || '').trim();
    const empty = { valid: false, reason: 'no_licence', expireAt: 0, deviceId: '', plan: '', checkedAt: now };
    if (!base || !token) {
      this._lic = empty;
      return empty;
    }

    let result = null;
    try {
      const url = new URL(base.replace(/\/+$/, '') + '/v1/core/whoami');
      const lib = url.protocol === 'https:' ? https : http;
      result = await new Promise((resolve) => {
        const req = lib.request({
          protocol: url.protocol, hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname, method: 'GET',
          headers: { 'x-core-licence': token, accept: 'application/json' },
          timeout: 6000,
        }, (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            try { resolve(JSON.parse(raw)); } catch (_) { resolve(null); }
          });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', () => resolve(null));
        req.end();
      });
    } catch (_) {
      result = null;
    }

    if (!result || result.ok !== true) {
      // core 连不上：保守起见沿用上一次的有效状态（避免网络抖动导致全线停摆），
      // 但最多容忍 10 分钟。超过就视为无效。
      if (this._lic && this._lic.valid && now - this._lic.checkedAt < 600000) {
        this._lic = Object.assign({}, this._lic, { stale: true, checkedAt: now });
        return this._lic;
      }
      this._lic = Object.assign({}, empty, { reason: 'core_unreachable', checkedAt: now });
      return this._lic;
    }

    this._lic = {
      valid: result.valid === true,
      reason: result.reason || '',
      expireAt: Number(result.expireAt || 0) * 1000,   // core 返回秒，这里转毫秒
      deviceId: result.deviceId || '',
      plan: result.plan || '',
      checkedAt: now,
    };
    return this._lic;
  }

  /** 同步取上次的授权状态（不发起请求），供定时器快速判断 */
  cachedLicence() {
    return this._lic || { valid: false, reason: 'unchecked', expireAt: 0, checkedAt: 0 };
  }

  /** 健康检查 */
  async health() {
    try {
      const base = String(this.cfg.coreUrl || '').trim().replace(/\/+$/, '');
      if (!base) return { ok: false, error: '未配置 coreUrl' };
      const url = new URL(base + '/health');
      const lib = url.protocol === 'https:' ? https : http;
      return await new Promise((resolve) => {
        const req = lib.request({
          hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname, method: 'GET', timeout: 5000,
        }, (res) => {
          let raw = '';
          res.on('data', (c) => { raw += c; });
          res.on('end', () => {
            try { resolve(Object.assign({ httpStatus: res.statusCode }, JSON.parse(raw))); }
            catch (_) { resolve({ ok: false, error: 'bad json' }); }
          });
        });
        req.on('timeout', () => req.destroy(new Error('timeout')));
        req.on('error', (e) => resolve({ ok: false, error: e.message }));
        req.end();
      });
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }
}

module.exports = { CoreClient };
