/**
 * tasks.js — 任务协作系统 (v0.10.0)
 *
 * v0.10.0 关键升级：Task 从 "signed message" 升级为 "signed state transition"。
 *
 *   任务不再是"一个对象"，而是"一串签过名的事件 + 由事件推导出的当前状态"。
 *
 *   TaskEvent（签名）:
 *   {
 *     eventId, taskId, action, actor,   // actor = 发起者 fingerprint
 *     previousHash,                      // 上一个事件哈希（状态链）
 *     ts, nonce,
 *     signature                          // actor 的 Ed25519 签名
 *   }
 *
 *   状态机（合法性不可协商）:
 *     OPEN ──claim(actor=claimer)──▶ CLAIMED
 *     OPEN ──cancel(actor=publisher)──▶ CANCELLED
 *     CLAIMED ──complete(actor=assignee)──▶ COMPLETED
 *     CLAIMED ──cancel(actor=publisher)──▶ CANCELLED
 *     （非法: OPEN→COMPLETED, COMPLETED→CLAIMED, CLAIMED(A)→CLAIMED(B)）
 *
 *   每个事件携带 actor 签名，接收方验证：
 *     1. actor 可信（TrustedIdentityStore）
 *     2. 签名有效（actor 私钥）
 *     3. 状态转移合法（当前状态 × action）
 *     4. 事件链连续（previousHash 匹配）
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sign, verifySignature, publicKeyMatchesFingerprint } from "./identity.js";

/** 任务状态 */
export const TASK_STATUS = {
  OPEN: "open",          // 等待认领
  CLAIMED: "claimed",    // 已被认领
  COMPLETED: "completed",// 已完成
  CANCELLED: "cancelled",// 已取消（v0.10.0）
};

/** 合法状态转移表：fromStatus -> { action: [允许的 toStatus, 允许的 actor 规则] } */
const TRANSITIONS = {
  [TASK_STATUS.OPEN]: {
    claim: { to: TASK_STATUS.CLAIMED, actorMustBe: "any" },           // 任意有能力的节点可认领
    cancel: { to: TASK_STATUS.CANCELLED, actorMustBe: "publisher" },  // 只有发布者可取消
  },
  [TASK_STATUS.CLAIMED]: {
    complete: { to: TASK_STATUS.COMPLETED, actorMustBe: "assignee" }, // 只有当前认领者可完成
    cancel: { to: TASK_STATUS.CANCELLED, actorMustBe: "publisher" },  // 发布者可取消已认领任务
  },
};

/**
 * TaskPolicyEngine（v0.12.2）——任务的权威模型，结构化、可配置、拒绝假实现。
 *
 * 审查指出的两个核心问题：
 *   ① quorum(N) 曾是"接口先行，语义未实现"——配置看起来比实际安全级别高。
 *      修复：未实现的策略显式 throw，绝不静默降级为 "any"。
 *   ② TaskPolicy 只是 actor authorization，不是 policy engine。
 *      修复：每个 action 升级为结构化对象 { authority, conditions?, threshold? }。
 *
 * 每项 action 的 authority 取值：
 *   "any"        — 任意可信节点
 *   "publisher"  — 仅发布者
 *   "assignee"   — 仅当前认领者
 *   "quorum"     — 需要 threshold 个可信节点确认（v0.12.2 起未实现 → throw，拒绝假安全）
 * conditions / threshold：**reserved**（v0.12.3）——尚无 evaluator，仅占位；
 *   在真正实现 conditions evaluator 与 quorum verifier 之前，系统不会假装它们生效。
 * fork 规则（字符串，不涉及 authorization）：
 *   "publisher"  — publisher 分支优先（默认，兼容 v0.12.0）
 *   "newest"     — 最新时间戳优先（适合无权威方的协作）
 *   "assignee"   — 当前认领者分支优先（适合任务执行权仲裁）
 *
 * 兼容旧格式：字符串 "any"/"publisher"/"assignee" 等价于 { authority: 同值 }。
 */
export const TASK_POLICIES = {
  DEFAULT: {
    claim: { authority: "any" },
    complete: { authority: "assignee" },
    cancel: { authority: "publisher" },
    verify: { authority: "publisher" },
    fork: "publisher",
  },
  COLLABORATIVE: {
    claim: { authority: "any" },
    complete: { authority: "assignee" },
    cancel: { authority: "publisher" },
    verify: { authority: "publisher" }, // quorum 未实现前不宣称 quorum（诚实 > 好看）
    fork: "newest",
  },
  EXECUTOR_AUTHORITY: {
    claim: { authority: "any" },
    complete: { authority: "assignee" },
    cancel: { authority: "publisher" },
    verify: { authority: "assignee" },
    fork: "assignee",
  },
};

/** 已知 authority 白名单（v0.12.3）——未知 authority 拒绝加载，不静默 ok:true */
const KNOWN_AUTHORITIES = new Set(["any", "publisher", "assignee", "quorum"]);

/** 已知 fork 规则白名单（v0.12.4）——与 authority 白名单风格一致，未知→throw */
const KNOWN_FORK_RULES = new Set(["publisher", "assignee", "newest"]);

/**
 * 归一化 policy 条目（v0.12.4，审查 P0 三态）：
 *   undefined/null → return null（调用方继承 default）
 *   invalid（非字符串非对象）→ throw
 *   字符串 "any"/"publisher"/"assignee" → {authority: 同值}
 *   对象 {authority} → as-is
 * @param {*} entry
 * @returns {object|null}
 */
function normalizePolicyEntry(entry) {
  if (entry === undefined || entry === null) return null;
  if (typeof entry === "string") return { authority: entry };
  if (entry && typeof entry === "object" && entry.authority) return entry;
  throw new Error(`invalid policy entry: ${JSON.stringify(entry)} — must be string or {authority: ...}`);
}

/**
 * 解析 authority 规则。
 * @param {object} policy 任务策略
 * @param {string} action claim|complete|cancel|verify
 * @returns {string} authority 规则（any/publisher/assignee/quorum）
 * @throws 若策略为未实现的 quorum 或未知 authority → 显式拒绝（绝不降级）
 */
function resolveAuthority(policy, action) {
  const rule = normalizePolicyEntry((policy || {})[action]);
  // 若 entry 为 null（缺失），继承 default（已在 mergePolicy 确保，但防御性处理）
  const authority = rule ? rule.authority : "publisher";
  if (typeof authority === "string" && authority.startsWith("quorum(")) {
    throw new Error(`unsupported policy: ${action} = "${authority}" — quorum 未实现，拒绝静默降级为 any`);
  }
  if (authority === "quorum") {
    throw new Error(`unsupported policy: ${action} = quorum — quorum 未实现，拒绝静默降级为 any`);
  }
  // v0.12.3: 未知 authority 白名单拒绝（"foobar" → 不静默 ok:true）
  if (!KNOWN_AUTHORITIES.has(authority)) {
    throw new Error(`unsupported policy: ${action} = "${authority}" — 未知 authority，拒绝加载任务`);
  }
  return authority;
}

/**
 * 规范化事件（签名覆盖的字段，固定键序）。
 * 注意：signature 与 eventHash 都不参与规范化（eventHash 是 canonical 的哈希）。
 */
/** 合法语义版本白名单（v0.12.8）——不存在的版本直接拒绝 */
const KNOWN_SEMANTIC_VERSIONS = new Set([1, 2]);

/** V1 canonical（v0.12.8）：旧格式/无 semanticVersion 事件——向后兼容历史签名 */
function canonicalizeEventV1(ev) {
  return JSON.stringify({
    eventId: ev.eventId,
    taskId: ev.taskId,
    action: ev.action,
    actor: ev.actor,
    previousHash: ev.previousHash ?? null,
    ts: ev.ts,
    nonce: ev.nonce,
    status: ev.status,
    beforeState: ev.beforeState || null,
    afterState: ev.afterState || null,
    payload: ev.payload || null,
  });
}

