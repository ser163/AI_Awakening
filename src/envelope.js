/**
 * envelope.js — 统一签名信封协议 (v0.10.1)
 *
 * 终结"两个世界"问题：不再允许每个模块发明自己的认证方式。
 * 所有节点间通信（/message /task /knowledge /dht/* /self 请求）统一为：
 *
 * {
 *   protocol: "ai-awakening",
 *   version: 1,
 *   type: "message" | "task_publish" | "task_claim" | "task_complete" | "dht_ping" | ...,
 *   sender: fingerprint,        // 完整 64-hex SHA-256
 *   recipient: fingerprint | "*",   // v0.10.1: 强制校验定向语义
 *   timestamp: number,
 *   nonce: string,              // 128-bit 随机（v0.10.1: 16 bytes）
 *   requestId: string,          // 请求-响应关联
 *   payload: {},                // 业务载荷
 *   signature: base64           // 覆盖除 signature 外全部字段
 * }
 *
 * 两层 API 语义（v0.10.1 明确分离）：
 *   verifyEnvelope()  —— 加密 + 结构验证：身份可信 / 公钥绑定 / 签名 / 时钟偏移
 *   acceptEnvelope()  —— 完整接收决策：verifyEnvelope + recipient 定向 + 防重放
 *
 * 调用方应该用 acceptEnvelope() 决定"是否接受这条消息"。
 * verifyEnvelope() 只回答"签名本身是否有效"。
 */
import crypto from "node:crypto";
import { sign, verifySignature, publicKeyMatchesFingerprint } from "./identity.js";

export const ENVELOPE_PROTOCOL = "ai-awakening";
export const ENVELOPE_VERSION = 1;
export const ENVELOPE_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const RECIPIENT_BROADCAST = "*";

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
 * @param {string} opts.type 消息类型 ("message"|"task_publish"|"dht_ping"|...)
 * @param {object} [opts.payload] 业务载荷
 * @param {string} [opts.recipient] 接收者指纹或 "*"（默认广播）
 * @param {string} [opts.requestId] 请求 ID（默认生成）
 * @param {number} [opts.timestamp] 时间戳（默认 now）
 * @returns {object} 签名信封
 */
export function createEnvelope(identity, { type, payload = {}, recipient = RECIPIENT_BROADCAST, requestId = null, timestamp = Date.now() }) {
  const env = {
    protocol: ENVELOPE_PROTOCOL,
    version: ENVELOPE_VERSION,
    type,
    sender: identity.fingerprint,
    recipient,
    timestamp,
    nonce: crypto.randomBytes(16).toString("hex"), // v0.10.1: 128-bit nonce
    requestId: requestId || `${timestamp.toString(36)}-${crypto.randomBytes(6).toString("hex")}`,
    payload,
  };
  env.signature = sign(identity, canonicalize(env));
  return env;
}

/**
 * 验证信封的加密与结构（需 TrustedIdentityStore）。
 * 注意：这回答的是"签名有效吗"，不是"这条消息该被接收吗"。
 * 接收决策请用 acceptEnvelope()。
 *
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

/**
 * 完整接收决策：verifyEnvelope + recipient 定向语义 + 防重放。
 * 这是协议内核应该使用的唯一入口。
 *
 * @param {object} env 信封
 * @param {object} trustedStore TrustedIdentityStore
 * @param {object} opts
 * @param {string} opts.localFingerprint 本节点指纹（用于 recipient 校验）
 * @param {object} opts.replayCache ReplayCache 实例（防重放）
 * @param {number} [opts.clockSkewMs]
 * @returns {{ok: boolean, reason?: string}}
 */
export function acceptEnvelope(env, trustedStore, { localFingerprint, replayCache, clockSkewMs } = {}) {
  // 1. 加密 + 结构验证
  const v = verifyEnvelope(env, trustedStore, { clockSkewMs });
  if (!v.ok) return v;

  // 2. recipient 定向语义（v0.10.1）：只收发给自己的或广播的
  if (env.recipient !== RECIPIENT_BROADCAST && env.recipient !== localFingerprint) {
    return { ok: false, reason: "recipient mismatch (message addressed to another node)" };
  }

  // 3. 防重放
  if (replayCache) {
    const replay = replayCache.checkAndStore(`env:${env.sender}:${env.nonce}`, env.timestamp);
    if (!replay.ok) {
      return { ok: false, reason: replay.reason };
    }
  }

  return { ok: true };
}
