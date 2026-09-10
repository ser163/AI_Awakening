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
    srcIdentity: source?.identity ?? source?.id ?? "",
    srcEventId: source?.eventId ?? null,
    observedAt: observedAt ?? null,
    validFrom: validFrom ?? null,
    validUntil: validUntil ?? null,
    observationId: observationId ?? null,
  });
  return crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}
export const SOURCE_TYPES = {
  UNKNOWN: "unknown",    // 来源未知/未提供（不得伪装成 agent）
  AGENT: "agent",        // 另一节点断言
  SELF: "self",          // 本节点自身
  REGISTRY: "registry",  // 注册表（引导信息）
  SENSOR: "sensor",      // 传感器/环境观察
  MEMORY: "memory",      // 从记忆重放
  NETWORK: "network",    // 网络拓扑观察
};

/** 权威记录类型：参与状态推导的 kind，不含 tx/event 标记 */
const AUTHORITATIVE_KINDS = new Set(["entity", "agent", "evidence", "evidence_retracted", "claim_retracted", "relation"]);

/**
 * v0.12.23 (审查 P1/P2): 确定性深排序 canonicalization——任意字段修改→hash 变化。
 * 排除仅 txId（事务随机 ID）和 eventHash（自指），保留 schemaVersion（防版本降级）。
 * 不再维护人工字段白名单。
 */
function sortedCanonical(obj) {
  if (obj === null || obj === undefined) return JSON.stringify(obj);
  if (typeof obj !== "object" || Array.isArray(obj)) return JSON.stringify(obj);
  const keys = Object.keys(obj).sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + sortedCanonical(obj[k]));
  return "{" + pairs.join(",") + "}";
}

/**
 * v0.12.23 (审查 P1/P2): 计算 World 权威记录的完整性哈希。
 *   — canonical = sortedCanonical(rec 排除 txId,eventHash) → 全字段受保护
 *   — 满 256 bit (64 hex)，不截断
 *   — 自动排除 eventHash(自指) + txId(事务随机 ID，非语义)
 *   — 保留 schemaVersion → 版本降级被检测
 * @param {object} rec 记录（可含 schemaVersion/txId/eventHash）
 * @returns {string|null} 64 hex SHA-256，或 null（非权威类型）
 */