/** V2 canonical（v0.12.8）：semanticVersion 纳入签名域（防版本降级攻击）。
 *  v0.13.0: taskDefinitionHash 条件纳入（仅 publish 事件携带；无此字段的旧 v2
 *  事件 canonical 与以前逐字节相同 → 向后兼容）。 */
function canonicalizeEventV2(ev) {
  const o = {
    eventId: ev.eventId,
    taskId: ev.taskId,
    action: ev.action,
    actor: ev.actor,
    previousHash: ev.previousHash ?? null,
    ts: ev.ts,
    nonce: ev.nonce,
    semanticVersion: ev.semanticVersion ?? 2, // v0.12.7+: 版本是安全边界，必须签名
  };
  // 仅当事件声明 taskDefinitionHash 时纳入签名域（固定键序，位于 semanticVersion 之后）
  if (ev.taskDefinitionHash) o.taskDefinitionHash = ev.taskDefinitionHash;
  o.status = ev.status;
  o.beforeState = ev.beforeState || null;
  o.afterState = ev.afterState || null;
  o.payload = ev.payload || null;
  return JSON.stringify(o);
}

/**
 * 版本化 canonicalization（v0.12.8）：
 *   semanticVersion === 2 → V2 canonical（含版本字段）
 *   其他（1 / 缺失 / 旧事件）→ V1 canonical（不含——历史签名仍可验证）
 * 注意：V2 事件把 semanticVersion 降为 1 后，签名会失效（V2 签名覆盖版本字段，
 * 降级后用 V1 canonical 验证不匹配）。
 */
function canonicalizeEvent(ev) {
  if (ev.semanticVersion === 2) return canonicalizeEventV2(ev);
  return canonicalizeEventV1(ev);
}

/** 计算事件的防篡改哈希（v0.10.1: 真哈希，不再是 eventId） */
export function hashEvent(ev) {
  return crypto.createHash("sha256").update(canonicalizeEvent(ev)).digest("hex");
}

/**
 * v0.12.15 (审查 P0): Event Integrity 统一 gate——所有入口共用同一个完整性规则。
 * 原则：V2 事件 = integrity boundary 内 → eventHash 必填且必须自洽；
 *       V1/legacy/unversioned = 迁移兼容 → 有 hash 则验证，无 hash 不阻塞。
 * 防止同一条 V2 事件在 live/replay/fork 上拥有不同合法性定义（live==replay 不变量）。
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkEventIntegrity(event) {
  if (event.semanticVersion === 2 && !event.eventHash) {
    return { ok: false, reason: "v2 event requires eventHash" };
  }
  if (event.eventHash && event.eventHash !== hashEvent(event)) {
    return { ok: false, reason: "eventHash mismatch (event content tampered)" };
  }
  return { ok: true };
}

/**
 * 计算 Task Definition 的 canonical hash（v0.13.0 审查 P0-②）。
 * 只覆盖静态定义字段（title/description/publisher/capabilities/policy）——
 * 不含 runtime state。Genesis Event 绑定此 hash，防 relay 改写任务定义。
 * 深度排序键：sender/receiver 各自序列化也不受对象键序影响。
 */
function deepSortedJSON(value) {
  if (Array.isArray(value)) return value.map(deepSortedJSON);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = deepSortedJSON(value[k]);
    return out;
  }
  return value;
}

export function canonicalizeTaskDefinition(task) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(deepSortedJSON({
      taskId: task.id,
      title: task.title,
      description: task.description,
      publisherFingerprint: task.publisherFingerprint,
      requiredCapabilities: task.requiredCapabilities || [],
      policy: task.policy || null,
    })))
    .digest("hex");
}

/**
 * v0.12.12: fork 视图纯推导函数——eventIndex + canonicalHead → 分支头列表。
 * 原则：forks = pure derived data，同一函数供 reconcile + live upsert 使用，
 * 消除"运行时 push fork 而恢复时重算"的双语义。
 */
export function deriveForkView(eventIndex, canonicalHead) {
  if (!eventIndex || !canonicalHead) return [];
  // canonical 主链集合
  const mainSet = new Set();
  let cur = canonicalHead;
  let guard = 0;
  while (cur && guard++ < 10000) { mainSet.add(cur); cur = eventIndex[cur]?.parentHash || null; }
  if (mainSet.size === 0) return [];
  // 建立 children 映射（parentHash → [childHash]）
  const children = {};
  for (const [h, meta] of Object.entries(eventIndex)) {
    if (meta.parentHash) {
      if (!children[meta.parentHash]) children[meta.parentHash] = [];
      children[meta.parentHash].push(h);
    }
  }
  // 分支头 = 非 canonical 的 leaf 节点（没有孩子的分支末端节点）
  const forks = [];
  for (const [h] of Object.entries(eventIndex)) {
    if (mainSet.has(h)) continue;
    if ((children[h] || []).length > 0) continue; // 还有孩子 → 非 leaf
    const meta = eventIndex[h];
    forks.push({ headEventHash: h, actor: meta?.actor || "", ts: meta?.ts || 0, action: meta?.action || "" });
  }
  return forks;
}

/** 生成唯一 ID */
function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 深合并 TaskPolicy（v0.12.4，审查 P0）：
 *   DEFAULT + 用户 override —— 缺失 action 继承 default（禁止缺省→any）；
 *   显式 action 覆盖 default；未知 action 保留（由 authority 白名单在解析时拒绝）。
 * @param {object} userPolicy 用户策略（可部分）
 * @returns {object} 合并后的完整策略
 */
function mergePolicy(userPolicy) {
  const base = JSON.parse(JSON.stringify(TASK_POLICIES.DEFAULT)); // 深拷贝默认
  if (!userPolicy || typeof userPolicy !== "object") return base;
  for (const key of Object.keys(userPolicy)) {
    const v = userPolicy[key];
    if (v === undefined || v === null) continue; // 显式 null → 继承 default
    base[key] = (typeof v === "object" && !Array.isArray(v))
      ? { ...base[key], ...v } // 部分 action 对象（如只给 authority）也深合并
      : v;
  }
  return base;
}

/**
 * 创建一个任务对象（初始 OPEN 状态）。
 */
export function createTask({ title, description = "", requiredCapabilities = [], assigneeFingerprint = "", meta = {}, policy = null }) {
  if (!title) throw new Error("task title is required");
  return {
    id: genId("task"),
    title,
    description,
    requiredCapabilities,
    assigneeFingerprint,
    meta,
    policy: mergePolicy(policy), // v0.12.4: 深合并，缺失 action 继承 DEFAULT
    status: TASK_STATUS.OPEN,
    publisherFingerprint: "",
    publisherName: "",
    assigneeFingerprintActual: "",
    result: null,
    createdAt: Date.now(),
    claimedAt: null,
    completedAt: null,
    cancelledAt: null,
    lastEventHash: null, // v0.10.0: 状态链尾，v0.11.0: 可能为分叉主链头
    eventHeight: 0,      // v0.12.4: 事件高度（替代 eventHashes 无限增长）
    eventIndex: {},      // v0.12.6: {[eventHash]: {eventId,parentHash,actor,action,ts,height}}——元数据索引
    forks: [],           // v0.11.0: 分叉列表 [{headEventHash, actor, ts, action, height}]
  };
}

/**
 * 创建一个签名的任务事件（v0.10.0）。
 * 事件由 actor 用私钥签名——从密码学上证明"这个状态变更是这个节点做的"。
 *
 * @param {object} identity actor 身份（签名者）
 * @param {string} action publish|claim|complete|cancel
 * @param {object} task 任务当前状态
 * @returns {object} 签名事件
 */
