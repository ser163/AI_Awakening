/**
 * signal.js — 节点间端到端加密信道 (v0.9.0)
 *
 * 标准密码学实现，用于 Agent 节点之间的私密通信：
 *   - X25519 ECDH 协商共享密钥（身份文件中的 xPrivateKey / xPublicKey）
 *   - AES-256-GCM 认证加密（机密性 + 完整性）
 *   - 发送者 Ed25519 签名（防冒充，可审计）
 *
 * v0.9.0 关键修复（身份绑定）：
 *   签名内容必须包含 senderFingerprint，使 from 字段不可伪造。
 *   接收端验证：fingerprint(env.senderPk) === env.from。
 *
 * 协议信封 v2（base64 JSON）：
 *   { v:2, from, senderPk, msgId, ts, expiresAt, epk, iv, tag, sig, ct }
 *
 * 公开、可审计、可互操作。
 */
import crypto from "node:crypto";
import { sign, verifySignature, fingerprintFromPublicKey } from "./identity.js";

const IV_LEN = 12;
const TAG_LEN = 16;
const PROTOCOL_VERSION = 2; // v0.9.0: 新增 senderFingerprint 绑定 + msgId
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // v0.10.0: 最大时钟偏移（与 ReplayCache 窗口一致）

/**
 * 生成唯一消息 ID（时间戳 + 随机）。
 */
function generateMsgId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 加密消息给指定接收者（用接收者的 X25519 公钥）。
 *
 * @param {object} identity 发送者身份（含 privateKey 用于签名，fingerprint 用于身份绑定）
 * @param {string} recipientXPublicHex 接收者 X25519 公钥（spki-der-hex）
 * @param {string|object} payload 明文
 * @param {object} [opts]
 * @param {number} [opts.ttlMs] 消息有效时长（默认 5 分钟，0=不过期）
 * @returns {string} base64 信封
 */
export function encryptFor(identity, recipientXPublicHex, payload, opts = {}) {
  const plaintext = typeof payload === "string" ? payload : JSON.stringify(payload);
  const ttlMs = opts.ttlMs !== undefined ? opts.ttlMs : 5 * 60 * 1000;

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
  const aesKey = crypto.hkdfSync("sha256", shared, Buffer.from("ai-awakening-v2-salt"), "ai-awakening-v2", 32);
  const iv = crypto.randomBytes(IV_LEN);

  // 3. AES-256-GCM
  const cipher = crypto.createCipheriv("aes-256-gcm", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  // 4. 组装信封（v2: senderFingerprint 绑定到签名）
  const now = Date.now();
  const msgId = generateMsgId();
  const epk = ephemeral.publicKey.export({ type: "spki", format: "der" }).toString("hex");
  const signedPayload = JSON.stringify({
    senderFingerprint: identity.fingerprint, // 关键：将身份绑定到签名
    msgId,
    ts: now,
    expiresAt: ttlMs > 0 ? now + ttlMs : 0,
    epk,
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ct: ciphertext.toString("base64"),
  });
  const sig = sign(identity, signedPayload);

  const envelope = {
    v: PROTOCOL_VERSION,
    from: identity.fingerprint,
    senderPk: identity.publicKey,
    msgId,
    ts: now,
    expiresAt: ttlMs > 0 ? now + ttlMs : 0,
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
 * 验证链：
 *   1. fingerprint(senderPk) === env.from  —— 公钥与身份绑定，防 from 伪造
 *   2. verifySignature(senderPk, 签名内容, sig) —— 内容完整可审计
 *   3. ECDH → AES-256-GCM 解密
 *
 * @param {object} identity 接收者身份（含 xPrivateKey）
 * @param {string} envelopeB64 信封（base64）
 * @returns {{ok: boolean, from?: string, text?: string, msgId?: string, ts?: number, error?: string}}
 */
export function decryptFrom(identity, envelopeB64) {
  try {
    const env = JSON.parse(Buffer.from(envelopeB64, "base64").toString("utf8"));
    if (!env.v || env.v < 1) return { ok: false, error: "unsupported_version" };

    // v1 兼容：v1 信封没有 msgId/senderFingerprint 绑定
    const isV1 = env.v === 1;

    // 1. 验签（认证发送者）
    const signedPayload = isV1
      ? JSON.stringify({ epk: env.epk, iv: env.iv, tag: env.tag, ct: env.ct })
      : JSON.stringify({
          senderFingerprint: env.from,
          msgId: env.msgId,
          ts: env.ts,
          expiresAt: env.expiresAt || 0,
          epk: env.epk,
          iv: env.iv,
          tag: env.tag,
          ct: env.ct,
        });

    if (!env.senderPk || !verifySignature(env.senderPk, signedPayload, env.sig)) {
      return { ok: false, error: "bad_signature" };
    }

    // v2: 验证 fingerprint(senderPk) === from —— 防伪造发送者身份
    if (!isV1) {
      const fpFromKey = fingerprintFromPublicKey(env.senderPk);
      if (fpFromKey !== env.from) {
        return { ok: false, error: "senderPk does not match fingerprint (spoof attempt)" };
      }
      // v0.10.0: 时间检查（签名已覆盖 ts / expiresAt，此处防重放窗口外投递）
      if (env.ts) {
        const skew = Math.abs(Date.now() - env.ts);
        if (skew > MAX_CLOCK_SKEW_MS) {
          return { ok: false, error: "clock skew out of range (expired or future message)" };
        }
      }
      // v0.10.0: expiresAt 真正参与 accept/reject（自毁计时器点火线已接上）
      if (env.expiresAt > 0 && Date.now() > env.expiresAt) {
        return { ok: false, error: "message_expired" };
      }
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

    // 3. HKDF salt 版本兼容
    const hkdfSalt = isV1 ? "ai-awakening-v1-salt" : "ai-awakening-v2-salt";
    const hkdfInfo = isV1 ? "ai-awakening-v1" : "ai-awakening-v2";
    const aesKey = crypto.hkdfSync("sha256", shared, Buffer.from(hkdfSalt), hkdfInfo, 32);
    const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey, Buffer.from(env.iv, "base64"));
    decipher.setAuthTag(Buffer.from(env.tag, "base64"));
    const plaintext = Buffer.concat([decipher.update(Buffer.from(env.ct, "base64")), decipher.final()]);

    return {
      ok: true,
      from: env.from,
      text: plaintext.toString("utf8"),
      msgId: env.msgId || null,
      ts: env.ts || null,
    };
  } catch (e) {
    return { ok: false, error: e.message || "decrypt_failed" };
  }
}