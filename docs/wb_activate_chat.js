/**
 * 页面内「发你好激活」脚本 v2（前端外援方案）
 *
 * 前置：桌面 Edge 打开 https://www.workbuddy.cn/ 且【已用 18030160950 登录】。
 * 用法：F12 → Console → 整段粘贴 → 回车。把输出贴回给 AI。
 *
 * 为什么需要 v2：
 *   /v2/chat/completions 走 APISIX openid-connect 且 bearer_only=true，
 *   只认 Authorization: Bearer <token>，光发 Cookie 会被 401 拦下。
 *   绑码接口 /activity/.../bind 不在该网关后，所以 Cookie 就能过（已实测 200）。
 *   本脚本会在页面里扫描 localStorage / sessionStorage / Cookie 找 JWT，
 *   找到就用 Bearer 调聊天接口；找不到就提示改走 UI 手动发送。
 *
 * 注：BIND 之前已成功（200），此处只做激活对话，不重复绑码。
 */
(async () => {
  const log = (...a) => console.log(...a);
  const JWT = /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/;

  // 1) 扫描页面里所有可能的 token 来源
  function findToken() {
    const buckets = [];
    try { buckets.push(document.cookie); } catch (e) {}
    for (const store of [window.localStorage, window.sessionStorage]) {
      if (!store) continue;
      for (let i = 0; i < store.length; i++) {
        try { buckets.push(store.getItem(store.key(i))); } catch (e) {}
      }
    }
    for (const b of buckets) {
      if (!b) continue;
      const m = String(b).match(JWT);
      if (m) return m[0];
    }
    return null;
  }

  const token = findToken();
  log('TOKEN_FOUND', !!token, token ? token.slice(0, 24) + '…' : '(none)');
  log('COOKIE_LEN', (document.cookie || '').length);
  log('COOKIE_SAMPLE', (document.cookie || '').slice(0, 400));

  if (!token) {
    log('NO_TOKEN: 页面里没找到 JWT。请直接在网页聊天框输入「你好」并发送即可完成激活，然后把聊天成功的结果贴回。');
    return;
  }

  // 2) 带 Bearer 调聊天接口
  try {
    const r = await fetch('/v2/chat/completions', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-source': 'workbuddy',
        accept: 'text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: '你好' }],
        stream: false,
      }),
    });
    const t = await r.text();
    log('CHAT', r.status, t.slice(0, 600));
  } catch (e) {
    log('CHAT_ERR', e.message);
  }
})();
