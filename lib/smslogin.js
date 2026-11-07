'use strict';
/**
 * 手机号 + 短信验证码登录（纯 HTTP，无浏览器）
 *
 * 为什么不用微信扫码：
 *   扫码走的是 Keycloak broker(weixinwebchat)，微信 openid 会形成一个**独立身份**，
 *   未与手机号账号关联时会被要求先补绑手机号（first-broker-login），
 *   即使走通也可能落到空号上。手机号短信登录才会落到用户本来的账号。
 *
 * 链路（auth-v2，实测）：
 *   GET  /auth-v2/realms/copilot/signin/phone/login?platform=website&redirect_uri&state
 *        -> { session_state }
 *   POST /auth-v2/realms/copilot/signin/phone/sms     { session_state, phone }
 *        -> { status: ok|cooldown, request_id }
 *   POST /auth-v2/realms/copilot/signin/phone/verify  { session_state, phone, sms_code }
 *        -> { status: ready_to_login, ticket }
 *           | { status: confirm_bind, confirm_token, phone }
 *   POST /auth-v2/realms/copilot/signin/phone/confirm { session_state, confirm_token }
 *   GET  /auth-v2/realms/copilot/signin/account/select?ticket&enterprise_id&user_id
 *   GET  /auth-v2/realms/copilot/signin/finalize?ticket&response_type=code&session_state&redirect_uri
 *        -> { code, state, iss }
 *   POST /auth-v2/realms/copilot/signin/session       { code, issuer, redirect_uri }  -> 短会话 Cookie
 *   GET  /console/auth/login?platform=web&state=xxx   -> 业务会话 Cookie
 *   GET  /v2/plugin/auth/token?state=xxx              -> { code:0, data:{accessToken,...} }
 */

const crypto = require('crypto');

const BASE = 'https://www.workbuddy.cn';
const APIV2 = BASE + '/auth-v2/realms/copilot';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const TTL_MS = 10 * 60 * 1000; // 一次登录会话 10 分钟

function rid() {
  return crypto.randomBytes(9).toString('hex');
}

/** 极简 Cookie 罐：按 domain+path 存，拼接时只给 www.workbuddy.cn 用 */
class Jar {
  constructor() {
    this.map = new Map(); // name -> value
  }
  absorb(res) {
    let list = [];
    if (typeof res.headers.getSetCookie === 'function') list = res.headers.getSetCookie();
    else {
      const raw = res.headers.get('set-cookie');
      if (raw) list = [raw];
    }
    for (const line of list) {
      const first = String(line).split(';')[0];
      const i = first.indexOf('=');
      if (i <= 0) continue;
      const name = first.slice(0, i).trim();
      const val = first.slice(i + 1).trim();
      const lower = String(line).toLowerCase();
      const expired = /max-age\s*=\s*0\b/.test(lower) || /expires\s*=\s*thu, 01 jan 1970/.test(lower);
      // 只关心业务域，其它域（tgw 路由除外）一律收下也无害
      if (expired) this.map.delete(name);
      else if (val !== '' && val !== 'deleted') this.map.set(name, val);
    }
    return this;
  }
  header() {
    return [...this.map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
  names() {
    return [...this.map.keys()];
  }
}

function qs(obj) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(obj)) if (v !== undefined && v !== null) p.set(k, String(v));
  return p.toString();
}

function normalizePhone(input) {
  let s = String(input || '').replace(/[\s-]/g, '');
  s = s.replace(/^\+?86/, '');
  if (!/^1[3-9]\d{9}$/.test(s)) throw new Error('手机号格式不对，需要 11 位大陆手机号');
  return s;
}

class SmsLogin {
  constructor(store, opts = {}) {
    this.store = store;
    this.sessions = new Map();
    this.max = Number(opts.max || 5);
    this.timer = setInterval(() => this.sweep(), 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.at > TTL_MS) this.sessions.delete(id);
  }

  async req(sess, url, { method = 'GET', json, noAuth = false } = {}) {
    const headers = {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Origin: BASE,
      Referer: BASE + '/login/?product=workbuddy',
    };
    const ck = sess.jar.header();
    if (ck) headers.Cookie = ck;
    if (noAuth) headers['X-No-Authorization'] = 'true';
    let body;
    if (json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(json);
    }
    const res = await fetch(url, { method, headers, body, redirect: 'manual' });
    sess.jar.absorb(res);
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    return { status: res.status, location: res.headers.get('location') || '', text, data };
  }

