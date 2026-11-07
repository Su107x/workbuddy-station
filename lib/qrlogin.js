'use strict';
/**
 * 扫码登录（服务端接管浏览器）
 *
 * 背景与结论（2026-10 实测）：
 *   - 网页版登录页 https://www.workbuddy.cn/login/ 内部是一个 iframe，先跳
 *     Keycloak（/auth/realms/copilot/protocol/openid-connect/auth，client_id=console，
 *     scope 含 offline_access），再由 Keycloak 的 weixinwebchat IdP 提供
 *     「微信扫码登录」，二维码来自 open.weixin.qq.com/connect/qrconnect 的微信开放平台 appid。
 *   - 网页版对业务接口（/v2/*、/activity/growth/*、/console/*）不发 Authorization，
 *     全靠 APISIX 的 openid-connect 会话 Cookie（名为 session）。网关对无凭证请求
 *     直接返回 APISIX 的 401 HTML，与业务层无关。
 *   - 因此手工复制 Cookie 极易失效（会话绑定、路径、过期）；正确做法是让服务器
 *     自己把这个登录页跑起来，二维码交给用户扫，登录完成后由服务器把会话 Cookie 收走。
 *
 * 本模块就干这一件事：一个扫码任务 = 一个独立的浏览器上下文。
 *   start()  → { id, qr, expiresAt }
 *   status() → { status: pending|scanned|success|expired|error|canceled, qr?, credential? }
 *
 * 浏览器解析顺序：WB_CHROMIUM_PATH → 打包/系统 chromium；Windows 开发机回落到 msedge。
 */

const crypto = require('crypto');
const { randomId } = require('./crypto');

const LOGIN_URL = 'https://www.workbuddy.cn/login/?platform=website&state=2&product=workbuddy';
const HOME_URL = 'https://www.workbuddy.cn/profile/growth-center';
const ORIGIN = 'https://www.workbuddy.cn';
const SESSION_TTL = 5 * 60 * 1000; // 微信二维码本身约 5 分钟有效
const MAX_SESSIONS = 3;

/**
 * 登录链路的真实形态（2026-10-28 从官方前端包逆向确认，非猜测）：
 *
 *   1. 打开 /login/?platform=web&state=<STATE>&product=workbuddy
 *      页面内部 → GET /auth/realms/copilot/console/auth/wechat-url
 *        ?client_id=login&response_type=code&self_redirect=true
 *        &kc_idp_hint=weixinwebchat&prompt=login&redirect_uri=<上面那个 URL>
 *      → 返回 {url: "https://open.weixin.qq.com/connect/qrconnect?..."}，二维码即来自此
 *
 *   2. 微信扫码（用户已登录时手机端无二次确认，扫完即完成）→ Keycloak 回调带 code
 *
 *   3. 官方 SPA 的换 token 顺序是：
 *        ye(state) → GET /console/auth/login?platform=web&state=<STATE>   （完成登录，APISIX 下发 session）
 *        ns(state) → GET /v2/plugin/auth/token?state=<STATE>            （头带 X-No-Authorization: true）
 *                    → {code:0, data:{accessToken, refreshToken, expiresIn}}
 *      未完成时 code=11217 "login ing..."。
 *
 *   4. 业务接口一律 Authorization: Bearer <accessToken>（官方 axios withCredentials:false），
 *      **不依赖 Cookie** —— 这正是之前拿 Cookie 打 /v2/* 一直 401 的原因。
 *
 * 所以本模块的做法：state 自选（随机串），浏览器只负责「出码 + 让微信扫码」，
 * 凭证一律由服务端用 state 去 /v2/plugin/auth/token 轮换取。
 */