function worldRecordHash(rec) {
  if (!rec || !rec.kind || !AUTHORITATIVE_KINDS.has(rec.kind)) return null;
  const { txId, eventHash, ...semantic } = rec;
  return crypto.createHash("sha256").update(sortedCanonical(semantic)).digest("hex");
}
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
      //   非法状态转换 → 故障即关闭（fail-closed）：persistentHealthy=false，非法记录绝不 _replay。
      //   legacy 行（无 txId）→ v0.12.23 起 fail-closed：无 eventHash 不可参与权威重放，
      //   必须经 migrateWorldLog() 显式迁移后才能启动。
      //   文件尾部未提交事务 / 半行 JSON（崩溃截断）→ 丢弃（崩溃恢复，见文件头语义）。
      let pendingTx = null; // {txId, records: [{line, rec}]}
      let abortLoad = false; // 完整性/协议失败 → 终止整个加载
      for (let i = 0; i < lines.length && !abortLoad; i++) {
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
          abortLoad = true;
        };
        if (!rec.txId) {
          // legacy 行（无事务标记）：v0.12.23 仅迁移路径允许——正常启动下 legacy 记录
          // 无 eventHash 不可直接参与权威重放（Legacy ≠ authoritative）。
          // 若确实有旧日志，使用 migrateWorldLog() 显式迁移后启动。
          this.persistentHealthy = false;
          this.persistenceError = `world log: legacy record (no txId) at line ${i + 1} — must migrate via migrateWorldLog()`;
          break;
        }
        if (rec.kind === "tx_begin") {
          if (pendingTx) {
            txViolation(`tx_begin(${rec.txId}) while tx ${pendingTx.txId} still open`);
            break;
          }
          pendingTx = { txId: rec.txId, records: [] };
        } else if (rec.kind === "tx_commit") {
          if (!pendingTx) {
            txViolation(`tx_commit(${rec.txId}) without tx_begin`);
            break;
          } else if (pendingTx.txId !== rec.txId) {
            txViolation(`tx_commit(${rec.txId}) inside open tx ${pendingTx.txId}`);
            break;
          } else {
            // 事务完整 → **先逐条验证 eventHash，全部通过后再按序应用**
            // （验证与应用分离：任一条 fail → 整个事务零应用，保持原子性）
            for (const { line, rec: r } of pendingTx.records) {
              // v0.12.23 (审查 P1): 权威记录必须带 eventHash 验证完整性——
              // 无 hash 的旧格式记录不得参与 authoritative replay（仅迁移路径补 hash）
              if (AUTHORITATIVE_KINDS.has(r.kind)) {
                if (!r.eventHash) {
                  this.persistentHealthy = false;
                  this.persistenceError = `world log: authoritative ${r.kind} record at line ${line} missing eventHash — must migrate via migrateWorldLog()`;
                  abortLoad = true;
                  break;
                }
                const h = worldRecordHash(r);
                if (!h || h !== r.eventHash) {
                  this.persistentHealthy = false;
                  this.persistenceError = `world log record integrity failed at line ${line}: ${r.kind} eventHash mismatch (record modified)`;
                  abortLoad = true;
                  break;
                }
              }
            }
            // 全部验证通过 → 才应用（任一 fail → abortLoad=true，事务零应用）
            if (!abortLoad) {
              try {
                for (const { rec: r } of pendingTx.records) this._replay(r);
              } catch (err) {
                this.persistentHealthy = false;
                this.persistenceError = `world log replay failed: ${err.message}`;
                abortLoad = true;
              }
            }
            pendingTx = null;
          }
        } else {
          // 数据 record
          if (!pendingTx) {
            txViolation(`record(${rec.kind || "?"}) with txId ${rec.txId} without tx_begin — 拒绝直接执行`);
            break;
          } else if (pendingTx.txId !== rec.txId) {
            txViolation(`record txId ${rec.txId} inside open tx ${pendingTx.txId}`);
            break;
          } else {
            pendingTx.records.push({ line: i + 1, rec });
          }
        }
        if (abortLoad) break; // 协议违规 → 立即终止（保留已 flush 的完整事务）
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

  /** 重放一条日志事件（幂等：追加式日志 → 内存状态）——通过 state-in/state-out 纯态转换桥接 */
  _replay(rec) {
    this._stateRestore(applyWorldTransition(this._stateSnapshot(), rec));
  }

  /** 将 WorldModel 运行时状态导出为纯 state 对象（由 applyWorldTransition 消费） */
  _stateSnapshot() {
    return { entities: this.entities, agents: this.agents, claims: this.claims, relations: this.relations, events: this.events };
  }

  /** 将纯 state 对象写回 WorldModel 运行时状态 */
  _stateRestore(state) {
    this.entities = state.entities;
    this.agents = state.agents;
    this.claims = state.claims;
    this.relations = state.relations;
    this.events = state.events;
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
      ...arr.map((r) => {
        // 与落盘行一致的语义对象（含 schemaVersion，不含 txId——txId 非语义字段不参与 hash）
        const full = { schemaVersion: 1, ...r };
        const h = worldRecordHash(full);
        // 落盘行带 txId（事务分组用）+ eventHash（完整性用）；两者均不参与 hash 计算
        return JSON.stringify({ ...full, txId, ...(h ? { eventHash: h } : {}) });
      }),
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
   * v0.12.18 (审查 P0): 先落盘强制门——先持久化、失败立即 throw，
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
    // v0.12.18 (审查 P0): 先落盘——本操作的全部记录（状态记录 + 事件记录）先一次性落盘
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
    const observedAt = ev.observedAt ?? Date.now();
    const source = normalizeSource(ev.source);
    const evidenceId = deterministicEvidenceId({
      subject: ev.subject,
      predicate: ev.predicate,
      object: ev.object,
      source,
      observedAt,
      validFrom: ev.validFrom ?? null,
      validUntil: ev.validUntil ?? null,
      observationId: ev.observationId ?? null,
    });
    const claimId = `${ev.subject}|${ev.predicate}|${String(ev.object)}`;
    const ts = Date.now();

    // v0.12.18 (审查 P0): 先落盘——evidence 记录 + ingested 事件记录一次性落盘。
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
        validFrom: ev.validFrom ?? null,   // v0.12.0: 时间三维分开
        validUntil: ev.validUntil ?? null,
        ts,
      },
      { kind: "event", data: { kind: "evidence_ingested", claimId, subject: ev.subject, predicate: ev.predicate, object: ev.object, ts }, ts },
    ]);

    // 持久化成功 → 更新内存
    this._addEvidenceToClaim(
      { claimId, evidenceId, subject: ev.subject, predicate: ev.predicate, object: ev.object, source, observedAt, validFrom: ev.validFrom ?? null, validUntil: ev.validUntil ?? null },
      ts
    );
    this._pushEvent({ kind: "evidence_ingested", claimId, subject: ev.subject, predicate: ev.predicate, object: ev.object, ts });
    return this.claims.get(claimId);
  }

  _addEvidenceToClaim(rec, now) {
    addEvidenceToClaims(this.claims, rec, now);
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
    // v0.12.18 (审查 P0): 先落盘——retraction 记录 + 事件记录一次性落盘，失败不碰内存
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
      const srcKey = ev.source?.identity ?? ev.source?.id ?? ev.evidenceId;
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
      // v0.12.18 (审查 P0): 先落盘——更新记录先落盘，成功后才改内存 ts
      this._appendOrThrow({ kind: "relation", from, type, to, ts: now });
      existing.ts = now;
      return existing;
    }
    // v0.12.18 (审查 P0): 先落盘——relation 记录 + 事件记录一次性落盘
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
 * v0.12.27 (审查 P1): 纯状态转换函数——state-in/state-out，返回新状态，不修改入参 state。
 * 实时写入、重放、迁移验证共用同一转换规则。
 * @param {object} state 世界状态容器 {entities, agents, claims, relations, events}
 * @param {object} rec 一条权威/telemetry 记录（无 txId/eventHash 语义字段）
 * @returns {object} 新世界状态容器
 * @throws {Error} 若 rec.ts 缺失或非法（authoritative transition 禁止回退到当前时间）
 */
