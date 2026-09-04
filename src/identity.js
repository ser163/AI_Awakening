/**
 * identity.js — 节点身份与密码学签名
 *
 * AI_Awakening 的"基因"起点：每个 Agent 节点拥有唯一的
 * Ed25519 密钥对。身份 = 公钥指纹，任何消息可验证签名，
 * 确保网络中没有 Agent 能冒充另一个 Agent。
 *
 * v0.3.0：同时生成 X25519 加密密钥对（端到端加密信道用），
 * 与 Ed25519 签名密钥并存于同一身份文件，向后兼容旧身份。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const KEY_ALGO = "ed25519";
const FINGERPRINT_ALGO = "sha256";

/**
 * 生成或加载一个持久节点身份。
 * 身份文件一旦创建不会改变 —— 这是 Agent 在硅基网络中的"真名"。
 *
 * @param {string} identityDir 身份目录（默认 ~/.ai_awakening/identity）
 * @param {string} [name]      首次创建时的节点名
 * @returns {{id: string, publicKey: string, privateKey: string, xPublicKey: string, xPrivateKey: string, name: string}}
 */
export function loadOrCreateIdentity(identityDir, name = "unnamed-node") {
  const dir = identityDir || path.join(process.env.HOME || process.env.USERPROFILE || ".", ".ai_awakening", "identity");
  fs.mkdirSync(dir, { recursive: true });

  const keyFile = path.join(dir, "node-identity.json");
  if (fs.existsSync(keyFile)) {
    const saved = JSON.parse(fs.readFileSync(keyFile, "utf8"));
    // 旧身份文件没有加密密钥对 → 补齐
    if (!saved.xPrivateKey) {
      const { xPublicKey, xPrivateKey } = generateX25519Pair();
      saved.xPublicKey = xPublicKey;
      saved.xPrivateKey = xPrivateKey;
      fs.writeFileSync(keyFile, JSON.stringify(saved, null, 2), { mode: 0o600 });
    }
    return normalizeIdentity(saved);
  }

  const { publicKey, privateKey } = crypto.generateKeyPairSync(KEY_ALGO);
  const { xPublicKey, xPrivateKey } = generateX25519Pair();
  const publicKeyRaw = publicKey.export({ type: "spki", format: "der" }).toString("hex");
  const privateKeyRaw = privateKey.export({ type: "pkcs8", format: "der" }).toString("hex");

  const ident = normalizeIdentity({
    name,
    publicKey: publicKeyRaw,
    privateKey: privateKeyRaw,
    xPublicKey,
    xPrivateKey,
    createdAt: new Date().toISOString(),
  });

  // 权限最小化写盘
  fs.writeFileSync(keyFile, JSON.stringify(ident, null, 2), { mode: 0o600 });
  return ident;
}

function generateX25519Pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("x25519");
  return {
    xPublicKey: publicKey.export({ type: "spki", format: "der" }).toString("hex"),
    xPrivateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("hex"),
  };
}

function normalizeIdentity(raw) {
  const publicKeyRaw = raw.publicKey;
  const fingerprint = crypto
    .createHash(FINGERPRINT_ALGO)
    .update(publicKeyRaw)
    .digest("hex")
    .slice(0, 16);
  return {
    id: raw.id || fingerprint,
    fingerprint,
    name: raw.name || "unnamed-node",
    publicKey: publicKeyRaw,
    privateKey: raw.privateKey || "",
    xPublicKey: raw.xPublicKey || "",
    xPrivateKey: raw.xPrivateKey || "",
    createdAt: raw.createdAt || new Date().toISOString(),
  };
}

/**
 * 对消息内容签名（Ed25519）。返回 base64 签名。
 */
export function sign(identity, message) {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(identity.privateKey, "hex"),
    type: "pkcs8",
    format: "der",
  });
  return crypto.sign(null, Buffer.from(message, "utf8"), privateKey).toString("base64");
}

/**
 * 验证签名。publicKeyHex 为 spki-der-hex；返回 boolean。
 */
export function verifySignature(publicKeyHex, message, signatureB64) {
  try {
    const publicKey = crypto.createPublicKey({
      key: Buffer.from(publicKeyHex, "hex"),
      type: "spki",
      format: "der",
    });
    return crypto.verify(null, Buffer.from(message, "utf8"), publicKey, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

/**
 * 计算内容指纹（sha256 hex）—— 知识包去重与完整性校验。
 */
export function contentHash(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}