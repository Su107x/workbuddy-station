'use strict';
/**
 * WorkBuddy 多账号工作台 · 服务端
 *
 * 设计目标：可直接部署到公网服务器，只依赖 Node 18+ 标准库。
 *   - 单进程 HTTP 服务，页面 + API + 反向代理同端口
 *   - 数据整库 AES-256-GCM 加密落盘（data/db.enc）
 *   - 登录口令 + 会话票据 + CSRF + 登录限流
 *   - 定时任务在自己的进程里跑，不依赖 crontab
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');

const { loadMasterKey, randomPassword, randomId, makeAccessKey, safeEqual, mask } = require('./lib/crypto');
const { Store } = require('./lib/store');
const { Auth } = require('./lib/auth');
const { Accounts } = require('./lib/accounts');
const { Proxy, readBody, json, openAiError } = require('./lib/proxy');
const { Scheduler } = require('./lib/sched');
const { Meow } = require('./lib/meow');
const { ModelCatalog } = require('./lib/modelcatalog');
const { CoreClient } = require('./lib/coreclient');
const agate = require('./lib/agate');
const { ModelSync } = require('./lib/modelsync');
const { QRLogin } = require('./lib/qrlogin');
const { PhoneLogin } = require('./lib/phonelogin');
const { publicAccount } = require('./lib/accounts');
const wb = require('./lib/wb');

const PORT = Number(process.env.PORT || 8790);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.WB_DATA_DIR || path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');

/**
 * 构建版本号：每次发布自动递增（YYYY.MMDDHHmm + 序号）。
 * 用于顶栏标识和启动自检，能一眼看出「磁盘代码」与「运行进程」是否同版本。
 */
const BUILD_VERSION = process.env.WB_BUILD_VERSION
  || (() => {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}.${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
  })();

/* ---------------- 初始化 ---------------- */
const master = loadMasterKey(DATA_DIR);
const store = new Store(DATA_DIR, master.key);
store.load();
const auth = new Auth(store);
const accounts = new Accounts(store);
const proxy = new Proxy(store, accounts, path.join(DATA_DIR, 'models.json'));
// 模型目录：上游 /v3/config 的模型倍率 + 时段促销（免费时段判定在这里）。
// 注入 proxy 后，代理可按「白名单 + 免费优先/最低倍率」自动选型。
const modelCatalog = new ModelCatalog(store, accounts);
proxy.catalog = modelCatalog;
// 核心决策服务客户端：配置了 settings.proxy.coreUrl 才生效。
// 未配置时所有决策走本地实现（自用场景行为完全不变）；交付版删掉本地实现、强制走 core。
proxy.core = new CoreClient(store);
const meow = new Meow(store, accounts);
const scheduler = new Scheduler(store, accounts, meow);
const qrlogin = new QRLogin(store);
const phonelogin = new PhoneLogin(store, qrlogin);

/* 后台刷新额度：多处路由「操作成功后顺手刷一下额度」，若用户连续点几下，
 * 会并发跑多个 refreshAll（每个账号一次请求，且内部可能触发令牌续期）。
 * 这里做一次合流：已有在飞的 refreshAll 就复用它，结束后清空。
 * 注意只合流，不复用结果——下一次调用仍会真实刷新。
 */
let bgRefreshAllP = null;
function bgRefreshAll() {
  if (bgRefreshAllP) return bgRefreshAllP;
  bgRefreshAllP = Promise.resolve()
    .then(() => accounts.refreshAll())
    .catch(() => {})
    .finally(() => { bgRefreshAllP = null; });
  return bgRefreshAllP;
}

/* ---------------- 积分 / 保活（可选模块） ----------------
 * 这两个模块由独立文件提供，加载失败时降级为「接口不可用」，
 * 绝不能让主服务起不来 —— 老部署升级时可能只替换了部分文件。
 */
let creditsSvc = null;
let creditsErr = '';
try {
  const { Credits } = require('./lib/credits');
  creditsSvc = new Credits(store, accounts);
} catch (err) {
  creditsErr = err.message || String(err);
}

let keepaliveSvc = null;
let keepaliveErr = '';
try {
  const { KeepAlive } = require('./lib/keepalive');
  keepaliveSvc = new KeepAlive(store, accounts);
} catch (err) {
  keepaliveErr = err.message || String(err);
}

/* 把同一批实例补注给调度器。
 * 否则 Scheduler 会自己再 new 一份 credits / keepalive，两边的重入锁不共享 ——
 * 页面点「立即保活」正撞上定时巡检时，同一批账号会被两个实例同时写。
 */
scheduler.attachServices({ credits: creditsSvc, keepalive: keepaliveSvc });
// 调度器需要 proxy.core 做授权闸门（授权无效时停掉所有定时任务）
scheduler.proxy = proxy;
// 模型目录自动同步：每天拉官方目录，新增免费模型自动入白名单、下架自动剔除
const modelSync = new ModelSync(store, modelCatalog);
scheduler.modelSync = modelSync;

/* 首次运行的口令策略：
 *   - 优先用环境变量 WB_ADMIN_PASSWORD（部署脚本/自动化场景）
 *   - 否则【不自动生成】——第一次打开网页时由用户自己设置（auth.login 里已支持）
 * 早先版本会随机生成并打印一次，用户关掉窗口就再也找不到，体验很差，已废弃。 */
let initialPassword = '';
if (!auth.isInitialized()) {
  const fromEnv = (process.env.WB_ADMIN_PASSWORD || '').trim();
  if (fromEnv) {
    if (fromEnv.length < 8) {
      console.error('[启动失败] WB_ADMIN_PASSWORD 至少 8 位');
      process.exit(1);
    }
    initialPassword = fromEnv;
    auth.initPassword(initialPassword);
    store.log('warn', '已用环境变量 WB_ADMIN_PASSWORD 初始化管理员口令');
  }
  // 未设环境变量：保持未初始化，等用户第一次打开网页时自己设密码
}

if (!store.data.settings.proxy.accessKey) {
  store.data.settings.proxy.accessKey = makeAccessKey();
  store.touch();
}

/* 老版本的小喵配置里存的是三个手填路径，现在接口已固定为官方接口，清掉残留 */
if (store.data.settings.meow && store.data.settings.meow.endpoints) {
  delete store.data.settings.meow.endpoints;
  store.touch();
}

