/**
 * world.js — World Model 世界模型 (v0.11.0)
 *
 * 审查判断："在 Goal 之前，应该先做 World Model。"
 * 现在的链是 Memory → Self，缺的是"世界是什么"。
 *
 * World Model 回答：
 *   谁是谁？（Agents / Entities）
 *   哪些知识是真的？（Facts + Confidence）
 *   哪些事情正在发生？（Events）
 *   它们之间什么关系？（Relationships）
 *   我对这些事情有多大把握？（Beliefs / Uncertainty）
 *
 * 架构位置：
 *   Memory ──证据──▶ World Model ──▶ Self Model ──▶ Goals ──▶ Planner
 *
 * 持久化：JSONL（与 Memory 同构，便于未来换 SQLite）。
 * 本模块只做"世界的事实层"——不含目标、不含行动。那是下一层的事。
 */
import fs from "node:fs";
import path from "node:path";

/**
 * WorldModel 类。
 * @param {string} [storageDir] 持久化目录（可选）
 */
export class WorldModel {
  constructor(storageDir = null) {
    this.storageDir = storageDir;
    this.file = storageDir ? path.join(storageDir, "world", "world.jsonl") : null;
    this.entities = new Map();   // id -> {id, type, name, firstSeen, lastSeen, meta}
    this.agents = new Map();     // id -> {id, fingerprint, name, capabilities[], trustHint, firstSeen}
    this.facts = new Map();      // id -> {id, subject, predicate, object, confidence, source, ts, lastSeen}
    this.events = [];            // 最近事件环形缓冲（上限 1000）
    this.relations = [];         // {from, type, to, ts}
    this._eventCap = 1000;
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const text = fs.readFileSync(this.file, "utf8");
      for (const line of text.trim().split("\n").filter(Boolean)) {
        const rec = JSON.parse(line);
        if (rec.kind === "entity") this.entities.set(rec.id, rec.data);
        else if (rec.kind === "agent") this.agents.set(rec.id, rec.data);
        else if (rec.kind === "fact") this.facts.set(rec.id, rec.data);
        else if (rec.kind === "event") this.events.push(rec.data);
      }
    } catch { /* 首次运行 */ }
  }

  _append(rec) {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, JSON.stringify(rec) + "\n", "utf8");
    } catch { /* 持久化失败不致命 */ }
  }

  _save() {
    // 简单方案：全量重写（world 数据量远小于 memory 事件流）
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const lines = [];
      for (const e of this.entities.values()) lines.push(JSON.stringify({ kind: "entity", id: e.id, data: e }));
      for (const a of this.agents.values()) lines.push(JSON.stringify({ kind: "agent", id: a.id, data: a }));
      for (const f of this.facts.values()) lines.push(JSON.stringify({ kind: "fact", id: f.id, data: f }));
      for (const ev of this.events) lines.push(JSON.stringify({ kind: "event", data: ev }));
      fs.writeFileSync(this.file, lines.join("\n") + "\n", "utf8");
    } catch { /* 持久化失败不致命 */ }
  }

  /** 记录一个实体（人/设备/组织/抽象对象） */
  observeEntity(id, type, name, meta = {}) {
    const now = Date.now();
    const existing = this.entities.get(id);
    if (existing) {
      existing.lastSeen = now;
      existing.name = name || existing.name;
      existing.meta = { ...existing.meta, ...meta };
      return existing;
    }
    const entity = { id, type, name, meta, firstSeen: now, lastSeen: now };
    this.entities.set(id, entity);
    this._append({ kind: "entity", id, data: entity });
    this._eventCap && this._pushEvent({ kind: "entity_seen", id, type, ts: now });
    return entity;
  }

  /** 记录一个 Agent 节点 */
  observeAgent(fingerprint, name, capabilities = [], trustHint = "learned") {
    const now = Date.now();
    const existing = this.agents.get(fingerprint);
    if (existing) {
      existing.lastSeen = now;
      existing.name = name || existing.name;
      if (capabilities.length) existing.capabilities = Array.from(new Set([...(existing.capabilities || []), ...capabilities]));
      return existing;
    }
    const agent = { id: fingerprint, fingerprint, name, capabilities, trustHint, firstSeen: now, lastSeen: now };
    this.agents.set(fingerprint, agent);
    this._append({ kind: "agent", id: fingerprint, data: agent });
    this._pushEvent({ kind: "agent_observed", fingerprint, name, ts: now });
    return agent;
  }

  /**
   * 记录一个事实（带置信度）。
   * @param {string} subject 主语（实体/agent id）
   * @param {string} predicate 谓词（如 "capable_of" / "located_at"）
   * @param {string} object 宾语
   * @param {object} [opts]
   * @param {number} [opts.confidence] 0-1（默认 0.5——不确定就该说不确定）
   * @param {string} [opts.source] 来源（fingerprint / "self" / "registry"）
   */
  assertFact(subject, predicate, object, { confidence = 0.5, source = "unknown" } = {}) {
    const id = `${subject}|${predicate}|${object}`;
    const now = Date.now();
    const existing = this.facts.get(id);
    if (existing) {
      // 事实更新：置信度按新证据调整（简单平均，未来可做贝叶斯）
      existing.confidence = Math.round((existing.confidence + confidence) / 2 * 100) / 100;
      existing.source = source;
      existing.lastSeen = now;
      return existing;
    }
    const fact = { id, subject, predicate, object, confidence, source, ts: now, lastSeen: now };
    this.facts.set(id, fact);
    this._append({ kind: "fact", id, data: fact });
    this._pushEvent({ kind: "fact_asserted", id, subject, predicate, object, confidence, ts: now });
    return fact;
  }

  /** 撤销一个事实（如发现错误） */
  retractFact(id) {
    if (this.facts.delete(id)) {
      this._pushEvent({ kind: "fact_retracted", id, ts: Date.now() });
      this._save();
      return true;
    }
    return false;
  }

  /** 查询事实 */
  queryFacts(subject = null, predicate = null) {
    return Array.from(this.facts.values()).filter((f) =>
      (subject === null || f.subject === subject) &&
      (predicate === null || f.predicate === predicate)
    );
  }

  /** 查询对某 agent/entity 的信念（按置信度排序） */
  beliefsAbout(subject) {
    return this.queryFacts(subject).sort((a, b) => b.confidence - a.confidence);
  }

  /** 记录一个关系 */
  addRelation(from, type, to) {
    const rel = { from, type, to, ts: Date.now() };
    this.relations.push(rel);
    if (this.relations.length > this._eventCap) this.relations.splice(0, this.relations.length - this._eventCap);
    this._pushEvent({ kind: "relation_added", from, type, to, ts: rel.ts });
    return rel;
  }

  /** 按关系类型查询 */
  queryRelations(type = null, from = null) {
    return this.relations.filter((r) =>
      (type === null || r.type === type) && (from === null || r.from === from)
    );
  }

  _pushEvent(ev) {
    this.events.push(ev);
    if (this.events.length > this._eventCap) this.events.splice(0, this.events.length - this._eventCap);
    this._save(); // 事件较少时全量保存可接受；量大后改为追加
  }

  /** 最近事件 */
  recentEvents(limit = 50) {
    return this.events.slice(-limit).reverse();
  }

  /** 统计摘要 */
  stats() {
    return {
      entities: this.entities.size,
      agents: this.agents.size,
      facts: this.facts.size,
      events: this.events.length,
      relations: this.relations.length,
    };
  }
}