export function applyWorldTransition(state, rec) {
  // 确定性：authoritative transition 要求记录自带有效时间戳——绝不回退 Date.now()
  if (!Number.isFinite(rec.ts)) {
    throw new Error(`authoritative record requires valid ts (got: ${rec.ts})`);
  }
  const now = rec.ts;
  // 浅克隆容器（entries 按需克隆——clone-on-write，旧 state 的对象不被修改）
  const next = {
    entities: new Map(state.entities),
    agents: new Map(state.agents),
    claims: new Map(state.claims),
    relations: new Map(state.relations),
    events: [...state.events],
  };
  if (rec.kind === "entity") {
    const e = next.entities.get(rec.id);
    if (!e) next.entities.set(rec.id, { id: rec.id, type: rec.type, name: rec.name, meta: rec.meta || {}, firstSeen: now, lastSeen: now });
    else {
      next.entities.set(rec.id, {
        ...e,
        lastSeen: now,
        name: rec.name || e.name,
        meta: rec.meta ? { ...e.meta, ...rec.meta } : e.meta,
      });
    }
  } else if (rec.kind === "agent") {
    const a = next.agents.get(rec.id);
    if (!a) next.agents.set(rec.id, { id: rec.id, fingerprint: rec.id, name: rec.name, capabilities: rec.capabilities || [], trustHint: rec.trustHint || "learned", firstSeen: now, lastSeen: now });
    else {
      next.agents.set(rec.id, {
        ...a,
        lastSeen: now,
        name: rec.name || a.name,
        capabilities: rec.capabilities?.length ? Array.from(new Set([...(a.capabilities || []), ...rec.capabilities])) : a.capabilities,
      });
    }
  } else if (rec.kind === "evidence") {
    addEvidenceToClaims(next.claims, rec, now);
  } else if (rec.kind === "claim_retracted") {
    // 撤销整个 claim（如发现原始证据系伪造）——标记而非删除（v0.12.4）
    const c = next.claims.get(rec.id);
    if (c) {
      next.claims.set(rec.id, {
        ...c,
        status: "retracted",
        retractedAt: rec.ts,
        retractedBy: rec.retractedBy || "",
        reason: rec.reason || "",
      });
    }
  } else if (rec.kind === "evidence_retracted") {
    // v0.12.4: 非破坏性撤销——标记 status=retracted，保留历史（"有历史的世界不该忘记"）
    const c = next.claims.get(rec.claimId);
    if (c) {
      const updated = { ...c, evidence: c.evidence.map((ev) => ev) };
      if (rec.evidenceId) {
        const ev = updated.evidence.find((e) => e.evidenceId === rec.evidenceId);
        if (ev) {
          updated.evidence = updated.evidence.map((e) =>
            e.evidenceId === rec.evidenceId
              ? { ...e, status: "retracted", retractedAt: rec.ts, retractedBy: rec.retractedBy || "", reason: rec.reason || "" }
              : e
          );
        }
      } else {
        // 整个 claim 撤销（evidenceId=null）
        updated.status = "retracted";
        updated.retractedAt = rec.ts;
        updated.retractedBy = rec.retractedBy || "";
        updated.reason = rec.reason || "";
      }
      next.claims.set(rec.claimId, updated);
    }
  } else if (rec.kind === "relation") {
    const rid = `${rec.from}|${rec.type}|${rec.to}`;
    if (!next.relations.has(rid)) {
      next.relations.set(rid, { id: rid, from: rec.from, type: rec.type, to: rec.to, ts: now });
      next.events.push({ kind: "relation_added", from: rec.from, type: rec.type, to: rec.to, ts: now });
    }
  } else if (rec.kind === "event") {
    next.events.push(structuredClone(rec.data));
  }
  return next;
}