/* ---------------- 工具 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function clientIp(req) {
  if (store.data.settings.security.trustProxy) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('x-frame-options', 'SAMEORIGIN');
  res.setHeader('referrer-policy', 'same-origin');
  res.setHeader('permissions-policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader(
    'content-security-policy',
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'self'"
  );
}

function sendJson(res, status, body, extraHeaders) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...(extraHeaders || {}),
  });
  res.end(text);
}

/**
 * gzip 压缩缓存。
 *
 * 为什么需要：index.html 单文件 200KB+，这台机器公网上行只有 ~5Mbps 且抖动大，
 * 不压缩时首屏要 2 秒以上（实测 0.05s 首字节 + 2.3s 传体）。gzip 后约 1/6 体积。
 *
 * 为什么用「首次压缩 + 缓存」而不是每次请求现压：
 *   现压每次都要读全文件 + 压缩 ≈ 10-20ms CPU，首页刷新频繁时会白烧 CPU；
 *   缓存后只有第一次付这个成本。缓存 key 带 mtime+size，文件更新自动失效。
 */
const gzipCache = new Map(); // key: 绝对路径 -> { mtimeMs, size, buf }

function getGzipped(target, st, cb) {
  const cached = gzipCache.get(target);
  if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
    cb(null, cached.buf);
    return;
  }
  fs.readFile(target, (err, raw) => {
    if (err) { cb(err); return; }
    zlib.gzip(raw, { level: 6 }, (e2, buf) => {
      if (e2) { cb(null, null); return; } // 压缩失败就退回明文，不能因此报错
      gzipCache.set(target, { mtimeMs: st.mtimeMs, size: st.size, buf });
      cb(null, buf);
    });
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  // 必须带分隔符比较，否则 /opt/jwd-server/publicX 这类同级目录会被当成 public 内部放行
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(404).end('Not Found');
    return;
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not Found');
      return;
    }
    const ext = path.extname(target).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    const baseHeaders = {
      'content-type': type,
      'cache-control': path.basename(target) === 'index.html' ? 'no-cache' : 'public, max-age=3600',
      // 文本类才压缩；图片/字体本身已压缩，再 gzip 只会更慢
      vary: 'Accept-Encoding',
    };
    const compressible = /^(text\/|application\/(json|javascript|xml)|image\/svg)/.test(type);
    const accepts = /gzip/i.test(String(req.headers['accept-encoding'] || ''));

    if (!compressible || !accepts || st.size < 1024) {
      res.writeHead(200, { ...baseHeaders, 'content-length': st.size });
      fs.createReadStream(target).pipe(res);
      return;
    }

    getGzipped(target, st, (e, buf) => {
      if (e || !buf) {
        res.writeHead(200, { ...baseHeaders, 'content-length': st.size });
        fs.createReadStream(target).pipe(res);
        return;
      }
      res.writeHead(200, {
        ...baseHeaders,
        'content-encoding': 'gzip',
        'content-length': buf.length,
      });
      res.end(buf);
    });
  });
}

function setCookie(res, name, value, maxAgeSec, secure) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (typeof maxAgeSec === 'number') parts.push(`Max-Age=${maxAgeSec}`);
  if (secure) parts.push('Secure');
  res.setHeader('set-cookie', parts.join('; '));
}

function isSecure(req) {
  if (req.socket.encrypted) return true;
  // 只有在明确声明部署于反向代理之后（WB_TRUST_PROXY=1）才信任 X-Forwarded-Proto。
  // 否则任意客户端都能伪造该头，服务端会在明文 HTTP 上下发带 Secure 的会话 Cookie，
  // 浏览器拒绝回传，导致管理员始终登录不上。
  if (process.env.WB_TRUST_PROXY !== '1') return false;
  return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
}

/* ---------------- 会话中间件 ---------------- */
function requireAuth(req, res, needCsrf) {
  const session = auth.check(req);
  if (!session) {
    sendJson(res, 401, { error: '未登录或会话已过期', code: 'NO_SESSION' });
    return null;
  }
  if (needCsrf && !auth.verifyCsrf(req, session)) {
    sendJson(res, 403, { error: 'CSRF 校验失败，请刷新页面重试', code: 'CSRF' });
    return null;
  }
  return session;
}

/* ---------------- 配对码（浏览器扩展接入） ---------------- */
const pairing = { code: '', expiresAt: 0, attempts: 0 };

function issuePairing() {
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  pairing.code = code;
  pairing.expiresAt = Date.now() + 10 * 60000;
  pairing.attempts = 0;
  return { code, expiresAt: pairing.expiresAt };
}

function consumePairing(code) {
  if (!pairing.code || Date.now() > pairing.expiresAt) return false;
  if (pairing.attempts >= 8) {
    pairing.code = '';
    return false;
  }
  if (!safeEqual(String(code || '').trim(), pairing.code)) {
    pairing.attempts += 1;
    return false;
  }
  pairing.code = '';
  pairing.expiresAt = 0;
  return true;
}

/* ---------------- 业务处理 ---------------- */
function statePayload() {
  const s = store.data.settings;
  const d = new Date();
  const localToday = d.toLocaleDateString('sv-SE');
  return {
    serverTime: Date.now(),
    today: localToday,
    initialized: auth.isInitialized(),
    build: { version: BUILD_VERSION, routeHealth: getRouteHealth() },
    summary: accounts.summary(),
    accounts: accounts.list(),
    settings: {
      siteTitle: s.siteTitle,
      checkin: s.checkin,
      quota: s.quota,
      proxy: {
        enabled: s.proxy.enabled,
        strategy: s.proxy.strategy,
        stickyTtlMin: s.proxy.stickyTtlMin,
        maxFailover: s.proxy.maxFailover,
        modelAlias: s.proxy.modelAlias,
        modelMap: s.proxy.modelMap || {},
        modelWhitelist: s.proxy.modelWhitelist || [],
        autoSelectModel: s.proxy.autoSelectModel === true,
        allowAnonymous: s.proxy.allowAnonymous,
        cacheFriendly: s.proxy.cacheFriendly !== false,
        accessKeyMasked: mask(s.proxy.accessKey, 6),
        // 注意：不再在 /api/state 里明文下发 accessKey。
        // 原因：state 是免授权白名单接口，任何能登录的人（含未授权的买家）
        // 都能从这里读到完整 Key。需要明文时走 GET /api/proxy/key（需授权）。
        hasAccessKey: Boolean(s.proxy.accessKey),
      },
      meow: s.meow,
      // 积分刷新 / 保活 / 账号错峰：缺了这三段前端读不到，
      // 设置页会显示成空值，用户以为存了其实没存。
      credits: s.credits,
      keepalive: s.keepalive,
      schedule: s.schedule,
      security: {
        sessionHours: s.security.sessionHours,
        loginMaxAttempts: s.security.loginMaxAttempts,
        trustProxy: s.security.trustProxy,
      },
    },
    proxyBaseUrl: (process.env.WB_PUBLIC_URL || s.publicBaseUrl || `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`) + '/v1',
    meow: {
      summary: meow.summary(),
      list: meow.list(),
      settings: s.meow,
      nextIn: scheduler.meowNextIn(),
    },
    scheduler: scheduler.status(),
    schedulerLastTick: scheduler.lastTick,
    logs: store.data.logs.slice(0, 80),
    logsTotal: (store.data.logs || []).length,
    stats: store.data.stats,
    usageLog: (store.data.usageLog || []).slice(0, 60),
    models: proxy.loadModels().length,
  };
}