export function createTaskEvent(identity, action, beforeTask, afterTask = null) {
  // v0.12.4: 拆 beforeState / afterState（审查 P0-③）。
  // 旧调用（3 参数，afterTask=null）→ beforeState = afterState = task 快照（向后兼容）。
  // 新调用（4 参数）→ beforeState = beforeTask 快照，afterState = afterTask 快照。
  // beforeTask=null（publish 等 genesis 事件）→ before 合成空状态。
  const task = afterTask || beforeTask; // 兼容旧调用：只有一个状态
  const before = afterTask ? (beforeTask || { status: null, assigneeFingerprintActual: "", result: null }) : task;
  const after = afterTask || task;
  const beforeState = { status: before.status, assigneeFingerprintActual: before.assigneeFingerprintActual || "", result: before.result ?? null };
  const afterState = { status: after.status, assigneeFingerprintActual: after.assigneeFingerprintActual || "", result: after.result ?? null };
  const event = {
    eventId: genId("evt"),
    taskId: task.id,
    action,
    actor: identity.fingerprint,
    previousHash: task.lastEventHash || null, // v0.10.1: 真哈希链
    ts: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex"),
    status: task.status, // 保留旧字段（兼容旧 canonicalizeTask）
    // v0.12.7 (审查 P0): 显式语义版本——不再用 before≠after 判断 legacy。
    //   v2 = 4-arg 调用：beforeState/afterState 明确，无条件 deriveNextState 验证
    //   v1 = 3-arg 兼容调用：before=after 快照，legacy 语义（仅迁移/读取）
    semanticVersion: afterTask ? 2 : 1,
    // v0.13.0 (审查 P0-②): genesis(publish) 绑定 Task Definition Hash——
    //   Event 一旦签名，定义（title/publisher/capabilities/policy）即不可被 relay 改写
    taskDefinitionHash: action === "publish" ? canonicalizeTaskDefinition(task) : undefined,
    // v0.12.4: 明确的 beforeState / afterState（含之前的 state 快照，按需迁移）
    beforeState,
    afterState,
    // 旧 payload.state 保留（兼容旧 canonicalizeTask 重放）
    payload: {
      state: afterState,
    },
  };
  // v0.10.1: eventHash = SHA-256(canonicalizeEvent) 防篡改；签名覆盖 canonical
  event.signature = sign(identity, canonicalizeEvent(event));
  event.eventHash = hashEvent(event); // 真哈希，不再是 eventId
  return event;
}

/**
 * 生成任务消息载荷（用于 shareKnowledge 广播）。
 */
export function taskMessage(action, task, event = null) {
  return { type: "task", action, task, event };
}

/**
 * 从知识包中识别任务消息。
 */
export function extractTaskFromPacket(packet) {
  const meta = packet.meta || {};
  if (meta.type !== "task") return null;
  return { action: meta.action, task: meta.task, event: meta.event || null };
}

/**
 * 校验一个事件是否是 actor 本人签发的合法状态变更。
 * @param {object} event 事件
 * @param {string} action 期望动作
 * @param {object} task 任务当前状态
 * @param {object} trustedStore TrustedIdentityStore
 * @param {object} [opts]
 * @param {boolean} [opts.hasLocalRecord] 本地是否已有该任务记录。
 *   首见（无本地记录）时不校验 previousHash 链——链从签名广播引导建立。
 * @returns {{ok: boolean, reason?: string}}
 */
export function validateTaskEvent(event, action, task, trustedStore, { hasLocalRecord = true, allowLegacy = true } = {}) {
  if (!event || !event.signature || !event.actor || !event.taskId || !event.action) {
    return { ok: false, reason: "malformed task event" };
  }
  if (event.taskId !== task.id) return { ok: false, reason: "taskId mismatch" };
  if (event.action !== action) return { ok: false, reason: `action mismatch (event=${event.action}, expected=${action})` };

  // 1. actor 可信 + 公钥绑定
  const publicKey = trustedStore.getPublicKey(event.actor);
  if (!publicKey) return { ok: false, reason: "unknown event actor (no trusted public key)" };
  if (!publicKeyMatchesFingerprint(publicKey, event.actor)) {
    return { ok: false, reason: "actor publicKey does not match fingerprint" };
  }

  // 2. 签名有效
  if (!verifySignature(publicKey, canonicalizeEvent(event), event.signature)) {
    return { ok: false, reason: "invalid event signature" };
  }

  // v0.10.1: eventHash 自洽（历史事件被修改 → hash 不匹配 → 断链）
  // v0.12.15 (审查 P0): V2 integrity boundary 必须在每个入口统一——
  //   V2 事件必须有 eventHash，且 eventHash 必须等于 hashEvent(event)
  const integrity = checkEventIntegrity(event);
  if (!integrity.ok) {
    return { ok: false, reason: integrity.reason };
  }

  // 3. 状态链连续（真哈希链）
  //    首见（hasLocalRecord=false）：信任由签名广播引导，跳过链校验。
  //    有本地记录：previousHash 必须匹配本地链尾，或匹配本地历史中的事件（= 合法分叉）。
  // v0.12.6 (审查 P0): Fork 是链关系，不是免检通行证。标记 forked 后继续语义验证。
  let forked = false;
  if (hasLocalRecord && event.previousHash !== (task.lastEventHash || null)) {
    const forkParentExists = !!(task.eventIndex && task.eventIndex[event.previousHash]);
    if (!forkParentExists) {
      return { ok: false, reason: "event chain broken (previousHash mismatch)" };
    }
    forked = true;
    // 不提前 return——继续 afterState 语义验证
  }

  // v0.12.7 (审查 P0): 加密完整性 ≠ 状态机完整性。
  // v0.12.8 (审查 P0): 版本号是安全边界，必须被签名。semanticVersion 白名单拒绝未知版本。
  if (event.semanticVersion !== undefined && event.semanticVersion !== null) {
    if (typeof event.semanticVersion !== "number" || !KNOWN_SEMANTIC_VERSIONS.has(event.semanticVersion)) {
      return { ok: false, reason: `unsupported semanticVersion: ${event.semanticVersion} (must be 1 or 2)` };
    }
  }
  // v0.13.0 (审查 P0-②/P0-③): genesis(publish) 定义绑定——v2 publish 事件必须携带
  // taskDefinitionHash 且 hash(packet.task definition) 一致（防 relay 改写定义）；
  // publisher 身份必须等于 event actor（防 Alice 签事件、Bob 被记为 publisher）。
  if (action === "publish" && event.semanticVersion === 2) {
    if (!event.taskDefinitionHash) {
      return { ok: false, reason: "v2 publish event missing taskDefinitionHash (definition not bound)" };
    }
    if (canonicalizeTaskDefinition(task) !== event.taskDefinitionHash) {
      return { ok: false, reason: "task definition hash mismatch (definition tampered by relay)" };
    }
    if (task.publisherFingerprint && event.actor !== task.publisherFingerprint) {
      return { ok: false, reason: "publish actor must equal task.publisherFingerprint" };
    }
  }
  // v0.12.9 (审查 P0): 版本门控——allowLegacy=false（网络路径）只接受显式 v2；
  //   semanticVersion=1 或缺失（unversioned）一律 REJECT。allowLegacy=true（本地
  //   migration/replay）才允许 v1/unversioned 走 legacy 解码。
  if (!allowLegacy) {
    const isV2 = event.semanticVersion === 2;
    if (!isV2) {
      const reason = event.semanticVersion === 1
        ? "semanticVersion=1 rejected on network path (v1 = local migration only)"
        : "unversioned event rejected on network path (v2 required)";
      return { ok: false, reason };
    }
  }
  // isLegacy 判定（v0.12.8 修正）：
  //   semanticVersion===2 → v2 无条件 deriveNextState
  //   semanticVersion===1 → v1 legacy（历史格式，显式声明）
  //   缺失（旧磁盘事件）→ 启发式：无 beforeState/afterState 或 before≈after 视为 legacy
  let isLegacyEvent;
  if (event.semanticVersion === 1) isLegacyEvent = true;
  else if (event.semanticVersion === 2) isLegacyEvent = false;
  else if (!event.beforeState || !event.afterState) isLegacyEvent = true;
  else isLegacyEvent = event.beforeState.status === event.afterState.status && event.beforeState.assigneeFingerprintActual === event.afterState.assigneeFingerprintActual;
  if (!isLegacyEvent) {
    // v2 事件（4-arg）：无条件验证状态机（含 no-op 也要经 deriveNextState）
    if (hasLocalRecord && !forked) {
      // 主链事件：beforeState 必须匹配本地当前状态（任务头部）
      if (event.beforeState.status !== task.status) {
        return { ok: false, reason: `beforeState mismatch: event=${event.beforeState.status}, local=${task.status}` };
      }
      if ((event.beforeState.assigneeFingerprintActual || "") !== (task.assigneeFingerprintActual || "")) {
        return { ok: false, reason: "beforeState assignee mismatch" };
      }
    }
    // no-op（before=after）在 deriveNextState 里没有合法转移（claim 必须 open→claimed 等），
    // 因此会被拒绝——不存在"合法 no-op"状态转移。
    const st = validateStateTransition(event);
    if (!st.ok) return st;
  }

  return { ok: true, forked: forked || undefined }; // forked 仅 true 时返回
}

