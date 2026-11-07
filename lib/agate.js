'use strict';
/**
 * 授权闸门（Licence Gate）
 *
 * 设计原则：
 *   1. **默认拒绝**：所有 /api/* 与 /v1/* 核心接口，没有有效授权码一律 403。
 *      只有白名单里的接口（登录、会话、授权管理本身）放行。
 *   2. **前端不可绕过**：判断在服务端做，前端改 JS / 逆向 UI 都无效。
 *   3. **自用不受影响**：没配置 coreUrl（settings.proxy.coreUrl 为空）= 自用模式，闸门全放行。
 *   4. **失败姿态保守**：core 连不上时沿用上次有效状态（最多 10 分钟），
 *      超时后按无效处理 —— 宁可停，不可白用。
 *
 * 覆盖的核心域（用户明确要求严格把关）：
 *   签到 / 小喵 / 成长任务 / 邀请 / 代理 / 模型 / 账号操作
 */

/**
 * 免授权白名单：这些接口在未授权时也必须能访问，
 * 否则用户连"输入授权码"这一步都做不了。
 */
const ALLOW_PATTERNS = [
  /^\/api\/login$/,              // 登录
  /^\/api\/session$/,            // 查会话状态
  /^\/api\/logout$/,             // 退出
  /^\/api\/state$/,              // 首屏状态（前端要靠它判断初始化/授权状态）
  /^\/api\/settings$/,           // 设置读写 —— 必须能读能写，否则填不了授权码
  /^\/api\/licence/,             // 授权相关专用接口
  /^\/api\/models\/info$/,       // 模型信息（未授权时返回空即可，不泄露）
  /^\/api\/password$/,           // 改密码
  /^\/api\/pair$/,               // 配对（本地扩展）
  /^\/api\/version$/,            // 版本
  /^\/api\/health$/,             // 健康检查
];

/**
 * 判定某个路径是否免授权。
 * @param {string} pathname
 * @returns {boolean}
 */
function isAllowedPath(pathname) {
  const p = String(pathname || '');
  for (const re of ALLOW_PATTERNS) {
    if (re.test(p)) return true;
  }
  return false;
}

/**
 * 授权闸门核心：返回 { ok, reason, expireAt }
 * @param {object} p
 * @param {object} p.store
 * @param {object} p.proxy  Proxy 实例（含 core）
 * @returns {Promise<{ok:boolean, reason:string, expireAt:number, mode:string}>}
 */
async function check(p) {
  const store = p.store;
  const proxy = p.proxy;
  const cfg = (store.data.settings && store.data.settings.proxy) || {};
  const coreUrl = String(cfg.coreUrl || '').trim();

  // 自用模式：没配 coreUrl = 自己用，不设门禁
  if (!coreUrl) {
    return { ok: true, reason: '', expireAt: 0, mode: 'local' };
  }

  const core = proxy && proxy.core;
  if (!core || !core.enabled()) {
    // 配了 coreUrl 但客户端未初始化 —— 按未授权处理（保守）
    return { ok: false, reason: 'core_not_ready', expireAt: 0, mode: 'cloud' };
  }

  const token = String(cfg.coreLicence || '').trim();
  if (!token) {
    return { ok: false, reason: 'no_licence', expireAt: 0, mode: 'cloud' };
  }

  const st = await core.licenceStatus().catch(() => null);
  if (!st) {
    return { ok: false, reason: 'licence_check_failed', expireAt: 0, mode: 'cloud' };
  }
  if (st.valid) {
    return { ok: true, reason: '', expireAt: st.expireAt || 0, mode: 'cloud' };
  }
  return { ok: false, reason: st.reason || 'invalid', expireAt: 0, mode: 'cloud' };
}

/**
 * 给未授权请求生成人类可读的提示（会显示在前端）。
 * @param {string} reason
 * @returns {string}
 */
function reasonText(reason) {
  switch (String(reason || '')) {
    case 'no_licence': return '未填写授权码：请到「设置 → 代理 / 模型 → 核心服务授权码」填入授权码';
    case 'expired': return '授权已过期：请联系服务商续期，拿到新授权码后替换';
    case 'device_mismatch': return '授权码与当前设备不符：请把本机设备指纹发给服务商重新签发';
    case 'bad_signature': return '授权码无效（签名校验失败）：请确认整段复制完整';
    case 'core_unreachable': return '无法连接授权服务：请检查网络，或稍后重试';
    case 'core_not_ready': return '授权服务未就绪：请检查「核心服务地址」配置';
    case 'licence_check_failed': return '授权校验失败：请检查网络后重试';
    default: return '未授权：请在设置中填入有效授权码';
  }
}

module.exports = { check, isAllowedPath, reasonText, ALLOW_PATTERNS };
