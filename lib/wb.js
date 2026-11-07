'use strict';
/**
 * WorkBuddy 官方接口客户端。
 *
 * 已实测确认的契约（2026-10，来源：客户端 product.json 与主进程代码）：
 *   base            https://www.workbuddy.cn
 *   鉴权头          Authorization: Bearer <accessToken>
 *                   X-User-Id: <uid>
 *                   （不发 x-source：上游没有这个头，见 buildHeaders 注释）
 *                   X-Enterprise-Id / X-Tenant-Id（企业账号才有）
 *   签到状态        POST /v2/billing/meter/checkin-activity-status   body {}
 *   执行签到        POST /v2/billing/meter/daily-checkin             body {}
 *   额度汇总        POST /v2/billing/meter/get-user-resource-summary body {}
 *   免费资源包      POST /v2/billing/meter/get-user-resource-free-packages
 *   付费资源包      POST /v2/billing/meter/get-user-resource-paid-packages
 *   对话            POST /v2/chat/completions
 *   统一响应壳      { code, msg, data }，code === 0 为成功
 *
 * 小喵（Buddy 旅行）接口来自官方后端 bundle growthSpace-BR3JGo_d.js，
 * 与网页版成长中心同名同路径，无 /v2 前缀：
 *   配置（地点）    GET  /activity/growth/buddy/travel/config
 *   当前状态        GET  /activity/growth/buddy/travel/status
 *   派出旅行        POST /activity/growth/buddy/travel/depart  { location_id }
 *   领取奖励        POST /activity/growth/buddy/travel/claim   {}
 *   旅行记录        GET  /activity/growth/buddy/travel/records?page&page_size
 *   旅行 Buddy      GET  /activity/growth/buddy/info
 *
 * 网页版本用 Cookie 鉴权（withCredentials），客户端版本用 Bearer。
 * 这里两条都支持：账号带 cookie 就发 cookie，带 token 就发 Bearer，两者可并存。
 */

const DEFAULT_ENDPOINT = 'https://www.workbuddy.cn';

/**
 * 官方客户端 UA。/v3/config 校验 UA，用别的 UA 会 400 code=12403。
 * 与 lib/models.js 的 OFFICIAL_UA 保持一致（同一个值，两处各自定义以免循环依赖）。
 */
const OFFICIAL_UA = 'WorkBuddy/5.9.3 WorkBuddy/5.9.3 CLI/2.165.0';

class WBError extends Error {
  constructor(message, meta) {
    super(message);
    this.name = 'WBError';
    this.status = meta && meta.status;
    this.code = meta && meta.code;
    this.raw = meta && meta.raw;
    this.kind = (meta && meta.kind) || 'upstream';
  }
}

function pickNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function pickStr(obj, keys) {
  if (!obj || typeof obj !== 'object') return '';
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** 早于 2000 年的时间一律当成「上游没给」的占位值（常见 0001-01-01 / 0） */
const MIN_VALID_MS = 946684800000;

/**
 * 把上游各种时间表示统一成毫秒时间戳：
 *   - 纯数字：>= 1e12 视为毫秒，否则视为秒
 *   - 数字字符串：同上
 *   - 'YYYY-MM-DD HH:mm:ss'：上游给的是 UTC+8 本地时间，这里显式按 +08:00 解析，
 *     不依赖服务器时区（服务器若是 UTC，用本地时间解析会整整差 8 小时）
 *   - ISO / 'YYYY-MM-DD'：交给 Date
 * 解析不出来返回 null。
 */
function toMs(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null;
    const ms = v >= 1e12 ? Math.round(v) : Math.round(v * 1000);
    return ms >= MIN_VALID_MS ? ms : null;
  }
  const s = String(v).trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return toMs(Number(s));
  // 无时区的 "2026-11-28 16:13:32" 固定按 UTC+8 解释
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (m) {
    const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - 8 * 3600 * 1000;
    return Number.isFinite(t) && t >= MIN_VALID_MS ? t : null;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) && t >= MIN_VALID_MS ? t : null;
}

/** 资源包/套餐的到期时间字段名在客户端里有多套写法，按优先级逐个试 */
const EXPIRE_KEYS = [
  // 实测确认：资源包详情里 DeductionEndTime 是毫秒时间戳，最可靠
  'DeductionEndTime',
  // 实测确认：CycleEndTime 是 "2026-11-28 16:13:32"（UTC+8 本地时间）
  'CycleEndTime',
  'ExpireTime', 'ExpireAt', 'ExpireDate', 'ExpireTimestamp', 'ExpiredTime', 'ExpirationTime',
  'CycleEndAt', 'EndTime', 'EndAt', 'ValidEnd', 'ValidUntil', 'ValidEndTime',
  'deductionEndTime', 'cycleEndTime', 'expireTime', 'expireAt', 'expireDate', 'expireTimestamp',
  'expiredTime', 'expirationTime', 'cycleEndAt', 'endTime', 'endAt', 'validEnd', 'validUntil', 'validEndTime',
];

/** 从对象里取第一个能解析成时间戳的到期字段 */
function pickExpireAt(obj) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of EXPIRE_KEYS) {
    const ms = toMs(obj[k]);
    if (ms !== null) return ms;
  }
  return null;
}

function normEndpoint(url) {
  const s = String(url || DEFAULT_ENDPOINT).trim().replace(/\/+$/, '');
  return s || DEFAULT_ENDPOINT;
}

function buildHeaders(account, extra) {
  const h = {
    'content-type': 'application/json',
    'user-agent': (account && account.ua) || 'WorkBuddy-Console/1.0',
    ...(extra || {}),
  };
  if (account && account.token) h.authorization = `Bearer ${account.token}`;
  if (account && account.cookie) h.cookie = account.cookie;
  // 只发真实数字 UID；扫码登录拿不到 UID 时库里会存 ck_xxx 占位，那种不能当请求头发出去
  if (account && account.uid && /^\d{6,}$/.test(String(account.uid))) h['x-user-id'] = String(account.uid);
  if (account && account.enterpriseId) {
    h['x-enterprise-id'] = account.enterpriseId;
    h['x-tenant-id'] = account.enterpriseId;
  }
  if (account && account.domain) h['x-domain'] = account.domain;
  return h;
}

/**
 * 对话请求头：只带「本服务真实需要的会话标识」，不伪造官方客户端身份。
 *
 * ⚠️ 2026-11-03 结论修正（勿回退）：
 *   上游 code:11128「Illegal API invocation from an unapproved channel」的判定主信号是
 *   **客户端身份**：UA、OpenAI SDK 特征头（X-Stainless-*）以及 **TLS 指纹（JA3/JA4）**。
 *   本网关是七层代理，TLS 在网关侧重建，指纹天然不可能等于官方桌面客户端，
 *   所以「补头冒充官方客户端」这条路从根本上不成立：
 *     - 补全后仍会被随机拦截（头对了但 TLS 指纹、头顺序对不上）
 *     - 且属于绕过对方访问控制，有连累账号/key 被风控封禁的风险
 *   因此这里**不再构造 x-agent-intent / x-ide-* / x-codebuddy-request 等身份伪装头**，
 *   也**不再把 UA 强改成官方三段式**（UA 沿用账号自身配置或默认值）。
 *   要走第三方客户端，正确路径是向对方申请服务端/网关白名单接入，
 *   或改用「凭证即授权」的端点（不绑定客户端）。
 */
