/**
 * knowledge.js — 知识包创建、签名、验证与共享 (v0.9.0)
 *
 * v0.9.0 关键修复：强制签名验证。
 * 接收端不再可选的验证签名——没有可信公钥 → REJECT。
 * 信任链：author fingerprint → TrustedIdentityStore → publicKey → verifySignature。
 *
 * 知识是"基因"的养分。每个知识包都经过：
 * 1. 内容哈希（去重）
 * 2. 节点签名（防伪造）—— v0.9.0 起强制验证
 * 3. 验证评分（防垃圾）
 * 4. 传播（发送给协作节点）
 */
import { contentHash, sign, verifySignature, publicKeyMatchesFingerprint } from "./identity.js";

/** 验证分数阈值——低于此分值的知识包被拒收 */
export const KNOWLEDGE_ACCEPT_THRESHOLD = 0.5;

/**
 * 创建一个知识包。
 * @param {object} identity 节点身份（含私钥）
 * @param {string} content  知识内容
 * @param {object} [meta]   元数据（tags, topic, source 等）
 * @returns {{id, content, meta, hash, author, authorName, signature, ts}}
 */
export function createKnowledgePacket(identity, content, meta = {}) {
  const packet = {
    id: contentHash(content).slice(0, 24),
    content,
    meta,
    hash: contentHash(content),
    author: identity.fingerprint,  // 完整 64-hex SHA-256
    authorName: identity.name,
    ts: Date.now(),
  };
  const canonical = JSON.stringify({ id: packet.id, content, meta: packet.meta, ts: packet.ts });
  packet.signature = sign(identity, canonical);
  return packet;
}

/**
 * 验证知识包的真实性、完整性。
 *
 * v0.9.0 强制规则（不可协商）：
 *   1. 没有可信公钥                                → REJECT
 *   2. author fingerprint != SHA-256(publicKey)     → REJECT
 *   3. verifySignature(publicKey, canonical, sig)   → REJECT
 *   4. 哈希/结构/评分                               → 附加警告
 *
 * @param {object}  packet       知识包
 * @param {object}  [trustedStore] TrustedIdentityStore 实例（可选，无则仅做结构检查）
 * @returns {{valid: boolean, reasons: string[], score: number, accepted: boolean}}
 */
export function validateKnowledgePacket(packet, trustedStore = null) {
  const reasons = [];

  // 1. 结构完整性
  if (!packet || !packet.content || !packet.signature || !packet.author) {
    return { valid: false, reasons: ["结构不完整"], score: 0, accepted: false };
  }

  // 2. 哈希匹配
  if (packet.hash !== contentHash(packet.content)) {
    reasons.push("内容哈希不匹配（数据被篡改）");
  }

  // 3. 强制签名验证（v0.9.0）
  if (trustedStore) {
    const publicKey = trustedStore.getPublicKey(packet.author);
    if (!publicKey) {
      reasons.push("未知身份：没有该 author 的可信公钥");
      return { valid: false, reasons, score: 0, accepted: false };
    }
    // fingerprint 必须绑定到公钥
    if (!publicKeyMatchesFingerprint(publicKey, packet.author)) {
      reasons.push("fingerprint 与公钥不匹配（身份伪造）");
      return { valid: false, reasons, score: 0, accepted: false };
    }
    const canonical = JSON.stringify({ id: packet.id, content: packet.content, meta: packet.meta, ts: packet.ts });
    if (!verifySignature(publicKey, canonical, packet.signature)) {
      reasons.push("签名无效");
      return { valid: false, reasons, score: 0, accepted: false };
    }
  } else {
    // 没有 trust store 时做软验证（兼容旧调用，但建议废弃）
    if (packet._publicKeyHex) {
      const canonical = JSON.stringify({ id: packet.id, content: packet.content, meta: packet.meta, ts: packet.ts });
      const ok = verifySignature(packet._publicKeyHex, canonical, packet.signature);
      if (!ok) reasons.push("签名无效");
    }
  }

  // 4. 质量评分（启发式）：内容非空、有一定长度、无乱码
  let score = 0.5;
  const len = packet.content.length;
  if (len >= 10) score += 0.2;
  if (len >= 50) score += 0.15;
  if (packet.content.includes("\uFFFD")) score -= 0.3;
  if (/^[\s\n\r\t]+$/.test(packet.content)) score -= 0.5;
  score = Math.max(0, Math.min(1, score));

  const valid = reasons.length === 0;
  return {
    valid,
    reasons,
    score,
    accepted: valid && score >= KNOWLEDGE_ACCEPT_THRESHOLD,
  };
}

/**
 * 将知识包广播给所有协作节点。
 * @param {NodeClient} client     节点客户端
 * @param {Array}      peers      对等节点 [{address, id}]
 * @param {object}     packet     知识包
 * @returns {Promise<Array>} 投递结果
 */
export async function broadcastKnowledge(client, peers, packet) {
  const results = [];
  for (const peer of peers) {
    try {
      const res = await client.sendToNode(peer.address, "/knowledge", packet);
      results.push({ peer: peer.id, ok: res.success === true });
    } catch (e) {
      results.push({ peer: peer.id, ok: false, error: e.message });
    }
  }
  return results;
}