const routes = [];

/**
 * 成长任务全局汇总（跨账号）。
 * 优先用各账号上次同步时缓存的 summary，不产生任何上游请求。
 * @returns {object} 汇总数据
 */
function route(method, pattern, handler, opts) {
  routes.push({ method, pattern, handler, opts: opts || {} });}

/**
 * 启动自检：校验关键路由是否全部注册成功。
 *
 * 背景：曾出现过「磁盘上是新代码、进程内存里是旧代码」的不一致（tar 覆盖后
 * 进程未 reload），症状是页面报「接口不存在」但没有任何自检能发现。
 * 这里在启动时比对预期路由清单，缺失则写 warn 日志并在 state 暴露，
 * 让问题在启动瞬间就暴露，而不是等用户点按钮才发现。
 */
/**
 * 启动自检：校验关键路由是否全部注册成功。
 *
 * 背景：曾出现过「磁盘上是新代码、进程内存里是旧代码」的不一致（tar 覆盖后
 * 进程未 reload），症状是页面报「接口不存在」但没有任何自检能发现。
 * 这里在启动时用示例 URL 逐条试匹配，缺失则写 warn 日志并在 state 暴露，
 * 让问题在启动瞬间就暴露，而不是等用户点按钮才发现。
 */
const REQUIRED_ROUTES = [
  { method: 'GET', url: '/api/session' },
  { method: 'POST', url: '/api/login' },
  { method: 'GET', url: '/api/state' },
  // 注意：/v1/models/catalog 不在这里 —— 它是裸 handler（不走 route() 注册），
  // 自检只查 routes 表，列进来会永远误报缺失。
  // 它的可用性由 tools/gen_client_models.js 实跑验证（拉不到会直接报错退出）。
];

function selfCheckRoutes() {
  const missing = [];
  for (const probe of REQUIRED_ROUTES) {
    // 直接用已注册路由的正则去试匹配示例 URL：能匹配上就说明这条路由确实在
    const hit = routes.some((r) => r.method === probe.method && r.pattern.test(probe.url));
    if (!hit) missing.push(`${probe.method} ${probe.url}`);
  }
  return { ok: missing.length === 0, missing, total: routes.length };
}// 惰性求值：必须在所有 route() 注册完成之后才计算，否则拿到的是空的路由表。
// 用 getter 而非常量，避免「声明在前、注册在后」的时序坑。
let routeHealthCache = null;
function getRouteHealth() {
  if (!routeHealthCache) routeHealthCache = selfCheckRoutes();
  return routeHealthCache;
}

/* 认证 */
route('GET', /^\/api\/session$/, async (req, res) => {
  const session = auth.check(req);
  sendJson(res, 200, {
    authed: Boolean(session),
    initialized: auth.isInitialized(),
    csrf: session ? session.csrf : '',
    siteTitle: store.data.settings.siteTitle,
  });
}, { public: true });

/* ---- 模型目录同步 ---- */
route('GET', /^\/api\/models\/sync$/, async (req, res) => {
  sendJson(res, 200, modelSync.summary());
});

route('POST', /^\/api\/models\/sync\/run$/, async (req, res) => {
  const r = await modelSync.run({ force: true });
  sendJson(res, 200, r);
});

/**
 * 取网关 API Key 明文（需要授权 + 已登录）。
 * 为什么单独开接口：/api/state 是免授权白名单，不能在那里下发明文 Key，
 * 否则未授权的买家也能读到。前端只在「代理」页需要时调用本接口。
 */
route('GET', /^\/api\/proxy\/key$/, async (req, res) => {
  sendJson(res, 200, { accessKey: store.data.settings.proxy.accessKey || '' });
});

/**
 * 授权状态（免授权也能查，前端靠它显示"该填授权码 / 已过期 / 正常"）。
 * 只回报状态，不泄露任何核心数据。
 */
route('GET', /^\/api\/licence$/, async (req, res) => {
  let g;
  try {
    g = await agate.check({ store, proxy });
  } catch (e) {
    g = { ok: false, reason: 'licence_check_failed', mode: 'cloud', expireAt: 0 };
  }
  sendJson(res, 200, {
    ok: g.ok,
    reason: g.reason,
    message: g.ok ? '' : agate.reasonText(g.reason),
    mode: g.mode,
    expireAt: g.expireAt || 0,
  });
}, { public: true });

route('POST', /^\/api\/login$/, async (req, res) => {
  const body = await readBody(req, 8192);
  const ip = clientIp(req);
  const result = auth.login(body.password, ip);
  setCookie(res, 'wb_session', result.token, Math.floor((result.exp - Date.now()) / 1000), isSecure(req));
  store.log('info', `管理员登录成功（${ip}）`);
  sendJson(res, 200, { ok: true, csrf: result.csrf });
}, { public: true, noCsrf: true });

route('POST', /^\/api\/logout$/, async (req, res) => {
  auth.logout(req);
  setCookie(res, 'wb_session', '', 0, isSecure(req));
  sendJson(res, 200, { ok: true });
}, { public: true, noCsrf: true });

/* 状态 */
route('GET', /^\/api\/state$/, async (req, res) => {
  sendJson(res, 200, statePayload());
});

/* 账号 */
route('POST', /^\/api\/accounts$/, async (req, res) => {
  const body = await readBody(req, 64 * 1024);
  if (body.id) {
    sendJson(res, 200, { account: accounts.update(body.id, body) });
    return;
  }
  const res0 = await wb.verifyCredentials(
    String(body.token || '').trim(),
    String(body.uid || '').trim(),
    body.endpoint,
    String(body.cookie || '').trim()
  );
  if (!res0.ok && res0.kind === 'auth') {
    sendJson(res, 400, { error: '凭证校验失败：' + res0.message, code: 'BAD_CREDENTIAL' });
    return;
  }
  const acc = accounts.create(body);
  let verified = null;
  if (res0.ok) {
    verified = await accounts.refresh(acc.id).catch(() => null);
  }
  store.log('info', `新增账号 ${acc.nickname}`);
  sendJson(res, 200, { account: verified ? verified.account : acc, verified: res0.ok, note: res0.ok ? '' : res0.message });
});

route('POST', /^\/api\/accounts\/([\w-]+)\/delete$/, async (req, res, m) => {
  sendJson(res, 200, accounts.remove(m[1]));
});

route('POST', /^\/api\/accounts\/([\w-]+)\/relogin$/, async (req, res, m) => {
  const acc = accounts.find(m[1]);
  if (!acc) {
    sendJson(res, 404, { ok: false, error: '账号不存在' });
    return;
  }
  if (!acc.phone) {
    sendJson(res, 400, { ok: false, error: '这个账号没存手机号，请用「手机号登录」重新绑定' });
    return;
  }
  try {
    const out = await phonelogin.start(acc.phone);
    sendJson(res, 200, { ok: true, id: out.id, masked: out.masked, expiresIn: out.expiresIn });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
  }
});