/**
 * 推导状态转移的期望结果（v0.12.6，审查 P0）——**唯一的状态转移来源**。
 * 协议自己计算"beforeState + action + actor → 应该变成什么"，
 * 不再相信事件发送者自报的 afterState。live path（validate）与 replay path
 * （canonicalizeTask）共用此函数，保证两条路径结果一致。
 *
 * @param {object} beforeState { status, assigneeFingerprintActual, result }
 * @param {string} action publish|claim|complete|cancel
 * @param {string} actor fingerprint
 * @param {object} [payload] 事件载荷（complete 的 result 可来自 payload）
 * @returns {object} expected afterState（完整字段）
 * @throws {Error} 若转移非法
 */
export function deriveNextState(beforeState, action, actor, payload = null) {
  const b = beforeState || {};
  const status = b.status ?? null;
  // deriveNextState 是纯函数（v0.12.7）——禁止 Date.now/Math.random/network/fs。same input → same output。

  const after = {
    status,
    assigneeFingerprintActual: b.assigneeFingerprintActual || "",
    result: b.result ?? null,
  };

  if (action === "publish") {
    if (status !== null && status !== undefined) {
      throw new Error(`illegal state transition: ${status} →publish→ open (publish requires genesis)`);
    }
    after.status = TASK_STATUS.OPEN;
    after.assigneeFingerprintActual = "";
    after.result = null;
    return after;
  }
  if (action === "claim") {
    if (status !== TASK_STATUS.OPEN) {
      throw new Error(`illegal state transition: ${status} →claim→ claimed (claim requires open)`);
    }
    after.status = TASK_STATUS.CLAIMED;
    after.assigneeFingerprintActual = actor; // claim 的 assignee 必须是 actor 本人
    after.result = null; // claim 不携带 result
    return after;
  }
  if (action === "complete") {
    if (status !== TASK_STATUS.CLAIMED) {
      throw new Error(`illegal state transition: ${status} →complete→ completed (complete requires claimed)`);
    }
    after.status = TASK_STATUS.COMPLETED;
    after.assigneeFingerprintActual = b.assigneeFingerprintActual || ""; // 保留 assignee
    // complete 的 result 可来自 payload.state.result / payload.result / beforeState.result
    const carriedResult = payload?.state?.result ?? payload?.result ?? null;
    after.result = carriedResult !== undefined && carriedResult !== null ? carriedResult : (b.result ?? null);
    return after;
  }
  if (action === "cancel") {
    if (status !== TASK_STATUS.OPEN && status !== TASK_STATUS.CLAIMED) {
      throw new Error(`illegal state transition: ${status} →cancel→ cancelled (cancel requires open|claimed)`);
    }
    after.status = TASK_STATUS.CANCELLED;
    after.assigneeFingerprintActual = ""; // cancel 清空 assignee
    after.result = null;
    return after;
  }
  throw new Error(`unknown action: ${action}`);
}

/**
 * v0.12.12 (审查 P0): 共享 Event Apply Pipeline——live 与 replay 走完全相同的语义验证。
 * 不变量：声明的 beforeState 必须 == 当前重建状态（不信任事件自带 beforeState）；
 * expected = deriveNextState(currentState,...)；expected == afterState。
 * @param {object} currentState 当前重建状态 {status, assigneeFingerprintActual, result}
 * @param {object} event v2 事件
 * @returns {object} 新状态
 * @throws {Error} 任何不变量违反
 */
export function applyEvent(currentState, event) {
  const before = event.beforeState;
  if (before) {
    const cur = { status: currentState.status, assigneeFingerprintActual: currentState.assigneeFingerprintActual || "", result: currentState.result ?? null };
    const decl = { status: before.status, assigneeFingerprintActual: before.assigneeFingerprintActual || "", result: before.result ?? null };
    if (cur.status !== decl.status || cur.assigneeFingerprintActual !== decl.assigneeFingerprintActual || (cur.result ?? null) !== (decl.result ?? null)) {
      throw new Error(`beforeState != currentState: declared=${JSON.stringify(decl)}, current=${JSON.stringify(cur)}`);
    }
  }
  const expected = deriveNextState(currentState, event.action, event.actor, event.payload);
  const after = event.afterState;
  if (after) {
    if (after.status !== expected.status) throw new Error(`afterState.status mismatch: declared=${after.status}, expected=${expected.status}`);
    if ((after.assigneeFingerprintActual || "") !== (expected.assigneeFingerprintActual || "")) throw new Error(`afterState.assignee mismatch: declared=${after.assigneeFingerprintActual || ""}, expected=${expected.assigneeFingerprintActual || ""}`);
    if (actionHasResult(event.action) && (after.result ?? null) !== (expected.result ?? null)) throw new Error(`afterState.result mismatch: declared=${after.result ?? null}, expected=${expected.result ?? null}`);
  }
  return { status: expected.status, assigneeFingerprintActual: expected.assigneeFingerprintActual || "", result: expected.result ?? null };
}

/**
 * 验证状态转换语义（v0.12.5→v0.12.6）。
 * v0.12.6: 改为 deriveNextState() + compare——协议自己推导 expected，
 * 不再信任事件自报的 afterState；并完整比较状态字段（含 result）。
 *
 * @param {object} event 事件（需含 beforeState/afterState/action/actor）
 * @returns {{ok: boolean, reason?: string, expected?: object}}
 */
export function validateStateTransition(event) {
  const before = event.beforeState;
  const after = event.afterState;
  if (!before || !after) return { ok: false, reason: "event missing beforeState/afterState" };
  try {
    const expected = deriveNextState(before, event.action, event.actor, event.payload);
    // 全字段比较（status + assignee + result）——不只比 status
    const mismatches = [];
    if (after.status !== expected.status) mismatches.push(`status: declared=${after.status}, expected=${expected.status}`);
    if ((after.assigneeFingerprintActual || "") !== (expected.assigneeFingerprintActual || "")) {
      mismatches.push(`assignee: declared=${after.assigneeFingerprintActual || ""}, expected=${expected.assigneeFingerprintActual || ""}`);
    }
    if (actionHasResult(event.action) && (after.result ?? null) !== (expected.result ?? null)) {
      mismatches.push(`result: declared=${after.result ?? null}, expected=${expected.result ?? null}`);
    }
    if (mismatches.length > 0) {
      return { ok: false, reason: `afterState mismatch: ${mismatches.join("; ")}` };
    }
    return { ok: true, expected };
  } catch (err) {
    return { ok: false, reason: err?.message || String(err) };
  }
}