function makeState() {
  return 'wb' + crypto.randomBytes(12).toString('hex');
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 空闲自动关闭浏览器的等待时长（毫秒）。
 *
 * 为什么要这个：浏览器实例是**跨扫码任务复用**的（ensureBrowser 缓存 this.browser），
 * 以前只在进程退出时才 close —— 也就是说，只要扫码登录过一次，Chromium 就永久常驻
 * （Windows 300~500MB、Linux 200~350MB）。在 2GB 内存的小服务器上这是致命的：
 * 系统本身 + Node + 常驻 Chromium 会长期贴着上限，一有峰值就 OOM 或疯狂换页。
 *
 * 所以改成：没有活跃扫码任务后，空闲 N 分钟自动关掉浏览器；下次扫码再拉起。
 * 代价只是下一次登录多等 1~2 秒（浏览器冷启动），换掉几百 MB 常驻内存，值。
 *
 * 用环境变量 WB_BROWSER_IDLE_MINUTES 调整，设为 0 表示不自动关闭（退回旧行为）。
 */
function browserIdleMs() {
  const raw = (process.env.WB_BROWSER_IDLE_MINUTES || '').trim();
  if (raw === '') return 10 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 10 * 60 * 1000;
  return Math.floor(n * 60 * 1000);
}

class QRLogin {
  constructor(store) {
    this.store = store;
    this.browser = null;
    this.sessions = new Map();
    this.results = new Map(); // 已完成任务的结果缓存，供前端最后几次轮询取回
    this.launching = null;
    this.idleTimer = null;
  }

  /* ---------------- 浏览器生命周期 ---------------- */

  /** 取消「空闲自动关闭」倒计时（浏览器正在被使用） */
  cancelBrowserIdle() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  /** 没有活跃任务时，空闲一段时间后释放浏览器常驻内存 */
  scheduleBrowserIdle() {
    this.cancelBrowserIdle();
    const ms = browserIdleMs();
    if (ms <= 0) return; // 0 = 不自动关闭
    if (!this.browser) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      // 还有活跃任务就再等一轮（任务自己结束时会走 close(id) 重新计时，
      // 这里兜住「任务被遗弃、没人调 close」的情况）
      if (this.sessions.size > 0) {
        this.scheduleBrowserIdle();
        return;
      }
      const b = this.browser;
      if (!b) return;
      this.browser = null;
      this.launching = null;
      b.close().catch(() => {});
      if (this.store && this.store.log) {
        this.store.log('info', '浏览器已空闲，自动关闭以释放内存（下次扫码会重新拉起）');
      }
    }, ms);
    // 别让这个定时器吊住进程退出
    if (typeof this.idleTimer.unref === 'function') this.idleTimer.unref();
  }

  async ensureBrowser() {
    this.cancelBrowserIdle();
    if (this.browser && this.browser.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      let chromium;
      try {
        chromium = require('playwright-core').chromium;
      } catch (err) {
        throw new Error('缺少浏览器驱动依赖，请先执行 npm install（需要 playwright-core）');
      }
      const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--mute-audio',
        '--disable-blink-features=AutomationControlled',
      ];
      const exe = (process.env.WB_CHROMIUM_PATH || process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || '').trim();
      const attempts = [];
      if (exe) attempts.push({ executablePath: exe });
      if (process.platform === 'win32') attempts.push({ channel: 'msedge' });
      attempts.push({ channel: 'chrome' });
      attempts.push({}); // 依赖 playwright 安装的 chromium

      let lastErr = null;
      for (const extra of attempts) {
        try {
          const b = await chromium.launch({ headless: true, args, ...extra });
          b.on('disconnected', () => {
            if (this.browser === b) this.browser = null;
          });
          this.browser = b;
          this.scheduleBrowserIdle(); // 拉起就开始倒计时，避免空转常驻
          return b;
        } catch (err) {
          lastErr = err;
        }
      }
      throw new Error(
        '无法启动浏览器内核：' +
          (lastErr && lastErr.message ? lastErr.message.split('\n')[0] : '未知错误') +
          '。请设置环境变量 WB_CHROMIUM_PATH 指向 Chromium 可执行文件。'
      );
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  /* ---------------- 二维码提取 ---------------- */

  /** 在页面所有 frame 里找微信二维码 img，返回 { frame, src } */
  async locateQR(page) {
    for (const f of page.frames()) {
      if (!/open\.weixin\.qq\.com/.test(f.url())) continue;
      try {
        const src = await f.evaluate(() => {
          const img = document.querySelector('img.img') || document.querySelector('img');
          return img ? img.getAttribute('src') || '' : '';
        });
        if (src) return { frame: f, src };
      } catch (_) {
        /* frame 正在导航，下一轮再试 */
      }
    }
    return null;
  }

  /** 抓二维码图片二进制：优先直接下载（原图 470px），失败则元素截图 */
  async fetchQR(page, found) {
    const abs = found.src.startsWith('http') ? found.src : new URL(found.src, found.frame.url()).toString();
    try {
      const res = await page.context().request.get(abs, {
        timeout: 15000,
        headers: { referer: found.frame.url() },
      });
      const ct = String(res.headers()['content-type'] || '');
      if (res.ok() && /image\//.test(ct)) {
        const buf = await res.body();
        if (buf && buf.length > 500) {
          return { dataUrl: 'data:' + ct.split(';')[0] + ';base64,' + buf.toString('base64'), src: abs };
        }
      }
    } catch (_) {
      /* 落到截图 */
    }
    try {
      const el = await found.frame.$('img.img');
      const target = el || (await found.frame.$('img'));
      if (target) {
        const buf = await target.screenshot({ type: 'png' });
        return { dataUrl: 'data:image/png;base64,' + buf.toString('base64'), src: abs };
      }
    } catch (_) {
      /* ignore */
    }
    return null;
  }

  /* ---------------- 任务 ---------------- */

  /** 启动一个扫码任务 */
  async start() {
    if (this.sessions.size >= MAX_SESSIONS) {
      // 清掉最老的已结束任务腾位置
      const idle = [...this.sessions.values()].filter((s) => s.done).sort((a, b) => a.createdAt - b.createdAt);
      if (idle.length) await this.close(idle[0].id);
      if (this.sessions.size >= MAX_SESSIONS) throw new Error(`同时最多 ${MAX_SESSIONS} 个扫码任务，请先关掉不用的`);
    }

    const browser = await this.ensureBrowser();
    const ctx = await browser.newContext({
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      viewport: { width: 1280, height: 900 },
      userAgent: UA,
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    const id = randomId(10);
    const state = makeState();
    const sess = {
      id,
      ctx,
      page,
      state,
      status: 'pending',
      qr: '',
      qrSrc: '',
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL,
      error: '',
      credential: null,
      done: false,
      timer: null,
      trace: [], // 全过程轨迹，失败时用于定位
      probeTries: 0,
      tokenTries: 0,
      lastTokenPoll: 0,
    };
    this.sessions.set(id, sess);

    // 全过程观测：URL 变迁 + 业务请求（只读，不干预页面）
    page.on('framenavigated', (f) => {
      try {
        if (f === page.mainFrame() && sess.trace.length < 300) sess.trace.push('nav: ' + f.url().slice(0, 250));
      } catch (_) {
        /* ignore */
      }
    });
    page.on('response', (res) => {
      try {
        const u = res.url();
        if (!/workbuddy\.cn/.test(u)) return;
        // 只读嗅探：页面自己换 token 的响应体里就有 accessToken / refreshToken。
        // 这是最可靠的信源——页面怎么成功，我们就照抄什么，绝不自己去猜。
        if (/\/v2\/plugin\/auth\/token/.test(u)) {
          res
            .text()
            .then((txt) => {
              let j = null;
              try {
                j = JSON.parse(txt);
              } catch (_) {
                /* not json */
              }
              if (j && j.code === 0 && j.data && (j.data.accessToken || j.data.access_token)) {
                sess.tokenSniffed = {
                  accessToken: j.data.accessToken || j.data.access_token || '',
                  refreshToken: j.data.refreshToken || j.data.refresh_token || '',
                  expiresIn: j.data.expiresIn || j.data.expires_in || 0,
                };
                if (!sess.tokenSniffedAt) sess.tokenSniffedAt = Date.now();
                if (sess.trace.length < 300) sess.trace.push('✅ 页面自行换到 token（已嗅探捕获）');
              } else if (j && j.code !== 11217 && sess.trace.length < 300) {
                sess.trace.push('页面换 token 返回 code=' + j.code + ' ' + String(j.msg || '').slice(0, 60));
              }
            })
            .catch(() => {});
          return;
        }
        if (!/\/(v2|activity|console)\//.test(u)) return;
        if (sess.trace.length < 300) sess.trace.push('res: ' + res.status() + ' ' + u.replace(ORIGIN, '').slice(0, 200));
      } catch (_) {
        /* ignore */
      }
    });
    // 关键观测：页面自己发业务请求时到底带 Authorization 还是只靠 Cookie。
    // 这决定了服务端该用哪种凭证去复现会话。
    page.on('request', (req) => {
      try {
        const u = req.url();
        if (!/workbuddy\.cn/.test(u)) return;
        if (!/\/(v2|activity|console)\//.test(u)) return;
        const h = req.headers();
        if (h.authorization && !sess.authSeen) {
          sess.authSeen = h.authorization.slice(0, 24) + '…';
          sess.authRaw = h.authorization;
          sess.trace.push('发现 Authorization 头：' + sess.authSeen);
        }
      } catch (_) {
        /* ignore */
      }
    });

    try {
      const loginUrl =
        'https://www.workbuddy.cn/login/?platform=website&state=' +
        encodeURIComponent(state) +
        '&product=workbuddy';
      sess.loginUrl = loginUrl;
      await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      // 等二维码出现（keycloak 页 + 微信 iframe 至少两级）
      const deadline = Date.now() + 30000;
      let found = null;
      while (Date.now() < deadline) {
        found = await this.locateQR(page);
        if (found) break;
        await sleep(700);
      }
      if (!found) throw new Error('登录页未渲染出二维码，请稍后重试');
      const qr = await this.fetchQR(page, found);
      if (!qr) throw new Error('二维码抓取失败');
      sess.qr = qr.dataUrl;
      sess.qrSrc = qr.src;
      // 记录登录前的 Cookie 基线，后面靠「新增了哪些 Cookie」判断登录是否完成
      sess.baseline = new Set((await ctx.cookies(ORIGIN).catch(() => [])).map((c) => c.name));
      this.store.log('info', `扫码登录任务已创建（${id.slice(0, 6)}），等待用户扫码`);
      sess.timer = setInterval(() => {
        this.tick(id).catch(() => {});
      }, 2000);
      if (sess.timer.unref) sess.timer.unref();
      return { id, qr: sess.qr, expiresAt: sess.expiresAt, browser: 'ok' };
    } catch (err) {
      await this.close(id);
      throw err;
    }
  }

  async close(id) {
    const sess = this.sessions.get(id);
    if (!sess) return;
    if (sess.timer) clearInterval(sess.timer);
    sess.timer = null;
    sess.done = true;
    this.sessions.delete(id);
    this.scheduleBrowserIdle(); // 最后一个任务结束 → 开始空闲倒计时
    if (sess.status === 'success' || sess.status === 'expired' || sess.status === 'error') {
      this.results.set(id, {
        id,
        status: sess.status,
        error: sess.error || '',
        credential: sess.credential,
        trace: (sess.trace || []).slice(-40),
        at: Date.now(),
        account: null,
      });
      this.sweepResults();
      if (sess.status !== 'success') {
        // 失败也要把轨迹留下来，一次扫码就能定位问题
        this.store.log(
          'warn',
          `扫码任务 ${id.slice(0, 6)} 结束（${sess.status}）：${sess.error || ''}｜轨迹：${(sess.trace || [])
            .slice(-14)
            .join(' ← ')
            .slice(0, 1400)}`
        );
      }
    }
    try {
      await sess.ctx.close();
    } catch (_) {
      /* ignore */
    }
  }

  sweepResults() {
    const cutoff = Date.now() - 3 * 60 * 1000;
    for (const [k, v] of this.results) {
      if (v.at < cutoff) this.results.delete(k);
    }
  }

  /** 取浏览器当前 Cookie 串（用于服务端代跑需要登录态的接口） */
  async cookieHeader(sess) {
    try {
      const jar = await sess.ctx.cookies();
      return jar
        .filter((c) => c.value)
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
    } catch (_) {
      return '';
    }
  }

  /**
   * 用 state 换 token（服务端发起）。
   *
   * 重要教训（2026-10-28 二次踩坑）：`GET /console/auth/login?state=X` 不是"查询登录态"，
   * 它会**重新发起一次 OIDC 授权**。上一版每 3 秒调一次，等于每 3 秒把 state→会话的映射
   * 冲掉一次，结果就是扫码成功后 token 接口永远返回 `{"code":11217,"msg":"login ing..."}`。
   * 现在：默认只读 `/v2/plugin/auth/token`；只有在回调已落地、页面自己 15 秒都没换出 token 时，
   * 才由服务端补一次 mint（先 /console/auth/login 再取 token），且全生命周期只补一次。
   */
  async pollToken(sess, mint) {
    const st = encodeURIComponent(sess.state);
    const cookie = await this.cookieHeader(sess);
    const headers = {
      accept: 'application/json, text/plain, */*',
      'user-agent': UA,
      'x-no-authorization': 'true',
      referer: sess.loginUrl || LOGIN_URL,
    };
    if (cookie) headers.cookie = cookie;

    let loc = '';
    if (mint) {
      try {
        const r = await fetch(`${ORIGIN}/console/auth/login?platform=web&state=${st}`, {
          headers,
          redirect: 'manual',
        });
        loc = r.headers.get('location') || '';
        if (sess.trace.length < 300) sess.trace.push('manual-mint: /console/auth/login → ' + (loc || r.status));
      } catch (e) {
        return { ok: false, code: -1, msg: 'mint 失败：' + e.message, loc: '' };
      }
    }

    // 2) 取 token（无条件尝试：登录未完成时后端回 code=11217，不会误判）
    try {
      const res = await fetch(`${ORIGIN}/v2/plugin/auth/token?state=${st}`, { headers });
      const txt = await res.text();
      let j = null;
      try {
        j = JSON.parse(txt);
      } catch (_) {
        /* ignore */
      }
      if (j && j.code === 0 && j.data && (j.data.accessToken || j.data.access_token)) {
        const d = j.data;
        return {
          ok: true,
          code: 0,
          accessToken: d.accessToken || d.access_token || '',
          refreshToken: d.refreshToken || d.refresh_token || '',
          expiresIn: d.expiresIn || d.expires_in || 0,
          loc,
        };
      }
      return { ok: false, code: j ? j.code : res.status, msg: j ? j.msg : txt.slice(0, 120), loc };
    } catch (e) {
      return { ok: false, code: -1, msg: 'token 接口请求失败：' + e.message, loc };
    }
  }

  /** 单次轮询（加锁，避免 status 轮询与定时器并发进同一任务） */
  async tick(id) {
    const sess = this.sessions.get(id);
    if (!sess || sess.done) return sess || null;
    if (sess.ticking) return sess;
    sess.ticking = true;
    try {
      return await this.runTick(sess);
    } catch (err) {
      sess.lastError = err.message;
      return sess;
    } finally {
      sess.ticking = false;
    }
  }

  /**
   * 轮询主体。
   *
   * 关键教训（2026-10-28 实测踩坑）：扫码过程中**绝对不能主动导航**。
   * 上一版把「Cookie 名集合出现新增」当作登录成功信号，结果统计 Cookie
   * （sajssdk_2015_cross_new_user 之类）一出现就判定成功并 goto 业务页，
   * 直接把 Keycloak 正在进行的 OIDC 回调打断 —— 表现为「扫了码但一个会话
   * Cookie 都没有」。所以现在：
   *   1. 成功判定唯一标准 = 页面内真实业务接口返回 200；
   *   2. 扫码期间只读不写，不导航、不刷新；
   *   3. 全过程留轨迹（URL 变迁 + 业务请求），失败时一次性写进日志。
   */
  async runTick(sess) {
    const id = sess.id;
    // 已扫码后放宽超时（手机确认可能慢），二维码阶段仍按微信 5 分钟
    const ttl = sess.status === 'scanned' ? 8 * 60 * 1000 : SESSION_TTL;
    if (Date.now() > sess.createdAt + ttl) {
      sess.status = 'expired';
      sess.error = '二维码已超时，请重新发起';
      await this.close(id);
      return sess;
    }
    const page = sess.page;
    if (page.isClosed()) {
      sess.status = 'error';
      sess.error = '浏览器页面已关闭';
      await this.close(id);
      return sess;
    }

    const url = page.url();
    const onLogin = /\/login\/?(\?|$)/.test(url);
    const callbackSeen = /[?&]code=/.test(url);

    // 微信 broker 落到了 Keycloak 的「绑定手机号」页：这条链路只能造出一个空号，
    // 不会落到用户已有的手机号账号上，直接失败并给出正确指引。
    if (Date.now() - (sess.bindCheckAt || 0) > 4000) {
      sess.bindCheckAt = Date.now();
      const html = await page.content().catch(() => '');
      if (html && /first-broker-login|未绑定手机号|绑定手机号/.test(html)) {
        sess.trace.push('命中 first-broker-login（微信身份未绑定手机号）');
        sess.status = 'error';
        sess.error =
          '这个微信还没绑定 WorkBuddy 手机号账号。扫码会新建一个空账号（拿到的额度和你的账号不互通），所以已中止。请点「手机号登录」，用 173****7130 收短信登录，才会落到你原来的账号上。';
        await this.close(id);
        return sess;
      }
    }
    if (callbackSeen && !sess.callbackAt) {
      sess.callbackAt = Date.now();
      sess.trace.push('回调已落地（URL 带 code）');
      this.store.log('info', `扫码登录任务 ${id.slice(0, 6)} 收到 OIDC 回调，等待 SPA 换 token`);
    }

    // A) 页面是否已离开登录页。仅记录，不导航。
    if (!onLogin && !sess.leftLoginAt) {
      sess.leftLoginAt = Date.now();
      sess.trace.push('离开登录页：' + url.slice(0, 160));
    }

    // B) 主路径①：页面自己换到了 token —— 直接抄（最可靠）
    if (sess.tokenSniffed) {
      const jar = await sess.ctx.cookies().catch(() => []);
      return this.finish(id, jar, { ok: true, ...sess.tokenSniffed });
    }

    // B) 主路径②：只读轮询 token 接口。回调落地前完全不碰它，
    //    避免任何可能干扰 OIDC 流程的请求。
    if (callbackSeen && Date.now() - (sess.lastTokenPoll || 0) > 2500) {
      sess.lastTokenPoll = Date.now();
      sess.tokenTries = (sess.tokenTries || 0) + 1;
      // 回调落地后先给 SPA 8 秒自己换 token（它会调 /console/auth/login 再调 token 接口）；
      // 8 秒还没换出来，才由服务端按同一顺序补一次，且全任务只补一次——
      // 回调之前调用这个接口会重启 OIDC 流程，必须严格排除在回调前调用。
      const overdue = Date.now() - (sess.callbackAt || Date.now()) > 8000;
      const mint = overdue && !sess.minted;
      if (mint) sess.minted = true;
      const t = await this.pollToken(sess, mint);
      sess.tokenProbe = t;
      if (t && t.ok && t.accessToken) {
        const jar = await sess.ctx.cookies().catch(() => []);
        return this.finish(id, jar, t);
      }
      if (sess.tokenTries <= 2 || sess.tokenTries % 5 === 0) {
        sess.trace.push(`token#${sess.tokenTries} code=${t && t.code} ${String((t && t.msg) || '').slice(0, 40)}`);
      }
    }

    // C) 兜底：页面自己发业务请求时带上了 Authorization → 已拿到 token
    if (sess.authSeen) {
      const jar = await sess.ctx.cookies().catch(() => []);
      return this.finish(id, jar, null);
    }
    const shouldProbe = sess.status === 'scanned' || sess.leftLoginAt;
    if (shouldProbe && Date.now() - (sess.lastProbe || 0) > 3500) {
      sess.lastProbe = Date.now();
      sess.probeTries = (sess.probeTries || 0) + 1;
      const probe = await this.pageProbe(page);
      sess.probe = probe;
      sess.trace.push(`probe#${sess.probeTries} ${probe.http} ${String(probe.snippet || probe.error || '').slice(0, 80)}`);
      if (probe.ok) {
        // 会话已建立，把整份 Cookie 收走
        const jar = await sess.ctx.cookies().catch(() => []);
        return this.finish(id, jar);
      }
    }

    // C) 仍在登录页：刷新二维码 + 检测扫码状态（纯读操作）
    const found = await this.locateQR(page);
    if (found) {
      if (found.src !== sess.qrSrc) {
        const qr = await this.fetchQR(page, found);
        if (qr) {
          sess.qr = qr.dataUrl;
          sess.qrSrc = qr.src;
        }
      }
      if (sess.status === 'pending') {
        const txt = await found.frame.evaluate(() => document.body.innerText || '').catch(() => '');
        if (/扫描成功|扫码成功|请在手机上确认|已扫描/.test(txt)) {
          sess.status = 'scanned';
          sess.trace.push('微信侧已扫码，等待手机确认');
          this.store.log('info', `扫码登录任务 ${id.slice(0, 6)} 已扫码，等待手机确认`);
        }
      }
    } else if (sess.status === 'pending' && sess.leftLoginAt) {
      // 二维码消失且已离开登录页，通常是完成了
      sess.status = 'scanned';
    }

    return sess;
  }

  /** 在页面上下文里打一次业务接口：这是判断「会话是否真的建立」的唯一依据 */
  async pageProbe(page) {
    try {
      const r = await page.evaluate(async () => {
        try {
          const res = await fetch('/v2/billing/meter/checkin-activity-status', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
            credentials: 'include',
          });
          const text = await res.text();
          let json = null;
          try {
            json = JSON.parse(text);
          } catch (_) {
            /* ignore */
          }
          return { http: res.status, code: json ? json.code : null, body: String(text).slice(0, 200) };
        } catch (e) {
          return { http: 0, error: String(e).slice(0, 200) };
        }
      });
      const gateway401 = /401 Authorization Required/.test(String(r.body || ''));
      r.ok = r.http === 200 && !gateway401 && (r.code === 0 || r.code === null || r.code === undefined);
      r.snippet = r.body;
      return r;
    } catch (e) {
      return { ok: false, http: 0, error: String(e).slice(0, 200) };
    }
  }

  /** 收走凭证。调用前已确认会话可用，这里只做采集，绝不再导航。 */
  async finish(id, cookies, tokenResult) {
    const sess = this.sessions.get(id);
    if (!sess || sess.done) return sess || null;
    const page = sess.page;

    const jar = (Array.isArray(cookies) ? cookies : []).filter((c) => c && c.value);
    const cookieStr = jar.map((c) => `${c.name}=${c.value}`).join('; ');

    // 尽力从页面存储里捞 uid / token
    let storage = {};
    try {
      storage = await page.evaluate(() => {
        const dump = (s) => {
          const o = {};
          for (let i = 0; i < s.length; i += 1) {
            const k = s.key(i);
            try {
              o[k] = s.getItem(k);
            } catch (_) {
              o[k] = '';
            }
          }
          return o;
        };
        return { ls: dump(localStorage), ss: dump(sessionStorage) };
      });
    } catch (_) {
      storage = {};
    }
    const flat = JSON.stringify(storage || {});

    const pick = (re) => {
      const m = flat.match(re);
      return m ? m[1] : '';
    };
    const uid =
      pick(/"?(?:uid|user_?id|userId|UserId|userID)"?\s*:\s*"?(\d{8,25})/i) ||
      pick(/"?(?:uid|user_?id|userId|UserId)"?\s*:\s*(\d{8,25})/i) ||
      (cookieStr.match(/(?:^|;\s*)(?:uid|user_id)=(\d{8,25})/) || [])[1] ||
      '';
    const token =
      (tokenResult && tokenResult.accessToken) ||
      (sess.authRaw ? String(sess.authRaw).replace(/^Bearer\s+/i, '') : '') ||
      pick(/"(?:access_?token|accessToken|id_?token|idToken|token)"\s*:\s*"([A-Za-z0-9._-]{24,})"/);
    const refreshToken = (tokenResult && tokenResult.refreshToken) || '';
    const expiresIn = (tokenResult && tokenResult.expiresIn) || 0;
    const nickname = pick(/"?(?:nick_?name|nickName|userName|displayName|name)"?\s*:\s*"([^"]{1,40})"/);

    sess.credential = {
      cookie: cookieStr,
      uid,
      token,
      refreshToken,
      expiresIn,
      tokenAt: Date.now(),
      nickname,
      ua: UA,
      storageKeys: Object.keys(storage.ls || {}),
      cookieNames: [...new Set(jar.map((c) => c.name))],
      cookieDomains: [...new Set(jar.map((c) => c.domain))].slice(0, 8),
      probe: sess.probe || null,
      tokenProbe: sess.tokenProbe || null,
      trace: sess.trace.slice(-40),
    };
    sess.status = 'success';
    sess.error = '';
    this.store.log(
      'info',
      `扫码会话已建立：token ${token ? '已获取' : '未获取'}（refresh=${refreshToken ? '有' : '无'}，有效期 ${expiresIn || '?'}s）｜Cookie ${sess.credential.cookieNames.length} 个`
    );
    await this.close(id);
    return sess;
  }

  /** 查询任务状态（GET 时顺带推进一次，保证前端轮询即可推进） */
  async status(id) {
    const sess = this.sessions.get(id);
    if (!sess) {
      this.sweepResults();
      const done = this.results.get(id);
      if (done) {
        return {
          id: done.id,
          status: done.status,
          qr: '',
          error: done.error,
          credential: done.credential,
          trace: done.trace || [],
          account: done.account,
        };
      }
      return { status: 'unknown', error: '任务不存在或已结束' };
    }
    if (sess.status === 'pending' || sess.status === 'scanned') {
      if (!sess.checking) {
        sess.checking = true;
        await this.tick(id).catch(() => {});
        sess.checking = false;
      }
    }
    const done = this.results.get(id);
    return {
      id: sess.id,
      status: sess.status,
      qr: sess.status === 'pending' || sess.status === 'scanned' ? sess.qr : '',
      expiresAt: sess.expiresAt,
      error: sess.error || '',
      credential: sess.credential,
      trace: (sess.trace || []).slice(-15),
      account: done ? done.account : null,
    };
  }

  /** 把「已入库的账号」回写到结果缓存，避免前端重复轮询时重复建号 */
  markCommitted(id, account) {
    const done = this.results.get(id);
    if (done) done.account = account;
  }

  count() {
    return this.sessions.size;
  }

  async shutdown() {
    this.cancelBrowserIdle();
    for (const id of [...this.sessions.keys()]) await this.close(id);
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (_) {
        /* ignore */
      }
      this.browser = null;
    }
  }
}

module.exports = { QRLogin, LOGIN_URL, ORIGIN };