function buildChannelHeaders(account, extra) {
  const h = buildHeaders(account, extra);
  const now = Date.now();
  const rid = (extra && extra['x-request-id']) || String(now * 1000 + Math.floor(Math.random() * 1000));
  /* ★ conversation-id 必须"同一轮请求稳定不变"。
   * 踩过的坑：原实现每次调用都新生成随机 conversation-id，导致同一个 x-request-id
   * 的三次重试各配了三个不同的 conversation-id。官方桌面端是「一个对话一个固定
   * conversation-id，重试时原样复用」，这种「同 requestId 多 conversationId」的
   * 自相矛盾形状，正是上游判「非官方客户端」的典型特征。
   * 现在：调用方（proxy）按客户端对话派生一个稳定的值传进来；拿不到才退化为
   * 按 requestId 派生——保证同一 rid 的重试永远得到同一个 conversation-id。 */
  const conv = (extra && extra['x-conversation-id'])
    || ('wb2api-conv-' + String(rid).replace(/[^0-9a-z]/gi, '').slice(0, 24));
  h['x-request-id'] = rid;
  h['x-conversation-id'] = conv;
  return h;
}

async function rawRequest(account, method, pathName, body, opts) {
  const endpoint = normEndpoint(account && account.endpoint);
  const url = /^https?:\/\//i.test(pathName) ? pathName : endpoint + pathName;
  const timeout = (opts && opts.timeout) || 20000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = Date.now();
  const doFetch = async (headers) => {
    const res = await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
    return { url, method, status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), text, json, ms: Date.now() - started };
  };
  try {
    let out = await doFetch(buildHeaders(account, opts && opts.headers));
    // token 失效时退回纯 Cookie 会话（实测业务接口仅凭 Cookie 也能通）
    if (out.status === 401 && account && account.token && account.cookie && !(opts && opts.noAuthRetry)) {
      const h2 = buildHeaders(account, opts && opts.headers);
      delete h2.authorization;
      out = await doFetch(h2);
      out.usedCookieAuth = true;
    }
    return out;
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    throw new WBError(aborted ? `请求超时（${timeout}ms）` : `网络请求失败：${err.message}`, {
      kind: aborted ? 'timeout' : 'network',
    });
  } finally {
    clearTimeout(timer);
  }
}

function interpret(res) {
  const body = res.json;
  const code = body && typeof body.code === 'number' ? body.code : null;
  const msg = body ? String(body.msg || body.message || '').trim() : '';
  if (res.status === 401 || res.status === 403) {
    const e = new WBError(msg || '令牌无效或已过期', { status: res.status, code, raw: body, kind: 'auth' });
    throw e;
  }
  if (!res.ok) {
    throw new WBError(msg || `上游返回 HTTP ${res.status}`, { status: res.status, code, raw: body, kind: 'http' });
  }
  if (code !== null && code !== 0) {
    const e = new WBError(msg || `业务错误 code=${code}`, { status: res.status, code, raw: body, kind: 'biz' });
    throw e;
  }
  return body;
}

/** 签到状态 + 该活动的积分总额，是「剩余积分」最可靠来源 */
async function checkinStatus(account) {
  const res = await rawRequest(account, 'POST', '/v2/billing/meter/checkin-activity-status', {});
  const body = interpret(res);
  const d = (body && body.data) || {};
  return {
    active: Boolean(d.active),
    todayCheckedIn: Boolean(d.today_checked_in),
    streakDays: pickNum(d, ['streak_days', 'streakDays']) || 0,
    dailyCredit: pickNum(d, ['daily_credit', 'dailyCredit']) || 0,
    todayCredit: pickNum(d, ['today_credit', 'todayCredit']) || 0,
    isStreakDay: Boolean(d.is_streak_day),
    nextStreakDay: pickNum(d, ['next_streak_day', 'nextStreakDay']) || 0,
    streakBonusDays: d.streak_bonus_days || null,
    streakBonusCredit: pickNum(d, ['streak_bonus_credit']) || 0,
    totalCredits: pickNum(d, ['total_credits', 'totalCredits']),
    checkinDates: Array.isArray(d.checkin_dates) ? d.checkin_dates : [],
    startTime: pickStr(d, ['start_time']),
    endTime: pickStr(d, ['end_time']),
    activityName: pickStr(d, ['activity_name']),
    raw: d,
    ms: res.ms,
  };
}

/** 执行签到。已签到的判定交给上游错误码，调用方负责归类 */
async function claimCheckin(account) {
  const res = await rawRequest(account, 'POST', '/v2/billing/meter/daily-checkin', {});
  const body = interpret(res);
  const d = (body && body.data) || {};
  return {
    credit: pickNum(d, ['credit']) || 0,
    streakDays: pickNum(d, ['streak_days', 'streakDays']) || 0,
    isStreakDay: Boolean(d.is_streak_day),
    raw: d,
    ms: res.ms,
  };
}

async function resourceSummary(account) {
  try {
    // 注意：这个接口不带 /v2 前缀（客户端里 resourcePrefix 为空串），带 /v2 会 404
    const res = await rawRequest(account, 'POST', '/billing/meter/get-user-resource-summary', {});
    const body = interpret(res);
    return { ok: true, data: (body && body.data) || null, ms: res.ms };
  } catch (err) {
    return { ok: false, error: err.message, kind: err.kind, status: err.status };
  }
}

/**
 * 资源包列表（带到期时间）。
 *
 * 实测（2026-10）：这两个接口都必须显式传 PackageCodes，不传上游报
 *   code=10001 ... PackageCodes required
 * 且路径**不带 /v2**，带 /v2 直接 404。
 *
 * @param {object} account
 * @param {'paid'|'free'} kind
 * @param {{codes?: string[], pageNumber?: number, pageSize?: number, needRenewInfo?: boolean}} [opts]
 * @returns {Promise<{ok: boolean, items?: object[], accounts?: object[], totalCount?: number, error?: string}>}
 */
async function packages(account, kind, opts) {
  const o = opts || {};
  const pathName = kind === 'free'
    ? '/billing/meter/get-user-resource-free-packages'
    : '/billing/meter/get-user-resource-paid-packages';
  const codes = Array.isArray(o.codes) ? o.codes.filter((x) => typeof x === 'string' && x) : [];
  try {
    const res = await rawRequest(account, 'POST', pathName, {
      PackageCodes: codes,
      PageNumber: Number(o.pageNumber) || 1,
      PageSize: Number(o.pageSize) || Math.max(20, codes.length),
      // 实测 free-packages 同样接受 NeedRenewInfo，且到期字段本就随包返回，统一传
      NeedRenewInfo: o.needRenewInfo !== false,
    });
    const body = interpret(res);
    const d = (body && body.data) || {};
    const list = d.Accounts || d.accounts || d.Packages || d.packages || [];
    const items = Array.isArray(list) ? list : [];
    return { ok: true, items, accounts: items, totalCount: Number(d.TotalCount) || 0 };
  } catch (err) {
    return { ok: false, error: err.message, kind: err.kind, status: err.status };
  }
}

/**
 * 资源包详情索引：以 PackageCode / ResourceId 为键，方便和 summary 的包对齐。
 * 失败不影响主流程（到期时间取不到就是 null）。
 */
