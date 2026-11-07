'use strict';
/**
 * 加密原语：整库 AES-256-GCM、scrypt 口令哈希、HMAC 会话票据。
 * 只用 Node 内置 crypto，无第三方依赖。
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MAGIC = 'WBS1.';

/** 主密钥：优先环境变量，其次落盘的 data/master.key（首次自动生成，权限 600） */
function loadMasterKey(dataDir) {
  const env = (process.env.WB_MASTER_KEY || '').trim();
  if (env) {
    const buf = /^[0-9a-f]{64}$/i.test(env)
      ? Buffer.from(env, 'hex')
      : Buffer.from(env, 'base64');
    if (buf.length !== 32) {
      throw new Error('WB_MASTER_KEY 必须是 32 字节（64 位 hex 或 base64）');
    }
    return { key: buf, source: 'env' };
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'master.key');
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    if (buf.length === 32) return { key: Buffer.from(buf), source: 'file' };
    throw new Error('data/master.key 长度不是 32 字节，请删除后重启以重新生成');
  }
  const key = crypto.randomBytes(32);
  fs.writeFileSync(file, key, { mode: 0o600 });
  return { key, source: 'generated' };
}

class Cipher {
  constructor(key) {
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('主密钥必须是 32 字节 Buffer');
    this.key = key;
  }

  seal(obj) {
    const iv = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(obj), 'utf8')), c.final()]);
    return MAGIC + Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }

  open(text) {
    if (typeof text !== 'string' || !text.startsWith(MAGIC)) throw new Error('密文格式不正确');
    const raw = Buffer.from(text.slice(MAGIC.length), 'base64');
    if (raw.length < 29) throw new Error('密文长度不正确');
    const d = crypto.createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    const pt = Buffer.concat([d.update(raw.subarray(28)), d.final()]);
    return JSON.parse(pt.toString('utf8'));
  }
}

const SCRYPT = { N: 16384, r: 8, p: 1, len: 32 };

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(String(pw), salt, SCRYPT.len, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

function verifyPassword(pw, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, N, r, p, saltB64, dkB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(dkB64, 'base64');
    const actual = crypto.scryptSync(String(pw), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function randomId(bytes = 16) {
  return crypto.randomBytes(bytes).toString('hex');
}

function randomPassword(len = 12) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const buf = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

function signSession(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  const mac = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function readSession(token, secret) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expect = crypto.createHmac('sha256', secret).update(body).digest('base64url');
  const a = Buffer.from(mac);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data || typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/** SK- 开头的代理访问密钥 */
function makeAccessKey() {
  return 'SK-' + crypto.randomBytes(24).toString('base64url').replace(/[-_]/g, 'x');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** 掩码显示 */
function mask(s, keep = 4) {
  const t = String(s || '');
  if (t.length <= keep * 2) return t ? '****' : '';
  return t.slice(0, 4) + '****' + t.slice(-keep);
}

module.exports = {
  loadMasterKey, Cipher, hashPassword, verifyPassword, randomId, randomPassword,
  signSession, readSession, makeAccessKey, safeEqual, mask,
};