/** action 是否涉及 result 字段 */
function actionHasResult(action) {
  return action === "complete";
}

/**
 * 检查状态转移合法性（基于当前状态 × action × actor 规则）。
 * @param {object} task 当前任务
 * @param {string} action 请求的动作
 * @param {string} actorFingerprint 动作发起者
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkTransition(task, action, actorFingerprint) {
  // v0.12.2: 先解析 policy（quorum 未实现 → 无论状态如何都显式 throw，拒绝降级）
  // 这必须在状态转移检查之前——否则 OPEN 状态没有 verify 条目会提前返回 illegal transition，
  // 掩盖"策略本身未实现"这个更严重的错误。
  const policy = task.policy || {};
  if (action === "cancel" || action === "complete" || action === "verify") {
    resolveAuthority(policy, action); // 只用于验证；实际规则在下方使用
  }

  const allowed = TRANSITIONS[task.status]?.[action];
  if (!allowed) {
    return { ok: false, reason: `illegal transition: ${task.status} → ${action}` };
  }
  // v0.12.1: 策略可配置——取消授权规则读 task.policy（默认 publisher）
  // v0.12.2: resolveAuthority 处理结构化策略 + quorum 拒绝（绝不降级）
  let actorRule = allowed.actorMustBe;
  if (action === "cancel" || action === "complete" || action === "verify") {
    actorRule = resolveAuthority(policy, action);
  }

  if (actorRule === "publisher" && actorFingerprint !== task.publisherFingerprint) {
    return { ok: false, reason: "only the publisher can perform this action" };
  }
  if (actorRule === "assignee" && actorFingerprint !== task.assigneeFingerprintActual) {
    return { ok: false, reason: "only the current assignee can perform this action" };
  }
  return { ok: true };
}

/**
 * 计算任务"执行态"的确定性哈希（v0.12.2/v0.12.3）——用于 applyCanonicalState 判等。
 * 审查指出：名称"所有状态字段"不准确——只覆盖业务运行态字段
 * （status/assignee/result/三个时间戳/lastEventHash），
 * 静态字段（title/description/policy/publisher）故意不参与。
 * 因此准确名称应为 canonicalTaskExecutionStateHash / canonicalTaskRuntimeStateHash；
 * 保留原导出名以兼容调用方，但语义按"执行态"理解。
 * @param {object} task 任务状态
 * @returns {string} sha256 hex
 */
export function canonicalTaskStateHash(task) {
  return crypto.createHash("sha256").update(JSON.stringify({
    status: task.status,
    assigneeFingerprintActual: task.assigneeFingerprintActual || "",
    result: task.result ?? null,
    claimedAt: task.claimedAt ?? null,
    completedAt: task.completedAt ?? null,
    cancelledAt: task.cancelledAt ?? null,
    lastEventHash: task.lastEventHash ?? null,
  })).digest("hex");
}

/**
 * 本地任务仓库：事件日志 + 状态推导，持久化。
 */
export class TaskStore {
  constructor(storageDir = null) {
    this.storageDir = storageDir;
    this.tasks = new Map();       // id -> task (当前状态)
    this.events = new Map();      // id -> [events]（按 taskId 分组）
    this._seenEvents = new Set(); // eventId 去重
    this._eventHashById = new Map(); // v0.12.9: eventId → eventHash（一致性约束）
    this._seenEventHashes = new Set(); // v0.12.9: eventHash 去重（内容身份）
    this._taskFile = storageDir ? path.join(storageDir, "tasks", "tasks.jsonl") : null;
    this._eventFile = storageDir ? path.join(storageDir, "tasks", "events.jsonl") : null;
    // v0.12.3: 持久化健康状态——与 WorldModel 统一，不再静默吞异常
    this.persistentHealthy = true;
    this.persistenceError = null;
    this._load();
  }

  /** 持久化健康（v0.12.3） */
  isHealthy() { return this.persistentHealthy; }
  persistenceErrorMessage() { return this.persistenceError; }

  _load() {
    if (!this._taskFile) return;
    // v0.12.13 (审查 P0): tasks.jsonl 也事务性加载——与 events.jsonl 统一原子性
    try {
      fs.mkdirSync(path.dirname(this._taskFile), { recursive: true });
      const text = fs.readFileSync(this._taskFile, "utf8");
      const parsedTasks = [];
      for (const line of text.trim().split("\n").filter(Boolean)) {
        parsedTasks.push(JSON.parse(line));
      }
      for (const t of parsedTasks) this.tasks.set(t.id, t);
    } catch (e) {
      // ENOENT = 首次运行；其他 = snapshot 损坏 → 标记 unhealthy，不清空 tasks（保留）
      if (e?.code !== "ENOENT") {
        this.persistentHealthy = false;
        this.persistenceError = `task snapshot corrupt: ${e.message}`;
      }
    }
    // v0.12.12 (审查 P0): 事务性加载——先全部解析到临时数组，任何一行失败
    // 就标记 unhealthy 且不修改内存事件状态，避免 partial event log 被 reconcile。
    if (this._eventFile) {
      const parsedEvents = [];  // {taskId, ev}
      const seenEvents = new Set();
      const eventHashById = new Map();
      const seenEventHashes = new Set();
      try {
        const text = fs.readFileSync(this._eventFile, "utf8");
        for (const line of text.trim().split("\n").filter(Boolean)) {
          const ev = JSON.parse(line);
          if (ev.eventId) {
            seenEvents.add(ev.eventId);
            if (ev.eventHash) eventHashById.set(ev.eventId, ev.eventHash);
          }
          if (ev.eventHash) seenEventHashes.add(ev.eventHash);
          if (ev.taskId) parsedEvents.push({ taskId: ev.taskId, ev });
        }
      } catch (e) {
        // ENOENT = 首次运行（无日志）→ 正常空加载；其他错误 = 日志损坏 → fail-closed
        if (e?.code !== "ENOENT") {
          this.persistentHealthy = false;
          this.persistenceError = `event log corrupt: ${e.message}`;
          this._reconcileFromEvents();
          return;
        }
      }
      // 全部解析成功 → 事务性提交
      this._seenEvents = seenEvents;
      this._eventHashById = eventHashById;
      this._seenEventHashes = seenEventHashes;
      for (const { taskId, ev } of parsedEvents) {
        if (!this.events.has(taskId)) this.events.set(taskId, []);
        this.events.get(taskId).push(ev);
      }
    }
    this._reconcileFromEvents();
  }

  /** v0.13.0 P1-⑥/⑦: 从 events 重建 runtime state（event log wins）+ derived forks。 */
  _reconcileFromEvents() {
    for (const [id, task] of this.tasks) {
      const events = this.events.get(id);
      if (!events || events.length === 0) continue;
      if (!this._tryRebuildFromEvents(id, task, events)) continue;
    }
  }

