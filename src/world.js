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
 *
 * ⚠️ v0.12.20 (审查 P1) 持久化语义声明——**crash-consistent，非 durable commit**：
 *   _persist() 成功 = 数据已写入 OS file interface（appendFileSync），
 *   **不保证 fsync 落盘**。进程/OS/磁盘在 write 后、稳定存储前崩溃，
 *   最后一次事务可能整体丢失——由 BEGIN/RECORD/COMMIT 边界保证：
 *   "丢失的是整个最后事务"，绝不产生半事务状态。
 *   需要 durable commit 的场景应显式 fsync（当前本地单节点模型不需要）。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * v0.12.19 (审查 P2): 确定性 evidenceId——SHA256(canonical content)，
 * 不再用 Math.random()。相同输入（subject/predicate/object/source/时间窗/observationId）
 * 在任何节点产生相同 evidenceId（确定性状态推导前提）。
 * 如需记录同内容的不同次观察，调用方通过 ev.observationId（signed nonce）加入哈希区分。
 * @param {object} params evidence 字段
 * @param {string} params.subject
 * @param {string} params.predicate
 * @param {*} params.object
 * @param {object} [params.source]
 * @param {number|string|null} [params.observedAt]
 * @param {number|string|null} [params.validFrom]
 * @param {number|string|null} [params.validUntil]
 * @param {string|null} [params.observationId] 调用方可选的 signed nonce（区分同内容多次观察）
 * @returns {string} 24 hex chars
 */