async function packageDetailIndex(account, codes, errors) {
  const index = new Map();
  if (!codes.length) return index;
  /* 实测（2026-10-30，四个账号逐一验证）：
   *   paid-packages 对**所有账号**都返回 200 + Accounts=0 / TotalCount=0；
   *   真正的资源包（含 DeductionEndTime / CycleEndTime）全在 **free-packages**。
   * 所以先查 free，拿不到再退回 paid（将来若有真正的付费包仍能覆盖）。
   * pageSize 必须给足：实测单个账号可达 52 条，给 20 会漏掉到期那笔。
   */
  const opts = { codes, pageSize: 200, needRenewInfo: true };
  let det = await packages(account, 'free', opts);
  if (!det.ok || !(det.items && det.items.length)) {
    const alt = await packages(account, 'paid', opts);
    if (alt.ok && alt.items && alt.items.length) det = alt;
    else if (!alt.ok && errors) {
      errors.push({ part: 'packages', message: alt.error, kind: alt.kind, status: alt.status });
    }
  }
  if (!det.ok) return index;
  for (const it of det.items) {
    const code = pickStr(it, ['PackageCode', 'packageCode']);
    if (code) index.set(code, it);
    const rid = pickStr(it, ['ResourceId', 'resourceId']);
    if (rid && !index.has(rid)) index.set(rid, it);
  }
  return index;
}

/** 汇总：额度总览。字段名在客户端里是多套并存，这里做容错提取 */
async function snapshot(account) {
  const out = {
    at: Date.now(),
    credits: null,          // 账号总积分（上游 TotalCredits 口径 = 当前可用）
    creditsTotal: null,     // 额度总量（各资源包 CycleTotalCapacity 之和）
    creditsRemain: null,    // 各资源包可用余量之和
    creditsUsed: null,      // 已消耗
    planName: '',
    expireAt: null,         // 最近一笔到期时刻（毫秒），null = 上游没下发有效期
    daysLeft: null,
    nextExpireAt: null,     // 同 expireAt，语义更明确：最近到期的那一笔
    nextExpireCredits: null,// 那一笔到期时还剩多少积分
    nextExpirePackageId: '',
    nextExpirePackageName: '',
    planExpireAt: null,     // 套餐级过期时间（资源包自身没效期时的兜底）
    packages: [],
    creditGroups: [],
    checkin: null,
    errors: [],
  };

  const st = await checkinStatus(account).catch((e) => {
    out.errors.push({ part: 'checkin', message: e.message, kind: e.kind, status: e.status });
    return null;
  });
  if (st) {
    out.checkin = st;
    // 签到活动的 total_credits 是「该活动累计发放的签到积分」（实测恒为 200），
    // 不是账号总积分，只能单独作参考，绝不能当账号余额用。
    out.checkinCredits = typeof st.totalCredits === 'number' ? st.totalCredits : null;
  }

  // summary 自带 Packages，已经包含每个包的额度/余量/已用，
  // 不再单独调 paid/free-packages（上游已改为必须传 PackageCodes，且信息更少）。
  const sum = await resourceSummary(account);

  if (sum.ok && sum.data) {
    const d = sum.data;
    // 账号总积分以资源包汇总为准：TotalCredits 是上游的总积分口径，
    // 各资源包 CycleRemainCapacity 之和是当前可用余量。
    const total = pickNum(d, ['TotalCredits', 'totalCredits', 'total_credits', 'credits', 'balance', 'Balance']);
    if (total !== null) out.credits = total;
    const pkgList = Array.isArray(d.Packages) ? d.Packages : [];
    let remain = 0, used = 0, capTotal = 0, hasPkg = false;
    for (const p of pkgList) {
      const rem = pickNum(p, ['CycleRemainCapacity', 'cycleRemainCapacity']);
      const usedCap = pickNum(p, ['CycleUsedCapacity', 'cycleUsedCapacity']);
      const cap = pickNum(p, ['CycleTotalCapacity', 'cycleTotalCapacity']);
      if (rem !== null) { remain += rem; hasPkg = true; }
      if (usedCap !== null) used += usedCap;
      if (cap !== null) capTotal += cap;
    }
    if (hasPkg) out.creditsRemain = remain;
    if (used > 0) out.creditsUsed = used;
    if (capTotal > 0) out.creditsTotal = capTotal;
    out.creditGroups = (Array.isArray(d.CreditGroups) ? d.CreditGroups : []).map((g) => ({
      kind: pickStr(g, ['Kind']) || '',
      name: pickStr(g, ['Name']) || '',
      total: pickNum(g, ['CycleTotalCapacity']) || 0,
      remain: pickNum(g, ['CycleRemainCapacity']) || 0,
      used: pickNum(g, ['CycleUsedCapacity']) || 0,
    }));
    out.planName = pickStr(d, ['SubscriptionPackageName', 'subscriptionPackageName', 'subscriptionPackageCode', 'packageName', 'planName', 'PlanName']);
    out.isPaidUser = Boolean(d.IsPaidUser);
    out.rawSummary = d;
  } else if (!sum.ok) {
    out.errors.push({ part: 'summary', message: sum.error, kind: sum.kind, status: sum.status });
  }

  // summary 自带 Packages，已经包含每个包的额度/余量/已用，
  // 但**实测 summary 里没有任何时间字段**（只有 PackageCode / CycleXxxCapacity /
  // CapacityUnit / TotalCount），所以到期时间必须再调一次「资源包详情」：
  //   Step 1 summary 拿 PackageCodes → Step 2 paid-packages(PackageCodes) 拿 DeductionEndTime。
  const pkgList = Array.isArray(out.rawSummary && out.rawSummary.Packages) ? out.rawSummary.Packages : [];
  const codes = [];
  for (const p of pkgList) {
    const c = pickStr(p, ['PackageCode']);
    if (c && !codes.includes(c)) codes.push(c);
  }
  const detailIndex = await packageDetailIndex(account, codes, out.errors);
  out.packageDetailCount = detailIndex.size;

  for (const p of pkgList) {
    const code = pickStr(p, ['PackageCode']) || '';
    if (out.packages.some((x) => x.id === code)) continue;
    const det = (code && detailIndex.get(code)) || null;
    // 额度优先用详情里的 *Precise 字段，否则 524.09000128 会被截成 524
    const total = pickNum(det, ['CycleCapacitySizePrecise', 'CycleTotalCapacity'])
      ?? pickNum(p, ['CycleTotalCapacity']);
    const remain = pickNum(det, ['CycleCapacityRemainPrecise', 'CycleRemainCapacity'])
      ?? pickNum(p, ['CycleRemainCapacity']);
    let used = pickNum(det, ['CycleCapacityUsedPrecise', 'CycleUsedCapacity'])
      ?? pickNum(p, ['CycleUsedCapacity']);
    if (used === null && total !== null && remain !== null) {
      used = Math.round((total - remain) * 1e6) / 1e6;
    }
    // 到期优先看详情（DeductionEndTime 毫秒 > CycleEndTime 字符串），再退到 summary 上的同名字段
    const expireAt = pickExpireAt(det) || pickExpireAt(p);
    const leftMs = expireAt === null ? null : expireAt - Date.now();
    out.packages.push({
      id: code,
      name: pickStr(det, ['SubProductName', 'PackageName']) || pickStr(p, ['PackageName']) || '资源包',
      total,
      used,
      remain,
      unit: pickStr(det, ['CapacityUnit']) || pickStr(p, ['CapacityUnit']) || 'credits',
      expireAt,                                                   // 毫秒时间戳，null = 未下发有效期
      // 剩余天数向下取整：29.1 天显示「还剩 29 天」，不足 1 天显示 0（配合 expired 表示今天/已到期）
      daysLeft: leftMs === null ? null : Math.max(0, Math.floor(leftMs / 86400000)),
      expired: leftMs !== null && leftMs <= 0,
      // 赠送包等来源标记（AccountAttributes[].Value，如 welcome_gift），可供流水归因
      giftTag: (Array.isArray(det && det.AccountAttributes) ? det.AccountAttributes : [])
        .map((a) => pickStr(a, ['Value']))
        .filter(Boolean)
        .join(','),
      raw: p,
      detail: det || null,
    });
  }

  // 到期倒计时：取「还没过期」的包里最早到期的那一笔（只看有余额的，没余额的到期了也不影响）
  const nowMs = Date.now();
  const upcoming = out.packages
    .filter((p) => p.expireAt !== null && p.expireAt > nowMs && (p.remain === null || p.remain > 0))
    .sort((a, b) => a.expireAt - b.expireAt);
  const next = upcoming[0] || null;
  out.nextExpireAt = next ? next.expireAt : null;        // 最近一笔到期的时刻（毫秒）
  out.nextExpireCredits = next ? next.remain : null;      // 那一笔还剩多少积分
  out.nextExpirePackageId = next ? next.id : '';
  out.nextExpirePackageName = next ? next.name : '';
  out.expireAt = out.nextExpireAt;
  // 所有包都没有效期时，退到套餐级过期时间（同样是多候选字段）
  if (out.expireAt === null) {
    const planExpire = pickExpireAt(out.rawSummary);
    if (planExpire) {
      out.expireAt = planExpire;
      out.nextExpireAt = planExpire;
      out.planExpireAt = planExpire;
    }
  }
  out.daysLeft = out.expireAt === null ? null : Math.max(0, Math.floor((out.expireAt - nowMs) / 86400000));

  out.ok = out.errors.length === 0 || out.credits !== null;
  return out;
}

