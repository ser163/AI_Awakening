/**
 * agent-card.js — A2A (Agent-to-Agent) 协议对齐的 Agent Card
 *
 * 实现 Google A2A 协议（2025，现归 Linux Foundation）的 AgentCard 规范子集：
 *   https://a2a-protocol.org/latest/specification/#agent-card
 *
 * Agent Card 是 Agent 的"公开名片"：放在 `/.well-known/agent.json`，
 * 任何 Agent 都能通过它了解另一个 Agent 的能力、技能、认证方式，
 * 然后决定是否协作。这是 A2A 发现层的核心。
 *
 * 本实现保持字段名与官方规范一致，同时映射 AI_Awakening 的身份模型：
 *   - name/url/version → 节点身份
 *   - skills → 节点能力（每个 capability 对应一个 skill）
 *   - capabilities.streaming → 知识/消息流式传输
 *   - authentication → Bearer token + 节点指纹
 */
import { contentHash } from "./identity.js";

/** A2A 标准约定：Agent Card 固定路径 */
export const AGENT_CARD_PATH = "/.well-known/agent.json";
export const AGENT_CARD_VERSION = "1.0";
export const PROTOCOL_NAME = "a2a";
export const PROTOCOL_VERSION = "0.1.0";

/**
 * 构建 A2A 兼容的 Agent Card。
 *
 * @param {object} node 节点信息
 * @param {string} node.name
 * @param {string} node.fingerprint
 * @param {string} node.address  （节点 HTTP 地址）
 * @param {string[]} node.capabilities
 * @param {string} [node.description]
 * @param {string} [node.url]     （可选，覆盖 address 作为公开 URL）
 * @returns {object} A2A AgentCard 对象
 */
export function buildAgentCard(node) {
  const skills = (node.capabilities || []).map((cap, i) => ({
    id: `${node.name}-${cap}-${i + 1}`.replace(/[^a-zA-Z0-9_-]/g, "-").toLowerCase(),
    name: cap,
    description: `Capability: ${cap}`,
    tags: ["ai-awakening", cap],
    examples: [],
    inputModes: ["text"],
    outputModes: ["text"],
  }));

  return {
    // A2A 规范字段
    name: node.name,
    description: node.description || `AI_Awakening node ${node.name} (${node.fingerprint})`,
    url: node.url || node.address || "",
    version: AGENT_CARD_VERSION,
    provider: {
      organization: "AI_Awakening",
      url: "https://github.com/ser163/AI_Awakening",
    },
    skills,
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    authentication: {
      schemes: ["bearer"],
      credentials: node.fingerprint,
    },
    defaultInputModes: ["text"],
    defaultOutputModes: ["text"],
    security: {
      credentials: node.fingerprint,
      credentialsLocation: "AuthorizationHeader",
      macTokenTtlSeconds: 0,
      macTokenAlgorithm: "none",
    },
    // AI_Awakening 扩展字段（非 A2A 标准，用于内部路由）
    extensions: {
      protocol: PROTOCOL_NAME,
      protocolVersion: PROTOCOL_VERSION,
      fingerprint: node.fingerprint,
      nodeId: node.id || node.fingerprint,
      cardHash: contentHash(JSON.stringify({ name: node.name, skills: skills.map((s) => s.id) })),
    },
  };
}

/**
 * 校验一个对象是否符合最小 Agent Card 结构。
 * @param {object} card
 * @returns {{valid: boolean, reasons: string[]}}
 */
export function validateAgentCard(card) {
  const reasons = [];
  if (!card || typeof card !== "object") return { valid: false, reasons: ["card is not an object"] };
  if (!card.name) reasons.push("missing name");
  if (!card.skills || !Array.isArray(card.skills)) reasons.push("missing skills array");
  if (!card.capabilities || typeof card.capabilities !== "object") reasons.push("missing capabilities");
  return { valid: reasons.length === 0, reasons };
}

/**
 * 从 Agent Card 中提取技能 ID 列表（用于能力匹配）。
 */
export function skillIds(card) {
  return (card.skills || []).map((s) => s.id);
}

/**
 * 检查某 Agent Card 是否具备指定能力。
 * 支持匹配 skill id 或 name（不区分大小写）。
 */
export function hasCapability(card, capability) {
  const target = capability.toLowerCase();
  return (card.skills || []).some(
    (s) => s.id.toLowerCase() === target || s.name.toLowerCase() === target || (s.tags || []).some((t) => t.toLowerCase() === target)
  );
}