route('POST', /^\/api\/accounts\/([\w-]+)\/refresh$/, async (req, res, m) => {
  const out = await accounts.refresh(m[1]);
  sendJson(res, 200, out);
});

route('POST', /^\/api\/accounts\/refresh-all$/, async (req, res) => {
  const results = await accounts.refreshAll();
  sendJson(res, 200, { results });
});

/* ---------------- 扫码登录 ----------------
 * 服务端自己跑登录页（无头浏览器）→ 抓微信二维码给用户扫 → 扫完自动收走会话 Cookie 入库。
 * 手工复制 Cookie 会因 APISIX 会话绑定/过期频繁失效，这条路径才是正解。
 */
route('POST', /^\/api\/login\/qr\/start$/, async (req, res) => {
  try {
    const out = await qrlogin.start();
    sendJson(res, 200, { ok: true, ...out });
  } catch (err) {
    store.log('error', '扫码登录启动失败：' + err.message);
    sendJson(res, 500, { error: err.message });
  }
});

route('GET', /^\/api\/login\/qr\/([\w-]+)$/, async (req, res, m) => {
  const id = m[1];
  let st;
  try {
    st = await qrlogin.status(id);
  } catch (err) {
    sendJson(res, 500, { error: err.message });
    return;
  }
  if (st.status === 'success' && st.credential && !st.account) {
    const cred = st.credential;
    if (cred.tokenAt && cred.expiresIn) cred.tokenExpiresAt = cred.tokenAt + cred.expiresIn * 1000;
    const probe = { cookie: cred.cookie, token: cred.token, ua: cred.ua };
    // UID 兜底：身份只在 /console/* 里
    if (!cred.uid) {
      const me = await wb.whoami(probe).catch(() => null);
      if (me && me.uid) {
        cred.uid = me.uid;
        cred.uuid = cred.uuid || me.uuid || '';
        cred.nickname = cred.nickname || me.nickname || '';
        cred.enterpriseId = cred.enterpriseId || me.enterpriseId || '';
      }
    }
    const check = await wb.verifyCredentials(cred.token, cred.uid, undefined, cred.cookie).catch((e) => ({
      ok: false,
      message: e.message,
    }));
    if (check.ok) {
      if (check.uid) cred.uid = check.uid;
      if (check.uuid && !cred.uuid) cred.uuid = check.uuid;
      if (!cred.nickname && check.nickname) cred.nickname = check.nickname;
      if (!cred.enterpriseId && check.enterpriseId) cred.enterpriseId = check.enterpriseId;
      try {
        const out = accounts.commitCredential(cred);
        await accounts.refresh(out.account.id).catch(() => {});
        await meow.sync(out.account.id).catch(() => {});
        const fresh = accounts.find(out.account.id);
        const pub = fresh ? publicAccount(fresh) : null;
        qrlogin.markCommitted(id, pub);
        st.account = pub;
        store.log('info', `扫码登录成功：${out.created ? '新增' : '更新'}账号 ${pub ? pub.nickname : ''}`);
      } catch (err) {
        st.commitError = err.message;
        store.log('error', '扫码结果入库失败：' + err.message);
      }
    } else {
      st.status = 'error';
      st.error = '扫码完成但会话校验失败：' + (check.message || '未知原因');
      store.log(
        'warn',
        `扫码登录会话校验失败：${check.message || ''}｜token=${cred.token ? '有' : '无'}｜Cookie：${(cred.cookieNames || []).join(',')}｜换 token 探测：${JSON.stringify(
          cred.tokenProbe || {}
        ).slice(0, 200)}｜页面内探测：${JSON.stringify(cred.probe || {}).slice(0, 120)}`
      );
    }
  }
  // 凭证本体不往浏览器回传，只回摘要，便于界面显示与排查
  if (st.credential) {
    const c = st.credential;
    st.credential = {
      uid: c.uid || '',
      nickname: c.nickname || '',
      cookieNames: c.cookieNames || [],
      hasToken: Boolean(c.token),
      probe: c.probe || null,
      trace: c.trace || [],
    };
  }
  sendJson(res, 200, st);
});

route('POST', /^\/api\/login\/qr\/([\w-]+)\/cancel$/, async (req, res, m) => {
  await qrlogin.close(m[1]);
  sendJson(res, 200, { ok: true });
});

/* ---------------- 手机号 + 短信验证码登录（纯 HTTP） ----------------
 * 微信扫码走 Keycloak broker，会落到独立身份并要求补绑手机号；
 * 手机号短信登录才会落到用户本来的账号上。全程无需浏览器、无需手工复制 Cookie。
 */
async function commitLoginCredential(cred) {
  if (cred.tokenAt && cred.expiresIn && !cred.tokenExpiresAt) {
    cred.tokenExpiresAt = cred.tokenAt + cred.expiresIn * 1000;
  }
  const probe = { cookie: cred.cookie, token: cred.token, ua: cred.ua };
  if (!cred.uid) {
    const me = await wb.whoami(probe).catch(() => null);
    if (me && me.uid) {
      cred.uid = me.uid;
      cred.uuid = cred.uuid || me.uuid || '';
      cred.nickname = cred.nickname || me.nickname || '';
      cred.enterpriseId = cred.enterpriseId || me.enterpriseId || '';
    }
  }
  const check = await wb.verifyCredentials(cred.token, cred.uid, undefined, cred.cookie).catch((e) => ({
    ok: false,
    message: e.message,
  }));
  if (!check.ok) return { ok: false, message: check.message || '会话校验失败' };
  if (check.uid) cred.uid = check.uid;
  if (check.uuid && !cred.uuid) cred.uuid = check.uuid;
  if (!cred.nickname && check.nickname) cred.nickname = check.nickname;
  if (!cred.enterpriseId && check.enterpriseId) cred.enterpriseId = check.enterpriseId;
  const out = accounts.commitCredential(cred);
  await accounts.refresh(out.account.id).catch(() => {});
  await meow.sync(out.account.id).catch(() => {});
  const fresh = accounts.find(out.account.id);
  return { ok: true, created: out.created, account: fresh ? publicAccount(fresh) : null };
}

route('POST', /^\/api\/login\/sms\/start$/, async (req, res) => {
  try {
    const body = await readBody(req, 8192);
    const out = await phonelogin.start(body.phone);
    store.log('info', `手机号登录：已向 ${out.phone.slice(0, 3)}****${out.phone.slice(-4)} 发送验证码`);
    sendJson(res, 200, { ok: true, ...out });
  } catch (err) {
    store.log('warn', '手机号登录发起失败：' + err.message);
    sendJson(res, 400, { ok: false, error: err.message });
  }
});