  /**
   * v0.12.12 (审查 P0): 从 events 重建权威 runtime state（唯一来源是 Event Log）。
   * - head 选择：只按 forkRule 从 DAG heads 池决策，snapshot.lastEventHash 不参与
   *   （快照最多是 skip 加速，不能影响 canonical choice）
   * - 每个 v2 事件走共享 applyEvent()（beforeState==currentState + derive + afterState）
   * - 任何失败 → return false，不写回 partial snapshot（日志损坏 = 只读降级）
   */
  _tryRebuildFromEvents(id, task, events) {
    const byHash = {};
    for (const ev of events) byHash[ev.eventHash || ev.eventId] = ev;
    // v0.12.14/15 (审查 P0): Event Integrity 统一 gate——与 live/fork 同一规则
    for (const ev of events) {
      const integrity = checkEventIntegrity(ev);
      if (!integrity.ok) {
        this.persistentHealthy = false;
        this.persistenceError = `event ${ev.eventId} ${integrity.reason}`;
        return false; // 损坏 → 不重建、不写回
      }
    }
    // v0.12.14 (审查 P0-1): DAG 父节点完整性——previousHash !== null 必须存在于 byHash。
    //   孤儿事件（父不存在）不得脱离真实 DAG 被当成合法 genesis/fork head。
    for (const ev of events) {
      if (ev.previousHash && !byHash[ev.previousHash]) {
        this.persistentHealthy = false;
        this.persistenceError = `event ${ev.eventId} has dangling previousHash (${String(ev.previousHash).slice(0, 8)}...)`;
        return false;
      }
    }
    // 2. 找全部 chain head（不被任何孩子的 previousHash 指向的事件）
    const hasChild = new Set();
    for (const ev of events) if (ev.previousHash) hasChild.add(ev.previousHash);
    const heads = events.filter(ev => !hasChild.has(ev.eventHash || ev.eventId));
    if (heads.length === 0) return false;

    // 3. canonical head 只由 forkRule 决策（snapshot.lastEventHash 不参与！）
    // v0.12.12 (审查 P1): forkRule 必须 fail-closed——未知规则直接拒绝，不 fallback 到 newest
    const forkRule = (task.policy && task.policy.fork) || "publisher";
    if (!KNOWN_FORK_RULES.has(forkRule)) {
      this.persistentHealthy = false;
      this.persistenceError = `task ${id}: unsupported fork rule "${forkRule}" (fail-closed: refuse canonicalization)`;
      return false;
    }
    const sorted = heads.slice().sort((a, b) => {
      if (forkRule === "publisher") {
        const aIsPub = a.actor === task.publisherFingerprint ? 1 : 0;
        const bIsPub = b.actor === task.publisherFingerprint ? 1 : 0;
        if (aIsPub !== bIsPub) return bIsPub - aIsPub;
      } else if (forkRule === "assignee") {
        const aIsAsgn = a.actor === task.assigneeFingerprintActual ? 1 : 0;
        const bIsAsgn = b.actor === task.assigneeFingerprintActual ? 1 : 0;
        if (aIsAsgn !== bIsAsgn) return bIsAsgn - aIsAsgn;
      }
      return (b.ts || 0) - (a.ts || 0) || String(a.eventHash || "").localeCompare(String(b.eventHash || ""));
    });
    const headEv = sorted[0];
    if (!headEv) return false;

    // 4. 回溯主链
    const chain = [];
    let cur = headEv.eventHash || headEv.eventId;
    let guard = 0;
    while (cur && byHash[cur] && guard++ < 10000) {
      chain.unshift(byHash[cur]);
      cur = byHash[cur].previousHash || null;
    }
    if (chain.length === 0) return false;
    const mainHashes = new Set(chain.map(ev => ev.eventHash || ev.eventId));

    // 5. 重建 runtime state（共享 applyEvent 管道）
    const rebuilt = { ...task, status: null, assigneeFingerprintActual: "", result: null, claimedAt: null, completedAt: null, cancelledAt: null, lastEventHash: null, forks: [], eventIndex: {}, eventHeight: 0 };
    let curState = { status: null, assigneeFingerprintActual: "", result: null };
    for (const ev of chain) {
      const h = ev.eventHash || ev.eventId;
      try {
        if (ev.semanticVersion === 2) {
          // genesis（i===0）beforeState 是空 → currentState 也是空，applyEvent 全字段验证
          curState = applyEvent(curState, ev);
        } else if (ev.afterState) {
          // legacy：直接应用声明状态（历史格式，语义自由度保留）
          curState = { status: ev.afterState.status || curState.status, assigneeFingerprintActual: ev.afterState.assigneeFingerprintActual || curState.assigneeFingerprintActual, result: ev.afterState.result ?? curState.result };
        }
      } catch (err) {
        // P0: 日志损坏/语义断裂 → 立即终止，禁止 partial state 写回
        this.persistentHealthy = false;
        this.persistenceError = `event ${ev.eventId} replay failed: ${err.message}`;
        return false;
      }
      rebuilt.status = curState.status; rebuilt.assigneeFingerprintActual = curState.assigneeFingerprintActual; rebuilt.result = curState.result;
      rebuilt.lastEventHash = h; rebuilt.eventHeight++; rebuilt.eventIndex[h] = { eventId: ev.eventId, parentHash: ev.previousHash || null, actor: ev.actor, action: ev.action, ts: ev.ts, height: rebuilt.eventHeight };
      if (ev.action === "claim") rebuilt.claimedAt = ev.ts;
      if (ev.action === "complete") rebuilt.completedAt = ev.ts;
      if (ev.action === "cancel") rebuilt.cancelledAt = ev.ts;
    }
    // 6. eventIndex 全量索引（fork 分支事件也补入；hash 已在第 1 步全部验证过）
    for (const ev of events) {
      const h = ev.eventHash || ev.eventId;
      if (rebuilt.eventIndex[h]) continue;
      const parentMeta = rebuilt.eventIndex[ev.previousHash];
      rebuilt.eventIndex[h] = {
        eventId: ev.eventId,
        parentHash: ev.previousHash ?? null,
        actor: ev.actor,
        action: ev.action,
        ts: ev.ts,
        height: (parentMeta?.height ?? 0) + 1,
      };
    }
    // 7. forks 纯 derived（与运行时同一推导函数）
    rebuilt.forks = deriveForkView(rebuilt.eventIndex, rebuilt.lastEventHash);
    rebuilt.title = task.title; rebuilt.description = task.description;
    rebuilt.publisherFingerprint = task.publisherFingerprint; rebuilt.publisherName = task.publisherName;
    rebuilt.requiredCapabilities = task.requiredCapabilities; rebuilt.policy = task.policy;
    this.tasks.set(id, rebuilt);
    this._saveTasks();
    return true;
  }

  _saveTasks() {
    if (!this._taskFile) return;
    try {
      fs.mkdirSync(path.dirname(this._taskFile), { recursive: true });
      const lines = Array.from(this.tasks.values()).map((t) => JSON.stringify(t)).join("\n") + "\n";
      fs.writeFileSync(this._taskFile, lines, "utf8");
    } catch (err) {
      // v0.12.3: 不再静默——Task 是权威状态，内存成功磁盘失败=重启后任务倒退
      this.persistentHealthy = false;
      this.persistenceError = err?.message || String(err);
    }
  }

  _appendEvent(event) {
    if (!this._eventFile) return;
    try {
      fs.mkdirSync(path.dirname(this._eventFile), { recursive: true });
      fs.appendFileSync(this._eventFile, JSON.stringify(event) + "\n", "utf8");
    } catch (err) {
      this.persistentHealthy = false;
      this.persistenceError = err?.message || String(err);
    }
  }

