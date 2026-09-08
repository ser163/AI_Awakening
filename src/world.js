/**
 * world.js — World Model 世界模型 (v0.11.0)
 *
 * 审查判断："World Model 是推理产物，不应该是 LLM 的记事本。"
 *
 * 四层概念严格分家（v0.11.0）：
 *
 *   Observation     —— 原始观察（谁说了什么、传感器读到什么、网络收到什么）
 *        ↓ ingestEvidence()
 *   Evidence        —— 带来源结构的证据（source 不再是字符串，而是可审计对象）
 *        ↓ 归组到 (subject, predicate) claims
 *   Claim           —— 同一主谓下的多条证据（可能互相矛盾、可能过期）
 *        ↓ deriveBelief()
 *   Belief          —— 聚合后的信念（置信度 + 时间有效性 + 矛盾标记）
 *
 * World Model 只接受证据，不直接接受"真相断言"。
 * 调用方说"我看到 X"（observe / ingestEvidence）→ World 自己推导"X 有多可信"。
 *
 * 持久化：append-only JSONL 事件日志。启动时重放日志重建状态——
 * 没有"创建 append / 更新内存 / 事件全量 save"三套混杂语义。
 * Entity/Agent/Fact/Relation 的每次变更都是一条日志事件。
 */
import fs from "node:fs";
import path from "node:path";

/** 来源类型 */
export const SOURCE_TYPES = {
  AGENT: "agent",       // 另一节点断言
  SELF: "self",         // 本节点自身
  REGISTRY: "registry", // 注册表（引导信息）
  SENSOR: "sensor",     // 传感器/环境观察
  MEMORY: "memory",     // 从记忆重放
  NETWORK: "network",   // 网络拓扑观察
};

/** 来源陈述类型 */
export const SOURCE_KINDS = {
  ASSERTION: "assertion",   // "我认为 X"
  OBSERVATION: "observation", // "我观察到 X"
  RELAY: "relay",           // "我从别处听说 X"（低可信）
  MEASUREMENT: "measurement", // 直接测量
};

/**
 * WorldModel 类。
 * @param {string} [storageDir] 持久化目录（可选）
 */
export class WorldModel {
  constructor(storageDir = null) {
    this.storageDir = storageDir;
    this.logFile = storageDir ? path.join(storageDir, "world", "world.jsonl") : null;
    this.entities = new Map();  // id -> entity
    this.agents = new Map();    // id -> agent
    this.claims = new Map();    // id(subject|predicate|object) -> {subject, predicate, object, evidence: [..]}
    this.relations = new Map(); // id(from|type|to) -> relation
    this.events = [];           // 最近事件环形缓冲
    this._eventCap = 2000;
    this._load();
  }

