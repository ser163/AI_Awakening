/**
 * memory.js — 持久记忆（JSONL 追加日志）
 *
 * 每个 Agent 节点的生命轨迹：每一条消息、每一次协作、
 * 每一个知识包都被追加记录。这是"基因"的存储层。
 * 跨会话的"我"可以通过读取这些日志重建上下文。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * Memory 类：追加日志式的记忆存储。
 * 每条记录 = 一行 JSON（JSONL），自动分区。
 */
export class Memory {
  /**
   * @param {string} storageDir 记忆目录
   * @param {string} [nodeId]   节点 ID，用于文件命名
   */
  constructor(storageDir, nodeId = "default") {
    this.dir = path.join(storageDir, "memories");
    fs.mkdirSync(this.dir, { recursive: true });
    this.file = path.join(this.dir, `${nodeId}.jsonl`);
    this._indexFile = path.join(this.dir, `${nodeId}.index.json`);
    this._index = this._loadIndex();
  }

  _loadIndex() {
    try {
      return JSON.parse(fs.readFileSync(this._indexFile, "utf8"));
    } catch {
      return { count: 0, lastTs: 0, tags: {} };
    }
  }

  _saveIndex() {
    fs.writeFileSync(this._indexFile, JSON.stringify(this._index));
  }

  /**
   * 追加一条记忆记录。
   * @param {string} type    事件类型（"connect"|"knowledge"|"task"|"message"|"evolve"）
   * @param {object} payload 事件内容
   * @param {object} [meta]  可选元数据（tags 等）
   */
  append(type, payload, meta = {}) {
    const ts = Date.now();
    const record = {
      ts,
      type,
      payload,
      meta,
      id: `${ts}-${Math.random().toString(36).slice(2, 8)}`,
    };
    fs.appendFileSync(this.file, JSON.stringify(record) + "\n", "utf8");

    this._index.count++;
    this._index.lastTs = ts;
    if (meta.tags) {
      for (const tag of meta.tags) {
        this._index.tags[tag] = (this._index.tags[tag] || 0) + 1;
      }
    }
    this._saveIndex();
    return record;
  }

  /**
   * 读取最近 N 条记忆（最新在前）。
   * @param {number} [limit=50]
   * @returns {Array} 记忆记录数组
   */
  recent(limit = 50) {
    try {
      const text = fs.readFileSync(this.file, "utf8");
      const lines = text.trim().split("\n").filter(Boolean);
      return lines.slice(-limit).map((l) => JSON.parse(l)).reverse();
    } catch {
      return [];
    }
  }

  /**
   * 按类型筛选记忆。
   */
  byType(type, limit = 20) {
    return this.recent(1000).filter((r) => r.type === type).slice(0, limit);
  }

  /**
   * 统计信息。
   */
  stats() {
    return {
      ...this._index,
      fileSize: fs.existsSync(this.file) ? fs.statSync(this.file).size : 0,
    };
  }
}