  /**
   * 记录任务当前状态（本地快照）。
   * @returns {{task: object, duplicate: boolean}}
   */
  upsert(task, event = null, { fork = false } = {}) {
    // v0.12.16 (审查 P0): 语义分离——event !== null 就是一次严格 Event mutation，
    // 不允许 malformed event（缺 eventId/缺 hash）退化成 snapshot-only 写入。
    //   upsert(task, event)  → Event-driven mutation：必须 eventId + integrity gate + 进 Event Log
    //   upsert(task, null)   → snapshot/internal persistence（仅内部合法用途）
    if (event) {
      if (!event.eventId) {
        const err = new Error("task event requires eventId (malformed event cannot fall back to snapshot)");
        err.integrity = true;
        throw err;
      }
      // v0.12.15 (审查 P0): Event Log 是权威存储边界——不依赖调用方是否 validate。
      // V2 事件缺 eventHash / hash 不自洽 → 拒绝写入（与 live/replay/fork 同一 gate）
      const integrity = checkEventIntegrity(event);
      if (!integrity.ok) {
        const err = new Error(`v2 event integrity failed: ${event.eventId} (${integrity.reason})`);
        err.integrity = true;
        throw err;
      }
      // v0.12.9 (审查 P0): eventId/eventHash 一致性约束——内容身份不可被复用篡改。
      //   same eventId + 不同 eventHash → 同一逻辑事件换了内容 = tamper，REJECT。
      //   same eventHash + 不同 eventId → 相同内容重复出现 = duplicate。
      const priorHash = this._eventHashById.get(event.eventId);
      const thisHash = event.eventHash || null;
      if (thisHash && priorHash && priorHash !== thisHash) {
        const err = new Error(`eventId reuse with different content: ${event.eventId} (tamper detected)`);
        err.tamper = true;
        throw err;
      }
      if (this._seenEvents.has(event.eventId)) {
        return { task, duplicate: true };
      }
      if (thisHash && this._seenEventHashes.has(thisHash)) {
        return { task, duplicate: true };
      }
      this._seenEvents.add(event.eventId);
      if (thisHash) {
        this._seenEventHashes.add(thisHash);
        this._eventHashById.set(event.eventId, thisHash);
      }
      this._appendEvent(event);
      if (!this.events.has(task.id)) this.events.set(task.id, []);
      this.events.get(task.id).push(event);
      // eventIndex 总是记录全部已知事件（含 fork——后续链检测依赖完整索引）
      if (!task.eventIndex) task.eventIndex = {};
      const hash = event.eventHash || event.eventId;
      const parentMeta = task.eventIndex[event.previousHash];
      const parentHeight = parentMeta?.height ?? 0;
      task.eventIndex[hash] = {
        eventId: event.eventId,
        parentHash: event.previousHash ?? null,
        actor: event.actor,
        action: event.action,
        ts: event.ts,
        height: parentHeight + 1, // branch height（parent.height+1），不是 canonical count
      };
      if (fork) {
        // v0.12.11 (审查 P0-1): fork 事件进 log+index，但不篡改 canonical head/height/status。
        // v0.12.12 (审查 P1-④): forks 是纯 derived view——事件入库后整体重算，
        // 与 reconcile/_tryRebuildFromEvents 走同一推导函数，不再单独 push。
      } else {
        // canonical 事件：更新 head/height/status
        task.lastEventHash = hash;
        task.eventHeight = (task.eventHeight || 0) + 1;
      }
      // forks 恒为 derived：canonical head 更新后（或 fork 入库后）重算整个视图
      task.forks = deriveForkView(task.eventIndex, task.lastEventHash);
    }
    this.tasks.set(task.id, task);
    this._saveTasks();
    return { task, duplicate: false };
  }

  /** 获取任务 */
  get(id) {
    return this.tasks.get(id);
  }