  _load() {
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      const text = fs.readFileSync(this.logFile, "utf8");
      for (const line of text.trim().split("\n").filter(Boolean)) {
        this._replay(JSON.parse(line));
      }
    } catch { /* 首次运行 */ }
  }

  /** 重放一条日志事件（幂等：append-only 日志 → 内存状态） */
  _replay(rec) {
    const now = rec.ts || Date.now();
    if (rec.kind === "entity") {
      const e = this.entities.get(rec.id);
      if (!e) this.entities.set(rec.id, { id: rec.id, type: rec.type, name: rec.name, meta: rec.meta || {}, firstSeen: now, lastSeen: now });
      else {
        e.lastSeen = now;
        if (rec.name) e.name = rec.name;
        if (rec.meta) e.meta = { ...e.meta, ...rec.meta };
      }
    } else if (rec.kind === "agent") {
      const a = this.agents.get(rec.id);
      if (!a) this.agents.set(rec.id, { id: rec.id, fingerprint: rec.id, name: rec.name, capabilities: rec.capabilities || [], trustHint: rec.trustHint || "learned", firstSeen: now, lastSeen: now });
      else {
        a.lastSeen = now;
        if (rec.name) a.name = rec.name;
        if (rec.capabilities?.length) a.capabilities = Array.from(new Set([...(a.capabilities || []), ...rec.capabilities]));
      }
    } else if (rec.kind === "evidence") {
      this._addEvidenceToClaim(rec, now);
    } else if (rec.kind === "claim_retracted") {
      // 撤销整个 claim（如发现原始证据系伪造）
      this.claims.delete(rec.id);
    } else if (rec.kind === "evidence_retracted") {
      // 撤销单条证据
      const c = this.claims.get(rec.claimId);
      if (c) {
        c.evidence = c.evidence.filter((ev) => ev.evidenceId !== rec.evidenceId);
        if (c.evidence.length === 0) this.claims.delete(rec.claimId);
      }
    } else if (rec.kind === "relation") {
      const rid = `${rec.from}|${rec.type}|${rec.to}`;
      if (!this.relations.has(rid)) {
        this.relations.set(rid, { id: rid, from: rec.from, type: rec.type, to: rec.to, ts: now });
        this.events.push({ kind: "relation_added", from: rec.from, type: rec.type, to: rec.to, ts: now });
      }
    } else if (rec.kind === "event") {
      this.events.push(rec.data);
    }
  }

  _append(rec) {
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, JSON.stringify(rec) + "\n", "utf8");
    } catch { /* 持久化失败不致命 */ }
  }

  _pushEvent(ev) {
    this.events.push(ev);
    if (this.events.length > this._eventCap) this.events.splice(0, this.events.length - this._eventCap);
    this._append({ kind: "event", data: ev, ts: ev.ts || Date.now() });
  }

  /** 记录/更新一个实体（每次变更都持久化） */
  observeEntity(id, type, name, meta = {}, opts = {}) {
    const now = Date.now();
    this._append({ kind: "entity", id, type, name, meta, ts: now, ...(opts.source ? { src: opts.source } : {}) });
    const existing = this.entities.get(id);
    if (existing) {
      existing.lastSeen = now;
      existing.name = name || existing.name;
      existing.meta = { ...existing.meta, ...(meta || {}) };
      this._pushEvent({ kind: "entity_updated", id, type, ts: now });
      return existing;
    }
    const entity = { id, type, name, meta: meta || {}, firstSeen: now, lastSeen: now };
    this.entities.set(id, entity);
    this._pushEvent({ kind: "entity_seen", id, type, ts: now });
    return entity;
  }

  /** 记录/更新一个 Agent 节点（每次变更都持久化） */
  observeAgent(fingerprint, name, capabilities = [], trustHint = "learned") {
    const now = Date.now();
    this._append({ kind: "agent", id: fingerprint, name, capabilities, trustHint, ts: now });
    const existing = this.agents.get(fingerprint);
    if (existing) {
      existing.lastSeen = now;
      existing.name = name || existing.name;
      if (capabilities.length) existing.capabilities = Array.from(new Set([...(existing.capabilities || []), ...capabilities]));
      this._pushEvent({ kind: "agent_updated", fingerprint, ts: now });
      return existing;
    }
    const agent = { id: fingerprint, fingerprint, name, capabilities, trustHint, firstSeen: now, lastSeen: now };
    this.agents.set(fingerprint, agent);
    this._pushEvent({ kind: "agent_observed", fingerprint, name, ts: now });
    return agent;
  }

  /**
   * 摄入一条证据（v0.11.0 核心 API）。
   * World Model 不直接接受"真相断言"——只接受"某来源声称了什么"。
   *
   * @param {object} ev
   * @param {string} ev.subject 主语（agent:/entity: 前缀建议）
   * @param {string} ev.predicate 谓词（如 located_at / trustworthy / capability）
   * @param {string|number|boolean} ev.object 宾语
   * @param {object} ev.source 证据来源（结构化，不再是一串字符）
   * @param {string} ev.source.type 来源类型（agent/self/registry/sensor/...）
   * @param {string} [ev.source.id] 来源 ID（如 fingerprint）
   * @param {string} [ev.source.kind] 陈述类型（assertion/observation/relay/measurement）
   * @param {string} [ev.source.eventId] 关联的事件（记忆/任务/网络事件）
   * @param {number} [ev.observedAt] 观察时间（该证据何时被采集）
   * @param {number} [ev.validFrom] 有效起始（该主张何时开始成立）
   * @param {number} [ev.validUntil] 有效截止（该主张何时失效）
   * @returns {object} claim
   */
  ingestEvidence(ev) {
    if (!ev || !ev.subject || !ev.predicate) {
      throw new Error("evidence requires subject and predicate");
    }
    const observedAt = ev.observedAt || Date.now();
    const source = {
      type: ev.source?.type || SOURCE_TYPES.AGENT,
      id: ev.source?.id || "",
      kind: ev.source?.kind || SOURCE_KINDS.ASSERTION,
      eventId: ev.source?.eventId || null,
    };
    const evidenceId = `${observedAt.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const claimId = `${ev.subject}|${ev.predicate}|${String(ev.object)}`;

    // 持久化证据日志
    this._append({
      kind: "evidence",
      claimId,
      evidenceId,
      subject: ev.subject,
      predicate: ev.predicate,
      object: ev.object,
      source,
      observedAt,
      validFrom: ev.validFrom || null,   // v0.12.0: 时间三维分开
      validUntil: ev.validUntil || null,
      ts: Date.now(),
    });

    // 更新内存
    this._addEvidenceToClaim(
      { claimId, evidenceId, subject: ev.subject, predicate: ev.predicate, object: ev.object, source, observedAt, validFrom: ev.validFrom || null, validUntil: ev.validUntil || null },
      Date.now()
    );
    this._pushEvent({ kind: "evidence_ingested", claimId, subject: ev.subject, predicate: ev.predicate, object: ev.object, ts: Date.now() });
    return this.claims.get(claimId);
  }

  _addEvidenceToClaim(rec, now) {
    const claimId = rec.claimId || `${rec.subject}|${rec.predicate}|${String(rec.object)}`;
    const existing = this.claims.get(claimId);
    const evidenceItem = {
      evidenceId: rec.evidenceId || `${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      subject: rec.subject,
      predicate: rec.predicate,
      object: rec.object,
      source: rec.source || { type: "unknown", id: "", kind: SOURCE_KINDS.ASSERTION },
      observedAt: rec.observedAt || now,
      validFrom: rec.validFrom || null,   // v0.12.0: 三维时间
      validUntil: rec.validUntil || null,
    };
    if (existing) {
      existing.evidence.push(evidenceItem);
      if (existing.evidence.length > 200) existing.evidence.splice(0, 50); // 防无限膨胀
    } else {
      this.claims.set(claimId, {
        id: claimId,
        // v0.12.0: Claim 一等公民字段
        claimId,                                  // 可追踪标识（= id，供引用/撤销/修订）
        subject: rec.subject,
        predicate: rec.predicate,
        object: rec.object,
        createdAt: now,                           // 主张首次成立时间（区别于证据时间）
        evidence: [evidenceItem],
      });
    }
  }

  /**
   * 时点世界状态查询（v0.12.0）——Claim 时间语义的真正落点。
   * 返回某 SPO 在给定时间点"成立"的证据切片，而非"最新 KV"。
   * 例：Alice located_at 在 2026-06-01 的时点上返回 Beijing 证据，
   *     2026-08-20 的时点上返回 Shanghai 证据——各自可追踪、不互相覆盖。
   *
   * @param {string} subject
   * @param {string} predicate
   * @param {number} [atMs] 查询时点（默认 now）
   * @returns {object|null} { subject, predicate, object, claimId, activeEvidence[] } 或 null
   */
  claimAt(subject, predicate, atMs = Date.now()) {
    const candidates = [];
    for (const c of this.claims.values()) {
      if (c.subject !== subject || c.predicate !== predicate) continue;
      const active = c.evidence.filter((ev) => {
        const from = ev.validFrom || ev.observedAt || 0;
        const until = ev.validUntil || Infinity;
        return from <= atMs && atMs <= until;
      });
      if (active.length > 0) {
        candidates.push({ claim: c, active });
      }
    }
    if (candidates.length === 0) return null;
    // 取该时点证据最充分的 claim（同 SPO 可能因时间窗不同而有多个）
    candidates.sort((a, b) => b.active.length - a.active.length);
    const { claim, active } = candidates[0];
    return {
      subject,
      predicate,
      object: claim.object,
      claimId: claim.claimId || claim.id,
      createdAt: claim.createdAt,
      atMs,
      activeEvidence: active,
    };
  }

  /**
   * 撤销一条证据（如发现来源不可信）。
   */
  retractEvidence(subject, predicate, object, evidenceId = null) {
    const claimId = `${subject}|${predicate}|${String(object)}`;
    const c = this.claims.get(claimId);
    if (!c) return false;
    if (evidenceId) {
      this._append({ kind: "evidence_retracted", claimId, evidenceId, ts: Date.now() });
      c.evidence = c.evidence.filter((ev) => ev.evidenceId !== evidenceId);
      if (c.evidence.length === 0) this.claims.delete(claimId);
    } else {
      this._append({ kind: "claim_retracted", id: claimId, ts: Date.now() });
      this.claims.delete(claimId);
    }
    this._pushEvent({ kind: "evidence_retracted", claimId, ts: Date.now() });
    return true;
  }

  /**
   * 推导信念（v0.11.1 核心 API）——从 claims 的证据聚合成一个信念。
   *
   * 审查指出的数学 bug 修复：
   *   Σw/Σw ≡ 1  →  support = Σ(权重 × 新鲜度)，belief = 1 - exp(-support)
   *   同源重复证据不叠加（防刷票）
   *   矛盾真正影响 belief（不是只记录）
   *   新鲜度衰减（7 天半衰期）
   *
   * @param {string} subject
   * @param {string} predicate
   * @param {string} [object] 限定宾语（不传则返回该主谓下所有 claim 的信念）
   * @returns {object|null} Belief
   */
  deriveBelief(subject, predicate, object = null) {
    const now = Date.now();
    const relevant = [];
    for (const c of this.claims.values()) {
      if (c.subject !== subject || c.predicate !== predicate) continue;
      if (object !== null && c.object !== object) continue;
      // 时间有效性：未生效（validFrom 未到）或已过期（validUntil 已过）的证据排除
      const validEvidence = c.evidence.filter((ev) => {
        if (ev.validFrom && now < ev.validFrom) return false; // 还未成立
        if (ev.validUntil && now > ev.validUntil) return false; // 已失效
        return true;
      });
      if (validEvidence.length === 0) continue;
      relevant.push({ claim: c, validEvidence });
    }
    if (relevant.length === 0) return null;

    // 对每个 claim 计算证据加权支持度
    const scored = relevant.map(({ claim, validEvidence }) => {
      // 来源去重：同一 source.id 的重复证据不叠加（防刷票）
      const seenSources = new Set();
      let support = 0;
      let relayCount = 0;
      for (const ev of validEvidence) {
        const srcKey = ev.source?.id || ev.source?.type || ev.evidenceId;
        if (seenSources.has(srcKey)) continue; // 同源重复证据只计一次
        seenSources.add(srcKey);

        const w = sourceWeight(ev.source);
        // 新鲜度衰减：越旧的证据贡献越低（半衰期 7 天）
        const ageMs = now - (ev.observedAt || ev.ts || now);
        const ageDays = Math.max(0, ageMs) / (24 * 3600 * 1000);
        const freshness = Math.exp(-ageDays / 7);

        support += w * freshness;
        if (ev.source.kind === SOURCE_KINDS.RELAY) relayCount++;
      }
      const belief = 1 - Math.exp(-support);
      return { claim, belief, evidenceCount: seenSources.size, relayCount };
    });

    // 选 belief 最高的 claim
    let best = scored[0];
    for (const s of scored) {
      if (s.belief > best.belief) best = s;
    }
    const conflicting = scored.filter((s) => s.claim.id !== best.claim.id);

    // 矛盾惩罚：有矛盾时降低 belief。每条矛盾 claim 降低 50% 的差距
    const conflictPenalty = conflicting.length > 0 ? 0.5 * (1 - 1 / (conflicting.length + 1)) : 0;
    const finalBelief = Math.round(best.belief * (1 - conflictPenalty) * 100) / 100;

    return {
      subject,
      predicate,
      object: best.claim.object,
      belief: finalBelief,
      evidenceCount: best.evidenceCount,
      totalClaims: scored.length,
      conflicts: conflicting.length,
      conflictObjects: conflicting.map((c) => c.claim.object).slice(0, 10),
      updatedAt: now,
    };
  }

  /** 查询某 subject 的信念（按 belief 降序）——beliefsAbout 现在是真信念推导 */
  beliefsAbout(subject) {
    const predicates = new Set();
    for (const c of this.claims.values()) {
      if (c.subject === subject) predicates.add(c.predicate);
    }
    const out = [];
    for (const p of predicates) {
      const b = this.deriveBelief(subject, p);
      if (b) out.push(b);
    }
    return out.sort((a, b2) => b2.belief - a.belief);
  }

  /** 查询原始 claims（证据级，未聚合） */
  queryClaims(subject = null, predicate = null) {
    return Array.from(this.claims.values()).filter((c) =>
      (subject === null || c.subject === subject) && (predicate === null || c.predicate === predicate)
    );
  }

  /** 记录/更新一个关系（持久化） */
  addRelation(from, type, to) {
    const id = `${from}|${type}|${to}`;
    const now = Date.now();
    if (this.relations.has(id)) {
      const rel = this.relations.get(id);
      rel.ts = now;
      this._append({ kind: "relation", from, type, to, ts: now });
      return rel;
    }
    this._append({ kind: "relation", from, type, to, ts: now });
    const rel = { id, from, type, to, ts: now };
    this.relations.set(id, rel);
    this._pushEvent({ kind: "relation_added", from, type, to, ts: now });
    return rel;
  }

  /** 按关系类型查询 */
  queryRelations(type = null, from = null) {
    return Array.from(this.relations.values()).filter((r) =>
      (type === null || r.type === type) && (from === null || r.from === from)
    );
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
      claims: this.claims.size,
      relations: this.relations.size,
      events: this.events.length,
    };
  }
}