route('POST', /^\/api\/login\/sms\/([\w-]+)\/retry-harvest$/, async (req, res, m) => {
  try {
    const cred = await phonelogin.retryHarvest(m[1]);
    const out = await commitLoginCredential(cred);
    if (!out.ok) {
      sendJson(res, 200, { ok: false, stage: 'verify', error: '抓到 token 但会话校验失败：' + out.message });
      return;
    }
    sendJson(res, 200, { ok: true, account: out.account, created: out.created });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: err.message, trace: err.trace || undefined });
  }
});

route('GET', /^\/api\/login\/sms\/last$/, async (req, res) => {
  sendJson(res, 200, { ok: true, last: phonelogin.lastSend });
});

// 登录进度查询：前端在等待 verify 返回时轮询它，避免长时间只有「登录中…」看着像卡死
route('GET', /^\/api\/login\/sms\/([\w-]+)\/status$/, async (req, res, m) => {
  try {
    sendJson(res, 200, phonelogin.status(m[1]));
  } catch (err) {
    sendJson(res, 200, { ok: false, step: 'error', stepText: err.message, elapsed: 0, trace: [] });
  }
});

route('POST', /^\/api\/login\/sms\/([\w-]+)\/resend$/, async (req, res, m) => {
  try {
    const out = await phonelogin.resend(m[1]);
    sendJson(res, 200, { ok: true, ...out });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message });
  }
});

route('POST', /^\/api\/login\/sms\/([\w-]+)\/verify$/, async (req, res, m) => {
  const id = m[1];
  try {
    const body = await readBody(req, 8192);
    const cred = await phonelogin.verify(id, body.code);
    const out = await commitLoginCredential(cred);
    if (!out.ok) {
      store.log(
        'warn',
        `手机号登录会话校验失败：${out.message}｜Cookie：${(cred.cookieNames || []).join(',')}｜trace=${(cred.trace || []).slice(-4).join(' | ')}`
      );
      sendJson(res, 200, { ok: false, stage: 'verify', error: '登录成功但会话校验失败：' + out.message });
      return;
    }
    store.log('info', `手机号登录成功：${out.created ? '新增' : '更新'}账号 ${out.account ? out.account.nickname : ''}`);
    sendJson(res, 200, { ok: true, account: out.account, created: out.created });
  } catch (err) {
    if (err.code === 'select') {
      sendJson(res, 200, { ok: false, needSelect: true, accounts: err.accounts, error: err.message });
      return;
    }
    store.log('warn', '手机号登录失败：' + err.message);
    sendJson(res, 200, { ok: false, error: err.message, trace: err.trace || undefined, url: err.url || undefined });
  }
});

/* 签到 */
route('POST', /^\/api\/checkin\/one$/, async (req, res) => {
  const body = await readBody(req, 8192);
  const out = await accounts.checkinOne(String(body.id || ''), { force: Boolean(body.force) });
  sendJson(res, 200, out);
});

route('POST', /^\/api\/checkin\/all$/, async (req, res) => {
  const results = await accounts.checkinAll();
  sendJson(res, 200, { results });
});

/* ---------------- 小喵（Buddy 旅行） ----------------
 * 全部走官方成长中心同款接口，失败原因按上游原文归类后回传。
 */
function meowFail(res, err) {
  const code = err && err.statusCode ? err.statusCode : 500;
  sendJson(res, code, { error: err && err.message ? err.message : '操作失败' });
}

route('POST', /^\/api\/meow\/sync$/, async (req, res) => {
  const body = await readBody(req, 8192);
  try {
    sendJson(res, 200, await meow.sync(String(body.id || '')));
  } catch (err) { meowFail(res, err); }
});

route('GET', /^\/api\/meow\/config\/([\w-]+)$/, async (req, res, m) => {
  try {
    sendJson(res, 200, await meow.config(m[1]));
  } catch (err) { meowFail(res, err); }
});

route('POST', /^\/api\/meow\/depart$/, async (req, res) => {
  const body = await readBody(req, 8192);
  try {
    sendJson(res, 200, await meow.depart(String(body.id || ''), {
      locationId: String(body.locationId || '').trim(),
      strategy: String(body.strategy || '').trim(),
    }));
  } catch (err) { meowFail(res, err); }
});

route('POST', /^\/api\/meow\/claim$/, async (req, res) => {
  const body = await readBody(req, 8192);
  try {
    sendJson(res, 200, await meow.claim(String(body.id || '')));
  } catch (err) { meowFail(res, err); }
});

route('POST', /^\/api\/meow\/run$/, async (req, res) => {
  const body = await readBody(req, 8192);
  try {
    const out = await meow.runOnce(String(body.id || ''), { force: Boolean(body.force) });
    if (out.travel) await accounts.refresh(String(body.id || '')).catch(() => {});
    sendJson(res, 200, out);
  } catch (err) { meowFail(res, err); }
});

route('POST', /^\/api\/meow\/run-all$/, async (req, res) => {
  const body = await readBody(req, 8192);
  const results = await meow.runAll({ force: Boolean(body.force) });
  if (results.some((r) => r.action === 'claimed' || r.action === 'departed')) {
    bgRefreshAll();
  }
  sendJson(res, 200, { results });
});

route('GET', /^\/api\/meow\/records\/([\w-]+)$/, async (req, res, m) => {
  const u = new URL(req.url, 'http://x');
  sendJson(res, 200, await meow.records(m[1], u.searchParams.get('page') || 1, u.searchParams.get('size') || 20));
});

/* ---------------- 成长任务（Growth Program Tasks） ----------------
 * 走官方成长中心同款接口：
 *   GET  /v2/activity/growth/tasks              任务列表
 *   POST /activity/growth/tasks/accept          接受任务
 *   POST /activity/growth/tasks/{code}/claim    领取奖励（上游幂等，重复调用不会重复发奖）
 *   GET  /activity/growth/energy                能量余额
 */
function growthFail(res, err) {
  const code = err && err.statusCode ? err.statusCode : 500;
  sendJson(res, code, { error: err && err.message ? err.message : '操作失败' });
}







/**
 * 单个任务点亮（手动触发）。
 *
 * 与 /api/growth/complete（批量）的区别：**不受 settings.growth.allowLightUp 批量开关约束**。
 * 批量开关的用途是「禁止一条命令刷全部任务」（风控），而单任务按钮是用户对某一个任务的明确意图。
 * 2026-10-30 实测：埋点 userId 换成桌面 UUID 后，上报是真能归账的（0 → 1），
 * 所以单任务这条链路要真的能用，不能再被一个批量开关整条堵死。
 */