/** 校验一组凭证是否可用：先试计费接口，鉴权失败再试成长中心（Cookie 通常只在这边有效） */
async function verifyCredentials(token, uid, endpoint, cookie) {
  const account = { token, uid, cookie, endpoint: endpoint || DEFAULT_ENDPOINT };
  try {
    const st = await checkinStatus(account);
    return { ok: true, via: 'billing', status: st };
  } catch (err) {
    if (err && err.kind === 'auth') {
      // Cookie 会话（APISIX openid-connect）：/console/* 能直接反映登录态，并且能拿到 UID
      const me = await whoami(account).catch(() => ({ uid: '', uuid: '', nickname: '', enterpriseId: '' }));
      if (me && me.uid) {
        return {
          ok: true, via: 'console', uid: me.uid, uuid: me.uuid || '',
          nickname: me.nickname || '', enterpriseId: me.enterpriseId || '',
        };
      }
      try {
        const tr = await travelStatus(account);
        return { ok: true, via: 'growth', travel: tr };
      } catch (err2) {
        return { ok: false, kind: err2.kind || err.kind, status: err2.status || err.status, message: err2.message || err.message };
      }
    }
    return { ok: false, kind: err.kind, status: err.status, message: err.message };
  }
}

/* ---------------- 身份识别 ---------------- */

/** 递归扫描响应体，捞出 uid / uuid / 昵称 / 企业 ID（字段名在上游有多套写法） */
function scanIdentity(node, depth, out) {
  if (!node || depth > 6) return;
  if (Array.isArray(node)) {
    for (const v of node.slice(0, 20)) scanIdentity(v, depth + 1, out);
    return;
  }
  if (typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    const key = String(k).toLowerCase();
    // ★ uid ≠ uin。桌面客户端把 account.uid 写成 UUID（2ed057f8-…-…），
    //   /console/accounts 同一层里还有 uin（12 位数字）。埋点上报 /v2/report 认的是 UUID：
    //   实测同一份事件、同一 token，只把 userId 从 uin 换成 UUID，任务计数 0 → 1。
    //   所以两者分开存，别让下面的数字分支把 UUID 过滤掉。
    if (!out.uuid && /^(uid|userid|user_id|useridstr)$/.test(key)) {
      const s = String(v);
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) out.uuid = s;
    }
    if (!out.uid && /^(uid|userid|user_id|useridstr|uin|staffid|staff_id)$/.test(key)) {
      const s = String(v);
      if (/^\d{6,25}$/.test(s)) out.uid = s;
    }
    if (!out.nickname && /^(nickname|nick_name|username|user_name|displayname|display_name)$/.test(key) && typeof v === 'string') {
      const s = v.trim();
      if (s && s.length <= 40) out.nickname = s;
    }
    if (!out.enterpriseId && /^(enterpriseid|enterprise_id|tenantid|tenant_id|orgid|org_id)$/.test(key)) {
      const s = String(v);
      if (s && s !== '0' && s !== 'null') out.enterpriseId = s;
    }
    scanIdentity(v, depth + 1, out);
  }
}

/**
 * 用现有凭证问「我是谁」。
 * 网页 Cookie 会话下，用户身份只出现在 /console/* 的返回里；把 UID 捞出来才能入库。
 */
async function whoami(account) {
  const out = { uid: '', uuid: '', nickname: '', enterpriseId: '', sources: [], errors: [] };
  for (const p of ['/console/accounts', '/console/account']) {
    try {
      const res = await rawRequest(account, 'GET', p, undefined, { timeout: 12000 });
      if (!res.ok) {
        out.errors.push({ path: p, status: res.status });
        continue;
      }
      if (!res.json) continue;
      out.sources.push(p);
      scanIdentity(res.json, 0, out);
      if (out.uid && out.uuid) break;
    } catch (err) {
      out.errors.push({ path: p, message: err.message });
    }
  }
  return out;
}

/** 原始探测：给设置页的诊断台用 */
async function probe(account, method, pathName, body) {
  return rawRequest(account, method, pathName, body, { timeout: 15000 });
}

/**
 * 拉上游产品配置 /v3/config：模型目录 + 时段促销 + 会员分层。
 *
 * 为什么必须用它而不是 data/models.json：
 *   - models.json 是 product.json@5.9.3 的静态快照，已过期（若干模型倍率缺失）；
 *   - 「时段免费/折扣」信息**只在** /v3/config 的 data.modelPromotions 里，
 *     /console/enterprises/personal/models 与 /v2/.../models 都不下发 promotions。
 *
 * 必须带官方三段式 UA，否则 400 code=12403（"check ua, get coding copilot version error"）。
 *
 * @param {object} account 账号
 * @returns {Promise<object>} { ok, data, error }
 */
async function productConfig(account) {
  try {
    const res = await rawRequest(account, 'GET', '/v3/config', undefined, {
      timeout: 20000,
      headers: { 'user-agent': OFFICIAL_UA, accept: 'application/json' },
    });
    if (!res.ok || !res.json) {
      const msg = (res.json && (res.json.msg || res.json.message)) || `HTTP ${res.status}`;
      return { ok: false, error: msg, status: res.status, code: res.json && res.json.code };
    }
    // 这个端点的响应壳不是 {code,msg,data}，data 直接在顶层
    const data = res.json && res.json.data ? res.json.data : res.json;
    return { ok: true, data, ms: res.ms };
  } catch (err) {
    return { ok: false, error: err.message, kind: err.kind, status: err.status };
  }
}

