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
 * 规范化事件（签名覆盖的字段，固定键序）。
 * 注意：signature 与 eventHash 都不参与规范化（eventHash 是 canonical 的哈希）。
 */
function canonicalizeEvent(ev) {
  return JSON.stringify({
    eventId: ev.eventId,
    taskId: ev.taskId,
    action: ev.action,
    actor: ev.actor,
    previousHash: ev.previousHash ?? null,
    ts: ev.ts,
    nonce: ev.nonce,
    status: ev.status,
    payload: ev.payload || null,
  });
}

/** 计算事件的防篡改哈希（v0.10.1: 真哈希，不再是 eventId） */
function hashEvent(ev) {
  return crypto.createHash("sha256").update(canonicalizeEvent(ev)).digest("hex");
}

/** 生成唯一 ID */
function genId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 创建一个任务对象（初始 OPEN 状态）。
 */
export function createTask({ title, description = "", requiredCapabilities = [], assigneeFingerprint = "", meta = {} }) {
  if (!title) throw new Error("task title is required");
  return {
    id: genId("task"),
    title,
    description,
    requiredCapabilities,
    assigneeFingerprint,
    meta,
    status: TASK_STATUS.OPEN,
    publisherFingerprint: "",
    publisherName: "",
    assigneeFingerprintActual: "",
    result: null,
    createdAt: Date.now(),
    claimedAt: null,
    completedAt: null,
    cancelledAt: null,
    lastEventHash: null, // v0.10.0: 状态链尾
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
export function createTaskEvent(identity, action, task) {
  const event = {
    eventId: genId("evt"),
    taskId: task.id,
    action,
    actor: identity.fingerprint,
    previousHash: task.lastEventHash || null, // v0.10.1: 真哈希链
    ts: Date.now(),
    nonce: crypto.randomBytes(8).toString("hex"),
    status: task.status,
    payload: null,
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
export function validateTaskEvent(event, action, task, trustedStore, { hasLocalRecord = true } = {}) {
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
  if (event.eventHash && event.eventHash !== hashEvent(event)) {
    return { ok: false, reason: "eventHash mismatch (event content tampered)" };
  }

  // 3. 状态链连续（真哈希链；仅本地有记录时校验；首见靠签名广播引导信任）
  if (hasLocalRecord && event.previousHash !== (task.lastEventHash || null)) {
    return { ok: false, reason: "event chain broken (previousHash mismatch)" };
  }

  return { ok: true };
}

/**
 * 检查状态转移合法性（基于当前状态 × action × actor 规则）。
 * @param {object} task 当前任务
 * @param {string} action 请求的动作
 * @param {string} actorFingerprint 动作发起者
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkTransition(task, action, actorFingerprint) {
  const allowed = TRANSITIONS[task.status]?.[action];
  if (!allowed) {
    return { ok: false, reason: `illegal transition: ${task.status} → ${action}` };
  }
  if (allowed.actorMustBe === "publisher" && actorFingerprint !== task.publisherFingerprint) {
    return { ok: false, reason: "only the publisher can perform this action" };
  }
  if (allowed.actorMustBe === "assignee" && actorFingerprint !== task.assigneeFingerprintActual) {
    return { ok: false, reason: "only the current assignee can perform this action" };
  }
  return { ok: true };
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
    this._taskFile = storageDir ? path.join(storageDir, "tasks", "tasks.jsonl") : null;
    this._eventFile = storageDir ? path.join(storageDir, "tasks", "events.jsonl") : null;
    this._load();
  }

  _load() {
    if (!this._taskFile) return;
    try {
      fs.mkdirSync(path.dirname(this._taskFile), { recursive: true });
      const text = fs.readFileSync(this._taskFile, "utf8");
      for (const line of text.trim().split("\n").filter(Boolean)) {
        const t = JSON.parse(line);
        this.tasks.set(t.id, t);
      }
    } catch { /* 首次运行 */ }
    try {
      if (this._eventFile) {
        const text = fs.readFileSync(this._eventFile, "utf8");
        for (const line of text.trim().split("\n").filter(Boolean)) {
          const ev = JSON.parse(line);
          if (ev.eventId) this._seenEvents.add(ev.eventId);
          if (ev.taskId) {
            if (!this.events.has(ev.taskId)) this.events.set(ev.taskId, []);
            this.events.get(ev.taskId).push(ev);
          }
        }
      }
    } catch { /* 首次运行 */ }
  }

  _saveTasks() {
    if (!this._taskFile) return;
    try {
      fs.mkdirSync(path.dirname(this._taskFile), { recursive: true });
      const lines = Array.from(this.tasks.values()).map((t) => JSON.stringify(t)).join("\n") + "\n";
      fs.writeFileSync(this._taskFile, lines, "utf8");
    } catch { /* 持久化失败不致命 */ }
  }

  _appendEvent(event) {
    if (!this._eventFile) return;
    try {
      fs.mkdirSync(path.dirname(this._eventFile), { recursive: true });
      fs.appendFileSync(this._eventFile, JSON.stringify(event) + "\n", "utf8");
    } catch { /* 持久化失败不致命 */ }
  }

  /**
   * 记录任务当前状态（本地快照）。
   * @returns {{task: object, duplicate: boolean}}
   */
  upsert(task, event = null) {
    if (event && event.eventId) {
      if (this._seenEvents.has(event.eventId)) return { task, duplicate: true };
      this._seenEvents.add(event.eventId);
      this._appendEvent(event);
      if (!this.events.has(task.id)) this.events.set(task.id, []);
      this.events.get(task.id).push(event);
      task.lastEventHash = event.eventHash || event.eventId; // v0.10.1: 真哈希链尾
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
}
