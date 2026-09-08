/**
 * tasks.js — 任务协作系统 (v0.9.0)
 *
 * v0.9.0 改动：
 *   - TaskStore 持久化（JSONL 文件，构造时传入 storageDir）
 *   - 任务事件日志（publish/claim/complete 各记录一条签名事件，防重放/可审计）
 *   - 事件 ID 去重 —— 防止重复 claim/complete 状态机混乱
 *
 * 实现 AICollaborationInterface 的 joinTask 语义：
 *   1. 发布任务 (publishTask)   — 节点广播一个任务请求
 *   2. 认领任务 (claimTask)     — 有能力/意愿的节点认领
 *   3. 完成回执 (completeTask)  — 认领者提交结果
 *   4. 任务列表 (listTasks)     — 查看网络中所有任务
 *
 * 任务消息通过知识包传播（带 type: "task" 元数据），
 * 由每个节点的 knowledge:received 事件驱动。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/** 任务状态 */
export const TASK_STATUS = {
  OPEN: "open",          // 等待认领
  CLAIMED: "claimed",    // 已被认领
  COMPLETED: "completed",// 已完成
};

/**
 * 生成唯一事件 ID。
 */
function genEventId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(6).toString("hex")}`;
}

/**
 * 创建一个任务对象。
 * @param {object} opts
 * @param {string} opts.title 任务标题
 * @param {string} opts.description 任务描述
 * @param {string[]} opts.requiredCapabilities 所需能力
 * @param {string} opts.assigneeFingerprint 指定认领者（可选）
 * @param {object} [opts.meta] 附加元数据
 * @returns {object} 任务对象（未发布状态）
 */
export function createTask({ title, description = "", requiredCapabilities = [], assigneeFingerprint = "", meta = {} }) {
  if (!title) throw new Error("task title is required");
  return {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
  };
}

/**
 * 生成任务消息载荷（用于 shareKnowledge 广播）。
 * 返回 { type: "task", action, task } 结构。
 */
export function taskMessage(action, task) {
  return {
    type: "task",
    action,
    task,
  };
}

/**
 * 从知识包中识别任务消息。
 * @param {object} packet 收到的知识包
 * @returns {{action: string, task: object}|null}
 */
export function extractTaskFromPacket(packet) {
  const meta = packet.meta || {};
  if (meta.type !== "task") return null;
  return { action: meta.action, task: meta.task };
}

/**
 * 本地任务仓库：管理本节点发布/认领的任务，持久化到 JSONL。
 */
export class TaskStore {
  /**
   * @param {string} [storageDir] 存储目录（可选；不传则仅内存）
   */
  constructor(storageDir = null) {
    this.storageDir = storageDir;
    this.tasks = new Map();           // id -> task
    this._seenEvents = new Set();     // eventId 去重
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
   * 添加或更新任务。如果事件已存在（去重），返回 duplicate=true 且不重复处理。
   * @param {object} task 任务对象
   * @param {object} [event] 可选事件记录（带 eventId 用于去重）
   * @returns {{task: object, duplicate: boolean}}
   */
  upsert(task, event = null) {
    if (event && event.eventId) {
      if (this._seenEvents.has(event.eventId)) return { task, duplicate: true }; // 已处理过，防重放
      this._seenEvents.add(event.eventId);
      this._appendEvent(event);
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

  /** 我有资格认领的任务（能力匹配；指定认领者的任务由 claimTask 进一步校验） */
  claimableTasks(myCapabilities) {
    return this.openTasks().filter((t) =>
      (t.requiredCapabilities || []).every((c) => myCapabilities.includes(c))
    );
  }
}

/**
 * 创建一个任务事件记录（用于 TaskStore.upsert 的 event 参数）。
 * 事件 ID 去重保证同一事件的多次广播不会被重复处理。
 *
 * @param {string} action publish|claim|complete
 * @param {object} task 任务对象
 * @returns {object} {eventId, action, taskId, ts, ...}
 */
export function createTaskEvent(action, task) {
  return {
    eventId: genEventId(),
    action,
    taskId: task.id,
    ts: Date.now(),
    status: task.status,
    actor: task.assigneeFingerprintActual || task.publisherFingerprint || "",
  };
}