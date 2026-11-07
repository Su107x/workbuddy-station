/**
 * 凭证提取脚本（前端外援方案）
 *
 * 在你的【已登录 workbuddy.cn 的桌面 Edge 浏览器】里使用：
 *   1. 打开 https://www.workbuddy.cn/ （确认是登录状态，右上角有头像）
 *   2. 按 F12 打开开发者工具 → Console（控制台）标签
 *   3. 把下面的脚本整段粘贴进去，回车运行
 *   4. 把输出中  WB_CRED_START  和  WB_CRED_END  之间的全部内容复制，发给我
 *
 * 注意：这段代码只在你自己的浏览器、你已登录的页面里运行，不依赖任何外部浏览器。
 */
(function () {
  try {
    const pick = (o) =>
      Object.fromEntries(
        Object.entries(o || {}).filter(([k]) =>
          /token|tkn|access|auth|user|uid|session|wb_|oneid|profile|account|sign|sso|cookie/i.test(k)
        )
      );

    const ls = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = localStorage.getItem(k); } } catch (e) {}
    const ss = {};
    try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = sessionStorage.getItem(k); } } catch (e) {}

    const data = {
      url: location.href,
      cookie: document.cookie,
      ls: pick(ls),
      ss: pick(ss),
    };

    console.log('WB_CRED_START');
    console.log(JSON.stringify(data, null, 2));
    console.log('WB_CRED_END');

    // 顺手尝试从 userInfo 里解析 uid
    try {
      const raw = ls['userInfo'] || ls['user'] || ss['userInfo'] || ss['user'];
      if (raw) console.log('USERINFO_PREVIEW: ' + String(raw).slice(0, 600));
    } catch (e) {}
  } catch (e) {
    console.log('WB_CRED_ERR ' + e.message);
  }
})();