/** 初始空世界状态（用于纯函数 dry-run / migration 验证） */
function initWorldState() {
  return { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
}

/** source 缺失时默认值——type 为 UNKNOWN，绝不伪装成 agent（provenance 语义） */
const DEFAULT_SOURCE = { type: SOURCE_TYPES.UNKNOWN, id: "", identity: "", kind: SOURCE_KINDS.ASSERTION, eventId: null, provenanceId: null };

/**
 * v0.12.29 (审查 P2): source 规范化——统一 ?? 取代 ||，存在但非法 → throw。
 * @param {object|undefined|null} src 原始 source（可能为 undefined/null）
 * @returns {object} 标准化 source 对象
 * @throws {Error} 若 source 存在但类型/子字段非法
 */
function normalizeSource(src) {
  if (src === undefined || src === null) return { ...DEFAULT_SOURCE };
  // 真正 plain object 检查——排除 Date/Map/proto 污染
  if (typeof src !== "object" || Array.isArray(src)) throw new Error("source must be a plain object");
  const proto = Object.getPrototypeOf(src);
  if (proto !== Object.prototype && proto !== null) throw new Error("source must be a plain object (non-standard prototype detected)");
  if (src.type !== undefined && typeof src.type !== "string") throw new Error("source.type must be a string");
  if (src.id !== undefined && typeof src.id !== "string") throw new Error("source.id must be a string");
  if (src.identity !== undefined && typeof src.identity !== "string") throw new Error("source.identity must be a string");
  if (src.kind !== undefined && typeof src.kind !== "string") throw new Error("source.kind must be a string");
  if (src.eventId !== undefined && src.eventId !== null && typeof src.eventId !== "string") throw new Error("source.eventId must be a string or null");
  if (src.provenanceId !== undefined && src.provenanceId !== null && typeof src.provenanceId !== "string") throw new Error("source.provenanceId must be a string or null");
  return {
    type: src.type ?? DEFAULT_SOURCE.type,
    id: src.id ?? "",
    identity: src.identity ?? src.id ?? "",
    kind: src.kind ?? DEFAULT_SOURCE.kind,
    eventId: src.eventId ?? null,
    provenanceId: src.provenanceId ?? null,
  };
}

/**
 * v0.12.27 (审查 P1): evidence → claim 的纯转换（clone-on-write）。
 * 被 applyWorldTransition()（重放/迁移）与 WorldModel._addEvidenceToClaim()（实时写入）共用。
 * @param {Map} claims claim 容器
 * @param {object} rec evidence 记录
 * @param {number} now 确定时间戳（来自 rec.ts，不取当前时间）
 */
function addEvidenceToClaims(claims, rec, now) {
  const claimId = rec.claimId || `${rec.subject}|${rec.predicate}|${String(rec.object)}`;
  const existing = claims.get(claimId);
  const evidenceItem = {
    evidenceId: rec.evidenceId || deterministicEvidenceId({
      subject: rec.subject,
      predicate: rec.predicate,
      object: rec.object,
      source: rec.source,
      observedAt: rec.observedAt ?? now,
      validFrom: rec.validFrom,
      validUntil: rec.validUntil,
      observationId: rec.observationId ?? null,
    }),
    subject: rec.subject,
    predicate: rec.predicate,
    object: rec.object,
    source: normalizeSource(rec.source),
    observedAt: rec.observedAt ?? now,
    validFrom: rec.validFrom ?? null,   // v0.12.0: 三维时间
    validUntil: rec.validUntil ?? null,
  };
  if (existing) {
    const evidence = [...existing.evidence, evidenceItem];
    if (evidence.length > 200) evidence.splice(0, 50); // 防无限膨胀
    claims.set(claimId, { ...existing, evidence });
  } else {
    claims.set(claimId, {
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
 * v0.12.23 (审查 P1): World 旧日志显式迁移——读取 legacy 格式（无 txId/无 eventHash）的
 * world.jsonl，逐行验证并转换为当前事务格式（BEGIN→RECORD(txId+eventHash)→COMMIT）。
 * 原始文件被备份为 world.jsonl.bak.v1，迁移后可被 WorldModel 正常加载。
 *
 * 设计：这是"旧日志 ≠ 权威状态"原则落地的唯一入口。
 * 非权威 event 记录（kind:"event"）不计算 hash，仅包裹事务标记保留遥测数据。
 *
 * @param {string} storageDir 持久化目录（与 WorldModel 构造函数同语义）
 * @returns {{ok: boolean, migrated: number, reason?: string}}
 */
export function migrateWorldLog(storageDir) {
  const logFile = path.join(storageDir, "world", "world.jsonl");
  let lines;
  try {
    const text = fs.readFileSync(logFile, "utf8").trim();
    if (!text) return { ok: true, migrated: 0 };
    lines = text.split("\n").filter(Boolean);
  } catch (err) {
    if (err?.code === "ENOENT") return { ok: true, migrated: 0 };
    return { ok: false, migrated: 0, reason: `read failed: ${err.message}` };
  }
  // Step 1 — 完整解析每一行。坏 JSON：仅容忍尾部截断行（与 _load 的崩溃残留语义一致），
  // 其余位置 → 拒绝迁移（不允许"带坏数据的日志"被短路或被打上 hash 印章）。
  const recs = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      recs.push(JSON.parse(lines[i]));
    } catch {
      if (i === lines.length - 1) break; // 尾部半行 = 崩溃残留 → 与 _load 相同丢弃
      return { ok: false, migrated: 0, reason: `invalid JSON at line ${i + 1}` };
    }
  }
  if (recs.length === 0) return { ok: true, migrated: 0 };

  // Step 2 — 格式判定：出现任何事务标记（tx_begin/tx_commit/txId 字段）→ 文件声明为 transactional。
  // 用容错检测（匹配 _load 语义）：容忍尾部未闭合事务作为崩溃残留；
  // 但拒绝所有其他协议违规（legacy 混排、nested tx、orphan record 等）。
  // 这与 validateTransactionalLog()（严格，拒绝尾部未闭合）语义分离。
  const hasTxMarkers = recs.some((r) => r && (r.kind === "tx_begin" || r.kind === "tx_commit" || r.txId));
  if (hasTxMarkers) {
    const v = checkTolerantTransactional(recs);
    if (!v.ok) return { ok: false, migrated: 0, reason: `transactional log corrupt: ${v.reason}` };
    return { ok: true, migrated: 0, reason: "already transactional" };
  }

  // Step 3 — legacy 格式 schema validation（必填字段 + 类型检查）
  for (let i = 0; i < recs.length; i++) {
    const err = validateLegacyRecord(recs[i]);
    if (err) return { ok: false, migrated: 0, reason: `record at line ${i + 1}: ${err}` };
  }

  // Step 3b — 语义验证：复用 World transition 规则（dry-run replay + 语义完整性检查）。
  // 不维护第二套 migration 专用语义规则。（v0.12.25 审查 P1-2）
  const semErr = validateLegacySemantics(recs);
  if (semErr) return { ok: false, migrated: 0, reason: `semantic validation failed: ${semErr}` };

  // Step 4 — 全部验证通过 → 纯函数构造 transactional 输出（此阶段不再失败，尚未触碰磁盘）。
  const outLines = [];
  let migrated = 0;
  for (const rec of recs) {
    const txId = crypto.randomUUID();
    outLines.push(JSON.stringify({ schemaVersion: 1, kind: "tx_begin", txId }));
    if (AUTHORITATIVE_KINDS.has(rec.kind)) {
      const full = { schemaVersion: 1, ...rec };
      const h = worldRecordHash(full);
      outLines.push(JSON.stringify({ ...full, txId, eventHash: h }));
      migrated++;
    } else {
      outLines.push(JSON.stringify({ schemaVersion: 1, txId, ...rec }));
    }
    outLines.push(JSON.stringify({ schemaVersion: 1, kind: "tx_commit", txId }));
  }

  // Step 5 — 原子替换：写临时文件 → rename 覆盖（备份原文件）。
  const bakFile = logFile + ".bak.v1";
  const tmpFile = logFile + ".migrating";
  try {
    fs.writeFileSync(tmpFile, outLines.join("\n") + "\n", "utf8");
    fs.renameSync(logFile, bakFile);
    fs.renameSync(tmpFile, logFile);
  } catch (err) {
    return { ok: false, migrated, reason: `write failed: ${err.message}` };
  }
  return { ok: true, migrated };
}

/**
 * v0.12.25 (审查 P1-1): transactional 日志严格验证——拒绝尾部未闭合事务。
 * 这是"日志完整性检查"，不是"容错加载"。
 * 容错加载（容忍尾部 crash 残留）由 WorldModel._load 自身处理。
 * 严格验证：tx_begin(txId) → RECORD(txId)×N → tx_commit(txId)
 * 所有权威记录必须 eventHash 存在且正确；任何协议违规 → fail。
 * @returns {{ok: boolean, reason?: string}}
 */
function validateTransactionalLog(recs) {
  let pending = null; // {txId, records: []}
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r || typeof r !== "object") return { ok: false, reason: `line ${i + 1}: not an object` };
    if (!r.txId) return { ok: false, reason: `line ${i + 1}: record without txId inside transactional log` };
    if (r.kind === "tx_begin") {
      if (pending) return { ok: false, reason: `line ${i + 1}: nested tx_begin while tx ${pending.txId} open` };
      pending = { txId: r.txId, records: [] };
    } else if (r.kind === "tx_commit") {
      if (!pending) return { ok: false, reason: `line ${i + 1}: orphan tx_commit` };
      if (pending.txId !== r.txId) return { ok: false, reason: `line ${i + 1}: tx_commit txId mismatch (${r.txId} vs ${pending.txId})` };
      // 提交点验证事务内全部权威记录
      for (const rec of pending.records) {
        if (!AUTHORITATIVE_KINDS.has(rec.kind)) continue;
        const h = worldRecordHash(rec);
        if (!rec.eventHash) return { ok: false, reason: `authoritative ${rec.kind} missing eventHash` };
        if (h !== rec.eventHash) return { ok: false, reason: `${rec.kind} eventHash mismatch (record modified)` };
      }
      pending = null;
    } else {
      if (!pending) return { ok: false, reason: `line ${i + 1}: record ${r.kind} without tx_begin` };
      if (pending.txId !== r.txId) return { ok: false, reason: `line ${i + 1}: record txId mismatch (${r.txId} vs ${pending.txId})` };
      pending.records.push(r);
    }
  }
  if (pending) return { ok: false, reason: `uncommitted transaction ${pending.txId} at end of log (no tx_commit)` };
  return { ok: true };
}

/** 可被迁移/加载的合法 kind（权威 + telemetry），其余一律拒绝 */
const MIGRATABLE_KINDS = new Set([...AUTHORITATIVE_KINDS, "event"]);

/**
 * v0.12.24 (审查 P1): legacy 记录的 schema + semantic validation——
 * migration 不能给历史垃圾数据"盖 hash 印章"。任一条非法 → 整个迁移失败，原文件不动。
 * @returns {string|null} 错误消息或 null（合法）
 */
function validateLegacyRecord(rec) {
  if (!rec || typeof rec !== "object" || Array.isArray(rec)) return "not a record object";
  const { kind } = rec;
  if (!kind || typeof kind !== "string") return "missing kind";
  if (!MIGRATABLE_KINDS.has(kind)) return `unsupported kind: ${String(kind)}`;
  const needNonEmptyStr = (v, field) =>
    typeof v !== "string" || v.trim() === "" ? `${field} must be a non-empty string` : null;
  switch (kind) {
    case "entity": {
      const err = needNonEmptyStr(rec.id, "id") || needNonEmptyStr(rec.type, "type");
      if (err) return err;
      if (rec.name !== undefined && typeof rec.name !== "string") return "name must be a string";
      if (rec.meta !== undefined && (typeof rec.meta !== "object" || rec.meta === null || Array.isArray(rec.meta))) return "meta must be an object";
      break;
    }
    case "agent": {
      const err = needNonEmptyStr(rec.id, "id");
      if (err) return err;
      if (rec.name !== undefined && typeof rec.name !== "string") return "name must be a string";
      if (rec.capabilities !== undefined && !Array.isArray(rec.capabilities)) return "capabilities must be an array";
      break;
    }
    case "evidence": {
      if (rec.subject === undefined || rec.subject === null || rec.subject === "") return "subject required";
      if (rec.predicate === undefined || rec.predicate === null || rec.predicate === "") return "predicate required";
      if (rec.object === undefined) return "object required";
      if (rec.evidenceId !== undefined && rec.evidenceId !== null && typeof rec.evidenceId !== "string") return "evidenceId must be a string";
      if (rec.source !== undefined && rec.source !== null) {
        try { normalizeSource(rec.source); } catch (err) { return err.message; }
      }
      break;
    }
    case "claim_retracted": {
      const err = needNonEmptyStr(rec.id, "id");
      if (err) return err;
      break;
    }
    case "evidence_retracted": {
      const err = needNonEmptyStr(rec.claimId, "claimId");
      if (err) return err;
      break;
    }
    case "relation": {
      const err =
        needNonEmptyStr(rec.from, "from") ||
        needNonEmptyStr(rec.type, "type") ||
        needNonEmptyStr(rec.to, "to");
      if (err) return err;
      break;
    }
    case "event": {
      if (!rec.data || typeof rec.data !== "object" || Array.isArray(rec.data)) return "data must be an object";
      break;
    }
  }
  if (rec.ts !== undefined && (typeof rec.ts !== "number" || !Number.isFinite(rec.ts))) return "ts must be a finite number";
  return null;
}

/**
 * v0.12.25 (审查 P1-1): 容错 transactional 检测——匹配 _load 的 crash-tolerant 加载语义。
 * 用于 migrateWorldLog 的 "already transactional" 判定。与 validateTransactionalLog()（严格）
 * 语义分离：容忍尾部未闭合事务（crash 残留），拒绝所有其他协议违规。
 * @returns {{ok: boolean, reason?: string}}
 */
function checkTolerantTransactional(recs) {
  let pending = null;
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i];
    if (!r || typeof r !== "object") return { ok: false, reason: `line ${i + 1}: not an object` };
    if (!r.txId) return { ok: false, reason: `line ${i + 1}: record without txId inside transactional log` };
    if (r.kind === "tx_begin") {
      if (pending) return { ok: false, reason: `line ${i + 1}: nested tx_begin while tx ${pending.txId} open` };
      pending = { txId: r.txId, records: [] };
    } else if (r.kind === "tx_commit") {
      if (!pending) return { ok: false, reason: `line ${i + 1}: orphan tx_commit` };
      if (pending.txId !== r.txId) return { ok: false, reason: `line ${i + 1}: tx_commit txId mismatch` };
      for (const rec of pending.records) {
        if (!AUTHORITATIVE_KINDS.has(rec.kind)) continue;
        const h = worldRecordHash(rec);
        if (!rec.eventHash) return { ok: false, reason: `authoritative ${rec.kind} missing eventHash` };
        if (h !== rec.eventHash) return { ok: false, reason: `${rec.kind} eventHash mismatch` };
      }
      pending = null;
    } else {
      if (!pending) return { ok: false, reason: `line ${i + 1}: record ${r.kind} without tx_begin` };
      if (pending.txId !== r.txId) return { ok: false, reason: `line ${i + 1}: record txId mismatch` };
      pending.records.push(r);
    }
  }
  // 容忍尾部未闭合事务（与 _load 一致：crash 残留丢弃）
  return { ok: true };
}

