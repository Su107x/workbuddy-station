/**
 * 页面内直接动作脚本（前端外援方案 · 无需提取 token）
 *
 * 前置条件：在桌面 Edge 打开 https://www.workbuddy.cn/，且【已用 18030160950 登录】
 *   （注意：必须是 18030160950 的登录态，不是你当前的主账号 XZ）
 *
 * 用法：F12 → Console → 整段粘贴 → 回车
 * 原理：workbuddy 网页版用 Cookie 鉴权（APISIX openid-connect），
 *       浏览器在已登录页面发起同域 fetch 会自动带上 HttpOnly 登录 Cookie，
 *       业务接口仅凭 Cookie 即鉴权通过，无需提取 accessToken。
 */
(async () => {
  const log = (...a) => console.log(...a);
  const INVITE = 's0bg8s6gt';

  // ① 绑定邀请码（被邀请方 = 当前登录的 18030160950）
  try {
    const r = await fetch('/activity/workbuddy/invitation/v2/bind', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-source': 'workbuddy' },
      body: JSON.stringify({ inviteCode: INVITE }),
    });
    const t = await r.text();
    log('BIND', r.status, t.slice(0, 500));
  } catch (e) { log('BIND_ERR', e.message); }

  // ② 发一句「你好」完成激活对话（触发受邀奖励条件）
  try {
    const r = await fetch('/v2/chat/completions', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-source': 'workbuddy', accept: 'text/event-stream' },
      body: JSON.stringify({
        model: 'deepseek-v4-pro',
        messages: [{ role: 'user', content: '你好' }],
        stream: false,
      }),
    });
    const t = await r.text();
    log('CHAT', r.status, t.slice(0, 500));
  } catch (e) { log('CHAT_ERR', e.message); }
})();
