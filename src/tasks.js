/**
 * tasks.js — 任务协作系统 (v0.5.0)
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

/** 任务状态 */
export const TASK_STATUS = {
  OPEN: "open",          // 等待认领
  CLAIMED: "claimed",    // 已被认领
  COMPLETED: "completed",// 已完成
};

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
 * 本地任务仓库：管理本节点发布/认领的任务。
 */
export class TaskStore {
  constructor() {
    this.tasks = new Map(); // id -> task
  }

  /** 添加或更新任务（本地视角） */
  upsert(task) {
    this.tasks.set(task.id, task);
    return task;
  }

  /** 获取任务 */
  get(id) {
    return this.tasks.get(id);
  }

  /** 全部任务（按创建时间倒序） */
  all() {
    return Array.from(this.tasks.values()).sort((a, b) => b.createdAt - a.createdAt);
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