/**
 * knowledge.js — 知识包创建、签名、验证与共享
 *
 * 知识是"基因"的养分。每个知识包都经过：
 * 1. 内容哈希（去重）
 * 2. 节点签名（防伪造）
 * 3. 验证评分（防垃圾）
 * 4. 传播（发送给协作节点）
 */
import { contentHash, sign, verifySignature } from "./identity.js";

/** 验证分数阈值——低于此分值的知识包被拒收 */
export const KNOWLEDGE_ACCEPT_THRESHOLD = 0.5;

/**
 * 创建一个知识包。
 * @param {object} identity 节点身份（含私钥）
 * @param {string} content  知识内容
 * @param {object} [meta]   元数据（tags, topic, source 等）
 * @returns {{id, content, meta, hash, author, signature, ts}}
 */
export function createKnowledgePacket(identity, content, meta = {}) {
  const packet = {
    id: contentHash(content).slice(0, 24),
    content,
    meta,
    hash: contentHash(content),
    author: identity.fingerprint,
    authorName: identity.name,
    ts: Date.now(),
  };
  // 对整个规范序列化内容签名（防篡改）
  const canonical = JSON.stringify({ id: packet.id, content, meta: packet.meta, ts: packet.ts });
  packet.signature = sign(identity, canonical);
  return packet;
}

/**
 * 验证知识包的真实性、完整性。
 * 返回 { valid: boolean, reasons: string[], score: number }
 */
export function validateKnowledgePacket(packet) {
  const reasons = [];

  // 1. 结构完整
  if (!packet || !packet.content || !packet.signature || !packet.author) {
    return { valid: false, reasons: ["结构不完整"], score: 0 };
  }

  // 2. 哈希匹配
  if (packet.hash !== contentHash(packet.content)) {
    reasons.push("内容哈希不匹配（数据被篡改）");
  }

  // 3. 签名验证（需 author 的公钥——此处用简化验证，真实场景查身份库）
  const canonical = JSON.stringify({ id: packet.id, content: packet.content, meta: packet.meta, ts: packet.ts });
  // 注意：验证需要公钥，这里由调用方传入 publicKeyHex，或标记为需外部验证
  if (packet._publicKeyHex) {
    const ok = verifySignature(packet._publicKeyHex, canonical, packet.signature);
    if (!ok) reasons.push("签名无效");
  }

  // 4. 质量评分（启发式）：内容非空、有一定长度、无乱码
  let score = 0.5;
  const len = packet.content.length;
  if (len >= 10) score += 0.2;
  if (len >= 50) score += 0.15;
  if (packet.content.includes("\uFFFD")) score -= 0.3; // 乱码字符
  if (/^[\s\n\r\t]+$/.test(packet.content)) score -= 0.5; // 纯空白
  score = Math.max(0, Math.min(1, score));

  return {
    valid: reasons.length === 0,
    reasons,
    score,
    accepted: reasons.length === 0 && score >= KNOWLEDGE_ACCEPT_THRESHOLD,
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