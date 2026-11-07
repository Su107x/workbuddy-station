'use strict';
/**
 * 抓取流程（v2）：
 *   1. 在已登录的 workbuddy.cn 页面里做同源探测：签到状态、小喵状态/配置/Buddy
 *      —— 同源请求会自动带上 HttpOnly Cookie，这是网页版真正的鉴权方式
 *   2. 扫 localStorage / sessionStorage 找 accessToken 与 uid（有就一起用，没有也行）
 *   3. 用 chrome.cookies 取回完整 Cookie（含 HttpOnly），拼成请求头字符串
 *   4. 把 token / cookie / uid / 探测结果一起上报到工作台
 *
 * 这样即使拿不到明文令牌，只要浏览器登录着，服务端也能用同样的 Cookie 调通接口。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const $ = (id) => document.getElementById(id);
const log = (msg, cls) => {
  const box = $('log');
  box.innerHTML += '<span class="' + (cls || '') + '">' + msg + '</span>\n';
  box.scrollTop = box.scrollHeight;
};

/* ---------------- 页面内执行（必须自包含） ---------------- */
function probeInPage() {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const req = async (path, method, body) => {
    try {
      const opt = { method: method || 'GET', credentials: 'include' };
      if (body) {
        opt.headers = { 'content-type': 'application/json' };
        opt.body = JSON.stringify(body);
      }
      const r = await fetch(path, opt);
      const text = await r.text();
      let json = null;
      try { json = JSON.parse(text); } catch (e) { json = null; }
      return { path, status: r.status, json, text: json ? undefined : String(text).slice(0, 180) };
    } catch (e) {
      return { path, status: 0, error: String((e && e.message) || e) };
    }
  };

  const tokens = new Set();
  const uids = new Set();
  const names = new Set();

  const consider = (v, keyHint) => {
    if (typeof v !== 'string') return;
    const s = v.trim();
    if (!s) return;
    if (UUID.test(s)) uids.add(s);
    if (s.length >= 20 && s.length <= 4096 && /^[A-Za-z0-9._~+/=-]+$/.test(s)) {
      if (/token|auth|session|credential|access/i.test(keyHint || '')) tokens.add(s);
      else if (s.split('.').length === 3) tokens.add(s); // JWT 形态
    }
    if (/nick|name/i.test(keyHint || '') && s.length <= 40 && !UUID.test(s)) names.add(s);
  };

  const walk = (obj, keyHint, depth) => {
    const d = depth || 0;
    if (d > 3 || obj === null || obj === undefined) return;
    if (typeof obj === 'string') {
      if (obj.startsWith('{') || obj.startsWith('[')) {
        try { walk(JSON.parse(obj), keyHint, d + 1); return; } catch (e) { /* 普通字符串 */ }
      }
      consider(obj, keyHint);
      return;
    }
    if (Array.isArray(obj)) { obj.slice(0, 15).forEach((it) => walk(it, keyHint, d + 1)); return; }
    if (typeof obj === 'object') {
      Object.keys(obj).forEach((k) => {
        if (/pass|pwd|secret|phone|mobile|idcard/i.test(k)) return;
        walk(obj[k], k, d + 1);
      });
    }
  };

  const dump = (store) => {
    try {
      for (let i = 0; i < store.length; i++) {
        const k = store.key(i);
        if (!k) continue;
        const v = store.getItem(k);
        if (UUID.test(v || '')) uids.add(v);
        walk(v, k, 0);
      }
    } catch (e) { /* 存储不可读 */ }
  };
  dump(window.localStorage);
  dump(window.sessionStorage);

  return (async () => {
    const probe = {
      page: location.pathname,
      checkin: await req('/v2/billing/meter/checkin-activity-status', 'POST', {}),
      travelStatus: await req('/activity/growth/buddy/travel/status'),
      travelConfig: await req('/activity/growth/buddy/travel/config'),
      buddyInfo: await req('/activity/growth/buddy/info'),
    };

    // 从探测结果里补充 uid / 昵称，页面存储里没有时也能拿到
    const dig = (node) => {
      if (!node || typeof node !== 'object') return;
      Object.keys(node).forEach((k) => {
        const v = node[k];
        if (typeof v === 'string') {
          if (UUID.test(v)) uids.add(v);
          if (/nickname|nick_name|nickName/i.test(k) && v.length <= 40) names.add(v);
        } else if (v && typeof v === 'object') dig(v);
      });
    };
    dig(probe.checkin.json);
    dig(probe.travelStatus.json);
    dig(probe.buddyInfo.json);

    return {
      tokens: [...tokens].slice(0, 8),
      uids: [...uids].slice(0, 6),
      names: [...names].slice(0, 4),
      probe: {
        checkin: { status: probe.checkin.status, code: probe.checkin.json && probe.checkin.json.code },
        travelStatus: { status: probe.travelStatus.status, state: probe.travelStatus.json && probe.travelStatus.json.data && probe.travelStatus.json.data.state },
        travelConfig: { status: probe.travelConfig.status, locations: (probe.travelConfig.json && probe.travelConfig.json.data && (probe.travelConfig.json.data.locations || []).length) || 0 },
        buddyInfo: { status: probe.buddyInfo.status },
        sample: probe.travelStatus.json || probe.travelConfig.json || null,
      },
    };
  })();
}