/** 对话透传：返回原始 fetch Response，由调用方决定如何回写 */
async function chat(account, body, opts) {
  const endpoint = normEndpoint(account.endpoint);
  const controller = new AbortController();
  const owned = !(opts && opts.signal);
  const signal = owned ? controller.signal : opts.signal;
  /* TTFB（首字节）超时：上游接受连接但迟迟不回响应头（挂起/排队）时，
   * 若只靠总超时（300s），一次尝试就要干等 5 分钟才 failover —— 实测用户
   * 「选工作站等 3 分半」就是这类场景。加上 45s 首字节超时后：
   *   响应头没到 → 快速 abort → 调用方立刻换下一个账号/模型；
   *   响应头一到 → 清掉定时器，流式生成时长不受任何限制。
   * 总超时（opts.timeout，默认 300s）只约束「等到响应头」这段，语义与原来一致。 */
  const ttfbMs = Math.max(1000, Number(opts && opts.ttfbTimeout) || 45000);
  const totalMs = Math.max(ttfbMs, Number(opts && opts.timeout) || 300000);
  let ttfbTimer = null;
  let totalTimer = null;
  if (owned) {
    ttfbTimer = setTimeout(() => controller.abort('ttfb'), ttfbMs);
    totalTimer = setTimeout(() => controller.abort('total'), totalMs);
  }
  try {
    const outHdr = buildChannelHeaders(account, {
      accept: 'text/event-stream',
      'x-request-id': opts && opts.requestId,
      'x-conversation-id': opts && opts.conversationId,
    });
    // 诊断开关：仅 WB_DEBUG_OUTHDR=1 时开启（=0 / 未设均关闭，避免 "0" 被 truthy 误判）
    const dbg = process.env.WB_DEBUG_OUTHDR === '1';
    if (dbg) {
      console.error('[outhdr] ' + JSON.stringify(Object.fromEntries(
        Object.entries(outHdr).map(([k, v]) => [k, /authorization|cookie/i.test(k) ? '***' : v])
      )));
    }
    const res = await fetch(endpoint + '/v2/chat/completions', {
      method: 'POST',
      headers: outHdr,
      body: JSON.stringify(body),
      signal,
    });
    if (dbg) console.error('[resp] status=' + res.status + ' model=' + (body && body.model) + ' rid=' + (outHdr['x-request-id'] || ''));
    return res;
  } catch (err) {
    // Node 的 undici fetch abort 后 err.name 不一定是 'AbortError'，
    // 所以用自己写入的 signal.reason 判定超时类型（owned 时 abort 只可能来自定时器）。
    const reason = owned ? String(controller.signal.reason || '') : '';
    if (reason === 'ttfb') {
      throw new WBError(`上游响应头超时（${ttfbMs}ms 内未返回，已换号重试）`, { kind: 'timeout' });
    }
    if (reason === 'total') {
      throw new WBError('上游连接超时', { kind: 'timeout' });
    }
    throw new WBError(`上游连接失败：${(err && err.message) || err}`, { kind: 'network' });
  } finally {
    if (ttfbTimer) clearTimeout(ttfbTimer);
    if (totalTimer) clearTimeout(totalTimer);
  }
}

/**
 * 便捷对话（发一条消息并拿回文本）。
 *
 * 重要：上游 /v2/chat/completions **只支持流式**，
 * 传 stream:false（或不传 stream）一律返回 400：
 *   "Non-stream chat request is currently not supported"
 * 因此这里固定用 stream:true，再把 SSE 里的 delta.content 拼成完整文本。
 *
 * 与 chat() 的区别：chat() 只返回原始 Response 供代理透传；
 * 本函数会校验状态码并解析出文本，失败时抛出带 status 的 WBError。
 *
 * @param {object} account 账号
 * @param {object} opts { model, messages|prompt, maxTokens }
 * @returns {Promise<{ok: boolean, status: number, text: string, usage: object|null, raw: string}>}
 */
async function chatSimple(account, opts) {
  const o = opts || {};
  const messages = Array.isArray(o.messages) && o.messages.length
    ? o.messages
    : [{ role: 'user', content: o.prompt || '你好' }];
  const body = {
    model: o.model || 'deepseek-v4-pro',
    messages,
    stream: true,
    max_tokens: o.maxTokens || 64,
  };
  const res = await chat(account, body);
  const status = res.status;
  const raw = await res.text();

  if (status < 200 || status >= 300) {
    let msg = 'HTTP ' + status;
    try {
      const j = JSON.parse(raw);
      if (j && (j.msg || j.message)) msg = j.msg || j.message;
    } catch (_) { /* 非 JSON 错误体，保留 HTTP 状态码文案 */ }
    const err = new WBError('对话失败：' + msg, { kind: 'upstream' });
    err.status = status;
    throw err;
  }

  let text = '';
  let usage = null;
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('data:')) continue;
    const payload = t.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      if (j.usage) usage = j.usage;
      const ch = j.choices && j.choices[0];
      if (ch && ch.delta && typeof ch.delta.content === 'string') text += ch.delta.content;
    } catch (_) { /* 跳过非 JSON 帧 */ }
  }
  return { ok: true, status, text, usage, raw };
}

/* ---------------- 小喵（Buddy 旅行） ---------------- */

const TRAVEL = {
  config: '/activity/growth/buddy/travel/config',
  status: '/activity/growth/buddy/travel/status',
  depart: '/activity/growth/buddy/travel/depart',
  claim: '/activity/growth/buddy/travel/claim',
  records: '/activity/growth/buddy/travel/records',
  info: '/activity/growth/buddy/info',
  energy: '/activity/growth/energy',
};

/* 领养第一只 Buddy —— 几乎所有成长任务的前置条件。
 * 上游 ref_go_travel.go:22-23 与 richmeow_upstream.py:187-205：
 *   1) POST {growth}/activity/growth/buddy/agreement  {"agree": true}
 *   2) POST {growth}/activity/growth/buddy/first      {}
 *   → 直接发积分（上游口径 +300c+8e），任务 first_buddy 随之 completed
 *
 * ★ 为什么必须有这一步（2026-10-30 实测）：
 *   对 playbook_prompt / Library_read 等任务发 accept，服务端 200+code0，
 *   但 data.results[].message 写的是
 *     "prerequisite not met: first_buddy (no buddy instance found)"
 *   —— 接单根本没生效，接单后的任何埋点都不会计入进度。
 *   上游 Go 里也有对应错误关键词 buddyTaskIncompleteMarker = "first_buddy task not completed yet"。
 */
const BUDDY_ADOPT = {
  agreement: '/activity/growth/buddy/agreement',
  first: '/activity/growth/buddy/first',
};

/** 领养协议确认：先同意协议，否则 buddy/first 会被拦。 */
async function buddyAgreement(account) {
  const res = await rawRequest(account, 'POST', BUDDY_ADOPT.agreement, { agree: true }, { timeout: 15000 });
  let body;
  try {
    body = interpret(res);
  } catch (err) {
    throw travelFailure(err);
  }
  return { ok: true, body, ms: res.ms };
}

/** 领养第一只 Buddy：直接发积分，first_buddy 任务随之完成。 */
async function buddyFirst(account) {
  const res = await rawRequest(account, 'POST', BUDDY_ADOPT.first, {}, { timeout: 20000 });
  let body;
  try {
    body = interpret(res);
  } catch (err) {
    throw travelFailure(err);
  }
  const d = (body && body.data) || {};
  return {
    ok: true,
    credit: pickNum(d, ['credit']) ?? 0,
    energy: pickNum(d, ['energy']) ?? 0,
    buddy: d.buddy || d.current || null,
    body,
    ms: res.ms,
  };
}

/**
 * 把上游 msg 归类成语义错误码。
 * 依据官方前端 depart/claim 的 catch 分支原文判定顺序。
 */
function classifyTravelError(msg, status) {
  const m = String(msg || '').toLowerCase();
  if (status === 429 || m.includes('daily limit') || m.includes('今天累')) return 'LIMIT';
  if (m.includes('no active buddy')) return 'NO_BUDDY';
  if (m.includes('already traveling')) return 'ALREADY_TRAVELING';
  if (m.includes('location not available')) return 'LOCATION_UNAVAILABLE';
  if (m.includes('not arrived yet') || m.includes('no unclaimed travel')) return 'NOT_ARRIVED';
  if (m.includes('grant credits failed')) return 'GRANT_FAILED';
  if (m.includes('invalid request')) return 'INVALID_REQUEST';
  if (status === 401 || status === 403) return 'AUTH';
  return 'UPSTREAM';
}