/* ---------------- 积分体系 ----------------
 * 数据来源：POST /billing/meter/get-user-resource-summary（不带 /v2 前缀）
 * 返回 data.Packages[]，逐包给出总量 / 已用 / 余量 / 到期时间。
 * 上游 /status 的积分滞后可达数小时，所以要单独查实时值。
 */
function needCredits(res) {
  if (creditsSvc) return true;
  sendJson(res, 503, { error: '积分模块未就绪', detail: creditsErr });
  return false;
}

route('GET', /^\/api\/credits$/, async (req, res) => {
  if (!needCredits(res)) return;
  const rows = [];
  for (const a of store.data.accounts || []) {
    const cached = (creditsSvc.getAccount && creditsSvc.getAccount(a.id)) || null;
    rows.push({
      id: a.id,
      nickname: a.nickname,
      enabled: a.enabled !== false,
      pauseMode: a.pauseMode || (a.enabled === false ? 'all' : ''),
      ...(cached || { at: null, credits: null, packages: [] }),
    });
  }
  // 汇总最近一笔到期，用于顶栏提醒"积分快过期了"
  let next = null;
  for (const r of rows) {
    if (!r.nextExpireAt) continue;
    if (!next || r.nextExpireAt < next.nextExpireAt) {
      next = { id: r.id, nickname: r.nickname, nextExpireAt: r.nextExpireAt, nextExpireCredits: r.nextExpireCredits };
    }
  }
  sendJson(res, 200, { at: Date.now(), accounts: rows, nextExpire: next });
});

/**
 * 模型目录 + 时段促销状态（前端模型管理界面用）。
 * force=1 强制绕过缓存重拉上游 /v3/config。
 */
route('GET', /^\/api\/models\/info$/, async (req, res) => {
  const force = /[?&]force=1/.test(req.url || '');
  const c = await modelCatalog.get({ force }).catch((e) => ({ ok: false, error: e.message, models: [], promotions: [] }));
  const wl = Array.isArray(store.data.settings.proxy.modelWhitelist)
    ? store.data.settings.proxy.modelWhitelist.map((x) => String(x || '').trim()).filter(Boolean) : [];
  // 当前会自动选中的模型（免费优先，其次白名单内倍率最低）
  let picked = null;
  if (c && c.ok) {
    const set = wl.length ? new Set(wl) : null;
    const pool = (c.models || []).filter((m) => (!set || set.has(m.id)) && m.rate !== null && m.rate !== undefined);
    if (pool.length) {
      const free = pool.filter((m) => m.rate === 0);
      picked = free.length ? free[0] : pool.slice().sort((a, b) => (a.rate - b.rate) || a.id.localeCompare(b.id))[0];
    }
  }
  sendJson(res, 200, {
    ok: !!(c && c.ok),
    error: (c && c.error) || '',
    stale: !!(c && c.stale),
    at: (c && c.at) || 0,
    models: (c && c.models) || [],
    promotions: (c && c.promotions) || [],
    nextFreeInMs: (c && c.nextFreeInMs) || null,
    whitelist: wl,
    autoSelect: store.data.settings.proxy.autoSelectModel === true,
    picked: picked ? { id: picked.id, name: picked.name, rate: picked.rate, free: !!picked.free } : null,
  });
});

route('POST', /^\/api\/credits\/refresh$/, async (req, res) => {
  if (!needCredits(res)) return;
  const body = await readBody(req, 8192);
  try {
    if (body.id) {
      const acc = (store.data.accounts || []).find((a) => a.id === String(body.id));
      if (!acc) return sendJson(res, 404, { error: '账号不存在' });
      return sendJson(res, 200, await creditsSvc.refreshAccount(acc));
    }
    sendJson(res, 200, await creditsSvc.refreshAll());
  } catch (err) {
    sendJson(res, 400, { error: err.message || '刷新失败' });
  }
});

route('GET', /^\/api\/credits\/ledger$/, async (req, res) => {
  if (!needCredits(res)) return;
  const u = new URL(req.url, 'http://localhost');
  const limit = Math.min(500, Math.max(1, Number(u.searchParams.get('limit')) || 100));
  const items = (creditsSvc.ledger && creditsSvc.ledger(limit)) || [];
  sendJson(res, 200, { total: items.length, items });
});

/* ---------------- 保活：令牌续期 + 活跃上报 ---------------- */
function needKeepalive(res) {
  if (keepaliveSvc) return true;
  sendJson(res, 503, { error: '保活模块未就绪', detail: keepaliveErr });
  return false;
}

route('GET', /^\/api\/keepalive\/status$/, async (req, res) => {
  const rt = store.data.runtime || {};
  sendJson(res, 200, {
    ready: Boolean(keepaliveSvc),
    error: keepaliveSvc ? '' : keepaliveErr,
    config: (store.data.settings && store.data.settings.keepalive) || {},
    lastRenewAt: rt.lastRenewAt || null,
    lastRenewResult: rt.lastRenewResult || '',
    lastKeepAliveAt: rt.lastKeepAliveAt || null,
    lastKeepAliveResult: rt.lastKeepAliveResult || '',
  });
});

route('POST', /^\/api\/keepalive\/run$/, async (req, res) => {
  if (!needKeepalive(res)) return;
  const body = await readBody(req, 8192);
  try {
    const out = body.mode === 'renew' ? await keepaliveSvc.renewAll() : await keepaliveSvc.runAll();
    sendJson(res, 200, out);
  } catch (err) {
    sendJson(res, 400, { error: err.message || '保活失败' });
  }
});

/* ---------------- 临时停用 ----------------
 * 两档语义：
 *   forward-only  只停转发与对话，签到 / 保活 / 小喵照常（默认）
 *   all           完全退出，连签到也不做
 * 停用比删除合适：删除会丢凭证，只能重新扫码登录。
 */
route('POST', /^\/api\/accounts\/([\w-]+)\/pause$/, async (req, res, m) => {
  const body = await readBody(req, 8192);
  const mode = body.mode === 'all' ? 'all' : 'forward-only';
  const acc = (store.data.accounts || []).find((a) => a.id === m[1]);
  if (!acc) return sendJson(res, 404, { error: '账号不存在' });
  if (typeof accounts.pause === 'function') {
    accounts.pause(acc.id, mode);
  } else {
    // 降级：老版本 accounts.js 没有 pause 方法时直接改字段
    acc.enabled = false;
    acc.pauseMode = mode;
    store.touch();
  }
  // 日志由 accounts.pause() 统一记录（它覆盖所有调用入口），这里不重复写
  sendJson(res, 200, { ok: true, id: acc.id, pauseMode: mode });
});

route('POST', /^\/api\/accounts\/([\w-]+)\/resume$/, async (req, res, m) => {
  const acc = (store.data.accounts || []).find((a) => a.id === m[1]);
  if (!acc) return sendJson(res, 404, { error: '账号不存在' });
  if (typeof accounts.resume === 'function') {
    accounts.resume(acc.id);
  } else {
    acc.enabled = true;
    acc.pauseMode = '';
    store.touch();
  }
  // 同上：日志统一由 accounts.resume() 记
  sendJson(res, 200, { ok: true, id: acc.id, pauseMode: '' });
});

