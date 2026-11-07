'use strict';
/**
 * 手机号验证码登录（浏览器驱动，服务端自跑）
 *
 * 为什么必须用浏览器：
 *   workbuddy.cn 的「手机号登录」实际是腾讯 OneID（oauth2.account.tencent.com）的嵌入式组件，
 *   发码前页面要先 POST /console/auth/risk-context 拿风控 state，并带 x-device-token（v3:…，
 *   由 tdid/指纹脚本生成）。纯 HTTP 打 auth-v2 的 /signin/phone/sms 会回 status:"ok" 但不下发短信。
 *
 * 实测链路：
 *   POST https://www.workbuddy.cn/console/auth/risk-context?platform=admin -> {state}
 *   POST https://oauth2.account.tencent.com/v1/auth/sms/code/send
 *        {"spi_extra":"{\"v\":1,\"state\":\"<risk state>\",\"src\":\"oneid_pc\",\"biz\":\"login\"}",
 *         "client_code":"codebuddy","mobile":"+86 1xxxxxxxxxx","scopes":["openid","mobile","profile"]}
 *        -> {"captcha":null,"expires_in":21,"status":"unexpired","state_token":"sl_..."}
 *   POST /v1/auth/sms/code/verify -> /v1/auth/accounts -> /v1/auth/select_account -> /v1/customer/authorization
 *   -> 回调 workbuddy -> 业务会话
 */

const { randomId } = require('./crypto');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const LOGIN_URL = 'https://www.workbuddy.cn/login/?product=workbuddy';
const PHONE_SEL = 'input[placeholder*="手机号"]';
const CODE_SEL = 'input[placeholder*="验证码"]';
const TTL_MS = 10 * 60 * 1000;
const MAX_SESSIONS = 3;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const maskPhone = (p) => (p ? p.slice(0, 3) + '****' + p.slice(-4) : '');

// 各阶段的中文说明，供前端轮询进度时展示
const STEP_TEXT = {
  opening: '正在打开登录页…',
  code_sent: '验证码已发送，等待你输入',
  verifying: '正在把验证码填入登录框…',
  waiting: '已提交，等待 workbuddy.cn 确认登录…',
  capturing: '登录成功，正在抓取会话凭证…',
  done: '完成',
  dry: '试运行完成',
};

class PhoneLogin {
  constructor(store, qrlogin) {
    this.store = store;
    this.qr = qrlogin; // 复用同一个 chromium 实例
    this.sessions = new Map();
    this.lastSend = null; // 最近一次发码的真实报文，供排障
    this.timer = setInterval(() => this.sweep(), 60 * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  log(msg, level) {
    try {
      this.store.log(level || 'info', '[手机号登录] ' + msg);
    } catch {}
  }

  sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.at > TTL_MS) this.close(id).catch(() => {});
  }