/**
 * 上游用 HTTP 403 同时表达「凭证失效」和业务拒绝（已在旅行中 / 还没到点）。
 * 所以必须先按 msg 判业务语义，只有判不出业务含义时才当成鉴权问题，
 * 否则会把「already traveling」误标成「凭证失效」。
 */
function travelFailure(err) {
  const msg = err && err.message ? err.message : '';
  const status = err && err.status;
  let code = classifyTravelError(msg, status);
  if (code === 'UPSTREAM' && err && err.kind === 'auth') code = 'AUTH';
  const out = new WBError(err ? err.message : '上游错误', {
    status, code, kind: err && err.kind, raw: err && err.raw,
  });
  out.travelCode = code;
  return out;
}

/**
 * 地点 id 归一化。
 *
 * 上游 /travel/config 的 location.id 是「数字」（1/2/3/4），travel/depart 也只认整数；
 * 传字符串（哪怕是 "1"）或 code（"coffee"）都会被上游判成 invalid request。
 * 所以 id 必须保留数字类型，绝不能用只接受字符串的 pickStr 去取。
 */
function pickId(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '') {
      const s = v.trim();
      if (/^\d+$/.test(s)) return Number(s);
      return s;
    }
  }
  return null;
}

/** 发给上游前把地点 id 统一成「数字优先」的形式 */
function normalizeLocationId(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return '';
  if (/^\d+$/.test(s)) return Number(s);
  return s;
}

/**
 * 地点归一化。字段名以实测上游 /travel/config 响应为准：
 *   { id:1, code:"coffee", name:"咖啡馆", description:"…", cover_url:"",
 *     duration_hours_min:1, duration_hours_max:4,
 *     reward_credit_min:5, reward_credit_max:10, sort:1,
 *     preview_photos:[{url,title}], traveling_photos:[{url,title}] }
 */
function normLocation(l) {
  if (!l || typeof l !== 'object') return null;
  const rawId = pickId(l, ['id', 'location_id', 'locationId']);
  const code = pickStr(l, ['code', 'key']);
  const id = rawId === null ? (code || '') : rawId;

  // 时长：上游用「小时」（duration_hours_min/max），depart 返回 duration_hours
  const hoursMin = pickNum(l, ['duration_hours_min', 'durationHoursMin']);
  const hoursMax = pickNum(l, ['duration_hours_max', 'durationHoursMax']);
  const hours = pickNum(l, ['duration_hours', 'durationHours']);
  // 兼容旧版「分钟」字段
  const legacyMinutes = pickNum(l, ['duration_min', 'durationMinutes', 'minutes']);
  let durationMin = legacyMinutes;
  if (durationMin === null && hoursMin !== null) durationMin = hoursMin * 60;
  if (durationMin === null && hours !== null) durationMin = hours * 60;

  const rewardMin = pickNum(l, ['reward_credit_min', 'rewardCreditMin']);
  const rewardMax = pickNum(l, ['reward_credit_max', 'rewardCreditMax']);
  const reward = pickNum(l, ['reward_credit', 'rewardCredit', 'credit', 'reward']);

  return {
    id,
    code,
    name: pickStr(l, ['name', 'title', 'label']),
    desc: pickStr(l, ['desc', 'description', 'intro', 'subtitle']),
    image: pickStr(l, ['cover_url', 'coverUrl', 'image', 'image_url', 'imageUrl', 'cover', 'thumbnail_url', 'icon']),
    durationMin,
    durationHours: hours !== null ? hours : (hoursMin !== null ? hoursMin : null),
    durationHoursMin: hoursMin,
    durationHoursMax: hoursMax,
    rewardCredit: reward !== null ? reward : (rewardMin !== null ? rewardMin : null),
    rewardCreditMin: rewardMin,
    rewardCreditMax: rewardMax,
    previewPhotos: Array.isArray(l.preview_photos) ? l.preview_photos : [],
    travelingPhotos: Array.isArray(l.traveling_photos) ? l.traveling_photos : [],
    raw: l,
  };
}

/** 官方前端 Ge() 的字段映射：state / location / depart_at / arrive_at / server_now / daily_limit_reached */
function normTravel(d) {
  const o = d && typeof d === 'object' ? d : {};
  const state = String(o.state || 'idle').toLowerCase();
  const serverNow = pickNum(o, ['server_now', 'serverNow']) || 0;
  return {
    state,
    location: normLocation(o.location),
    departAt: pickNum(o, ['depart_at', 'departAt']) || 0,
    arriveAt: pickNum(o, ['arrive_at', 'arriveAt']) || 0,
    serverNow,
    serverOffsetMs: serverNow ? serverNow * 1000 - Date.now() : 0,
    letter: o.letter || null,
    useDeeplink: pickStr(o, ['use_deeplink', 'useDeeplink']),
    dailyLimitReached: Boolean(o.daily_limit_reached ?? o.dailyLimitReached),
    rewardCredit: pickNum(o, ['reward_credit', 'rewardCredit']) || 0,
    raw: o,
  };
}

function emptyTravel() {
  return {
    state: 'idle', location: null, departAt: 0, arriveAt: 0, serverNow: 0,
    serverOffsetMs: 0, letter: null, useDeeplink: '', dailyLimitReached: false,
    rewardCredit: 0, raw: {},
  };
}

/** 地点配置。locations 为空表示活动未开放 */
async function travelConfig(account) {
  const res = await rawRequest(account, 'GET', TRAVEL.config, undefined, { timeout: 15000 });
  let body;
  try {
    body = interpret(res);
  } catch (err) {
    throw travelFailure(err);
  }
  const d = (body && body.data) || {};
  const rawLoc = Array.isArray(d.locations) ? d.locations : [];
  const locations = rawLoc.map(normLocation).filter((x) => x && x.id);
  return {
    enabled: locations.length > 0,
    locations,
    slogans: Array.isArray(d.intro_slogans) ? d.intro_slogans : [],
    sloganItems: Array.isArray(d.intro_slogan_items) ? d.intro_slogan_items : [],
    ms: res.ms,
  };
}

/** 当前旅行状态 */
async function travelStatus(account) {
  const res = await rawRequest(account, 'GET', TRAVEL.status, undefined, { timeout: 15000 });
  let body;
  try {
    body = interpret(res);
  } catch (err) {
    throw travelFailure(err);
  }
  const st = normTravel((body && body.data) || {});
  st.ms = res.ms;
  return st;
}

/** 派出旅行。locationId 必须来自 travelConfig().locations[].id（数字），上游只认整数 */
async function travelDepart(account, locationId) {
  const locId = normalizeLocationId(locationId);
  if (locId === '') throw Object.assign(new WBError('缺少地点 id', { kind: 'local' }), { travelCode: 'NO_LOCATION' });
  const res = await rawRequest(account, 'POST', TRAVEL.depart, { location_id: locId }, { timeout: 20000 });
  let body;
  try {
    body = interpret(res);
  } catch (err) {
    throw travelFailure(err);
  }
  const st = normTravel((body && body.data) || {});
  st.ms = res.ms;
  return st;
}

/** 领取旅行奖励，返回 { rewardCredit, letter, useDeeplink } */
async function travelClaim(account) {
  const res = await rawRequest(account, 'POST', TRAVEL.claim, {}, { timeout: 20000 });
  let body;
  try {
    body = interpret(res);
  } catch (err) {
    throw travelFailure(err);
  }
  const d = (body && body.data) || {};
  return {
    rewardCredit: pickNum(d, ['reward_credit', 'rewardCredit']) || 0,
    letter: d.letter || null,
    useDeeplink: pickStr(d, ['use_deeplink', 'useDeeplink']),
    raw: d,
    ms: res.ms,
  };
}

