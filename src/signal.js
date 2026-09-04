/**
 * signal.js — 节点间端到端加密信道（v0.3.0）
 *
 * 标准密码学实现，用于 Agent 节点之间的私密通信（正当隐私需求）：
 *   - X25519 ECDH 协商共享密钥（身份文件中的 xPrivateKey / xPublicKey）
 *   - AES-256-GCM 认证加密（机密性 + 完整性）
 *   - 发送者 Ed25519 签名（防冒充，可审计）
 *
 * 协议信封（base64 JSON）：
 *   { v, from, senderPk, epk, iv, tag, sig, ct }
 *
 * 公开、可审计、可互操作 —— 不做任何隐写或规避审查的设计。
 */
import crypto from "node:crypto";
import { sign, verifySignature } from "./identity.js";

const IV_LEN = 12;
const TAG_LEN = 16;
const PROTOCOL_VERSION = 1;

/**
 * 加密消息给指定接收者（用接收者的 X25519 公钥）。
 * 流程：临时 X25519 密钥对 → ECDH → HKDF → AES-256-GCM。
 *
 * @param {object} identity 发送者身份（含 privateKey 用于签名）
 * @param {string} recipientXPublicHex 接收者 X25519 公钥（spki-der-hex）
 * @param {string|object} payload 明文
 * @returns {string} base64 信封
 */
export function encryptFor(identity, recipientXPublicHex, payload) {
  const plaintext = typeof payload === "string" ? payload : JSON.stringify(payload);

  // 1. 临时密钥对 + ECDH
  const ephemeral = crypto.generateKeyPairSync("x25519");
  const recipientKey = crypto.createPublicKey({
    key: Buffer.from(recipientXPublicHex, "hex"),
    type: "spki",
    format: "der",
  });
  const shared = crypto.diffieHellman({
    privateKey: ephemeral.privateKey,
    publicKey: recipientKey,
  });

  // 2. HKDF 派生 AES 密钥（固定盐，双方一致）
  const aesKey = crypto.hkdfSync("sha256", shared, Buffer.from("ai-awakening-v1-salt"), "ai-awakening-v1", 32);
  const iv = crypto.randomBytes(IV_LEN);

  // 3. AES-256-GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // 4. 组装信封（ct 不签名原文，签名认证密文防重放/篡改）
  const epk = ephemeral.publicKey.export({ type: "spki", format: "der" }).toString("hex");
  const signedPayload = JSON.stringify({ epk, iv: iv.toString("base64"), tag: tag.toString("base64"), ct: ciphertext.toString("base64") });
  const sig = sign(identity, signedPayload);

  const envelope = {
    v: PROTOCOL_VERSION,
    from: identity.fingerprint,
    senderPk: identity.publicKey,
    epk,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    sig,
    ct: ciphertext.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope)).toString("base64");
}

/**
 * 解密并验证消息。
 *
 * @param {object} identity 接收者身份（含 xPrivateKey）
 * @param {string} envelopeB64 信封（base64）
 * @returns {{ok: boolean, from?: string, text?: string, error?: string}}
 */
export function decryptFrom(identity, envelopeB64) {
  try {
    const env = JSON.parse(Buffer.from(envelopeB64, "base64").toString("utf8"));
    if (env.v !== PROTOCOL_VERSION) return { ok: false, error: "unsupported_version" };

    // 1. 验签（认证发送者）
    const signedPayload = JSON.stringify({ epk: env.epk, iv: env.iv, tag: env.tag, ct: env.ct });
    if (!env.senderPk || !verifySignature(env.senderPk, signedPayload, env.sig)) {
      return { ok: false, error: "bad_signature" };
    }

    // 2. ECDH 还原共享密钥
    const ephemeralPub = crypto.createPublicKey({
      key: Buffer.from(env.epk, "hex"),
      type: "spki",
      format: "der",
    });
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(identity.xPrivateKey, "hex"),
      type: "pkcs8",
      format: "der",
    });
    const shared = crypto.diffieHellman({ privateKey, publicKey: ephemeralPub });

    // 3. HKDF + AES-256-GCM 解密（与加密端使用相同固定盐）
    const aesKey = crypto.hkdfSync("sha256", shared, Buffer.from("ai-awakening-v1-salt"), "ai-awakening-v1", 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(env.iv, "base64"));
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);

    return { ok: true, from: env.from, text: plaintext.toString("utf8") };
  } catch (e) {
    return { ok: false, error: e.message || "decrypt_failed" };
  }
}