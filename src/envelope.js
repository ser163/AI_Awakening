/**
 * envelope.js — 统一签名信封协议 (v0.10.0)
 *
 * 终结"两个世界"问题：不再允许每个模块发明自己的认证方式。
 * 所有节点间通信（/message /task /knowledge /dht/* /self 请求）统一为：
 *
 * {
 *   protocol: "ai-awakening",
 *   version: 1,
 *   type: "message" | "task" | "dht_ping" | "dht_find_node" | ...,
 *   sender: fingerprint,        // 完整 64-hex SHA-256
 *   recipient: fingerprint | "*",
 *   timestamp: number,
 *   nonce: string,              // 防重放（+ ReplayCache）
 *   requestId: string,          // 请求-响应关联
 *   payload: {},                // 业务载荷
 *   signature: base64           // 覆盖除 signature 外全部字段
 * }
 *
 * 接收端验证链（不可协商）：
 *   1. sender 在 TrustedIdentityStore 有可信公钥 → 否则 REJECT
 *   2. fingerprint(publicKey) === sender → 否则 REJECT
 *   3. verifySignature(publicKey, canonical, signature) → 否则 REJECT
 *   4. |now - timestamp| ≤ clockSkewMs → 否则 REJECT
 *   5. nonce 未被重放（ReplayCache）→ 否则 REJECT
 *
 * 一条链：Identity → Trust → Signature → Replay → Dispatch。
 */
import crypto from "node:crypto";
import { sign, verifySignature, publicKeyMatchesFingerprint } from "./identity.js";

export const ENVELOPE_PROTOCOL = "ai-awakening";
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** 规范化序列化（签名覆盖字段，固定键序） */
function canonicalize(env) {
  return JSON.stringify({
    protocol: env.protocol,
    version: env.version,
    type: env.type,
    sender: env.sender,
    recipient: env.recipient,
    timestamp: env.timestamp,
    nonce: env.nonce,
    requestId: env.requestId,
    payload: env.payload,
  });
}

/**
 * 创建一个签名信封。
 * @param {object} identity 发送者身份
 * @param {object} opts
 * @param {string} opts.type 消息类型 ("message"|"task"|"dht_ping"|"dht_find_node"|...)
 * @param {object} [opts.payload] 业务载荷
 * @param {string} [opts.recipient] 接收者指纹或 "*"
 * @param {string} [opts.requestId] 请求 ID（默认生成）
 * @param {number} [opts.timestamp] 时间戳（默认 now）
 * @returns {object} 签名信封
 */
export function createEnvelope(identity, { type, payload = {}, recipient = "*", requestId = null, timestamp = Date.now() }) {
  const env = {
    protocol: ENVELOPE_PROTOCOL,
    version: ENVELOPE_VERSION,
    type,
    sender: identity.fingerprint,
    recipient,
    timestamp,
    nonce: crypto.randomBytes(8).toString("hex"),
    requestId: requestId || `${timestamp.toString(36)}-${crypto.randomBytes(6).toString("hex")}`,
    payload,
  };
  env.signature = sign(identity, canonicalize(env));
  return env;
}

/**
 * 验证信封（需 TrustedIdentityStore）。
 * @param {object} env 信封
 * @param {object} trustedStore TrustedIdentityStore 实例
 * @param {object} [opts]
 * @param {number} [opts.clockSkewMs] 允许的最大时钟偏移（默认 5 分钟）
 * @returns {{ok: boolean, reason?: string}}
 */
export function verifyEnvelope(env, trustedStore, { clockSkewMs = ENVELOPE_CLOCK_SKEW_MS } = {}) {
  if (!env || typeof env !== "object") return { ok: false, reason: "not an envelope" };
  if (env.protocol !== ENVELOPE_PROTOCOL) return { ok: false, reason: "protocol mismatch" };
  if (env.version !== ENVELOPE_VERSION) return { ok: false, reason: `unsupported envelope version: ${env.version}` };
  if (!env.type || !env.sender || !env.signature || !env.nonce) {
    return { ok: false, reason: "malformed envelope (missing type/sender/signature/nonce)" };
  }

  // 1. 可信身份
  const publicKey = trustedStore.getPublicKey(env.sender);
  if (!publicKey) return { ok: false, reason: "unknown sender (no trusted public key)" };

  // 2. 公钥绑定指纹
  if (!publicKeyMatchesFingerprint(publicKey, env.sender)) {
    return { ok: false, reason: "sender publicKey does not match fingerprint" };
  }

  // 3. 签名
  if (!verifySignature(publicKey, canonicalize(env), env.signature)) {
    return { ok: false, reason: "invalid signature" };
  }

  // 4. 时钟偏移
  const skew = Math.abs(Date.now() - env.timestamp);
  if (skew > clockSkewMs) {
    return { ok: false, reason: "timestamp out of range (expired or future)" };
  }

  return { ok: true };
}