/** 旅行记录分页 */
async function travelRecords(account, page, pageSize) {
  const q = `?page=${Number(page) || 1}&page_size=${Number(pageSize) || 20}`;
  const res = await rawRequest(account, 'GET', TRAVEL.records + q, undefined, { timeout: 15000 });
  let body;
  try {
    body = interpret(res);
  } catch (err) {
    throw travelFailure(err);
  }
  const d = (body && body.data) || {};
  const list = Array.isArray(d.list) ? d.list : (Array.isArray(d.records) ? d.records : []);
  return {
    list,
    total: pickNum(d, ['total', 'total_count']) || list.length,
    totalPage: pickNum(d, ['total_page', 'totalPage']) || 1,
    page: Number(page) || 1,
    ms: res.ms,
  };
}

/** 当前 Buddy 信息（有没有 buddy、稀有度、名称） */
async function buddyInfo(account) {
  const res = await rawRequest(account, 'GET', TRAVEL.info, undefined, { timeout: 15000 });
  let body;
  try {
    body = interpret(res);
  } catch (err) {
    throw travelFailure(err);
  }
  const d = (body && body.data) || {};
  /* ★ 字段名踩过坑（2026-10-30 实测）：
   *   /activity/growth/buddy/info 实际返回的是 data.buddy
   *     {"buddy":{"instance_id":27741969,"name":"星际喵","rarity":"SR",...}}
   *   而 buddy/first 的返回是 data.buddy = {"instance":{...},"template":{...}}
   *   我们原来只读 d.current / d.current_buddy → 永远拿到 null，
   *   导致 lib/meow.js 认为「还没有 Buddy」，小喵自动派出/领奖整条链路从来没跑起来。
   *   两种形状都兼容：buddy 可能是扁平的，也可能是 {instance:{...}} 嵌套。
   */
  const b = d.buddy || d.current || d.current_buddy || null;
  const inst = b && typeof b === 'object' ? (b.instance || b) : null;
  const cur = inst || null;
  return {
    current: cur ? {
      // instance_id 上游是数字（27741969），pickStr 只取字符串 → 这里显式兼容数字
      instanceId: String(cur.instance_id ?? cur.instanceId ?? cur.id ?? ''),
      name: pickStr(cur, ['name', 'display_name']),
      rarity: pickStr(cur, ['rarity']),
      personality: pickStr(cur, ['personality']),
      soulDesc: pickStr(cur, ['soul_desc', 'soulDesc']),
      thumbnail: pickStr(cur, ['thumbnail_url', 'thumbnailUrl']),
      raw: cur,
    } : null,
    raw: d,
    ms: res.ms,
  };
}

/**
 * 同一账号的续期请求在飞行中去重：并发调用共用同一个 Promise。
 * 只去重「同时进行中」的请求，**不复用结果**——成功后下一次调用仍会真实发请求。
 * 为什么必须要有：refreshToken 可能是一次性的，两条入口同时拿同一个 RT 去换，
 * 后到者会用已被作废的 RT，可能把整个 token 家族吊销（账号只能重新扫码）。
 */
const _renewInflight = new Map(); // key = 账号标识（id > uid > email）

/**
 * 用 refreshToken 换新的 accessToken。
 * 上游有两条可能的通道，都试一遍；成功返回 {token, refreshToken, expiresIn}，失败返回 null。
 *
 * 外面这层只做并发去重，真正的请求在 renewTokenOnce 里，逻辑与改动前完全一致。
 */
async function renewToken(account) {
  // 必须保证「拿不到 key 就不去重」：共用 '' 键会把不同账号的请求错误合并
  const key = String((account && (account.id || account.uid || account.email)) || '');
  if (!key) return renewTokenOnce(account);
  if (_renewInflight.has(key)) return _renewInflight.get(key);
  const p = renewTokenOnce(account);
  _renewInflight.set(key, p);
  try {
    return await p; // 不吞异常：reject 会原样抛给所有等待者
  } finally {
    // 只删自己那一份，避免误删后来者的新请求
    if (_renewInflight.get(key) === p) _renewInflight.delete(key);
  }
}

async function renewTokenOnce(account) {
  const endpoint = normEndpoint(account && account.endpoint);
  const rt = account && account.refreshToken;
  if (!rt) return null;
  const ua = (account && account.ua) || 'WorkBuddy-Console/1.0';
  const base = { 'user-agent': ua, accept: 'application/json', ...(account.cookie ? { cookie: account.cookie } : {}) };
  const pick = (d) => {
    if (!d) return null;
    const token = d.accessToken || d.access_token;
    if (!token) return null;
    return {
      token: String(token),
      refreshToken: String(d.refreshToken || d.refresh_token || rt),
      expiresIn: Number(d.expiresIn || d.expires_in || 0) || 0,
    };
  };
  // 通道1：网关自己的刷新接口
  try {
    const r = await fetch(endpoint + '/v2/plugin/auth/token/refresh', {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/json' },
      body: JSON.stringify({ refreshToken: rt }),
    });
    const j = await r.json().catch(() => null);
    const hit = pick((j && j.data) || j);
    if (hit) return hit;
  } catch (_) {}
  // 通道2：Keycloak 兼容的 token 接口
  try {
    const r = await fetch(endpoint + '/auth-v2/realms/copilot/protocol/openid-connect/token', {
      method: 'POST',
      headers: { ...base, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: 'console' }).toString(),
    });
    const j = await r.json().catch(() => null);
    const hit = pick(j);
    if (hit) return hit;
  } catch (_) {}
  return null;
}

/* ---------------- 成长任务（Growth Program Tasks） ---------------- */

/**
 * 成长任务接口，来源：官方前端 bundle growthSpace-Bv4VOMPs.js
 *   任务列表      GET  /v2/activity/growth/tasks
 *   领取全部      POST /activity/growth/tasks/accept  { task_codes: string[] }
 *   领取单个      POST /activity/growth/tasks/{task_code}/claim
 *   徽章          GET  /v2/activity/growth/badges
 *   能量          GET  /activity/growth/energy
 *   关注公众号态  GET  /v2/activity/growth/subscribe-task/status
 *
 * 实测（2026-10-29）：
 *   - 对已领取任务再次 claim → { code:0, data:{ already_claimed:true, credit:0, energy:0 } }（幂等，安全）
 *   - 对已完成任务再次 accept → { code:0, data:{ results:[{ task_code, status:"error", message:"task already completed" }] } }
 */
const GROWTH_TASK = {
  list: '/v2/activity/growth/tasks',
  accept: '/activity/growth/tasks/accept',
  claim: (taskCode) => `/activity/growth/tasks/${encodeURIComponent(taskCode)}/claim`,
  badges: '/v2/activity/growth/badges',
  energy: '/activity/growth/energy',
  subscribeStatus: '/v2/activity/growth/subscribe-task/status',
  profile: '/v2/activity/growth/profile',
};

/**
 * 归一化成长任务。
 * @param {object} t 上游 task 对象
 * @returns {object} 归一化后的任务
 */