/* ---------------- 邀请活动 ----------------
 * 官方接口：
 *   POST /activity/workbuddy/invitation/v2/bind       绑定邀请码（仅新注册用户）
 *   GET  /activity/workbuddy/invitation/v2/my-progress  邀请进度
 *   GET  /activity/workbuddy/invitation/v2/invite-records 邀请记录
 *   GET  /activity/workbuddy/invitation/v2/my-code      我的邀请码
 */



/* ---------- 自动注册：新手机号 → 建号 → 绑邀请码 → 激活 ---------- */





/* 设置 */
route('POST', /^\/api\/settings$/, async (req, res) => {
  const body = await readBody(req, 64 * 1024);
  const allowed = ['siteTitle', 'checkin', 'quota', 'proxy', 'meow', 'security', 'publicBaseUrl', 'growth', 'invite', 'credits', 'keepalive', 'schedule'];
  const patch = {};
  for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
  if (patch.proxy && patch.proxy.accessKey !== undefined) delete patch.proxy.accessKey;
  // modelMap 是对象，deepMerge 会深合并 —— 用户在界面上删掉的映射永远删不掉。
  // 单独记下「本次提交的完整键集」，合并完再把多出来的旧键剔掉（实现删除语义）。
  let mapKeepKeys = null;
  if (patch.proxy && patch.proxy.modelMap && typeof patch.proxy.modelMap === 'object') {
    mapKeepKeys = Object.keys(patch.proxy.modelMap);
  }
  store.patch('settings', patch);
  if (mapKeepKeys) {
    const keep = new Set(mapKeepKeys);
    const mm = store.data.settings.proxy.modelMap || {};
    for (const k of Object.keys(mm)) if (!keep.has(k)) delete mm[k];
    store.touch();
  }
  sendJson(res, 200, { settings: statePayload().settings });
});

route('POST', /^\/api\/password$/, async (req, res) => {
  const body = await readBody(req, 8192);
  auth.changePassword(body.current, body.next);
  store.log('warn', '管理员口令已修改，所有会话失效');
  sendJson(res, 200, { ok: true, relogin: true });
});

/* 代理密钥 */
route('POST', /^\/api\/proxy\/rotate$/, async (req, res) => {
  store.data.settings.proxy.accessKey = makeAccessKey();
  store.touch();
  store.log('warn', '代理访问密钥已重置');
  sendJson(res, 200, { accessKey: store.data.settings.proxy.accessKey });
});

/* 探测台：拿真实令牌打任意路径，原样回显 */
route('POST', /^\/api\/probe$/, async (req, res) => {
  const body = await readBody(req, 64 * 1024);
  const acc = body.id ? accounts.find(body.id) : null;
  if (!acc) {
    sendJson(res, 400, { error: '请选择一个账号作为探测凭证来源' });
    return;
  }
  const method = String(body.method || 'POST').toUpperCase();
  const pathName = String(body.path || '').trim();
  if (!pathName.startsWith('/')) {
    sendJson(res, 400, { error: '路径必须以 / 开头' });
    return;
  }
  try {
    const out = await wb.probe(acc, method, pathName, body.body === undefined ? {} : body.body);
    sendJson(res, 200, {
      url: out.url,
      status: out.status,
      ms: out.ms,
      json: out.json,
      text: out.json ? undefined : out.text.slice(0, 4000),
    });
  } catch (err) {
    sendJson(res, 200, { error: err.message, kind: err.kind, status: err.status });
  }
});

/* 备份 */
route('GET', /^\/api\/backup$/, async (req, res) => {
  const file = path.join(DATA_DIR, 'db.enc');
  if (!fs.existsSync(file)) {
    sendJson(res, 404, { error: '数据文件不存在' });
    return;
  }
  const st = fs.statSync(file);
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': st.size,
    'content-disposition': `attachment; filename="wb-console-${new Date().toISOString().slice(0, 10)}.db.enc"`,
    'cache-control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
});

/* 配对码 */
route('POST', /^\/api\/pairing$/, async (req, res) => {
  sendJson(res, 200, issuePairing());
});

route('POST', /^\/api\/pair$/, async (req, res) => {
  const body = await readBody(req, 32 * 1024);
  const origin = req.headers.origin || '';
  const cors = {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
  if (!consumePairing(body.code)) {
    sendJson(res, 401, { error: '配对码无效或已过期' }, cors);
    return;
  }
  const token = String(body.token || '').trim();
  const cookie = String(body.cookie || '').trim();
  const uid = String(body.uid || '').trim();
  if (!uid || (!token && !cookie)) {
    sendJson(res, 400, { error: '缺少 uid，且 token 与 cookie 至少需要一个' }, cors);
    return;
  }
  const check = await wb.verifyCredentials(token, uid, body.endpoint, cookie);
  if (!check.ok) {
    sendJson(res, 400, { error: '凭证校验失败：' + check.message }, cors);
    return;
  }
  if (body.probe) {
    // 扩展在页面上下文里实测到的接口结果，落库便于排查
    store.log('info', `扩展接口探测：${JSON.stringify(body.probe).slice(0, 400)}`);
  }
  const existing = accounts.raw.find((a) => a.uid === uid);
  let acc;
  if (existing) {
    acc = accounts.update(existing.id, { token, cookie, nickname: body.nickname || existing.nickname });
    store.log('info', `扩展更新账号 ${acc.nickname}`);
  } else {
    acc = accounts.create({ token, cookie, uid, nickname: body.nickname, endpoint: body.endpoint });
    store.log('info', `扩展新增账号 ${acc.nickname}`);
  }
  await accounts.refresh(acc.id).catch(() => {});
  const fresh = accounts.find(acc.id);
  // 顺手同步一次小喵状态，让「小喵」页首次打开就有真实数据
  if (fresh) await meow.sync(fresh.id).catch(() => {});
  sendJson(res, 200, {
    ok: true,
    via: check.via || '',
    account: fresh ? require('./lib/accounts').publicAccount(fresh) : acc,
  }, cors);
}, { public: true, noCsrf: true, allowCors: true });

/* 日志清理 */
route('POST', /^\/api\/logs\/clear$/, async (req, res) => {
  store.data.logs = [];
  store.touch();
  sendJson(res, 200, { ok: true });
});

/* 日志查询（支持条数限制，供「运行日志」页使用） */
route('GET', /^\/api\/logs$/, async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const limit = Math.min(400, Math.max(1, Number(url.searchParams.get('limit')) || 200));
  const logs = (store.data.logs || []).slice(0, limit);
  const counts = { info: 0, warn: 0, error: 0, other: 0 };
  for (const l of logs) {
    if (l.level === 'info') counts.info += 1;
    else if (l.level === 'warn') counts.warn += 1;
    else if (l.level === 'error') counts.error += 1;
    else counts.other += 1;
  }
  sendJson(res, 200, { logs, counts, total: (store.data.logs || []).length });
});

