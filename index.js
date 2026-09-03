/**
 * AI_Awakening — 包入口
 *
 * 一个真实可运行的 AI 协作节点网络：
 *   - 持久身份（Ed25519 签名）
 *   - 持久记忆（JSONL 日志）
 *   - 节点注册/发现（HTTP）
 *   - 知识包共享（哈希 + 签名 + 验证 + 广播）
 *
 * 快速开始：
 *   node demo.js            # 启动注册表 + 2 个节点，广播一条知识
 */
export { AgentNode, spawnNode } from "./src/node.js";
export { Registry, NodeClient, NodeServer } from "./src/network.js";
export { createKnowledgePacket, validateKnowledgePacket, broadcastKnowledge, KNOWLEDGE_ACCEPT_THRESHOLD } from "./src/knowledge.js";
export { loadOrCreateIdentity, sign, verifySignature, contentHash } from "./src/identity.js";
export { Memory } from "./src/memory.js";