function normGrowthTask(t) {
  if (!t || typeof t !== 'object') return null;
  const p = t.progress && typeof t.progress === 'object' ? t.progress : {};
  const current = pickNum(p, ['current', 'current_count', 'currentCount', 'value']) ?? pickNum(t, ['current', 'progress_value']) ?? 0;
  const target = pickNum(p, ['target', 'total', 'target_count', 'targetCount']) ?? pickNum(t, ['target', 'progress_target']) ?? 1;
  const status = pickStr(t, ['accept_status', 'status']) || 'unknown';
  return {
    code: pickStr(t, ['task_code', 'code']),
    title: pickStr(t, ['title', 'name']),
    desc: pickStr(t, ['task_desc', 'description', 'desc']),
    type: pickStr(t, ['task_type', 'type']),
    jumpUrl: pickStr(t, ['jump_url', 'url']),
    status,                       // claimed | accepted | in_progress | completed | unknown
    // ★ `in_progress` 也是「已接单」：服务端对进行中的任务返回 accept_status="in_progress"
    //   （实测 template_5 接单后就是这个值）。漏判 → 上报被跳过 → 计数永远不动。
    accepted: status === 'accepted' || status === 'in_progress' || status === 'claimed' || status === 'completed',
    claimed: status === 'claimed',
    completed: current >= target && target > 0,
    current,
    target,
    rewardCredit: pickNum(t, ['reward_credit', 'rewardCredit', 'credit']) ?? 0,
    rewardEnergy: pickNum(t, ['reward_energy', 'rewardEnergy', 'energy']) ?? 0,
    rewardBuddy: t.reward_buddy ?? null,
    badgeName: pickStr(t, ['badge_name', 'badgeName']),
    locked: Boolean(t.locked),
    tag: pickStr(t, ['tag']),
    isNew: Boolean(t.is_new),
    pinned: Boolean(t.is_pinned),
    validStart: pickStr(t, ['valid_start', 'validStart']),
    validEnd: pickStr(t, ['valid_end', 'validEnd']),
    buttonText: pickStr(t, ['claimed_button_text', 'button_text', 'buttonText']),
    raw: t,
  };
}

/** 成长任务列表 */
async function growthTasks(account) {
  const res = await rawRequest(account, 'GET', GROWTH_TASK.list, undefined, {});
  const body = interpret(res);
  const d = (body && body.data) || {};
  const list = Array.isArray(d.tasks) ? d.tasks.map(normGrowthTask).filter(Boolean) : [];
  return { tasks: list, raw: d, ms: res.ms };
}

/**
 * 领取任务奖励。
 * @param {object} account 账号
 * @param {string} taskCode 任务 code
 * @returns {Promise<object>} { ok, alreadyClaimed, credit, energy, msg }
 */
async function growthClaim(account, taskCode) {
  const res = await rawRequest(account, 'POST', GROWTH_TASK.claim(taskCode), {});
  const body = interpret(res);
  const d = (body && body.data) || {};
  return {
    ok: true,
    alreadyClaimed: Boolean(d.already_claimed),
    credit: pickNum(d, ['credit']) ?? 0,
    energy: pickNum(d, ['energy']) ?? 0,
    raw: d,
    ms: res.ms,
  };
}

/**
 * 接受（领取）一组任务。
 * @param {object} account 账号
 * @param {string[]} taskCodes 任务 code 数组
 * @returns {Promise<object>} { ok, results:[{task_code,status,message}] }
 */
async function growthAccept(account, taskCodes) {
  const res = await rawRequest(account, 'POST', GROWTH_TASK.accept, { task_codes: taskCodes });
  const body = interpret(res);
  const d = (body && body.data) || {};
  const results = Array.isArray(d.results) ? d.results : [];
  return { ok: true, results, raw: d, ms: res.ms };
}

/** 能量余额 */
async function growthEnergy(account) {
  const res = await rawRequest(account, 'GET', GROWTH_TASK.energy, undefined, {});
  const body = interpret(res);
  const d = (body && body.data) || {};
  return {
    balance: pickNum(d, ['balance']) ?? 0,
    totalEarned: pickNum(d, ['total_earned']) ?? 0,
    totalConsumed: pickNum(d, ['total_consumed']) ?? 0,
    raw: d,
    ms: res.ms,
  };
}

/** 徽章墙 */
async function growthBadges(account) {
  const res = await rawRequest(account, 'GET', GROWTH_TASK.badges, undefined, {});
  const body = interpret(res);
  const d = (body && body.data) || {};
  const list = Array.isArray(d.badges) ? d.badges : [];
  return {
    badges: list.map((b) => ({
      code: pickStr(b, ['code']),
      title: pickStr(b, ['title']),
      earned: Boolean(b.earned),
      url: pickStr(b, ['url']),
      taskId: pickNum(b, ['task_id']),
    })),
    raw: d,
    ms: res.ms,
  };
}

/**
 * 连登里程碑（活跃地图）状态。
 * GET /activity/growth/streak —— 返回本月连登天数、三档兑换状态、补登卡余额。
 * 注意：这里的 days 是「本月」自然月口径（每月清零），与签到活动累计 streak_days 不同。
 */
async function streakStatus(account) {
  const res = await rawRequest(account, 'GET', '/activity/growth/streak', undefined, {});
  const body = interpret(res);
  const d = (body && body.data) || {};
  const rs = d.redemption_status || {};
  const tiers = Array.isArray(rs.tiers) ? rs.tiers : [];
  const byTier = {};
  for (const t of tiers) byTier[t.tier] = t;
  return {
    ok: body && body.code === 0,
    days: (d.streak && Number(d.streak.days)) || 0,
    monthTotalDays: (d.streak && Number(d.streak.month_total_days)) || 0,
    monthConsumedDays: (d.streak && Number(d.streak.month_consumed_days)) || 0,
    nextTier: (d.streak && d.streak.next_tier) || '',
    nextTierRemaining: (d.streak && Number(d.streak.next_tier_remaining)) || 0,
    makeupDates: (d.streak && Array.isArray(d.streak.makeup_dates)) ? d.streak.makeup_dates : [],
    makeupCards: (d.makeup_cards && Number(d.makeup_cards.balance)) || 0,
    makeupCardsMax: (d.makeup_cards && Number(d.makeup_cards.max)) || 0,
    tiers,
    tierStatus: {
      '7d': { count: rs.tier_7d_count || 0, status: rs.tier_7d_status || 'locked' },
      '14d': { count: rs.tier_14d_count || 0, status: rs.tier_14d_status || 'locked' },
      '28d': { count: rs.tier_28d_count || 0, status: rs.tier_28d_status || 'locked' },
    },
    byTier,
    raw: d,
    ms: res.ms,
  };
}

/**
 * 抽奖机会汇总。
 * GET /activity/growth/lottery/summary —— 返回当前可用抽奖次数。
 */
async function lotterySummary(account) {
  const res = await rawRequest(account, 'GET', '/activity/growth/lottery/summary', undefined, {});
  const body = interpret(res);
  const d = (body && body.data) || {};
  return {
    ok: body && body.code === 0,
    chances: Number(d.chances) || 0,
    moduleEnabled: Boolean(d.module && d.module.enabled),
    raw: d,
    ms: res.ms,
  };
}

module.exports = {
  DEFAULT_ENDPOINT, OFFICIAL_UA, WBError, TRAVEL, GROWTH_TASK,
  checkinStatus, claimCheckin, streakStatus, lotterySummary, snapshot, verifyCredentials, probe, chat, chatSimple,
  whoami, scanIdentity,
  travelConfig, travelStatus, travelDepart, travelClaim, travelRecords, buddyInfo,
  buddyAgreement, buddyFirst,
  classifyTravelError, normTravel, emptyTravel,
  growthTasks, growthClaim, growthAccept, growthEnergy, growthBadges, normGrowthTask,
  rawRequest, normEndpoint, renewToken, productConfig,
  normLocation, pickId, normalizeLocationId,
};