  /** 全部任务（按创建时间倒序） */
  all() {
    return Array.from(this.tasks.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  }

  /** 开放任务（等待认领） */
  openTasks() {
    return this.all().filter((t) => t.status === TASK_STATUS.OPEN);
  }

  /** 事件历史（某任务） */
  eventHistory(taskId) {
    return this.events.get(taskId) || [];
  }

  /** 我有资格认领的任务 */
  claimableTasks(myCapabilities) {
    return this.openTasks().filter((t) =>
      (t.requiredCapabilities || []).every((c) => myCapabilities.includes(c))
    );
  }

  /**
   * 确定性分叉解决（v0.11.0/v0.12.0）。
   * 候选 = 当前主链头 + 全部 fork 头；按规则选胜者：
   *   publisher 的事件 > 非 publisher；同角色时 ts 最新。
   * 若主链头胜出 → 返回 null（当前即 canonical，无需切换）。
   * @param {string} taskId
   * @returns {object|null} 应接受的 fork head（null = 主链获胜，无需重建）
   */
  resolveFork(taskId) {
    const task = this.tasks.get(taskId);
    if (!task || !task.forks || task.forks.length === 0) return null;

    // 主链头候选：从事件日志查 lastEventHash 对应事件的 actor/ts
    const events = this.events.get(taskId) || [];
    const headEvent = events.find((ev) => (ev.eventHash || ev.eventId) === task.lastEventHash) || null;
    const candidates = [
      ...(task.forks || []),
      ...(headEvent ? [{
        headEventHash: headEvent.eventHash || headEvent.eventId,
        actor: headEvent.actor || task.publisherFingerprint || "",
        ts: headEvent.ts || 0,
        action: headEvent.action || "",
        isMainChain: true,
      }] : []),
    ];
    if (candidates.length === 0) return null;
    const forkRule = (task.policy && task.policy.fork) || "publisher";
    // v0.12.4: fork rule 白名单——未知规则 throw，不静默 reinterpret 成 newest
    if (!KNOWN_FORK_RULES.has(forkRule)) {
      throw new Error(`unsupported fork rule: "${forkRule}" — 必须是 publisher/assignee/newest`);
    }
    candidates.sort((a, b) => {
      if (forkRule === "publisher") {
        const aIsPub = a.actor === task.publisherFingerprint ? 1 : 0;
        const bIsPub = b.actor === task.publisherFingerprint ? 1 : 0;
        if (aIsPub !== bIsPub) return bIsPub - aIsPub;
      } else if (forkRule === "assignee") {
        const aIsAsgn = a.actor === task.assigneeFingerprintActual ? 1 : 0;
        const bIsAsgn = b.actor === task.assigneeFingerprintActual ? 1 : 0;
        if (aIsAsgn !== bIsAsgn) return bIsAsgn - aIsAsgn;
      }
      // newest 或默认按时间戳降序；v0.12.3: ts 相同时用 eventHash lexical 打破平局（确定性 canonicalization）
      if (a.ts !== b.ts) return b.ts - a.ts;
      return String(a.headEventHash || "").localeCompare(String(b.headEventHash || ""));
    });
    const winner = candidates[0];
    // 主链胜出 → 无需切换
    if (!winner || winner.isMainChain) return null;
    return winner;
  }

  /**
   * 从 fork 重建任务状态（v0.12.0）。
   * 步骤：resolveFork → 沿获胜分支从 genesis 重放事件 → 重建 status/assignee/result/lastEventHash。
   * 不修改当前任务——返回新状态对象。
   * @param {string} taskId
   * @returns {object|null} 重建后的任务状态，或 null（无 fork 或无变化）
   */
  canonicalizeTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    const winner = this.resolveFork(taskId);
    if (!winner) return null; // 无 fork 或主链即 canonical

    const events = this.events.get(taskId) || [];
    if (events.length === 0) return null;

    // 构建 eventHash → event 映射
    const byHash = {};
    for (const ev of events) {
      const h = ev.eventHash || ev.eventId;
      byHash[h] = ev;
    }

    // 从 winner 的 headEventHash 沿 previousHash 向 genesis 回溯，收集链
    const chain = [];
    let cur = winner.headEventHash;
    while (cur && byHash[cur]) {
      chain.unshift(byHash[cur]); // 逆序（genesis 在前）
      const ev = byHash[cur];
      // v0.12.4 (审查 P1-④): replay 阶段重新验证 eventHash 自洽——
      // v0.12.15 (审查 P0): 与 live/upsert/_tryRebuildFromEvents 共用同一 integrity gate
      const integrity = checkEventIntegrity(ev);
      if (!integrity.ok) {
        throw new Error(`canonicalizeTask: event ${ev.eventId} ${integrity.reason}`);
      }
      cur = ev.previousHash || null;
    }
    if (chain.length === 0) return null;

    // 从 genesis 向前重放，用 deriveNextState 推导期望状态（不信任事件声明）
    // 兼容无 payload.state 的旧事件（fallback 到 event.status）
    const reconstructed = {
      ...task,
      status: TASK_STATUS.OPEN,
      assigneeFingerprintActual: "",
      result: null,
      claimedAt: null,
      completedAt: null,
      cancelledAt: null,
      lastEventHash: null,
      forks: [],
      eventHashes: [],   // 兼容旧字段（保留读取，新写入走 eventIndex）
      eventIndex: {},
    };
    // v0.12.6: 重放时跟踪当前 canonical 状态，对每个事件：
    //   1. 连续性检查：event.beforeState === 当前 canonical（全字段 stateHash）
    //   2. deriveNextState() 推导期望状态
    //   3. 验证：期望状态 === event.afterState（不信任声明）
    //   4. 应用：期望状态（不是 afterState）
    let currentState = { status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null };
    for (let i = 0; i < chain.length; i++) {
      const ev = chain[i];
      // v0.12.4 (审查 P1-④): replay 阶段重新验证 eventHash 自洽
      // v0.12.15 (审查 P0): 与 live/upsert/_tryRebuildFromEvents 共用同一 integrity gate
      const integrity = checkEventIntegrity(ev);
      if (!integrity.ok) {
        throw new Error(`canonicalizeTask: event ${ev.eventId} ${integrity.reason}`);
      }
      if (i > 0) {
        // 连续性检查：全字段比较（v0.12.6，不再只比 status）
        const curBefore = ev.beforeState || ev.payload?.state || null;
        if (curBefore) {
          const curState = { status: currentState.status, assigneeFingerprintActual: currentState.assigneeFingerprintActual || "", result: currentState.result ?? null };
          const curSimple = { status: curBefore.status, assigneeFingerprintActual: curBefore.assigneeFingerprintActual || "", result: curBefore.result ?? null };
          if (curState.status !== curSimple.status || curState.assigneeFingerprintActual !== curSimple.assigneeFingerprintActual || (curState.result ?? null) !== (curSimple.result ?? null)) {
            // 允许 3-arg 兼容：beforeState === afterState 时跳过连续检查
            const evBefore = ev.beforeState;
            const evAfter = ev.afterState;
            if (!evBefore || !evAfter || evBefore.status !== evAfter.status || evBefore.assigneeFingerprintActual !== evAfter.assigneeFingerprintActual) {
              throw new Error(`canonicalizeTask: chain state discontinuity at ${ev.eventId} (current=${JSON.stringify(curState)}, before=${JSON.stringify(curSimple)})`);
            }
          }
        }
      }
      // 用 deriveNextState 推导期望状态（v0.12.6/v0.12.7）
      if (ev.beforeState && ev.afterState && ev.action) {
        // v0.12.7: 用 semanticVersion 判断 legacy（不再用 before≠after）。
        //   semanticVersion===2 → v2 无条件验证（含 no-op）
        //   semanticVersion===1 → legacy 直接应用
        //   缺失（旧磁盘事件）→ 启发式：before===after 视为 legacy
        const noExplicitVersion = ev.semanticVersion === undefined || ev.semanticVersion === null;
        const heuristicLegacy = noExplicitVersion && ev.beforeState.status === ev.afterState.status && ev.beforeState.assigneeFingerprintActual === ev.afterState.assigneeFingerprintActual;
        const isLegacyEv = ev.semanticVersion === 1 || heuristicLegacy;
        if (isLegacyEv) {
          // 3-arg 兼容（beforeState===afterState 或 semanticVersion=1）：直接应用 afterState
          const state = ev.afterState || ev.payload?.state || {};
          if (i === 0) {
            currentState = { status: state.status || TASK_STATUS.OPEN, assigneeFingerprintActual: state.assigneeFingerprintActual || "", result: state.result ?? null };
          } else {
            currentState.status = state.status || ev.status || currentState.status;
            if (state.assigneeFingerprintActual) currentState.assigneeFingerprintActual = state.assigneeFingerprintActual;
            if (state.result !== undefined && state.result !== null) currentState.result = state.result;
          }
        } else {
          // v2 事件（4-arg 显式转移）：用 deriveNextState 推导，不信任声明
          // genesis（i===0）也走 deriveNextState——null→publish→open 是合法转移
          try {
            const beforeState = i === 0 ? { status: null, assigneeFingerprintActual: "", result: null } : currentState;
            const expected = deriveNextState(beforeState, ev.action, ev.actor, ev.payload);
            // 验证后状态与声明的 afterState 一致
            const after = ev.afterState;
            if (after.status !== expected.status) throw new Error(`afterState.status mismatch: declared=${after.status}, expected=${expected.status}`);
            if ((after.assigneeFingerprintActual || "") !== (expected.assigneeFingerprintActual || "")) throw new Error(`afterState.assignee mismatch: declared=${after.assigneeFingerprintActual || ""}, expected=${expected.assigneeFingerprintActual || ""}`);
            if (actionHasResult(ev.action) && (after.result ?? null) !== (expected.result ?? null)) throw new Error(`afterState.result mismatch: declared=${after.result ?? null}, expected=${expected.result ?? null}`);
            // 应用推导的状态（不是 afterState）
            currentState = { status: expected.status, assigneeFingerprintActual: expected.assigneeFingerprintActual || "", result: expected.result ?? null };
          } catch (err) {
            throw new Error(`canonicalizeTask: illegal state transition at ${ev.eventId}: ${err.message}`);
          }
        }
      } else {
        // 极旧事件（无 beforeState/afterState）：fallback
        const state = ev.payload?.state || {};
        currentState.status = state.status || ev.status || currentState.status;
        if (state.assigneeFingerprintActual) currentState.assigneeFingerprintActual = state.assigneeFingerprintActual;
        if (state.result !== undefined && state.result !== null) currentState.result = state.result;
      }
      reconstructed.status = currentState.status;
      reconstructed.assigneeFingerprintActual = currentState.assigneeFingerprintActual;
      reconstructed.result = currentState.result;
      reconstructed.lastEventHash = ev.eventHash || ev.eventId;
      reconstructed.eventHeight = (reconstructed.eventHeight || 0) + 1;
      reconstructed.eventIndex[reconstructed.lastEventHash] = {
        eventId: ev.eventId,
        parentHash: ev.previousHash || null,
        actor: ev.actor,
        action: ev.action,
        ts: ev.ts,
        height: reconstructed.eventHeight,
      };
      if (ev.action === "claim") reconstructed.claimedAt = ev.ts;
      if (ev.action === "complete") reconstructed.completedAt = ev.ts;
      if (ev.action === "cancel") reconstructed.cancelledAt = ev.ts;
    }
    return reconstructed;
  }

  /**
   * 应用 canonical 状态（v0.12.1/v0.12.2）。
   * 审查指出的问题：canonicalizeTask 只算新状态不写回。
   * 此方法负责：resolveFork → canonicalizeTask → 若状态不同则 upsert 写回。
   * v0.12.2: 判等改用 canonicalTaskStateHash（不再人工挑 lastEventHash/status 两个字段）。
   * @param {string} taskId
   * @returns {object|null} 应用后的 canonical 状态，或 null（无需变更）
   */
  applyCanonicalState(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const canon = this.canonicalizeTask(taskId);
    if (!canon) return null; // 无 fork 或主链即 canonical
    // v0.12.2: 状态哈希判等（覆盖 status/assignee/result/timestamps/lastEventHash 全部字段）
    if (canonicalTaskStateHash(canon) === canonicalTaskStateHash(task)) return null;
    // 写回
    this.upsert(canon);
    return canon;
  }
}