  get(id) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('登录会话不存在或已超时，请重新发起');
    s.at = Date.now();
    return s;
  }

  /* ---------------- 页面动作 ---------------- */

  async pageText(page, n = 160) {
    try {
      const t = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' '));
      return t.slice(0, n);
    } catch {
      return '';
    }
  }

  /** 等「手机号」页签渲染出来 */
  async waitTab(page, timeout = 30000) {
    try {
      await page.waitForFunction(
        () => [...document.querySelectorAll('*')].some((e) => !e.children.length && (e.textContent || '').trim() === '手机号'),
        { timeout }
      );
      return true;
    } catch {
      return false;
    }
  }

  /** 点「手机号」页签，多套选择器兜底 */
  async clickTab(page) {
    return page.evaluate(() => {
      const leaves = [...document.querySelectorAll('*')].filter((e) => !e.children.length);
      const hits = leaves.filter((e) => (e.textContent || '').trim() === '手机号');
      if (!hits.length) return { ok: false, why: 'no-tab-node' };
      // 页签通常在登录卡片内、宽度较小；优先 class 命中 login-method-text
      hits.sort((a, b) => {
        const ca = /login-method-text/.test(String(a.className)) ? -1 : 0;
        const cb = /login-method-text/.test(String(b.className)) ? -1 : 0;
        if (ca !== cb) return ca - cb;
        return a.getBoundingClientRect().width - b.getBoundingClientRect().width;
      });
      const el = hits[0];
      const target = el.closest('button,div,span,li,a') || el;
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      if (el.click) el.click();
      return { ok: true, cls: String(el.className).slice(0, 40) };
    });
  }

  async hasPhoneInput(page) {
    return (await page.locator(PHONE_SEL).count().catch(() => 0)) > 0;
  }

  /** 打开登录页并切到手机号方式，返回 page 上下文 */
  async openPhoneTab(page, sess) {
    await page.goto(sess.loginUrl || LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const tabOk = await this.waitTab(page, 30000);
    sess.trace.push('tab-rendered=' + tabOk);
    if (!tabOk) throw new Error('登录页没渲染出登录方式页签：' + (await this.pageText(page)));

    if (await this.hasPhoneInput(page)) {
      sess.trace.push('已是手机号方式');
      return;
    }
    for (let i = 0; i < 3; i++) {
      const r = await this.clickTab(page).catch((e) => ({ ok: false, why: e.message }));
      sess.trace.push(`click-tab#${i + 1} ` + JSON.stringify(r).slice(0, 80));
      try {
        await page.waitForSelector(PHONE_SEL, { timeout: 8000 });
        sess.trace.push('phone-input ready');
        return;
      } catch {
        await sleep(1500);
      }
    }
    throw new Error('点了「手机号」页签但没出现手机号输入框：' + (await this.pageText(page)));
  }

  async checkAgreement(page) {
    try {
      return await page.evaluate(() => {
        const box = document.querySelector('.t-checkbox__former, input[type=checkbox]');
        if (!box) return 'no-checkbox';
        if (!box.checked) (box.closest('label') || box).click();
        return box.checked;
      });
    } catch {
      return 'err';
    }
  }

  /* ---------------- 发码 ---------------- */

  /**
   * @param {string} phoneRaw 11 位手机号
   * @param {{dryRun?:boolean}} opts dryRun=true 只走到「填好号码」为止，不发码（自测用）
   */
  async start(phoneRaw, opts = {}) {
    const phone = String(phoneRaw || '').replace(/\D/g, '');
    if (!/^1[3-9]\d{9}$/.test(phone)) throw new Error('手机号格式不对，需要 11 位大陆手机号');

    if (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) await this.close(oldest[0]).catch(() => {});
    }

    const browser = await this.qr.ensureBrowser();
    const ctx = await browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1440, height: 900 },
      userAgent: UA,
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const id = randomId(10);
    // 自选 state：登录页带上它，服务端登录完成后就能用 /v2/plugin/auth/token?state= 换票
    const state = 'wb' + randomId(12);
    const loginUrl = `https://www.workbuddy.cn/login/?platform=website&state=${state}&product=workbuddy`;
    const sess = {
      id, ctx, page, phone, at: Date.now(), step: 'opening', trace: [], smsSend: null, tokenJson: null,
      state, loginUrl,
    };
    this.sessions.set(id, sess);

    try {
      await this.openPhoneTab(page, sess);

      const cb = await this.checkAgreement(page);
      sess.trace.push('agreement=' + cb);
      await sleep(400);

      const input = page.locator(PHONE_SEL).first();
      await input.click({ timeout: 8000 });
      await page.keyboard.type(phone, { delay: 45 });
      await sleep(500);
      const typed = await input.inputValue().catch(() => '');
      sess.trace.push('typed=' + typed);

      if (opts.dryRun) {
        sess.step = 'dry';
        return { id, phone, dryRun: true, typed, trace: sess.trace };
      }
      if (typed.replace(/\D/g, '') !== phone) {
        throw new Error('手机号没填进去（当前值：' + (typed || '空') + '）');
      }

      // 录发码请求（含请求体，用于核对实际发出的号码）
      page.on('request', (req) => {
        const u = req.url();
        if (!/sms\/code\/(send|init)/.test(u)) return;
        sess.smsReq = { url: u, body: String(req.postData() || '').slice(0, 800) };
      });
      page.on('response', async (res) => {
        const u = res.url();
        if (!/sms\/code\/(send|init)/.test(u)) return;
        try {
          sess.smsSend = { url: u, status: res.status(), body: (await res.text()).slice(0, 800) };
        } catch {}
      });

      const clicked = await this.clickSend(page);
      sess.trace.push('click-send=' + clicked);
      if (!clicked) throw new Error('没找到「获取验证码」按钮：' + (await this.pageText(page)));

      for (let i = 0; i < 20 && !sess.smsSend; i++) await sleep(500);
      const txt = await this.pageText(page, 200);
      sess.trace.push('after-send: ' + txt);
      if (!sess.smsSend) throw new Error('点了发码但请求没发出去：' + txt.slice(0, 100));

      let sb = {};
      try {
        sb = JSON.parse(sess.smsSend.body);
      } catch {}
      if (sess.smsSend.status >= 400) {
        throw new Error('发码接口返回 ' + sess.smsSend.status + '：' + String(sess.smsSend.body).slice(0, 120));
      }
      if (sb.captcha) throw new Error('该号码触发了图形验证码，请在浏览器里人工过一下再重试');

      sess.step = 'code_sent';
      this.log(`已向 ${maskPhone(phone)} 发送验证码（HTTP ${sess.smsSend.status}）`);
      this.lastSend = {
        at: new Date().toISOString(),
        masked: maskPhone(phone),
        status: sess.smsSend.status,
        response: sess.smsSend.body,
        request: sess.smsReq ? sess.smsReq.body : null,
      };
      return {
        id,
        phone,
        masked: maskPhone(phone),
        sent: true,
        expiresIn: Number(sb.expires_in || 0) || 60,
        ...(opts.debug ? { sentReq: sess.smsReq, sentBody: sess.smsSend.body, trace: sess.trace } : {}),
      };
    } catch (err) {
      sess.trace.push('ERR ' + err.message);
      this.log('发码失败：' + err.message + ' | ' + sess.trace.join(' > '), 'warn');
      this.sessions.delete(id);
      await ctx.close().catch(() => {});
      throw err;
    }
  }

  async clickSend(page) {
    return page.evaluate(() => {
      const leaves = [...document.querySelectorAll('*')].filter((e) => !e.children.length);
      const btn = leaves.find((el) => /获取验证码|重新获取/.test((el.textContent || '').trim()));
      if (!btn) return false;
      (btn.closest('button,div,span,a') || btn).dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
      return true;
    });
  }

  async resend(id) {
    const sess = this.get(id);
    sess.smsSend = null;
    const ok = await this.clickSend(sess.page);
    if (!ok) throw new Error('没有可点的发码按钮');
    for (let i = 0; i < 20 && !sess.smsSend; i++) await sleep(500);
    if (!sess.smsSend) throw new Error('点了重发但请求没发出去');
    if (sess.smsSend.status >= 400) throw new Error('发码接口返回 ' + sess.smsSend.status);
    let sb = {};
    try {
      sb = JSON.parse(sess.smsSend.body);
    } catch {}
    if (sb.captcha) throw new Error('该号码触发了图形验证码，需要人工处理');
    this.log(`重发验证码 → ${maskPhone(sess.phone)}`);
    this.lastSend = {
      at: new Date().toISOString(),
      masked: maskPhone(sess.phone),
      status: sess.smsSend.status,
      response: sess.smsSend.body,
      request: sess.smsReq ? sess.smsReq.body : null,
    };
    return { ok: true, masked: maskPhone(sess.phone), retryAfter: 60, expiresIn: Number(sb.expires_in || 0) || 60 };
  }

  /* ---------------- 提交验证码 ---------------- */

  /** 从 localStorage / sessionStorage 里翻 token、refreshToken、uid */
  async harvest(page, sess) {
    const out = { token: '', refresh: '', uid: '' };
    try {
      const dump = await page.evaluate(() => {
        const o = {};
        try {
          for (const k of Object.keys(localStorage)) o['ls:' + k] = localStorage.getItem(k);
        } catch {}
        try {
          for (const k of Object.keys(sessionStorage)) o['ss:' + k] = sessionStorage.getItem(k);
        } catch {}
        return o;
      });
      if (!sess.lsKeys) {
        sess.lsKeys = Object.keys(dump).join(',');
        sess.trace.push('storage=' + String(sess.lsKeys).slice(0, 200));
      }
      for (const [k, v] of Object.entries(dump)) {
        if (!v) continue;
        if (/access_?token/i.test(k) && v.length > 20) out.token = out.token || v;
        if (/refresh_?token/i.test(k) && v.length > 10) out.refresh = out.refresh || v;
        if (/(uid|user_?id)/i.test(k) && /^\d{6,25}$/.test(v)) out.uid = out.uid || v;
        try {
          const walk = (o2, d = 0) => {
            if (!o2 || typeof o2 !== 'object' || d > 5) return;
            for (const [kk, vv] of Object.entries(o2)) {
              if (typeof vv === 'string') {
                if (/access_?token/i.test(kk) && vv.length > 20) out.token = out.token || vv;
                if (/refresh_?token/i.test(kk) && vv.length > 10) out.refresh = out.refresh || vv;
                if (/(^|_)(uid|user_?id)$/i.test(kk) && /^\d{6,25}$/.test(vv)) out.uid = out.uid || vv;
              } else walk(vv, d + 1);
            }
          };
          walk(JSON.parse(v));
        } catch {}
      }
    } catch {}
    return out;
  }

  async verify(id, codeRaw) {
    const sess = this.get(id);
    const code = String(codeRaw || '').replace(/\D/g, '');
    if (code.length < 4) throw new Error('验证码位数不对');
    const page = sess.page;
    sess.step = 'verifying';
    sess.verifyAt = Date.now();

    // 嗅探一切可能带 token 的响应
    page.on('request', (req) => {
      if (!/workbuddy\.cn/.test(req.url())) return;
      const h = req.headers() || {};
      const auth = h.authorization || h.Authorization || '';
      if (/^Bearer\s+\S{8,}/i.test(auth)) {
        sess.bearer = auth.replace(/^Bearer\s+/i, '').trim();
        const uid = h['x-user-id'] || h['x-uid'] || '';
        if (uid && /^\d{6,25}$/.test(uid)) sess.bearerUid = uid;
        sess.trace.push('bearer captured');
      }
    });
    page.on('response', async (res) => {
      const u = res.url();
      if (res.status() >= 400) return;
      if (!/token|auth|login|signin|authorization/i.test(u)) return;
      try {
        const t = await res.text();
        if (!/access_?token|accessToken/i.test(t)) return;
        const m = t.match(/\{[\s\S]*\}/);
        if (!m) return;
        const deep = (o, d = 0) => {
          if (!o || typeof o !== 'object' || d > 6) return null;
          if (o.accessToken || o.access_token) return o;
          for (const v of Object.values(o)) {
            const r = deep(v, d + 1);
            if (r) return r;
          }
          return null;
        };
        const hit = deep(JSON.parse(m[0]));
        if (hit) {
          sess.tokenJson = hit;
          sess.trace.push('token-sniff@' + u.split('?')[0] + ' keys=' + Object.keys(hit).join(','));
        }
      } catch {}
    });

    try {
      await page.waitForSelector(CODE_SEL, { timeout: 15000 });
    } catch {
      throw new Error('页面上没有验证码输入框：' + (await this.pageText(page)));
    }
    const codeInput = page.locator(CODE_SEL).first();
    await codeInput.click({ timeout: 8000 });
    await page.keyboard.type(code, { delay: 50 });
    await sleep(400);
    sess.trace.push('code-typed=' + (await codeInput.inputValue().catch(() => '?')));

    let submitted = await page.evaluate(() => {
      const leaves = [...document.querySelectorAll('*')].filter((e) => !e.children.length);
      const btn = leaves.find((el) => /^手机号登录$/.test((el.textContent || '').trim())) ||
        leaves.find((el) => /^登录$/.test((el.textContent || '').trim()));
      if (!btn) return false;
      (btn.closest('button,div,span,a') || btn).dispatchEvent(new MouseEvent('click', { bubbles: true, view: window }));
      return true;
    });
    if (!submitted) {
      sess.trace.push('submit-btn-not-found → 回车');
      await codeInput.press('Enter').catch(() => {});
    } else {
      sess.trace.push('submit-clicked');
    }
    sess.step = 'waiting';

    let done = false;
    for (let i = 0; i < 40; i++) {
      await sleep(1500);
      const url = page.url();
      if (sess.tokenJson || !/\/login/.test(url)) {
        done = true;
        sess.trace.push('settled@' + i + ' url=' + url.slice(0, 120));
        break;
      }
      // 页面已经给出明确失败（验证码错误/过期/频繁），不用等满 60 秒
      if (i % 2 === 1) {
        const t = await this.pageText(page, 300);
        const m = t.match(/验证码[^，。]{0,12}(错误|有误|不正确|失效|过期)|验证码已失效|操作频繁|请稍后再试|账号[^，。]{0,10}异常/);
        if (m) {
          sess.trace.push('page-error: ' + m[0]);
          throw new Error(m[0] + '（请重新发送验证码再试）');
        }
      }
    }
    if (!done) throw new Error('提交后没有完成登录：' + (await this.pageText(page)));
    sess.step = 'capturing';

    const cap = await this.capture(page, sess);
    if (!cap.token) {
      sess.at = Date.now(); // 保住这个已登录的页面，允许再抓一次
      this.log('登录完成但没抓到 token：' + sess.trace.slice(-6).join(' > '), 'warn');
      const e = new Error('登录已完成但没抓到 accessToken（会话已保留，可重试抓取，不用再发短信）');
      e.trace = sess.trace.filter((t) => /storage=|bearer|goto-console|direct=|settled|token-sniff/.test(t));
      e.bearer = sess.bearer ? sess.bearer.slice(0, 12) + '…' : '';
      e.url = String(page.url()).slice(0, 120);
      throw e;
    }
    const cred = this.credFrom(sess, cap);
    await this.close(id).catch(() => {});
    return cred;
  }

  /** 用 state 绑定的服务端换票接口取 accessToken（匿名可达，未完成返回 11217） */
  async pollToken(sess) {
    if (!sess.state) return null;
    let cookies = [];
    try {
      cookies = await sess.ctx.cookies('https://www.workbuddy.cn');
    } catch {
      cookies = await sess.ctx.cookies().catch(() => []);
    }
    const ck = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    const url = `https://www.workbuddy.cn/v2/plugin/auth/token?state=${encodeURIComponent(sess.state)}`;
    // 必须带超时：上游偶发长时间不返回时，没有 AbortSignal 会让整个登录永久挂住，
    // 前端按钮一直停在「登录中…」，用户既看不到错误也点不动。
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: {
          Accept: 'application/json',
          'X-No-Authorization': 'true',
          Cookie: ck,
          'User-Agent': UA,
          Referer: 'https://www.workbuddy.cn/console/',
        },
      });
      const j = await r.json().catch(() => null);
      return j;
    } finally {
      clearTimeout(t);
    }
  }

  /** 登录后抓凭证：state 换票 → 轮询 storage → 进控制台 → 抓 Bearer 头 */
  async capture(page, sess) {
    // 主路径：state 绑定换票
    let tokenJson = null;
    for (let i = 0; i < 60; i++) {
      const j = await this.pollToken(sess).catch(() => null);
      if (j) {
        sess.trace.push(`token#${i} code=${j.code} ${j.msg || ''}`.trim());
        if (j.code === 0 && j.data && (j.data.accessToken || j.data.access_token)) {
          tokenJson = j.data;
          break;
        }
        if (j.code && j.code !== 11217) {
          sess.trace.push('token-endpoint-code=' + j.code + ' ' + (j.msg || j.error || ''));
        }
      }
      if (sess.bearer) break;
      // 已经从 storage 拿到 token 就不用继续等换票接口（11217 表示尚未就绪）
      if (sess.tokenJson && (sess.tokenJson.accessToken || sess.tokenJson.access_token)) break;
      sess.step = 'capturing';
      await sleep(2000);
    }
    if (tokenJson) {
      sess.tokenJson = Object.assign({}, sess.tokenJson || {}, tokenJson);
      sess.trace.push('state-token ok');
    }

    let hv = await this.harvest(page, sess);
    for (let i = 0; i < 10 && !hv.token && !sess.bearer && !tokenJson; i++) {
      await sleep(2000);
      hv = await this.harvest(page, sess);
    }
    if (!hv.token && !sess.bearer && !tokenJson) {
      sess.trace.push('goto-console from=' + page.url().slice(0, 100));
      await page.goto('https://www.workbuddy.cn/console/', { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
      for (let i = 0; i < 10 && !hv.token && !sess.bearer && !tokenJson; i++) {
        await sleep(2000);
        hv = await this.harvest(page, sess);
      }
    }
    const cookies = await sess.ctx.cookies().catch(() => []);
    const wb = cookies.filter((c) => /workbuddy/.test(c.domain));
    const tj = sess.tokenJson || {};
    return {
      token: String(sess.bearer || tj.accessToken || tj.access_token || hv.token || ''),
      refresh: String(tj.refreshToken || tj.refresh_token || hv.refresh || ''),
      uid: String(sess.bearerUid || tj.userId || tj.uid || hv.uid || ''),
      cookie: wb.map((c) => `${c.name}=${c.value}`).join('; '),
      cookieNames: wb.map((c) => c.name),
      expiresIn: Number(tj.expiresIn || tj.expires_in || 0) || 0,
    };
  }

  /**
   * 查询登录会话的当前进度（前端轮询用，避免长时间「登录中…」看着像卡死）。
   * @returns {{ok:boolean,step:string,stepText:string,elapsed:number,trace:string[]}}
   */
  status(id) {
    const s = this.sessions.get(id);
    if (!s) {
      return { ok: false, step: 'gone', stepText: '登录会话不存在或已超时，请重新发起', elapsed: 0, trace: [] };
    }
    const step = String(s.step || 'opening');
    const since = s.verifyAt || s.at || Date.now();
    return {
      ok: true,
      step,
      stepText: STEP_TEXT[step] || '处理中',
      elapsed: Math.round((Date.now() - since) / 1000),
      trace: (s.trace || []).slice(-6),
    };
  }

  credFrom(sess, cap) {
    const tj = sess.tokenJson || {};
    const cred = {
      uid: cap.uid,
      nickname: String(tj.nickname || tj.userName || ''),
      phone: String(sess.phone || ''),
      cookie: cap.cookie,
      cookieNames: cap.cookieNames,
      token: cap.token,
      refreshToken: cap.refresh,
      tokenAt: Date.now(),
      expiresIn: cap.expiresIn,
      ua: UA,
      trace: sess.trace,
      via: 'phone-browser',
    };
    if (cred.expiresIn) cred.tokenExpiresAt = cred.tokenAt + cred.expiresIn * 1000;
    sess.step = 'done';
    sess.credential = cred;
    return cred;
  }

  /** 登录已完成但没抓到 token 时，在同一个已登录页面里再抓一次 */
  async retryHarvest(id) {
    const sess = this.get(id);
    const cap = await this.capture(sess.page, sess);
    if (!cap.token) throw new Error('仍然没抓到 accessToken：' + sess.trace.slice(-4).join(' > '));
    const cred = this.credFrom(sess, cap);
    await this.close(id).catch(() => {});
    return cred;
  }

  async close(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    this.sessions.delete(id);
    await s.ctx.close().catch(() => {});
  }

  async shutdown() {
    clearInterval(this.timer);
    for (const id of [...this.sessions.keys()]) await this.close(id).catch(() => {});
  }
}

module.exports = { PhoneLogin, UA };
