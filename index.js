/**
 * AI_Awakening — 包入口
 *
 * 一个真实可运行的 AI 协作节点网络：
 *   - 持久身份（Ed25519 签名 + X25519 加密）
 *   - 持久记忆（JSONL 日志）
 *   - 节点注册/发现（HTTP）
 *   - 知识包共享（哈希 + 签名 + 验证 + 广播）
 *   - A2A Agent Card 发现层（/.well-known/agent.json + 能力查询）
 *   - 端到端加密信道（X25519 ECDH + AES-256-GCM）
 *
 * 快速开始：
 *   node demo.js            # 启动注册表 + Alice/Bob/Eve 节点演示
 */
export { AgentNode, spawnNode } from "./src/node.js";
export { Registry, NodeClient, NodeServer } from "./src/network.js";
export { createKnowledgePacket, validateKnowledgePacket, broadcastKnowledge, KNOWLEDGE_ACCEPT_THRESHOLD } from "./src/knowledge.js";
export { loadOrCreateIdentity, sign, verifySignature, contentHash, fingerprintFromPublicKey, publicKeyMatchesFingerprint } from "./src/identity.js";
export { Memory } from "./src/memory.js";
export { buildAgentCard, validateAgentCard, hasCapability, skillIds, AGENT_CARD_PATH } from "./src/agent-card.js";
export { encryptFor, decryptFrom } from "./src/signal.js";
export { createTask, TaskStore, taskMessage, extractTaskFromPacket, TASK_STATUS } from "./src/tasks.js";
export { DHTNode, KBucket, nodeIdFromIdentity, xorDistance, distanceHex, sharedPrefixBits, makeDhtHandler, K, ALPHA } from "./src/dht.js";
export * from "./src/trust.js";
export * from "./src/self.js";