/* ---------------- Cookie ---------------- */
async function collectCookies() {
  const domains = ['workbuddy.cn', 'www.workbuddy.cn', '.workbuddy.cn'];
  const seen = new Map();
  for (const d of domains) {
    let list = [];
    try { list = await chrome.cookies.getAll({ domain: d.replace(/^\./, '') }); } catch (e) { list = []; }
    for (const c of list) {
      if (!/workbuddy\.cn$/.test(c.domain.replace(/^\./, ''))) continue;
      seen.set(c.name, c.value);
    }
    if (seen.size) break;
  }
  return [...seen.entries()].map(([k, v]) => k + '=' + v).join('; ');
}

/* ---------------- 主流程 ---------------- */
async function onSubmit() {
  const btn = $('go');
  const server = $('server').value.trim().replace(/\/+$/, '');
  const code = $('code').value.trim();
  $('log').innerHTML = '';

  if (!server || !/^https?:\/\//.test(server)) {
    log('请填写完整的服务地址，例如 https://wb.example.com', 'bad');
    return;
  }
  if (!/^\d{6}$/.test(code)) {
    log('配对码是 6 位数字，请先在控制台「账号」页获取', 'bad');
    return;
  }

  btn.disabled = true;
  btn.textContent = '抓取中…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !/workbuddy\.cn/.test(tab.url || '')) {
      log('请先切到一个已登录 workbuddy.cn 的标签页再点按钮', 'bad');
      return;
    }

    log('正在页面里探测接口（使用浏览器现有登录态）…');
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: probeInPage,
    });
    const data = (results && results[0] && results[0].result) || { tokens: [], uids: [], names: [], probe: {} };
    const p = data.probe || {};
    const st = (o) => (o ? String(o.status || 0) : '-');

    log('签到接口 HTTP ' + st(p.checkin) + ' · 小喵状态 HTTP ' + st(p.travelStatus) +
        ' · 地点接口 HTTP ' + st(p.travelConfig));
    if (p.travelStatus && p.travelStatus.state) log('小喵当前状态：' + p.travelStatus.state, 'ok');
    if (p.travelConfig && p.travelConfig.locations) log('可选地点 ' + p.travelConfig.locations + ' 个', 'ok');

    log('页面里找到 ' + data.tokens.length + ' 个候选令牌、' + data.uids.length + ' 个候选 UID');

    const cookie = await collectCookies();
    log('已取回 Cookie ' + (cookie ? cookie.split(';').length + ' 项' : '（无）'));

    if (!data.uids.length) {
      log('没有识别到 UID。请在控制台「新增账号」里手动填写 uid 后重试。', 'bad');
      return;
    }
    if (!data.tokens.length && !cookie) {
      log('既没有令牌也没有 Cookie，无法同步。请确认已登录后刷新页面再试。', 'bad');
      return;
    }

    const nickname = data.names.length ? data.names[0] : '';
    const payload = {
      code,
      uid: data.uids[0],
      nickname,
      probe: p,
    };
    if (data.tokens.length) payload.token = data.tokens[0];
    if (cookie) payload.cookie = cookie;

    log('上报中（' + (data.tokens.length ? '令牌 + ' : '') + (cookie ? 'Cookie' : '') + '）…');
    const res = await fetch(server + '/api/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) {
      log('上报失败：' + (out.error || ('HTTP ' + res.status)), 'bad');
      if (data.tokens.length > 1) log('若首个令牌无效，可在控制台账号页手动粘贴其它令牌。');
      return;
    }
    const acc = out.account || {};
    log('已同步：' + (acc.nickname || payload.uid.slice(0, 8)) +
        '（鉴权方式 ' + (out.via === 'growth' ? 'Cookie/成长中心' : out.via === 'billing' ? '令牌/计费' : '未知') + '）', 'ok');
    log('可以直接关掉这个窗口，回工作台刷新即可看到小喵状态。', 'ok');
  } catch (err) {
    log('出错：' + err.message, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = '抓取并上报';
  }
}

(async function init() {
  const saved = await chrome.storage.local.get(['server']);
  if (saved.server) $('server').value = saved.server;
  $('go').addEventListener('click', onSubmit);
  $('server').addEventListener('change', () => {
    chrome.storage.local.set({ server: $('server').value.trim() });
  });
})();