  /** 第一步：拿 session_state，并立刻发码 */
  async start(phoneRaw) {
    const phone = normalizePhone(phoneRaw);
    if (this.sessions.size >= this.max) {
      // 清掉最老的
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.sessions.delete(oldest[0]);
    }
    const id = 'S' + rid();
    const sess = { id, phone, at: Date.now(), jar: new Jar(), state: 'wb' + rid(), step: 'init', trace: [] };
    sess.redirectUri = `${BASE}/console/auth/login?platform=web&state=${sess.state}`;

    const r = await this.req(
      sess,
      `${APIV2}/signin/phone/login?` + qs({ platform: 'website', redirect_uri: sess.redirectUri, state: sess.state })
    );
    sess.trace.push(`start http=${r.status}`);
    if (r.status !== 200 || !r.data || !r.data.session_state) {
      throw new Error('创建登录会话失败：HTTP ' + r.status + ' ' + r.text.slice(0, 160));
    }
    sess.sessionState = r.data.session_state;
    this.sessions.set(id, sess);

    const sent = await this.sendCode(id);
    return { id, state: sess.state, phone, sms: sent };
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('登录会话不存在或已过期，请重新发起');
    s.at = Date.now();
    return s;
  }

  async sendCode(id) {
    const sess = this.get(id);
    const r = await this.req(sess, `${APIV2}/signin/phone/sms`, {
      method: 'POST',
      json: { session_state: sess.sessionState, phone: sess.phone },
    });
    sess.trace.push(`sms http=${r.status} ${r.data && r.data.status ? r.data.status : ''}`);
    const d = r.data || {};
    if (d.status === 'ok' || d.status === 'cooldown') {
      sess.step = 'sms_sent';
      return { ok: true, status: d.status, retryAfter: Number(d.retry_after || 0) || 60, requestId: d.request_id || '' };
    }
    if (d.error === 'captcha_required') {
      return { ok: false, captcha: true, message: '该号码触发人机校验，请在网页端登录一次后再试' };
    }
    throw new Error('发送验证码失败：' + (d.error_description || d.error || 'HTTP ' + r.status));
  }

  /** 第二步：提交验证码，走完 OIDC 换 token */
  async verify(id, codeRaw) {
    const sess = this.get(id);
    const code = String(codeRaw || '').replace(/\D/g, '');
    if (code.length < 4) throw new Error('验证码位数不对');

    let r = await this.req(sess, `${APIV2}/signin/phone/verify`, {
      method: 'POST',
      json: { session_state: sess.sessionState, phone: sess.phone, sms_code: code },
    });
    sess.trace.push(`verify http=${r.status} ${r.data && r.data.status ? r.data.status : ''}`);
    let d = r.data || {};
    if (r.status >= 400) {
      throw new Error('验证码校验失败：' + (d.error_description || d.error || 'HTTP ' + r.status));
    }

    if (d.status === 'confirm_bind') {
      // 该手机号在另一身份上，需要确认把登录身份绑定/迁移过来
      const c = await this.req(sess, `${APIV2}/signin/phone/confirm`, {
        method: 'POST',
        json: { session_state: sess.sessionState, confirm_token: d.confirm_token },
      });
      sess.trace.push(`confirm http=${c.status} ${c.data && c.data.status ? c.data.status : ''}`);
      if (c.status >= 400) throw new Error('确认绑定手机号失败：' + (c.data && (c.data.error_description || c.data.error)));
      d = c.data || {};
    }

    if (d.status === 'account_select_required') {
      // 多账号：让用户选。个人号一般不会走到这里。
      const ids = (d.accounts || []).map((a) => ({
        uid: a.user_id,
        nickname: a.display_name || a.username || '',
        enterpriseId: a.enterprise_id || '',
      }));
      sess.step = 'need_select';
      sess.accounts = ids;
      sess.selectTicket = d.ticket;
      throw Object.assign(new Error('该手机号关联多个账号，需要选择'), { code: 'select', accounts: ids });
    }

    if (d.status === 'oneid_required') {
      throw new Error('该账号需要走 OneID 授权，暂不支持纯 HTTP 登录');
    }
    if (d.status !== 'ready_to_login' || !d.ticket) {
      throw new Error('登录状态异常：' + JSON.stringify(d).slice(0, 160));
    }
    sess.ticket = String(d.ticket);
    sess.identity = d.identity || null;
    sess.step = 'verified';
    return this.finalize(sess);
  }

