'use strict';
/**
 * 会话与访问控制：登录、会话票据、CSRF、登录限流。
 */
const { signSession, readSession, hashPassword, verifyPassword, randomId, safeEqual } = require('./crypto');

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    if (!k) return;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

class Auth {
  constructor(store) {
    this.store = store;
    this.secret = randomId(32);
    this.sessions = new Map(); // sid -> {exp, csrf, ip}
    this.attempts = new Map(); // ip -> {count, first}
  }

  get settings() {
    return this.store.data.settings.security || {};
  }

  isInitialized() {
    return Boolean(this.store.data.admin && this.store.data.admin.passwordHash);
  }

  initPassword(password) {
    this.store.data.admin = {
      passwordHash: hashPassword(password),
      initializedAt: new Date().toISOString(),
    };
    this.store.touch();
  }

  changePassword(current, next) {
    if (!this.isInitialized()) throw new Error('尚未初始化口令');
    if (!verifyPassword(current, this.store.data.admin.passwordHash)) throw new Error('当前口令不正确');
    if (String(next || '').length < 8) throw new Error('新口令至少 8 位');
    this.initPassword(next);
    this.sessions.clear();
  }

  rateLimited(ip) {
    const max = Number(this.settings.loginMaxAttempts || 8);
    const winMs = Number(this.settings.loginWindowMinutes || 10) * 60000;
    const rec = this.attempts.get(ip);
    if (!rec) return false;
    if (Date.now() - rec.first > winMs) {
      this.attempts.delete(ip);
      return false;
    }
    return rec.count >= max;
  }

  recordFailure(ip) {
    const rec = this.attempts.get(ip) || { count: 0, first: Date.now() };
    rec.count += 1;
    this.attempts.set(ip, rec);
  }

  login(password, ip) {
    if (this.rateLimited(ip)) {
      const err = new Error('尝试次数过多，请稍后再试');
      err.code = 'RATE_LIMIT';
      throw err;
    }
    if (!this.isInitialized()) {
      if (String(password || '').length < 8) throw new Error('首次设置口令至少 8 位');
      this.initPassword(password);
      this.attempts.delete(ip);
      return this.createSession(ip);
    }
    if (!verifyPassword(password, this.store.data.admin.passwordHash)) {
      this.recordFailure(ip);
      const err = new Error('口令不正确');
      err.code = 'BAD_PASSWORD';
      throw err;
    }
    this.attempts.delete(ip);
    return this.createSession(ip);
  }

  createSession(ip) {
    const sid = randomId(24);
    const hours = Number(this.settings.sessionHours || 72);
    const exp = Date.now() + hours * 3600000;
    const csrf = randomId(16);
    this.sessions.set(sid, { exp, csrf, ip });
    this.gc();
    const token = signSession({ sid, exp }, this.secret);
    return { token, csrf, exp };
  }

  gc() {
    const now = Date.now();
    for (const [sid, rec] of this.sessions) {
      if (rec.exp < now) this.sessions.delete(sid);
    }
  }

  /** 从请求里取出有效会话 */
  check(req) {
    const cookies = parseCookies(req.headers.cookie);
    const raw = cookies.wb_session || (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!raw) return null;
    const payload = readSession(raw, this.secret);
    if (!payload) return null;
    const rec = this.sessions.get(payload.sid);
    if (!rec || rec.exp < Date.now()) return null;
    return { sid: payload.sid, csrf: rec.csrf };
  }

  logout(req) {
    const cookies = parseCookies(req.headers.cookie);
    const payload = readSession(cookies.wb_session || '', this.secret);
    if (payload) this.sessions.delete(payload.sid);
  }

  verifyCsrf(req, session) {
    if (!session) return false;
    const given = req.headers['x-wb-csrf'] || '';
    return safeEqual(given, session.csrf);
  }
}

module.exports = { Auth, parseCookies };