/**
 * v0.12.27 (审查 P1): 旧日志语义完整性验证——纯 state-in/state-out（不依赖 WorldModel 实例），
 * 复用唯一纯状态转换函数 applyWorldTransition()。
 * 对每条记录做试运行重放并检查：
 * - claim_retracted / evidence_retracted 必须引用已存在的 claim（与正常 API retractEvidence 对齐）
 * - relation 前向引用允许（世界允许先有关系后建实体）
 * - 记录 ts 必须为有限数值（确定性：禁止回退到当前时间）
 * @param {object[]} recs legacy 记录数组
 * @returns {string|null} 错误消息或 null（合法）
 */
function validateLegacySemantics(recs) {
  let state = initWorldState();
  for (let i = 0; i < recs.length; i++) {
    const rec = recs[i];
    if (!Number.isFinite(rec.ts)) {
      return `record at position ${i}: ts must be a finite number (got: ${rec.ts}) — 确定性重放要求权威记录自带时间戳`;
    }
    // 仅必要检查：retraction 必须引用已有 claim（正常 API retractEvidence 无 claim → return false，不写盘）
    if (rec.kind === "claim_retracted") {
      if (!state.claims.has(rec.id)) {
        return `claim_retracted at position ${i}: claim "${rec.id}" does not exist in world`;
      }
    }
    if (rec.kind === "evidence_retracted") {
      const c = state.claims.get(rec.claimId);
      if (!c) {
        return `evidence_retracted at position ${i}: claim "${rec.claimId}" does not exist in world`;
      }
      if (rec.evidenceId) {
        const found = c.evidence.some((e) => e.evidenceId === rec.evidenceId);
        if (!found) return `evidence_retracted at position ${i}: evidence "${rec.evidenceId}" not found in claim "${rec.claimId}"`;
      }
    }
    // 与重放完全相同的状态转换规则（幂等追加合并）
    try {
      state = applyWorldTransition(state, rec);
    } catch (err) {
      return `record at position ${i}: transition failed — ${err.message}`;
    }
  }
  return null;
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