  /** 多账号选择（备用） */
  async select(id, uid, enterpriseId) {
    const sess = this.get(id);
    const r = await this.req(
      sess,
      `${APIV2}/signin/account/select?` + qs({ ticket: sess.ticket || sess.selectTicket, enterprise_id: enterpriseId, user_id: uid })
    );
    if (r.status >= 400 || !r.data || !r.data.ticket) throw new Error('选择账号失败');
    sess.ticket = String(r.data.ticket);
    return this.finalize(sess);
  }

  async finalize(sess) {
    const fu =
      `${APIV2}/signin/finalize?` +
      qs({ ticket: sess.ticket, response_type: 'code', session_state: sess.sessionState, redirect_uri: sess.redirectUri });
    let f = await this.req(sess, fu);
    // 账号刚建立时后端可能还没就绪（409 account_not_ready），按官方节奏退避重试
    const waits = [1000, 2000, 5000, 10000, 20000];
    for (let i = 0; f.status === 409 && i < waits.length; i++) {
      sess.trace.push(`finalize 409 retry#${i + 1}`);
      await new Promise((r) => setTimeout(r, waits[i]));
      f = await this.req(sess, fu);
    }
    sess.trace.push(`finalize http=${f.status}`);
    const fd = f.data || {};
    if (!fd.code) throw new Error('换取授权码失败：' + (fd.error_description || fd.error || 'HTTP ' + f.status));

    const s = await this.req(sess, `${APIV2}/signin/session`, {
      method: 'POST',
      json: { code: fd.code, issuer: fd.iss || '', redirect_uri: sess.redirectUri },
    });
    sess.trace.push(`short-session http=${s.status}`);

    // 绑定 state -> 业务会话
    const cl = await this.req(sess, `${BASE}/console/auth/login?` + qs({ platform: 'web', state: sess.state }));
    sess.trace.push(`console-login http=${cl.status} loc=${cl.location ? cl.location.split('?')[0] : '-'}`);

    // 取 token
    let token = null;
    for (let i = 0; i < 6; i++) {
      const t = await this.req(sess, `${BASE}/v2/plugin/auth/token?` + qs({ state: sess.state }), { noAuth: true });
      const td = t.data || {};
      if (td.code === 0 && td.data && td.data.accessToken) {
        token = td.data;
        break;
      }
      sess.trace.push(`token#${i + 1} http=${t.status} code=${td.code} msg=${String(td.msg || '').slice(0, 40)}`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (!token) {
      throw new Error('手机号登录已完成，但换 token 失败（' + sess.trace.slice(-3).join(' | ') + '）');
    }

    sess.step = 'done';
    const cookie = sess.jar.header();
    const cred = {
      uid: String((sess.identity && (sess.identity.user_id || sess.identity.uid)) || ''),
      nickname: String((sess.identity && (sess.identity.display_name || sess.identity.nickname)) || ''),
      enterpriseId: String((sess.identity && sess.identity.enterprise_id) || ''),
      cookie,
      cookieNames: sess.jar.names(),
      token: String(token.accessToken),
      refreshToken: String(token.refreshToken || ''),
      tokenAt: Date.now(),
      expiresIn: Number(token.expiresIn || 0) || 0,
      ua: UA,
      trace: sess.trace,
      via: 'sms',
    };
    if (cred.tokenAt && cred.expiresIn) cred.tokenExpiresAt = cred.tokenAt + cred.expiresIn * 1000;
    sess.credential = cred;
    return cred;
  }

  close(id) {
    this.sessions.delete(id);
  }

  shutdown() {
    clearInterval(this.timer);
  }
}

module.exports = { SmsLogin, normalizePhone, UA };