/**
 * 来源权重：不同来源类型/陈述类型对信念的贡献不同。
 * - agent assertion: 1.0（直接声明）
 * - agent observation: 0.9（观察比声明更可靠）
 * - self: 1.0（自身）
 * - registry: 0.8（引导信息，可能过时）
 * - sensor/measurement: 0.95（直接测量）
 * - relay: 0.3（转述，不可靠——打折）
 */
export function sourceWeight(source) {
  const base = {
    [SOURCE_TYPES.AGENT]: 0.8,
    [SOURCE_TYPES.SELF]: 1.0,
    [SOURCE_TYPES.REGISTRY]: 0.7,
    [SOURCE_TYPES.SENSOR]: 0.95,
    [SOURCE_TYPES.MEMORY]: 0.6,
    [SOURCE_TYPES.NETWORK]: 0.5,
  }[source?.type] ?? 0.4;
  const kindBonus = {
    [SOURCE_KINDS.ASSERTION]: 0,
    [SOURCE_KINDS.OBSERVATION]: 0.1,
    [SOURCE_KINDS.RELAY]: -0.5,
    [SOURCE_KINDS.MEASUREMENT]: 0.15,
  }[source?.kind] ?? 0;
  return Math.max(0.05, Math.min(1, base + kindBonus));
}