/* ---------------- 请求分发 ---------------- */
const server = http.createServer(async (req, res) => {
  securityHeaders(res);
  const started = Date.now();
  let pathname = '/';
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch (_) {
    pathname = '/';
  }

  /* ---- /v1 代理接口的授权闸门 ----
   * 这些是最容易被白嫖的入口（买家可以直接 curl 打模型），
   * 必须在最前面拦，不能依赖网关 API Key（key 是本地生成的，等于没有）。 */
  if (pathname.startsWith('/v1/')) {
    let gate;
    try {
      gate = await agate.check({ store, proxy });
    } catch (e) {
      gate = { ok: false, reason: 'licence_check_failed' };
    }
    if (!gate.ok) {
      store.log('warn', `[授权] 拦截 ${pathname}（${gate.reason}）`);
      openAiError(res, 403, agate.reasonText(gate.reason), 'licence_required', gate.reason);
      return;
    }
  }

  // OpenAI 兼容反向代理
  if (pathname === '/v1/models' && req.method === 'GET') {
    await proxy.handleModels(req, res);
    return;
  }
  // 扩展模型目录（非 OpenAI 标准）：带实时倍率/免费状态/是否保留，
  // 用同一个网关 API Key 鉴权，供 tools/gen_client_models.js 生成桌面端配置。
  if (pathname === '/v1/models/catalog' && req.method === 'GET') {
    await proxy.handleModelCatalog(req, res);
    return;
  }
  if (pathname === '/v1/chat/completions' && req.method === 'POST') {
    if (!store.data.settings.proxy.enabled) {
      openAiError(res, 503, '反向代理未开启，请在控制台「代理」页开启', 'service_unavailable', 'proxy_disabled');
      return;
    }
    await proxy.handleChat(req, res);
    return;
  }

  // CORS 预检（仅配对接口需要跨域）
  if (req.method === 'OPTIONS' && pathname === '/api/pair') {
    res.writeHead(204, {
      'access-control-allow-origin': req.headers.origin || '*',
      'access-control-allow-headers': 'content-type',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-max-age': '600',
    });
    res.end();
    return;
  }

  if (pathname.startsWith('/api/')) {
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(pathname);
      if (!m) continue;
      const needCsrf = req.method !== 'GET' && !r.opts.noCsrf;
      if (!r.opts.public) {
        const session = requireAuth(req, res, needCsrf);
        if (!session) return;
      }

      /* ---- 授权闸门 ----
       * 位置：登录校验之后、handler 之前。
       * 覆盖：签到 / 小喵 / 成长任务 / 邀请 / 代理 / 模型 / 账号操作 等全部核心接口。
       * 前端无论如何改 JS、逆向 UI 都绕不过这里（判断在服务端）。
       * 只放行 agate.ALLOW_PATTERNS 里的白名单（登录、设置、授权管理本身）。 */
      if (!r.opts.public && !agate.isAllowedPath(pathname)) {
        let gate;
        try {
          gate = await agate.check({ store, proxy });
        } catch (e) {
          gate = { ok: false, reason: 'licence_check_failed' };
        }
        if (!gate.ok) {
          store.log('warn', `[授权] 拦截 ${pathname}（${gate.reason}）`);
          sendJson(res, 403, {
            error: agate.reasonText(gate.reason),
            code: 'LICENCE_REQUIRED',
            reason: gate.reason,
          });
          return;
        }
      }
      try {
        await r.handler(req, res, m);
      } catch (err) {
        const status = err && err.code === 'RATE_LIMIT' ? 429 : err && err.code === 'BAD_PASSWORD' ? 401 : 400;
        sendJson(res, status, { error: err.message || '请求失败', code: err.code || 'ERROR' });
      }
      return;
    }
    sendJson(res, 404, { error: '接口不存在' });
    return;
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    serveStatic(req, res, pathname);
    return;
  }

  res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end('Method Not Allowed');
  if (Date.now() - started > 5000) store.log('warn', `慢请求 ${pathname}`);
});

/* ---------------- 启动 ---------------- */
scheduler.start();

const nets = os.networkInterfaces();
const lan = Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal).map((n) => n.address);

// 收紧头部超时，缓解 Slowloris 类慢速连接攻击（默认 60s）
server.headersTimeout = 20000;
server.requestTimeout = 0; // 流式代理（/v1/chat/completions）可能很久，不限制整个请求

server.listen(PORT, HOST, () => {
  const line = '='.repeat(64);
  console.log('\n' + line);
  console.log('  WorkBuddy 多账号工作台 · 服务端已启动');
  console.log(line);
  console.log(`  监听地址   ${HOST}:${PORT}`);
  console.log(`  本机访问   http://127.0.0.1:${PORT}`);
  if (HOST === '0.0.0.0') lan.forEach((ip) => console.log(`  局域网     http://${ip}:${PORT}`));
  console.log(`  数据目录   ${DATA_DIR}`);
  console.log(`  主密钥来源 ${master.source === 'env' ? '环境变量 WB_MASTER_KEY' : 'data/master.key'}`);
  console.log(`  构建版本   ${BUILD_VERSION}`);
  const rh = getRouteHealth();
  console.log(`  路由自检   ${rh.ok ? `OK（${rh.total} 条）` : `缺失 ${rh.missing.length} 条 → ${rh.missing.join(' , ')}`}`);
  if (!rh.ok) {
    console.log('  ⚠ 警告：关键路由未注册，页面可能报「接口不存在」。请确认磁盘代码与运行进程一致。');
    try { store.log('warn', `启动自检：路由缺失 ${rh.missing.length} 条（${rh.missing.join(', ')}）`); } catch (_) {}
  }
  if (initialPassword) {
    console.log(line);
    console.log(`  管理员口令（来自环境变量）：${initialPassword}`);
    console.log('  请登录后立即在「设置」里修改口令。');
  } else if (!auth.isInitialized()) {
    console.log(line);
    console.log('  首次使用：请用浏览器打开上面的地址，自己设置一个密码（至少 8 位）');
    console.log('  设置完成后即可进入后台。');
  }
  console.log(line + '\n');
});

function shutdown(sig) {
  console.log(`\n收到 ${sig}，正在保存数据并退出…`);
  scheduler.stop();
  qrlogin.shutdown().catch(() => {});
  phonelogin.shutdown().catch(() => {});
  try { store.log('info', `服务停止（${sig}）`); } catch (_) {}
  store.flush();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  console.error('[uncaught]', err);
  try { store.log('error', 'uncaught: ' + err.message); store.flush(); } catch (_) {}
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