function deterministicEvidenceId({ subject, predicate, object, source, observedAt, validFrom, validUntil, observationId }) {
  const canonical = JSON.stringify({
    subject,
    predicate,
    object: String(object),
    srcIdentity: source?.identity || source?.id || "",
    srcEventId: source?.eventId || null,
    observedAt: observedAt ?? null,
    validFrom: validFrom ?? null,
    validUntil: validUntil ?? null,
    observationId: observationId ?? null,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}
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
    // v0.12.2: 持久化健康状态（⑨修复——静默错误不再假装世界正常运行）
    this.persistentHealthy = true;
    this.persistenceError = null;
    this._load();
  }

  /**
   * 持久化健康状态（v0.12.2，⑨修复）。
   * World Model 是权威状态（不是 telemetry）——持久化失败必须暴露，不能静默继续。
   * @returns {boolean} true = 健康
   */
  isHealthy() { return this.persistentHealthy; }

  /** 持久化错误信息（v0.12.2）。 */
  persistenceErrorMessage() { return this.persistenceError; }

  _load() {
    if (!this.logFile) return;
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      const text = fs.readFileSync(this.logFile, "utf8");
      if (!text.trim()) return;
      const lines = text.trim().split("\n").filter(Boolean);
      // v0.12.19/20 (审查 P1/P2): 严格事务状态机重放——
      //   协议: tx_begin(txId) → RECORD(txId)×N → tx_commit(txId)
      //   状态: IDLE → BEGIN(A) → OPEN(A) → COMMIT(A) → IDLE
      //   OPEN(A) 期间: RECORD(A) ✓ | COMMIT(A) ✓ | BEGIN(B)/COMMIT(B)/RECORD(B) → 非法
      //   IDLE 期间:   RECORD(txId)/COMMIT(txId)（无 BEGIN）→ 非法
      //   非法 transition → fail-closed：persistentHealthy=false，非法记录绝不 _replay。
      //   legacy 行（无 txId）→ 逐行直接应用（仅旧日志向后兼容）。
      //   文件尾部未 commit 事务 / 半行 JSON（崩溃截断）→ 丢弃（crash recovery，见文件头语义）。
      let pendingTx = null; // {txId, records: []}
      for (let i = 0; i < lines.length; i++) {
        let rec;
        try {
          rec = JSON.parse(lines[i]);
        } catch (err) {
          const isTail = i === lines.length - 1;
          if (isTail) {
            // 尾部半行 JSON = 崩溃/截断残留：丢弃（pendingTx 不 flush），
            // 不标记 unhealthy——事务边界保证世界停在最后一个 COMMIT。
            break;
          }
          this.persistentHealthy = false;
          this.persistenceError = `world log corrupted at line ${i + 1}: ${err?.message || err}`;
          break; // 停止重放——损坏后继续读取会让世界建立在不一致状态上
        }
        // 非法事务结构 → fail-closed 并停止（不静默跳过、不直接执行）
        const txViolation = (msg) => {
          this.persistentHealthy = false;
          this.persistenceError = `world log tx protocol violation at line ${i + 1}: ${msg}`;
          return true; // 已标记失败 → 上层 break
        };
        if (!rec.txId) {
          // legacy 行（无事务标记）：直接应用，保持旧日志兼容
          this._replay(rec);
          continue;
        }
        if (rec.kind === "tx_begin") {
          if (pendingTx) {
            if (txViolation(`tx_begin(${rec.txId}) while tx ${pendingTx.txId} still open`)) break;
          }
          pendingTx = { txId: rec.txId, records: [] };
        } else if (rec.kind === "tx_commit") {
          if (!pendingTx) {
            if (txViolation(`tx_commit(${rec.txId}) without tx_begin`)) break;
          } else if (pendingTx.txId !== rec.txId) {
            if (txViolation(`tx_commit(${rec.txId}) inside open tx ${pendingTx.txId}`)) break;
          } else {
            // 事务完整 → 按序应用全部记录
            for (const r of pendingTx.records) this._replay(r);
            pendingTx = null;
          }
        } else {
          // 数据 record
          if (!pendingTx) {
            if (txViolation(`record(${rec.kind || "?"}) with txId ${rec.txId} without tx_begin — 拒绝直接执行`)) break;
          } else if (pendingTx.txId !== rec.txId) {
            if (txViolation(`record txId ${rec.txId} inside open tx ${pendingTx.txId}`)) break;
          } else {
            pendingTx.records.push(rec);
          }
        }
      }
      // 尾部未 commit 事务 = 崩溃残留 → 丢弃（transaction boundary 保证不产生半事务状态）
      // pendingTx 不 flush，这里不做任何事
    } catch (err) {
      // ENOENT → 首次运行（静默）；其他 IO 错误 → 暴露
      if (err?.code !== "ENOENT") {
        this.persistentHealthy = false;
        this.persistenceError = `world log load failed: ${err?.message || err}`;
      }
    }
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
      // 撤销整个 claim（如发现原始证据系伪造）——标记而非删除（v0.12.4）
      const c = this.claims.get(rec.id);
      if (c) {
        c.status = "retracted";
        c.retractedAt = rec.ts || now;
        c.retractedBy = rec.retractedBy || "";
        c.reason = rec.reason || "";
      }
    } else if (rec.kind === "evidence_retracted") {
      // v0.12.4: 非破坏性撤销——标记 status=retracted，保留历史（"有历史的世界不该忘记"）
      const c = this.claims.get(rec.claimId);
      if (c && rec.evidenceId) {
        const ev = c.evidence.find((e) => e.evidenceId === rec.evidenceId);
        if (ev) {
          ev.status = "retracted";
          ev.retractedAt = rec.ts || now;
          ev.retractedBy = rec.retractedBy || "";
          ev.reason = rec.reason || "";
        }
      }
      // 整个 claim 撤销（evidenceId=null）
      if (c && !rec.evidenceId) {
        c.status = "retracted";
        c.retractedAt = rec.ts || now;
        c.retractedBy = rec.retractedBy || "";
        c.reason = rec.reason || "";
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

  /**
   * v0.12.19/20 (审查 P1): 事务化持久化——每条操作包裹 BEGIN + RECORDS + COMMIT 标记。
   * 写入格式：{txId, kind:"tx_begin"} → {txId, kind:..., ...}×N → {txId, kind:"tx_commit"}。
   *
   * ⚠️ 语义边界（v0.12.20 明确）：**crash-consistent，非 durable commit**。
   * 单次 appendFileSync 成功 = 已交给 OS file interface；无 fsync。
   * 进程/OS 崩溃可能丢失整个最后事务（BEGIN..COMMIT 全部未落盘），
   * 但绝不产生半事务状态——重放时无 COMMIT 的事务整体丢弃。
   *
   * @param {object|object[]} recs 单条或数组（数据记录，不含事务标记）
   * @returns {boolean} true = 写入 OS 成功
   */
  _persist(recs) {
    if (!this.logFile) return true; // 内存模式
    const arr = Array.isArray(recs) ? recs : [recs];
    if (arr.length === 0) return true;
    const txId = crypto.randomUUID(); // 每操作唯一事务 ID（崩溃恢复用，不参与状态推导）
    const logLines = [
      JSON.stringify({ schemaVersion: 1, kind: "tx_begin", txId }),
      ...arr.map((r) => JSON.stringify({ schemaVersion: 1, txId, ...r })),
      JSON.stringify({ schemaVersion: 1, kind: "tx_commit", txId }),
    ];
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.appendFileSync(this.logFile, logLines.join("\n") + "\n", "utf8");
      return true;
    } catch (err) {
      this.persistentHealthy = false;
      this.persistenceError = err?.message || String(err);
      return false;
    }
  }

  /**
   * v0.12.18 (审查 P0): append-first 强制门——先持久化、失败立即 throw，
   * 调用方不得继续修改内存（与 TaskStore v0.12.17 同一事务模型）。
   * @param {object|object[]} recs 单条或数组
   * @throws {Error} err.persistence = true 若落盘失败
   */
  _appendOrThrow(recs) {
    if (!this._persist(recs)) {
      const kinds = (Array.isArray(recs) ? recs : [recs]).map((r) => r.kind || "?").join(",");
      const err = new Error(`world log persistence failed (${kinds}): ${this.persistenceError || "unknown"}`);
      err.persistence = true;
      throw err;
    }
  }

  /** 仅内存事件环形缓冲（v0.12.18：写入日志由调用方在 _appendOrThrow batch 中统一完成） */
  _pushEvent(ev) {
    this.events.push(ev);
    if (this.events.length > this._eventCap) this.events.splice(0, this.events.length - this._eventCap);
  }

  /** 记录/更新一个实体（每次变更都持久化） */
  observeEntity(id, type, name, meta = {}, opts = {}) {
    const now = Date.now();
    const existing = this.entities.get(id);
    // v0.12.18 (审查 P0): append-first——本操作的全部记录（状态记录 + 事件记录）先一次性落盘
    const eventEv = { kind: existing ? "entity_updated" : "entity_seen", id, type, ts: now };
    this._appendOrThrow([
      { kind: "entity", id, type, name, meta, ts: now, ...(opts.source ? { src: opts.source } : {}) },
      { kind: "event", data: eventEv, ts: now },
    ]);
    // 持久化成功 → 才更新内存
    if (existing) {
      existing.lastSeen = now;
      existing.name = name || existing.name;
      existing.meta = { ...existing.meta, ...(meta || {}) };
      this._pushEvent(eventEv);
      return existing;
    }
    const entity = { id, type, name, meta: meta || {}, firstSeen: now, lastSeen: now };
    this.entities.set(id, entity);
    this._pushEvent(eventEv);
    return entity;
  }

  /** 记录/更新一个 Agent 节点（每次变更都持久化） */
  observeAgent(fingerprint, name, capabilities = [], trustHint = "learned") {
    const now = Date.now();
    const existing = this.agents.get(fingerprint);
    const eventEv = { kind: existing ? "agent_updated" : "agent_observed", fingerprint, name, ts: now };
    this._appendOrThrow([
      { kind: "agent", id: fingerprint, name, capabilities, trustHint, ts: now },
      { kind: "event", data: eventEv, ts: now },
    ]);
    if (existing) {
      existing.lastSeen = now;
      existing.name = name || existing.name;
      if (capabilities.length) existing.capabilities = Array.from(new Set([...(existing.capabilities || []), ...capabilities]));
      this._pushEvent(eventEv);
      return existing;
    }
    const agent = { id: fingerprint, fingerprint, name, capabilities, trustHint, firstSeen: now, lastSeen: now };
    this.agents.set(fingerprint, agent);
    this._pushEvent(eventEv);
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
      // v0.12.2 ⑤: 稳定主体 ID（独立性依据）——与 id（会话级）分开
      identity: ev.source?.identity || ev.source?.id || "",
      kind: ev.source?.kind || SOURCE_KINDS.ASSERTION,
      eventId: ev.source?.eventId || null,
      // v0.12.2 ⑤: 因果链预留——derivedFrom 记录传播来源（A→B→C→D 只算一个独立来源）
      provenanceId: ev.source?.provenanceId || null,
    };
    const evidenceId = deterministicEvidenceId({
      subject: ev.subject,
      predicate: ev.predicate,
      object: ev.object,
      source,
      observedAt,
      validFrom: ev.validFrom || null,
      validUntil: ev.validUntil || null,
      observationId: ev.observationId || null,
    });
    const claimId = `${ev.subject}|${ev.predicate}|${String(ev.object)}`;
    const ts = Date.now();

    // v0.12.18 (审查 P0): append-first——evidence 记录 + ingested 事件记录一次性落盘。
    // 失败 → throw，_addEvidenceToClaim/_pushEvent 一律不执行（零状态变更）。
    this._appendOrThrow([
      {
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
        ts,
      },
      { kind: "event", data: { kind: "evidence_ingested", claimId, subject: ev.subject, predicate: ev.predicate, object: ev.object, ts }, ts },
    ]);

    // 持久化成功 → 更新内存
    this._addEvidenceToClaim(
      { claimId, evidenceId, subject: ev.subject, predicate: ev.predicate, object: ev.object, source, observedAt, validFrom: ev.validFrom || null, validUntil: ev.validUntil || null },
      ts
    );
    this._pushEvent({ kind: "evidence_ingested", claimId, subject: ev.subject, predicate: ev.predicate, object: ev.object, ts });
    return this.claims.get(claimId);
  }

  _addEvidenceToClaim(rec, now) {
    const claimId = rec.claimId || `${rec.subject}|${rec.predicate}|${String(rec.object)}`;
    const existing = this.claims.get(claimId);
    const evidenceItem = {
      evidenceId: rec.evidenceId || deterministicEvidenceId({
        subject: rec.subject,
        predicate: rec.predicate,
        object: rec.object,
        source: rec.source,
        observedAt: rec.observedAt ?? now,
        validFrom: rec.validFrom,
        validUntil: rec.validUntil,
        observationId: rec.observationId || null,
      }),
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
        // v0.12.4 (审查 P1-⑥): Proposition 身份与 Claim 身份显式分离。
        //   propositionId = subject|predicate|object（世界主张本身）
        //   claimId       = 该主张的可追踪容器（含证据/修订历史）
        //   Evidence      = 单条观察（时间窗独立）
        //   四层：Proposition ≠ Claim ≠ Evidence ≠ Belief
        propositionId: claimId,
        subject: rec.subject,
        predicate: rec.predicate,
        object: rec.object,
        createdAt: now,                           // 主张首次成立时间（区别于证据时间）
        revisions: [],                            // v0.12.4: 修订历史（回填自证据时间窗；见 claimAt）
        evidence: [evidenceItem],
      });
    }
  }

  /**
   * 时点世界状态查询（v0.12.1）——Claim 时间语义 + Belief 评分的统一落点。
   * 审查指出的语义分裂修复：
   *   旧实现按"active evidence 数量"选冠军（relay×10 会赢 sensor×1）；
   *   新实现与 deriveBelief 共用 _scoreEvidence()，按信念 (1−e^(−support)) 选冠军。
   * 例：Alice located_at 在 2026-06-01 的时点上返回 Beijing，08-20 返回 Shanghai。
   *
   * @param {string} subject
   * @param {string} predicate
   * @param {number} [atMs] 查询时点（默认 now）
   * @returns {object|null} { subject, predicate, object, claimId, createdAt, atMs, belief, support, activeEvidence[] }
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
    // 按信念评分选冠军（不再是证据数量；与 deriveBelief 同一公式）
    const scored = candidates.map(({ claim, active }) => {
      const s = this._scoreEvidence(active, atMs);
      return { claim, active, belief: s.belief, support: s.support, evidenceCount: s.evidenceCount };
    });
    scored.sort((a, b) => b.belief - a.belief);
    const { claim, active, belief, support, evidenceCount } = scored[0];
    return {
      subject,
      predicate,
      object: claim.object,
      claimId: claim.claimId || claim.id,
      createdAt: claim.createdAt,
      atMs,
      belief,       // 信念（support score，非概率）
      support,      // 证据支持度
      evidenceCount,
      activeEvidence: active,
    };
  }

  /**
   * 时点信念推导（v0.12.1）——deriveBelief 的历史版本。
   * 与 deriveBelief 完全同公式，只是固定评分时点；
   * 与 claimAt 的区别：返回完整信念对象（含矛盾惩罚），而非单 claim 快照。
   *
   * @param {string} subject
   * @param {string} predicate
   * @param {number} [atMs] 评分时点
   * @returns {object|null} Belief
   */
  deriveBeliefAt(subject, predicate, atMs = Date.now()) {
    return this.deriveBelief(subject, predicate, null, atMs);
  }

  /**
   * 认识状态查询（v0.12.3）——四态闭环的显式入口。
   * 审查指出：deriveBelief 返回 null 无法区分"UNKNOWN"与"无此主张"，
   * 客户端会混淆 error / unknown / no-claim。
   * 此 API 显式返回四态之一：
   *   UNKNOWN       — 无任何证据（包括从未观察到的 subject/predicate）
   *   STALE         — 有证据但全部已过期
   *   SUPPORTED     — 有活跃证据、无冲突
   *   CONTRADICTED  — 有活跃证据、存在冲突
   *
   * @param {string} subject
   * @param {string} predicate
   * @param {number} [atMs] 查询时点
   * @returns {string} SUPPORTED | CONTRADICTED | STALE | UNKNOWN
   */
  epistemicStatus(subject, predicate, atMs = Date.now()) {
    const b = this.deriveBelief(subject, predicate, null, atMs);
    if (!b) return "UNKNOWN";
    return b.epistemicState;
  }

  /**
   * 撤销一条证据（如发现来源不可信）。
   */
  retractEvidence(subject, predicate, object, evidenceId = null, meta = {}) {
    const claimId = `${subject}|${predicate}|${String(object)}`;
    const c = this.claims.get(claimId);
    if (!c) return false;
    const now = Date.now();
    const retraction = {
      kind: "evidence_retracted",
      claimId,
      evidenceId: evidenceId || null,
      ts: now,
      retractedBy: meta.retractedBy || "",
      reason: meta.reason || "",
    };
    // v0.12.18 (审查 P0): append-first——retraction 记录 + 事件记录一次性落盘，失败不碰内存
    this._appendOrThrow([
      retraction,
      { kind: "event", data: { kind: "evidence_retracted", claimId, evidenceId: evidenceId || null, ts: now }, ts: now },
    ]);
    this._replay(retraction); // v0.12.4: 非破坏性——标记 status=retracted，不物理删除
    this._pushEvent({ kind: "evidence_retracted", claimId, evidenceId, ts: now });
    return true;
  }

  /**
   * 证据评分核心（v0.12.1）——deriveBelief 与 claimAt/deriveBeliefAt 共用的同一公式。
   * 审查指出的语义分裂修复：claimAt 不再"按证据数量选冠军"，
   * 而是与 deriveBelief 一样按 support → belief 评分。
   *
   * @param {Array} evidence 证据列表（已按时间窗过滤）
   * @param {number} atMs 评分时点（新鲜度衰减的基准）
   * @returns {object} { support, belief, evidenceCount, relayCount }
   */
  _scoreEvidence(evidence, atMs) {
    const seenSources = new Set();
    let support = 0;
    let relayCount = 0;
    let staleCount = 0;
    let newestObservedAt = 0;
    for (const ev of evidence) {
      // v0.12.2 ⑤: source 三概念分离——独立性用 identity，个体用 evidenceId，因果链用 provenanceId（预留）
      // source.identity = 稳定主体 ID（如 sensor:temperature:01）
      // source.id       = 会话/事件 ID（可去重但不可靠）
      // evidenceId      = 个体证据（无 identity/id 时不合并，每证据独立）
      const srcKey = ev.source?.identity || ev.source?.id || ev.evidenceId;
      if (seenSources.has(srcKey)) continue;
      seenSources.add(srcKey);

      const w = sourceWeight(ev.source);
      // 新鲜度衰减：越旧的证据贡献越低（半衰期 7 天）
      const ageMs = atMs - (ev.observedAt || ev.ts || atMs);
      const ageDays = Math.max(0, ageMs) / (24 * 3600 * 1000);
      const freshness = Math.exp(-ageDays / 7);

      support += w * freshness;
      if (ev.source.kind === SOURCE_KINDS.RELAY) relayCount++;
      if (ev.observedAt && ev.observedAt > newestObservedAt) newestObservedAt = ev.observedAt;
      if (ageDays > 30) staleCount++;
    }
    const belief = 1 - Math.exp(-support);
    return { support, belief, evidenceCount: seenSources.size, relayCount, staleCount, newestObservedAt };
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
   * 注意：belief 是 support score / confidence，不是概率。
   * belief=0.8 不意味着 P(claim is true)=80%。（v0.12.1 术语声明）
   *
   * @param {string} subject
   * @param {string} predicate
   * @param {string} [object] 限定宾语（不传则返回该主谓下所有 claim 的信念）
   * @param {number} [atMs] 评分时点（默认 now；v0.12.1 支持历史时点）
   * @returns {object|null} Belief
   */
  deriveBelief(subject, predicate, object = null, atMs = Date.now()) {
    const now = atMs;
    const relevant = [];    // active claims
    let staleClaims = [];   // 全部证据已过期
    for (const c of this.claims.values()) {
      if (c.status === "retracted") continue; // v0.12.4: 整条 claim 已撤销
      if (c.subject !== subject || c.predicate !== predicate) continue;
      if (object !== null && c.object !== object) continue;
      // v0.12.3: 三组证据计算——allEvidence（过 validFrom）/ activeEvidence（不过期）/ staleEvidence（已过期）
      const allEvidence = c.evidence.filter((ev) => {
        if (ev.validFrom && now < ev.validFrom) return false; // 未生效
        if (ev.status === "retracted") return false; // v0.12.4: 已撤销 ≠ 世界曾相信的证据
        return true;
      });
      const activeEvidence = allEvidence.filter((ev) => {
        if (ev.validUntil && now > ev.validUntil) return false; // 已过期
        if (ev.status === "retracted") return false; // v0.12.4: 已撤销
        return true;
      });
      if (activeEvidence.length > 0) {
        relevant.push({ claim: c, validEvidence: activeEvidence });
      } else if (allEvidence.length > 0) {
        // 全部证据已过期 → STALE（不再跳过）
        staleClaims.push({ claim: c, evidence: c.evidence, allEvidence });
      }
    }
    // 四态决策：all=0→UNKNOWN; all>0,active=0→STALE; active>0,no conflict→SUPPORTED; active>0,conflict→CONTRADICTED
    if (relevant.length === 0) {
      if (staleClaims.length > 0) {
        return {
          subject, predicate,
          object: staleClaims[0].claim.object,
          belief: 0, support: 0, dominance: 0,
          epistemicState: "STALE",
          evidenceCount: 0, totalClaims: staleClaims.length,
          conflicts: 0, conflictObjects: [],
          totalEvidence: staleClaims.reduce((s, sc) => s + sc.allEvidence.length, 0),
          updatedAt: now,
        };
      }
      return null; // UNKNOWN（无任何证据）
    }

    // 对每个 claim 计算证据加权支持度（同一公式，与 claimAt/deriveBeliefAt 统一）
    const scored = relevant.map(({ claim, validEvidence }) => {
      const s = this._scoreEvidence(validEvidence, now);
      return {
        claim,
        support: s.support,
        belief: s.belief,
        evidenceCount: s.evidenceCount,
        relayCount: s.relayCount,
        staleCount: s.staleCount,
        newestObservedAt: s.newestObservedAt,
      };
    });

    // 选 belief 最高的 claim
    let best = scored[0];
    for (const s of scored) {
      if (s.belief > best.belief) best = s;
    }
    const conflicting = scored.filter((s) => s.claim.id !== best.claim.id);

    // v0.12.2 ⑦: 矛盾惩罚从"冲突数量 heuristic"升级为"相对支持度 dominance"。
    //   旧：0.5 * (1 - 1/(conflicting.length+1))——一个弱反对和十个强反对惩罚一样。
    //   新：dominance = support(best) / Σ support(all)——相对强度决定信心。
    //   A=5.0 vs B=0.1 → dominance≈0.98（几乎不受影响）
    //   A=5.0 vs B=4.9 → dominance≈0.50（信心腰斩）
    const totalSupport = scored.reduce((sum, s) => sum + s.support, 0);
    const dominance = totalSupport > 0 ? best.support / totalSupport : 1;
    const finalBelief = Math.round(best.belief * dominance * 100) / 100;

    // v0.12.2 ⑥: epistemic state——belief strength 与认识状态是两个维度。
    //   SUPPORTED    — 有有效证据、无冲突
    //   CONTRADICTED — 存在冲突（无论强弱，dominance 已反映强度）
    //   STALE        — 所有证据已过期（无新鲜证据）
    let epistemicState = "SUPPORTED";
    if (conflicting.length > 0) epistemicState = "CONTRADICTED";
    if (best.staleCount > 0 && best.staleCount >= best.evidenceCount) epistemicState = "STALE";

    return {
      subject,
      predicate,
      object: best.claim.object,
      belief: finalBelief,
      support: best.support,
      dominance,            // v0.12.2 ⑦: 相对支持度
      epistemicState,       // v0.12.2 ⑥: SUPPORTED / CONTRADICTED / STALE
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
    const existing = this.relations.get(id);
    if (existing) {
      // v0.12.18 (审查 P0): append-first——更新记录先落盘，成功后才改内存 ts
      this._appendOrThrow({ kind: "relation", from, type, to, ts: now });
      existing.ts = now;
      return existing;
    }
    // v0.12.18 (审查 P0): append-first——relation 记录 + 事件记录一次性落盘
    this._appendOrThrow([
      { kind: "relation", from, type, to, ts: now },
      { kind: "event", data: { kind: "relation_added", from, type, to, ts: now }, ts: now },
    ]);
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
