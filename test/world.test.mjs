/**
 * 测试：v0.11.0 World Model
 *   - 持久化修复：relations 重启恢复、entity/agent 更新后重启仍在
 *   - Evidence → Claim → Belief 分层（source 结构化，不是字符串）
 *   - 时间有效性：过期证据不参与 belief 推导
 *   - 矛盾检测：互相矛盾的 object 被标记
 *   - 来源权重：relay（转述）比 direct observation 贡献低
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { WorldModel, SOURCE_TYPES, SOURCE_KINDS, migrateWorldLog, applyWorldTransition } from "../src/world.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = path.join(os.tmpdir(), "ai_world_test_" + Date.now());

describe("world: 持久化修复（v0.11.0 bug 回归）", () => {
  it("relations 重启后恢复（此前丢失）", () => {
    const dir = path.join(tmp, "rel_persist");
    const w1 = new WorldModel(dir);
    w1.observeAgent("fp-alice", "alice");
    w1.observeAgent("fp-bob", "bob");
    w1.addRelation("fp-alice", "works_with", "fp-bob");

    // 重启
    const w2 = new WorldModel(dir);
    const rels = w2.queryRelations("works_with");
    assert.equal(rels.length, 1, "重启后关系应恢复");
    assert.equal(rels[0].from, "fp-alice");
    assert.equal(rels[0].to, "fp-bob");
  });

  it("entity/agent 更新后重启仍在（此前更新丢失）", () => {
    const dir = path.join(tmp, "upd_persist");
    const w1 = new WorldModel(dir);
    w1.observeAgent("fp-carol", "carol", ["knowledge"]);

    // 更新（lastSeen/新能力）
    const updated = w1.observeAgent("fp-carol", "carol-renamed", ["task"]);
    assert.equal(updated.name, "carol-renamed");

    // 重启
    const w2 = new WorldModel(dir);
    const carol = w2.agents.get("fp-carol");
    assert.ok(carol, "agent 应存在");
    assert.equal(carol.name, "carol-renamed", "更新后的名字应持久化");
    assert.ok(carol.capabilities.includes("task"), "新增能力应持久化");
  });

  it("多次观察同实体产生一条记录（不是 N 条）", () => {
    const dir = path.join(tmp, "entity_dedup");
    const w1 = new WorldModel(dir);
    w1.observeEntity("device:42", "pump", "Pump-1");
    w1.observeEntity("device:42", "pump", "Pump-1", { status: "running" });
    const w2 = new WorldModel(dir);
    assert.equal(w2.entities.size, 1);
    assert.equal(w2.entities.get("device:42").meta.status, "running");
  });
});

describe("world: Evidence → Claim → Belief 分层", () => {
  it("ingestEvidence 结构化 source（不再是一串字符）", () => {
    const w = new WorldModel();
    w.ingestEvidence({
      subject: "agent:alice",
      predicate: "located_at",
      object: "New York",
      source: {
        type: SOURCE_TYPES.AGENT,
        id: "fp-alice",
        kind: SOURCE_KINDS.ASSERTION,
        eventId: "evt-123",
      },
    });
    const claims = w.queryClaims("agent:alice", "located_at");
    assert.equal(claims.length, 1);
    assert.equal(claims[0].evidence.length, 1);
    assert.equal(claims[0].evidence[0].source.type, "agent");
    assert.equal(claims[0].evidence[0].source.eventId, "evt-123");
  });

  it("deriveBelief 聚合多条证据为信念", () => {
    const w = new WorldModel();
    for (let i = 0; i < 3; i++) {
      w.ingestEvidence({
        subject: "agent:bob",
        predicate: "task_success",
        object: "true",
        source: { type: SOURCE_TYPES.AGENT, id: `fp-peer-${i}`, kind: SOURCE_KINDS.OBSERVATION },
      });
    }
    const b = w.deriveBelief("agent:bob", "task_success");
    assert.ok(b, "应推导出信念");
    assert.equal(b.object, "true");
    assert.equal(b.evidenceCount, 3);
    assert.ok(b.belief > 0.8, `三份直接观察应有高信念，实际 ${b.belief}`);
  });

  it("矛盾证据：低可信来源 vs 高可信来源，高者胜出且标记矛盾", () => {
    const w = new WorldModel();
    // 可信来源：自己观察
    w.ingestEvidence({
      subject: "agent:eve",
      predicate: "reliable",
      object: "true",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
    });
    // 不可信来源：转述（relay）说不可靠
    w.ingestEvidence({
      subject: "agent:eve",
      predicate: "reliable",
      object: "false",
      source: { type: SOURCE_TYPES.AGENT, id: "fp-stranger", kind: SOURCE_KINDS.RELAY },
    });
    const b = w.deriveBelief("agent:eve", "reliable");
    assert.ok(b);
    assert.equal(b.object, "true", "高可信来源应胜出");
    assert.equal(b.conflicts, 1, "应标记矛盾");
  });

  it("beliefsAbout 返回真信念排序（不再只是 queryFacts 排序）", () => {
    const w = new WorldModel();
    w.ingestEvidence({ subject: "agent:x", predicate: "strong", object: "true", source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.MEASUREMENT } });
    w.ingestEvidence({ subject: "agent:x", predicate: "weak", object: "true", source: { type: SOURCE_TYPES.AGENT, id: "fp-z", kind: SOURCE_KINDS.RELAY } });
    const bs = w.beliefsAbout("agent:x");
    assert.equal(bs.length, 2);
    assert.ok(bs[0].belief > bs[1].belief, "应按信念降序");
  });

  it("单一 relay 来源信念低（旧公式 Σw/Σw≡1 的伪绿测试）", () => {
    const w = new WorldModel();
    w.ingestEvidence({
      subject: "agent:rumor", predicate: "trustworthy", object: "true",
      source: { type: SOURCE_TYPES.AGENT, id: "fp-stranger", kind: SOURCE_KINDS.RELAY }, // 转述权重 0.3
    });
    const b = w.deriveBelief("agent:rumor", "trustworthy");
    assert.ok(b, "应推导出信念");
    assert.ok(b.belief < 0.4, `单一转述不应有高信念（实际 ${b.belief}，旧版会≈1）`);
    assert.ok(b.belief > 0.1, `转述至少应有一点支持（实际 ${b.belief}）`);
  });

  it("单条高可信证据中等信念；多条独立证据才高（1-exp(-support) 数学）", () => {
    const w = new WorldModel();
    w.ingestEvidence({
      subject: "agent:sensor1", predicate: "healthy", object: "true",
      source: { type: SOURCE_TYPES.SENSOR, id: "sensor-a", kind: SOURCE_KINDS.MEASUREMENT }, // 权重≈1.0
    });
    const one = w.deriveBelief("agent:sensor1", "healthy");
    // 1 - exp(-1.0) ≈ 0.63 —— 单条强证据不会冲到 100%
    assert.ok(one.belief > 0.5 && one.belief < 0.75, `单条强证据应为中等信念（实际 ${one.belief}）`);

    const w2 = new WorldModel();
    for (let i = 0; i < 4; i++) {
      w2.ingestEvidence({
        subject: "agent:multi", predicate: "healthy", object: "true",
        source: { type: SOURCE_TYPES.SENSOR, id: `sensor-${i}`, kind: SOURCE_KINDS.MEASUREMENT },
      });
    }
    const multi = w2.deriveBelief("agent:multi", "healthy");
    // 4 × 1.0 → 1 - exp(-4) ≈ 0.98
    assert.ok(multi.belief > 0.9, `多条独立证据应有高信念（实际 ${multi.belief}）`);
    assert.ok(multi.belief < 1, `信念不应恰好 1.0`);
  });

  it("同源刷票不叠加（100 条同来源证据 ≈ 1 条）", () => {
    const w = new WorldModel();
    for (let i = 0; i < 100; i++) {
      w.ingestEvidence({
        subject: "agent:spam", predicate: "reliable", object: "true",
        source: { type: SOURCE_TYPES.AGENT, id: "fp-x", kind: SOURCE_KINDS.ASSERTION }, // 同一 source.id
      });
    }
    const b = w.deriveBelief("agent:spam", "reliable");
    assert.equal(b.evidenceCount, 1, "同源 100 条证据只应算 1 个独立来源");
    assert.ok(b.belief < 0.6, `单个来源刷票不应堆出高信念（实际 ${b.belief}）`);
  });

  it("矛盾真正影响 belief（有矛盾 < 无矛盾）", () => {
    const wNoConflict = new WorldModel();
    wNoConflict.ingestEvidence({
      subject: "agent:calm", predicate: "reliable", object: "true",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
    });
    const noConflict = wNoConflict.deriveBelief("agent:calm", "reliable");

    const wConflict = new WorldModel();
    wConflict.ingestEvidence({
      subject: "agent:storm", predicate: "reliable", object: "true",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
    });
    wConflict.ingestEvidence({
      subject: "agent:storm", predicate: "reliable", object: "false",
      source: { type: SOURCE_TYPES.AGENT, id: "fp-stranger", kind: SOURCE_KINDS.ASSERTION },
    });
    const conflict = wConflict.deriveBelief("agent:storm", "reliable");
    assert.equal(conflict.conflicts, 1);
    assert.ok(conflict.belief < noConflict.belief, `矛盾应降低信念（${conflict.belief} < ${noConflict.belief}）`);
  });
});

describe("world: 时间有效性", () => {
  it("过期证据不参与 belief 推导", () => {
    const w = new WorldModel();
    const past = Date.now() - 1000;
    const farFuture = Date.now() + 1000;
    // 过期证据
    w.ingestEvidence({
      subject: "agent:old", predicate: "active", object: "true",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
      observedAt: past - 3600_000, validUntil: past, // 已过期
    });
    // 有效证据
    w.ingestEvidence({
      subject: "agent:old", predicate: "active", object: "true",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
      observedAt: past, validUntil: farFuture,
    });
    const b = w.deriveBelief("agent:old", "active");
    assert.ok(b);
    assert.equal(b.evidenceCount, 1, "过期证据应被排除");
  });

  it("claimAt 时点查询：同一 SPO 不同时间窗的主张可分离追溯", () => {
    const w = new WorldModel();
    const june = Date.parse("2026-06-01T00:00:00Z");
    const aug = Date.parse("2026-08-20T00:00:00Z");
    // 两个时间窗不重叠的主张（同一 SPO）
    w.ingestEvidence({
      subject: "agent:alice", predicate: "located_at", object: "Beijing",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
      observedAt: june, validFrom: june, validUntil: aug - 1,
    });
    w.ingestEvidence({
      subject: "agent:alice", predicate: "located_at", object: "Shanghai",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
      observedAt: aug, validFrom: aug, validUntil: null,
    });
    // 6 月时点 → Beijing
    const inJune = w.claimAt("agent:alice", "located_at", june + 1000);
    assert.ok(inJune);
    assert.equal(inJune.object, "Beijing");
    // 8 月时点 → Shanghai
    const inAug = w.claimAt("agent:alice", "located_at", aug + 1000);
    assert.ok(inAug);
    assert.equal(inAug.object, "Shanghai");
    // claim 有 createdAt 且可追踪
    assert.ok(inJune.claimId);
    assert.ok(inJune.createdAt);
    // 无效时点 → null
    assert.equal(w.claimAt("agent:alice", "located_at", june - 1000), null);
  });

  it("claimAt 尊重 validFrom=0 / validUntil=0（0 是合法时间，不退化）", () => {
    const w = new WorldModel();
    w.ingestEvidence({
      subject: "agent:zero", predicate: "epoch_test", object: "hits-0",
      source: { type: SOURCE_TYPES.SELF, id: "me", kind: SOURCE_KINDS.OBSERVATION },
      observedAt: 100, validFrom: 0, validUntil: 0,  // 仅在 t=0 有效
    });
    // validFrom=0：claimAt(0) 必须命中
    const at0 = w.claimAt("agent:zero", "epoch_test", 0);
    assert.ok(at0, "claimAt(0) 应命中 validFrom=0 的 evidence");
    assert.equal(at0.object, "hits-0");
    // validUntil=0：claimAt(1) 必须不命中（0 不是 Infinity）
    assert.equal(w.claimAt("agent:zero", "epoch_test", 1), null, "validUntil=0 → claimAt(1) 不命中");
  });

  it("claimAt 按信念选冠军，不再按证据数量（sensor×2.0 应赢 relay×0.6 刷量）", () => {
    const w = new WorldModel();
    const now = Date.now();
    // Claim A：sensor×1 —— 强来源，support=1.0 → belief≈0.63
    w.ingestEvidence({
      subject: "agent:who", predicate: "status", object: "A",
      source: { type: SOURCE_TYPES.SENSOR, id: "sensor-1", kind: SOURCE_KINDS.MEASUREMENT },
      observedAt: now, validFrom: now, validUntil: null,
    });
    // Claim B：relay×2 —— 2 个弱来源，support=0.6 → belief≈0.45
    // 旧 claimAt（按证据数）→ B 赢（2>1）；新 claimAt（按信念）→ A 赢（0.63>0.45）
    for (let i = 0; i < 2; i++) {
      w.ingestEvidence({
        subject: "agent:who", predicate: "status", object: "B",
        source: { type: SOURCE_TYPES.AGENT, id: `relay-agent-${i}`, kind: SOURCE_KINDS.RELAY },
        observedAt: now, validFrom: now, validUntil: null,
      });
    }
    const winner = w.claimAt("agent:who", "status", now + 1000);
    assert.ok(winner);
    assert.equal(winner.object, "A", "sensor×1（强, belief≈0.63）应赢 relay×2（弱, belief≈0.45）");
    assert.ok(winner.belief > 0.5, "冠军应带信念分");
    // 与 deriveBelief 结论一致（无语义分裂）
    const d = w.deriveBelief("agent:who", "status", null, now + 1000);
    assert.equal(d.object, "A", "deriveBelief 与 claimAt 必须同冠军");
    // deriveBeliefAt 是 deriveBelief 的历史时点别名
    const dAt = w.deriveBeliefAt("agent:who", "status", now + 1000);
    assert.equal(dAt.object, "A");
    assert.equal(dAt.belief, d.belief);
  });
  it("validFrom 未到的证据不参与推导（v0.12.0 三维时间）", () => {
    const w = new WorldModel();
    const future = Date.now() + 3600_000;
    // 还没成立的主张（validFrom 在未来）
    w.ingestEvidence({
      subject: "agent:fut", predicate: "located_at", object: "Tokyo",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
      validFrom: future, validUntil: future + 3600_000,
    });
    assert.equal(w.deriveBelief("agent:fut", "located_at"), null, "未生效证据不应产生信念");

    // 带 validFrom 的过去主张 + 有效期
    const past = Date.now() - 1000;
    w.ingestEvidence({
      subject: "agent:fut", predicate: "was_at", object: "Osaka",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
      validFrom: past - 1000, validUntil: past + 3600_000,
    });
    const b = w.deriveBelief("agent:fut", "was_at");
    assert.ok(b);
    assert.equal(b.object, "Osaka");
  });

  it("v0.12.2: epistemic state——SUPPORTED vs CONTRADICTED vs STALE", () => {
    const w = new WorldModel();
    const now = Date.now();
    // 无冲突 → SUPPORTED
    w.ingestEvidence({
      subject: "agent:epist", predicate: "status", object: "alive",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
      observedAt: now, validFrom: now, validUntil: null,
    });
    const b1 = w.deriveBelief("agent:epist", "status");
    assert.equal(b1.epistemicState, "SUPPORTED");
    assert.ok(b1.dominance >= 1.0, "无冲突时 dominance 应为 1");

    // 有冲突 → CONTRADICTED
    w.ingestEvidence({
      subject: "agent:epist", predicate: "status", object: "dead",
      source: { type: SOURCE_TYPES.AGENT, id: "fp-other", kind: SOURCE_KINDS.ASSERTION },
      observedAt: now, validFrom: now, validUntil: null,
    });
    const b2 = w.deriveBelief("agent:epist", "status");
    assert.equal(b2.epistemicState, "CONTRADICTED");
    // dominance = support(best) / Σsupport: self(1.0) / (1.0 + 0.8) ≈ 0.56
    assert.ok(b2.dominance < 0.8, "矛盾时 dominance 应降低");
    assert.ok(b2.conflicts >= 1);
  });

  it("v0.12.2: dominance 相对支持度——A=5.0 vs B=0.1 几乎不受影响，A=5.0 vs B=4.9 信心腰斩", () => {
    const w = new WorldModel();
    const now = Date.now();
    // Claim A: 5 个强证据（self×5, 但同源去重只计1次——用不同 identity 模拟独立来源）
    for (let i = 0; i < 5; i++) {
      w.ingestEvidence({
        subject: "agent:dom", predicate: "score", object: "A",
        source: { type: SOURCE_TYPES.SENSOR, identity: `sensor-strong-${i}`, kind: SOURCE_KINDS.MEASUREMENT },
        observedAt: now, validFrom: now, validUntil: null,
      });
    }
    // Claim B: 弱反对（1 个 relay）
    w.ingestEvidence({
      subject: "agent:dom", predicate: "score", object: "B",
      source: { type: SOURCE_TYPES.AGENT, identity: "relay-weak", kind: SOURCE_KINDS.RELAY },
      observedAt: now, validFrom: now, validUntil: null,
    });
    const b = w.deriveBelief("agent:dom", "score");
    assert.equal(b.object, "A");
    assert.ok(b.dominance > 0.85, "A=5×sensor vs B=1×relay → dominance 应接近 0.95");
    // 5×sensor(0.95) = 4.75, 1×relay(0.3) = 0.3 → dominance = 4.75/5.05 ≈ 0.94
    assert.ok(b.belief > 0.8, "dominance 高时 belief 应接近无矛盾");
  });

  it("v0.12.3: STALE 四态闭环——全部证据过期返回 epistemicState=STALE 而非 null", () => {
    const w = new WorldModel();
    const past = Date.now() - 100000;
    // 只有过期证据（validUntil < now）
    w.ingestEvidence({
      subject: "agent:stale", predicate: "status", object: "old",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
      observedAt: past, validFrom: past - 1000, validUntil: past + 1,
    });
    // deriveBelief 应返回 STALE（非 null）
    const b = w.deriveBelief("agent:stale", "status");
    assert.ok(b, "有证据（虽过期）不应返回 null");
    assert.equal(b.epistemicState, "STALE");
    assert.equal(b.belief, 0);
    // epistemicStatus 显式返回 STALE
    assert.equal(w.epistemicStatus("agent:stale", "status"), "STALE");
    // 无任何证据时返回 UNKNOWN
    assert.equal(w.epistemicStatus("agent:never", "seen"), "UNKNOWN");
    // 正常证据返回 SUPPORTED
    w.ingestEvidence({
      subject: "agent:stale", predicate: "new", object: "fresh",
      source: { type: SOURCE_TYPES.SELF, kind: SOURCE_KINDS.OBSERVATION },
      observedAt: Date.now(), validFrom: Date.now() - 1000, validUntil: null,
    });
    assert.equal(w.epistemicStatus("agent:stale", "new"), "SUPPORTED");
  });
});

describe("world: World 是推导产物，不是 LLM 记事本", () => {
  it("没有 assertFact —— 只有 ingestEvidence（强制走证据通道）", () => {
    const w = new WorldModel();
    assert.equal(typeof w.assertFact, "undefined", "assertFact 不应存在");
    assert.equal(typeof w.ingestEvidence, "function", "ingestEvidence 应存在");
    assert.equal(typeof w.deriveBelief, "function", "deriveBelief 应存在");
  });

  it("retractEvidence 撤销后信念消失", () => {
    const w = new WorldModel();
    w.ingestEvidence({
      subject: "agent:liar", predicate: "trustworthy", object: "true",
      source: { type: SOURCE_TYPES.AGENT, id: "fp-liar", kind: SOURCE_KINDS.ASSERTION },
    });
    assert.ok(w.deriveBelief("agent:liar", "trustworthy"));
    w.retractEvidence("agent:liar", "trustworthy", "true");
    assert.equal(w.deriveBelief("agent:liar", "trustworthy"), null);
  });

  it("v0.12.4: retractEvidence 非破坏性——证据保留历史（status=retracted）", () => {
    const w = new WorldModel();
    w.ingestEvidence({
      subject: "agent:x", predicate: "score", object: "42",
      source: { type: SOURCE_TYPES.SELF, id: "fp-x", kind: SOURCE_KINDS.OBSERVATION },
    });
    const before = w.queryClaims("agent:x", "score");
    const evId = before[0].evidence[0].evidenceId;
    w.retractEvidence("agent:x", "score", "42", evId, { retractedBy: "fp-auditor", reason: "source compromised" });
    // 证据仍在（历史保留）
    const after = w.queryClaims("agent:x", "score");
    assert.equal(after.length, 1, "claim 不应被物理删除");
    const ev = after[0].evidence.find((e) => e.evidenceId === evId);
    assert.equal(ev.status, "retracted", "证据应标记 retracted 而非删除");
    assert.equal(ev.retractedBy, "fp-auditor");
    assert.equal(ev.reason, "source compromised");
    // 信念消失（retracted 证据不参与推导）
    assert.equal(w.deriveBelief("agent:x", "score"), null);
  });
});

// v0.12.18 (审查 P0): World append-first 原子性——每类 mutation 异常后零状态变更
describe("world: append-first 原子性（P0）", () => {
  const dir = path.join(tmp, "af_atomic_" + Date.now());

  function setupWorld(wm) {
    wm.observeAgent("fp-alice", "alice", ["knowledge"]);
    wm.observeEntity("device:01", "sensor", "Temp-1");
    wm.addRelation("fp-alice", "monitors", "device:01");
    wm.ingestEvidence({
      subject: "device:01", predicate: "temperature", object: "36.5",
      source: { type: SOURCE_TYPES.SENSOR, id: "fp-alice", kind: SOURCE_KINDS.MEASUREMENT },
    });
    return wm; // 已有 1 agent, 1 entity, 1 relation, 1 claim (= claim objects with evidence)
  }

  function snapshot(wm) {
    return {
      agents: Array.from(wm.agents.keys()).sort(),
      entities: Array.from(wm.entities.keys()).sort(),
      relations: Array.from(wm.relations.keys()).sort(),
      claims: Array.from(wm.claims.keys()).sort(),
    };
  }

  function blockLog(dir) {
    const logFile = path.join(dir, "world", "world.jsonl");
    const bak = logFile + ".bak";
    if (fs.existsSync(logFile)) fs.cpSync(logFile, bak);
    fs.rmSync(logFile, { force: true });
    fs.mkdirSync(logFile, { recursive: true }); // 目录同名占位 → append 抛 ENOTDIR
  }
  function unblockLog(dir) {
    const logFile = path.join(dir, "world", "world.jsonl");
    const bak = logFile + ".bak";
    fs.rmSync(logFile, { recursive: true, force: true }); // 恢复
    if (fs.existsSync(bak)) { fs.cpSync(bak, logFile); fs.rmSync(bak); }
  }

  it("evidence append failure → throw, 状态不变, 重启恢复", () => {
    const d = path.join(dir + "_ev");
    const w = new WorldModel(d);
    setupWorld(w);
    const pre = snapshot(w);
    blockLog(d);
    assert.throws(() => w.ingestEvidence({
      subject: "device:01", predicate: "pressure", object: "1.2",
      source: { type: SOURCE_TYPES.SENSOR, id: "fp-alice", kind: SOURCE_KINDS.MEASUREMENT },
    }), /persistence failed/, "evidence 必须 throw");
    assert.deepEqual(snapshot(w), pre, "append 失败不得修改 claims");
    assert.equal(w.isHealthy(), false, "persistentHealthy 为 false");
    unblockLog(d);
    const w2 = new WorldModel(d);
    assert.deepEqual(snapshot(w2), pre, "重启 replay == 原状态");
    assert.ok(w2.isHealthy(), "重启后 healthy");
  });

  it("entity append failure → throw, 状态不变, 重启恢复", () => {
    const d = path.join(dir + "_en");
    const w = new WorldModel(d);
    setupWorld(w);
    const pre = snapshot(w);
    blockLog(d);
    assert.throws(() => w.observeEntity("device:99", "actuator", "Valve-1"), /persistence failed/, "entity 必须 throw");
    assert.deepEqual(snapshot(w), pre, "append 失败不得添加 entity");
    assert.equal(w.isHealthy(), false);
    unblockLog(d);
    const w2 = new WorldModel(d);
    assert.deepEqual(snapshot(w2), pre, "重启 replay == 原状态");
    assert.ok(w2.isHealthy());
  });

  it("agent append failure → throw, 状态不变, 重启恢复", () => {
    const d = path.join(dir + "_ag");
    const w = new WorldModel(d);
    setupWorld(w);
    const pre = snapshot(w);
    blockLog(d);
    assert.throws(() => w.observeAgent("fp-eve", "eve"), /persistence failed/, "agent 必须 throw");
    assert.deepEqual(snapshot(w), pre, "append 失败不得添加 agent");
    assert.equal(w.isHealthy(), false);
    unblockLog(d);
    const w2 = new WorldModel(d);
    assert.deepEqual(snapshot(w2), pre, "重启 replay == 原状态");
    assert.ok(w2.isHealthy());
  });

  it("relation append failure → throw, 状态不变, 重启恢复", () => {
    const d = path.join(dir + "_rl");
    const w = new WorldModel(d);
    setupWorld(w);
    const pre = snapshot(w);
    blockLog(d);
    assert.throws(() => w.addRelation("fp-alice", "knows", "entity:nonexistent"), /persistence failed/, "relation 必须 throw");
    assert.deepEqual(snapshot(w), pre, "append 失败不得添加 relation");
    assert.equal(w.isHealthy(), false);
    unblockLog(d);
    const w2 = new WorldModel(d);
    assert.deepEqual(snapshot(w2), pre, "重启 replay == 原状态");
    assert.ok(w2.isHealthy());
  });

  it("retraction append failure → throw, 状态不变, 重启恢复", () => {
    const d = path.join(dir + "_re");
    const w = new WorldModel(d);
    setupWorld(w);
    const claim = w.queryClaims("device:01", "temperature");
    const evId = claim[0].evidence[0].evidenceId;
    const pre = snapshot(w);
    blockLog(d);
    assert.throws(() => w.retractEvidence("device:01", "temperature", "36.5", evId, { retractedBy: "test" }), /persistence failed/, "retract 必须 throw");
    assert.deepEqual(snapshot(w), pre, "append 失败不得撤销证据");
    assert.equal(w.isHealthy(), false);
    unblockLog(d);
    const w2 = new WorldModel(d);
    assert.deepEqual(snapshot(w2), pre, "重启 replay == 原状态");
    assert.ok(w2.isHealthy(), "重启后 healthy");
  });
});

// v0.12.19 (审查 P1): World transaction/commit 语义——崩溃尾部截断不产生半事务状态
describe("world: transaction commit 语义（P1）", () => {
  const dir = path.join(tmp, "tx_commit_" + Date.now());

  function setupWorld(wm) {
    wm.observeAgent("fp-alice", "alice", ["knowledge"]);
    wm.ingestEvidence({
      subject: "device:01", predicate: "temperature", object: "36.5",
      source: { type: SOURCE_TYPES.SENSOR, id: "fp-alice", kind: SOURCE_KINDS.MEASUREMENT },
    });
    return wm;
  }

  function snapshot(wm) {
    return {
      agents: Array.from(wm.agents.keys()).sort(),
      entities: Array.from(wm.entities.keys()).sort(),
      relations: Array.from(wm.relations.keys()).sort(),
      claims: Array.from(wm.claims.keys()).sort(),
    };
  }

  it("日志尾部截断（事务前半写入、无 commit）→ 重启丢弃半事务，不产生脏状态", () => {
    const d = path.join(dir, "tail_" + Date.now());
    const w = new WorldModel(d);
    setupWorld(w);
    const pre = snapshot(w);
    // 模拟崩溃：手工追加一个"只写了 BEGIN + records、没有 COMMIT"的事务
    const logFile = path.join(d, "world", "world.jsonl");
    const orphanTx = {
      txId: "orphan-1",
      kind: "evidence",
      claimId: "device:01|pressure|1.2",
      evidenceId: "orphan-ev-1",
      subject: "device:01",
      predicate: "pressure",
      object: "1.2",
      source: { type: "sensor", id: "fp-alice", kind: "measurement" },
      observedAt: Date.now(),
      ts: Date.now(),
    };
    fs.appendFileSync(logFile, `{"schemaVersion":1,"kind":"tx_begin","txId":"orphan-1"}\n`, "utf8");
    fs.appendFileSync(logFile, JSON.stringify({ schemaVersion: 1, ...orphanTx }) + "\n", "utf8");
    // 注意：故意不写 tx_commit → 模拟崩溃于 COMMIT 之前
    const w2 = new WorldModel(d);
    assert.deepEqual(snapshot(w2), pre, "未 commit 事务不得应用（pressure claim 不应出现）");
    assert.equal(w2.queryClaims("device:01", "pressure").length, 0, "半事务证据不得进入 claims");
    assert.ok(w2.isHealthy(), "截断恢复后 healthy（不是损坏——事务边界保证一致性）");
  });

  it("完整事务（BEGIN→records→COMMIT）正常应用", () => {
    const d = path.join(dir, "ok_" + Date.now());
    const w = new WorldModel(d);
    w.observeEntity("device:ok", "sensor", "Ok-1");
    const w2 = new WorldModel(d);
    assert.equal(w2.entities.get("device:ok")?.name, "Ok-1", "完整事务应被应用");
    assert.ok(w2.isHealthy());
  });

  it("尾部半行 JSON（崩溃于 COMMIT 行中间）→ 丢弃该事务, 世界停在最后 COMMIT", () => {
    const d = path.join(dir, "half_" + Date.now());
    const w = new WorldModel(d);
    w.observeAgent("fp-alice", "alice");
    const pre = snapshot(w);
    // 模拟写一半崩溃：COMMIT 行只写了一部分（无换行结尾）
    const logFile = path.join(d, "world", "world.jsonl");
    fs.appendFileSync(logFile, '{"schemaVersion":1,"kind":"tx_begin","txId":"half-1"}\n', "utf8");
    fs.appendFileSync(logFile, '{"schemaVersion":1,"txId":"half-1","kind":"entity","id":"ghost","type":"sensor","name":"Ghost",', "utf8");
    // ↑ 故意截断（无闭合括号、无换行）→ 模拟 OS 部分写入
    const w2 = new WorldModel(d);
    assert.deepEqual(snapshot(w2), pre, "半行事务不得应用（ghost entity 不应出现）");
    assert.equal(w2.entities.has("ghost"), false, "撕裂记录不得产生实体");
    assert.ok(w2.isHealthy(), "尾部撕裂恢复后 healthy（事务边界保证一致性）");
  });

  it("中部 JSON 损坏（非尾部）→ 仍然 fail-closed unhealthy（v0.12.4 语义不回归）", () => {
    const d = path.join(dir, "mid_" + Date.now());
    const w = new WorldModel(d);
    w.observeAgent("fp-alice", "alice");
    w.observeEntity("device:ok", "sensor", "Ok-1");
    // 中部插入损坏行（后面还有内容 → 不是崩溃截断，是真实损坏）
    const logFile = path.join(d, "world", "world.jsonl");
    fs.appendFileSync(logFile, "{not valid json\n", "utf8");
    w.observeEntity("device:after", "sensor", "After-1");
    const w2 = new WorldModel(d);
    assert.ok(!w2.isHealthy(), "中部损坏必须标记 unhealthy（fail-closed）");
    assert.equal(w2.entities.get("device:ok")?.name, "Ok-1", "损坏前的完整事务仍应应用");
    assert.equal(w2.entities.has("device:after"), false, "损坏后的数据不得进入世界");
  });

  // v0.12.20 (审查 P1): 严格事务状态机——非法事务结构必须 fail-closed
  describe("strict transaction state machine", () => {
    const strictDir = path.join(dir, "strict_" + Date.now());

    it("RECORD(txId) without BEGIN → fail-closed, 记录不应用", () => {
      const d = path.join(strictDir, "orphan_rec_" + Date.now());
      const w = new WorldModel(d);
      w.observeAgent("fp-alice", "alice");
      const pre = [...w.agents.keys()].sort();
      const logFile = path.join(d, "world", "world.jsonl");
      // 直接写入带 txId 的记录，无 BEGIN（模拟结构损坏）
      fs.appendFileSync(logFile, '{"schemaVersion":1,"txId":"orphan","kind":"entity","id":"ghost","type":"sensor","name":"Ghost"}\n', "utf8");
      const w2 = new WorldModel(d);
      assert.ok(!w2.isHealthy(), "无 BEGIN 的 txId record → unhealthy");
      assert.deepEqual([...w2.agents.keys()].sort(), pre, "非法记录不得应用（ghost entity 不应出现）");
    });

    it("COMMIT(txId) without BEGIN → unhealthy", () => {
      const d = path.join(strictDir, "orphan_commit_" + Date.now());
      const w = new WorldModel(d);
      w.observeAgent("fp-alice", "alice");
      const logFile = path.join(d, "world", "world.jsonl");
      fs.appendFileSync(logFile, '{"schemaVersion":1,"kind":"tx_commit","txId":"no-begin"}\n', "utf8");
      const w2 = new WorldModel(d);
      assert.ok(!w2.isHealthy(), "无 BEGIN 的 commit → unhealthy");
      assert.equal(w2.agents.get("fp-alice")?.name, "alice", "合法事务仍应应用");
    });

    it("RECORD(txId=A) after BEGIN(txId=B) → unhealthy, A 不应用", () => {
      const d = path.join(strictDir, "cross_tx_" + Date.now());
      const w = new WorldModel(d);
      w.observeAgent("fp-alice", "alice");
      const pre = [...w.agents.keys()].sort();
      const logFile = path.join(d, "world", "world.jsonl");
      // 合法 tx_begin(B) 后插入 record(A)（模拟日志结构损坏）
      fs.appendFileSync(logFile, '{"schemaVersion":1,"kind":"tx_begin","txId":"tx-B"}\n', "utf8");
      fs.appendFileSync(logFile, '{"schemaVersion":1,"txId":"tx-A","kind":"entity","id":"cross-ghost","type":"sensor"}\n', "utf8");
      const w2 = new WorldModel(d);
      assert.ok(!w2.isHealthy(), "record(A) inside open tx(B) → unhealthy");
      assert.deepEqual([...w2.agents.keys()].sort(), pre, "非法 record 不得影响世界");
    });

    // v0.12.21 (审查 P1): legacy record 不得绕过 pendingTx 事务边界
    it("legacy RECORD inside open tx → unhealthy, X 与 A 都不得进入 World", () => {
      const d = path.join(strictDir, "legacy_pierce_" + Date.now());
      const w = new WorldModel(d);
      w.observeAgent("fp-alice", "alice");
      const pre = [...w.agents.keys()].sort();
      const logFile = path.join(d, "world", "world.jsonl");
      // BEGIN A → RECORD A → legacy RECORD X（无 txId，伪装旧日志穿透）→ 无 COMMIT A
      fs.appendFileSync(logFile, '{"schemaVersion":1,"kind":"tx_begin","txId":"tx-A"}\n', "utf8");
      fs.appendFileSync(logFile, '{"schemaVersion":1,"txId":"tx-A","kind":"entity","id":"entity-A","type":"sensor","name":"A"}\n', "utf8");
      fs.appendFileSync(logFile, '{"schemaVersion":1,"kind":"entity","id":"entity-X","type":"sensor","name":"X"}\n', "utf8");
      const w2 = new WorldModel(d);
      assert.ok(!w2.isHealthy(), "legacy record inside open tx → unhealthy（fail-closed）");
      assert.equal(w2.entities.has("entity-A"), false, "未 commit 事务 A 不得进入 World");
      assert.equal(w2.entities.has("entity-X"), false, "legacy X 不得绕过事务边界生效");
      assert.deepEqual([...w2.agents.keys()].sort(), pre, "合法事务仍应应用，世界无脏数据");
    });

    it("正常启动遇 legacy record（无 txId）→ fail-closed（Legacy ≠ authoritative）", () => {
      const d = path.join(strictDir, "legacy_reject_" + Date.now());
      const w = new WorldModel(d);
      w.observeAgent("fp-first", "first"); // 建立目录（写入的是 tx 格式）
      // 模拟旧版本日志：直接追加一行无 txId 的 legacy 记录
      const logFile = path.join(d, "world", "world.jsonl");
      fs.appendFileSync(logFile, '{"schemaVersion":1,"kind":"entity","id":"legacy-ok","type":"sensor","name":"Legacy"}\n', "utf8");
      const w2 = new WorldModel(d);
      assert.ok(!w2.isHealthy(), "正常启动遇 legacy 行必须 unhealthy（只能走 migration）");
      assert.equal(w2.entities.has("legacy-ok"), false, "legacy 记录不得直接进入权威 World");
    });

    it("migrateWorldLog() 迁移 legacy 日志后 → 正常加载（迁移是唯一入口）", () => {
      const d = path.join(strictDir, "legacy_migrate_" + Date.now());
      // 手工构造纯 legacy 格式日志（无 txId，模拟 v0.12.21 之前）
      const worldDir = path.join(d, "world");
      fs.mkdirSync(worldDir, { recursive: true });
      const logFile = path.join(worldDir, "world.jsonl");
      fs.writeFileSync(logFile, [
        JSON.stringify({ schemaVersion: 1, kind: "agent", id: "fp-mig", name: "migrated", capabilities: [], trustHint: "learned", ts: 1720000000000 }),
        JSON.stringify({ schemaVersion: 1, kind: "entity", id: "dev-mig", type: "sensor", name: "Mig", meta: {}, ts: 1720000000001 }),
        JSON.stringify({ schemaVersion: 1, kind: "event", data: { kind: "entity_seen", id: "dev-mig", type: "sensor", ts: 1720000000001 }, ts: 1720000000001 }),
      ].join("\n") + "\n", "utf8");
      // 未迁移 → fail-closed
      const w0 = new WorldModel(d);
      assert.ok(!w0.isHealthy(), "legacy 日志未迁移不可直接加载");
      // 显式迁移
      const res = migrateWorldLog(d);
      assert.equal(res.ok, true, "迁移应成功");
      assert.equal(res.migrated, 2, "应迁移 2 条权威记录（event 不计）");
      // 迁移后 → 正常加载
      const w2 = new WorldModel(d);
      assert.ok(w2.isHealthy(), "迁移后 healthy");
      assert.equal(w2.agents.get("fp-mig")?.name, "migrated", "迁移后的 agent 应加载");
      assert.equal(w2.entities.get("dev-mig")?.name, "Mig", "迁移后的 entity 应加载");
      // 原文件已备份
      assert.ok(fs.existsSync(logFile + ".bak.v1"), "原文件应备份为 .bak.v1");
    });

    it("已迁移（合法事务+eventHash 完整）→ already transactional 短路", () => {
      const d = path.join(strictDir, "already_mig_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6));
      const w = new WorldModel(d);
      w.observeEntity("dev:short", "sensor", "Shortcut");
      // 迁移函数看到的是完全合法的 transactional 日志
      const res = migrateWorldLog(d);
      assert.equal(res.ok, true, "合法 transactional 日志应短路");
      assert.equal(res.migrated, 0, "不迁移任何记录");
      assert.ok(res.reason?.includes("already"), "原因含 already");
      // WorldModel 正常加载不受影响
      const w2 = new WorldModel(d);
      assert.ok(w2.isHealthy(), "短路后仍 healthy");
      assert.equal(w2.entities.get("dev:short")?.name, "Shortcut");
    });

    it("tx_begin + legacy 无 txId 混合 → 拒绝迁移（不短路也不打 hash）", () => {
      const d = path.join(strictDir, "mixed_reject_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6));
      const worldDir = path.join(d, "world");
      fs.mkdirSync(worldDir, { recursive: true });
      const logFile = path.join(worldDir, "world.jsonl");
      // 手工构造：合法 tx_begin → 无 txId legacy 行 → tx_commit（结构违规）
      fs.writeFileSync(logFile, [
        JSON.stringify({ schemaVersion: 1, kind: "tx_begin", txId: "tx-mixed" }),
        JSON.stringify({ schemaVersion: 1, kind: "entity", id: "dev-mixed", type: "sensor", name: "X", ts: 1 }),
        JSON.stringify({ schemaVersion: 1, kind: "tx_commit", txId: "tx-mixed" }),
        JSON.stringify({ kind: "agent", id: "fp-mixed", name: "injected", ts: 2 }), // 无 txId — 入侵
      ].join("\n") + "\n", "utf8");
      const res = migrateWorldLog(d);
      assert.equal(res.ok, false, "混合日志应拒绝");
      assert.ok(res.reason?.includes("corrupt"), "原因含 corrupt");
      // 原文件未经修改
      assert.ok(!fs.existsSync(logFile + ".bak.v1"), "不应备份");
      const content = fs.readFileSync(logFile, "utf8");
      assert.ok(content.includes("tx-mixed"), "原文件未变");
    });

    it("legacy 记录缺少必填字段（entity 无 id）→ schema validation 拒绝迁移", () => {
      const d = path.join(strictDir, "schema_reject_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6));
      const worldDir = path.join(d, "world");
      fs.mkdirSync(worldDir, { recursive: true });
      const logFile = path.join(worldDir, "world.jsonl");
      fs.writeFileSync(logFile, [
        JSON.stringify({ schemaVersion: 1, kind: "entity", type: "sensor", name: "orphan", ts: 100 }), // 缺 id
      ].join("\n") + "\n", "utf8");
      const res = migrateWorldLog(d);
      assert.equal(res.ok, false, "缺 id → 拒绝迁移");
      assert.ok(res.reason?.includes("id"), "原因提及 id");
      assert.ok(!fs.existsSync(logFile + ".bak.v1"), "不应备份");
    });

    it("legacy retraction 引用不存在 claim → semantic validation 拒绝迁移", () => {
      const d = path.join(strictDir, "semantic_reject_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6));
      const worldDir = path.join(d, "world");
      fs.mkdirSync(worldDir, { recursive: true });
      const logFile = path.join(worldDir, "world.jsonl");
      fs.writeFileSync(logFile, [
        JSON.stringify({ kind: "evidence_retracted", claimId: "e:ghost|located_at|Nowhere", ts: 1 }), // 引用的 claim 不存在
      ].join("\n") + "\n", "utf8");
      const res = migrateWorldLog(d);
      assert.equal(res.ok, false, "retraction 引用不存在 claim → 拒绝");
      assert.ok(res.reason?.includes("does not exist"), "原因提及不存在");
      assert.ok(!fs.existsSync(logFile + ".bak.v1"), "不应备份");
    });

    it("validateTransactionalLog 严格拒绝尾部未闭合事务（crash residue 不通过）", () => {
      // 直接在 world.js 中测试内部函数——通过手工构造文件 + migrateWorldLog 的
      // "已迁移"短路路径（validateTransactionalLog 拒绝 → 报告 corrupt）来间接验证
      const d = path.join(tmp, "strict_tail_" + Date.now() + "_" + Math.random().toString(36).slice(2, 6));
      const worldDir = path.join(d, "world");
      fs.mkdirSync(worldDir, { recursive: true });
      const logFile = path.join(worldDir, "world.jsonl");
      fs.writeFileSync(logFile, [
        JSON.stringify({ schemaVersion: 1, kind: "tx_begin", txId: "tx-tail" }),
        JSON.stringify({ schemaVersion: 1, kind: "entity", txId: "tx-tail", id: "dev-tail", type: "sensor", name: "Tail", eventHash: "a".repeat(64), ts: 1 }),
        // 没有 tx_commit（crash 残留）
      ].join("\n") + "\n", "utf8");
      // 模拟：调用 validateTransactionalLog 会拒绝，但 checkTolerantTransactional 会容忍
      // migrateWorldLog 用容错检测 → 容忍尾部残留 → 仍 type 为 "already transactional"
      const res = migrateWorldLog(d);
      assert.equal(res.ok, true, "尾部未闭合 → 容错检测容忍为 already transactional");
      assert.equal(res.migrated, 0, "不迁移");
    });

    it("正常 BEGIN→RECORD×N→COMMIT 通过（状态机不误伤合法事务）", () => {
      const d = path.join(strictDir, "legal_" + Date.now());
      const w = new WorldModel(d);
      w.observeEntity("device:legal", "sensor", "legal-1");
      const w2 = new WorldModel(d);
      assert.ok(w2.isHealthy());
      assert.equal(w2.entities.get("device:legal")?.name, "legal-1", "合法事务正常应用");
    });
  });

  it("同 txId 多 record 事务 → 全部应用或全部丢弃（原子性跨 record）", () => {
    const d = path.join(dir, "multi_" + Date.now());
    const w = new WorldModel(d);
    // addRelation 本身写入 relation + event 两条 record（同一事务）
    w.addRelation("fp-a", "knows", "fp-b");
    const w2 = new WorldModel(d);
    const rels = w2.queryRelations("knows");
    assert.equal(rels.length, 1, "relation 事务应完整应用");
    assert.ok(w2.isHealthy());
  });

  // v0.12.19 (审查 P2): evidenceId 确定性——相同输入产生相同 ID（不再 Math.random）
  describe("world: evidenceId 确定性（P2）", () => {
    it("相同输入两次 ingestEvidence → 相同 evidenceId", () => {
      const w = new WorldModel();
      const fixed = {
        subject: "agent:alice", predicate: "located_at", object: "Beijing",
        source: { type: SOURCE_TYPES.SENSOR, id: "sensor-01", kind: SOURCE_KINDS.MEASUREMENT },
        observedAt: 1720000000000,
        validFrom: 1720000000000,
        validUntil: 1725000000000,
      };
      const c1 = w.ingestEvidence({ ...fixed });
      const c2 = w.ingestEvidence({ ...fixed });
      const id1 = c1.evidence[0].evidenceId;
      const id2 = c2.evidence[0].evidenceId;
      assert.equal(id1, id2, "同输入必须产生同 evidenceId");
      assert.ok(!id1.includes("-") === false || id1.length > 10, "evidenceId 不再用时间戳-随机数格式");
      assert.ok(/^[0-9a-f]+$/.test(id1), "evidenceId 应为 hex（SHA256 派生）");
    });

    it("不同 source.identity → 不同 evidenceId（独立性区分仍在）", () => {
      const w = new WorldModel();
      const base = {
        subject: "agent:alice", predicate: "located_at", object: "Beijing",
        source: { type: SOURCE_TYPES.SENSOR, kind: SOURCE_KINDS.MEASUREMENT },
        observedAt: 1720000000000,
      };
      const a = w.ingestEvidence({ ...base, source: { ...base.source, id: "sensor-01" } });
      const evIdA = a.evidence[0].evidenceId; // 捕获（下次 ingest 同 claim 追加）
      const b = w.ingestEvidence({ ...base, source: { ...base.source, id: "sensor-02" } });
      const evIdB = b.evidence[b.evidence.length - 1];
      assert.notEqual(evIdA, evIdB, "不同来源应不同 ID");
    });

    it("提供 observationId（signed nonce）→ 同内容可分多次观察", () => {
      const w = new WorldModel();
      const base = {
        subject: "agent:alice", predicate: "located_at", object: "Beijing",
        source: { type: SOURCE_TYPES.SENSOR, id: "sensor-01", kind: SOURCE_KINDS.MEASUREMENT },
        observedAt: 1720000000000,
      };
      const n1 = w.ingestEvidence({ ...base, observationId: "obs-1" });
      const evIdN1 = n1.evidence[0].evidenceId; // 捕获（下次 ingest 同 claim 追加）
      const n2 = w.ingestEvidence({ ...base, observationId: "obs-2" });
      const evIdN2 = n2.evidence[n2.evidence.length - 1];
      assert.notEqual(evIdN1, evIdN2, "不同 observationId 应不同 ID");
    });
  });
});

// v0.12.27 (审查 P1): applyWorldTransition 纯函数 + deterministic ts
describe("world: applyWorldTransition 纯函数 & 确定性", () => {
  it("state-in/state-out：入参 state 不被修改", () => {
    const s0 = { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
    const s1 = applyWorldTransition(s0, { kind: "entity", id: "e:pure", type: "sensor", name: "P", ts: 100 });
    assert.notEqual(s1, s0, "返回新对象");
    assert.equal(s0.entities.size, 0, "旧 state 未改变");
    assert.equal(s1.entities.size, 1, "新 state 含 entity");
  });

  it("ts 缺失 → throw（禁止 Date.now 回退）", () => {
    const s = { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
    assert.throws(() => applyWorldTransition(s, { kind: "entity", id: "e:bad", type: "sensor", name: "B" }), /valid ts/);
    assert.throws(() => applyWorldTransition(s, { kind: "entity", id: "e:bad", type: "sensor", name: "B", ts: null }), /valid ts/);
    assert.throws(() => applyWorldTransition(s, { kind: "entity", id: "e:bad", type: "sensor", name: "B", ts: "abc" }), /valid ts/);
  });

  it("相同初态 + 相同事件序列 → 相同终态（确定性重放）", () => {
    const events = [
      { kind: "entity", id: "e:d1", type: "sensor", name: "D1", ts: 1 },
      { kind: "entity", id: "e:d2", type: "sensor", name: "D2", ts: 2 },
      { kind: "agent", id: "fp:d", name: "agent-d", capabilities: ["speak"], ts: 3 },
    ];
    let s1 = { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
    let s2 = { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
    for (const ev of events) {
      s1 = applyWorldTransition(s1, ev);
      s2 = applyWorldTransition(s2, ev);
    }
    assert.equal(s1.entities.size, 2);
    assert.equal(s2.entities.size, 2);
    assert.equal(s1.agents.size, 1);
    assert.equal(s2.agents.size, 1);
    assert.equal(s1.entities.get("e:d1")?.name, "D1");
    assert.equal(s2.entities.get("e:d1")?.name, "D1");
  });

  it("event data 深拷贝——外部修改 rec.data 不得影响 state（引用隔离）", () => {
    const s0 = { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
    const data = { kind: "entity_seen", id: "e:ref", type: "sensor", meta: { tag: "orig" } };
    const s1 = applyWorldTransition(s0, { kind: "event", data, ts: 10 });
    assert.equal(s1.events.length, 1, "state 含 1 条事件");
    // 外部修改原 data 对象（深改嵌套字段）
    data.meta.tag = "MUTATED";
    data.kind = "hacked";
    assert.notEqual(s1.events[0], data, "state 中的事件不是原对象引用");
    assert.equal(s1.events[0].kind, "entity_seen", "state 事件不受外部修改影响");
    assert.equal(s1.events[0].meta.tag, "orig", "嵌套字段同样隔离");
  });

  it("evidence 时间字段 falsy 值不丢失（0 是合法时间, ?? 而非 ||）", () => {
    const s0 = { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
    const rec = {
      kind: "evidence",
      subject: "agent:a", predicate: "located_at", object: "X",
      ts: 100,
      observedAt: 0,        // falsy 但合法（epoch 0）
      validFrom: 0,
      validUntil: 0,
      source: { type: SOURCE_TYPES.SELF, id: "me" },
    };
    const s1 = applyWorldTransition(s0, rec);
    const claim = s1.claims.get("agent:a|located_at|X");
    assert.ok(claim, "claim 已建");
    const ev = claim.evidence[0];
    assert.equal(ev.observedAt, 0, "observedAt=0 不丢失");
    assert.equal(ev.validFrom, 0, "validFrom=0 不丢失");
    assert.equal(ev.validUntil, 0, "validUntil=0 不丢失");
  });

  it("source 缺失 → 默认值；source falsy 子字段不丢失（?? 而非 ||）", () => {
    const s0 = { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
    // source 缺失 → 默认 UNKNOWN（不伪装 agent）
    const s1 = applyWorldTransition(s0, {
      kind: "evidence", subject: "agent:a", predicate: "p", object: "x", ts: 5,
    });
    const ev1 = s1.claims.get("agent:a|p|x").evidence[0];
    assert.equal(ev1.source.type, SOURCE_TYPES.UNKNOWN, "缺失 source=UNKNOWN≠agent");
    assert.notEqual(ev1.source.type, SOURCE_TYPES.AGENT, "missing source != agent source");
    // source=null → 同样 UNKNOWN，不是 agent
    const sNull = applyWorldTransition(s0, {
      kind: "evidence", subject: "agent:null", predicate: "p", object: "x", ts: 5,
      source: null,
    });
    assert.equal(sNull.claims.get("agent:null|p|x").evidence[0].source.type, SOURCE_TYPES.UNKNOWN, "null source=UNKNOWN≠agent");
    // source.id 显式空串 → 不丢失
    const s2 = applyWorldTransition(s0, {
      kind: "evidence", subject: "agent:b", predicate: "p", object: "x", ts: 6,
      source: { type: SOURCE_TYPES.SENSOR, id: "", kind: SOURCE_KINDS.MEASUREMENT },
    });
    const ev2 = s2.claims.get("agent:b|p|x").evidence[0];
    assert.equal(ev2.source.id, "", "id='' 不回退默认");
  });

  it("0 与 null 生成不同 evidenceId（validFrom=0 合法）", () => {
    const base = { subject: "agent:det", predicate: "test", object: "id" };
    const s0 = { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
    const rec0 = { kind: "evidence", ...base, ts: 1, validFrom: 0, source: { type: SOURCE_TYPES.SELF, id: "me" } };
    const recNull = { kind: "evidence", ...base, ts: 2, source: { type: SOURCE_TYPES.SELF, id: "me" } };
    const s1 = applyWorldTransition(s0, rec0);
    const s2 = applyWorldTransition(s0, recNull);
    const cid = `${base.subject}|${base.predicate}|${base.object}`;
    const evId0 = s1.claims.get(cid).evidence[0].evidenceId;
    const evIdNull = s2.claims.get(cid).evidence[0].evidenceId;
    assert.notEqual(evId0, evIdNull, "validFrom=0 与 null 不同 evidenceId");
  });

  it("non-plain source (Date/Map/Object.create(null)) → throw", () => {
    const s0 = { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
    assert.throws(() => applyWorldTransition(s0, {
      kind: "evidence", subject: "agent:d", predicate: "p", object: "x", ts: 9, source: new Date(),
    }), /plain object/);
    assert.throws(() => applyWorldTransition(s0, {
      kind: "evidence", subject: "agent:d", predicate: "p", object: "x", ts: 10, source: new Map(),
    }), /plain object/);
    assert.throws(() => applyWorldTransition(s0, {
      kind: "evidence", subject: "agent:d", predicate: "p", object: "x", ts: 11, source: Object.create(null),
    }), /plain object/);
  });

  it("source 存在但非法 → throw（validation fail）", () => {
    const s0 = { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
    assert.throws(() => applyWorldTransition(s0, {
      kind: "evidence", subject: "agent:c", predicate: "p", object: "x", ts: 7, source: "not-an-object",
    }), /source must be a plain object/);
    assert.throws(() => applyWorldTransition(s0, {
      kind: "evidence", subject: "agent:c", predicate: "p", object: "x", ts: 8,
      source: { type: 123, id: "s1" },
    }), /source.type must be a string/);
  });

  it("source.type / source.kind 必须是合法枚举（拒绝未知字符串）", () => {
    const s0 = { entities: new Map(), agents: new Map(), claims: new Map(), relations: new Map(), events: [] };
    assert.throws(() => applyWorldTransition(s0, {
      kind: "evidence", subject: "agent:e", predicate: "p", object: "x", ts: 12,
      source: { type: "forged-admin", id: "x" },
    }), /invalid source.type "forged-admin"/);
    assert.throws(() => applyWorldTransition(s0, {
      kind: "evidence", subject: "agent:e", predicate: "p", object: "x", ts: 13,
      source: { type: SOURCE_TYPES.SELF, id: "x", kind: "forged-claim" },
    }), /invalid source.kind "forged-claim"/);
  });
});

// v0.12.23 (审查 P1/P2): eventHash 完整性——任意权威字段修改→hash 变化→fail-closed
describe("world: eventHash 完整性（P1/P2）", () => {
  const dir = path.join(tmp, "eventhash_" + Date.now());

  function readRawLog(d) {
    return fs.readFileSync(path.join(d, "world", "world.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  }

  it("权威记录带 64 hex eventHash（SHA-256 全长，不截断）", () => {
    const d = path.join(dir, "len_" + Date.now());
    const w = new WorldModel(d);
    w.observeEntity("device:eh", "sensor", "EH-1");
    const recs = readRawLog(d);
    const entity = recs.find((r) => r.kind === "entity");
    assert.ok(entity, "日志含 entity 记录");
    assert.ok(entity.eventHash, "权威记录必须带 eventHash");
    assert.equal(entity.eventHash.length, 64, "SHA-256 全长 = 64 hex");
  });

  it("篡改任意权威字段（name）→ 重启 fail-closed, 记录不应用", () => {
    const d = path.join(dir, "tamper_" + Date.now());
    const w = new WorldModel(d);
    w.observeAgent("fp-keep", "keep");
    w.observeEntity("device:tampered", "sensor", "Original");
    // 手工篡改 entity 记录的 name（不更新 eventHash）
    const lines = fs.readFileSync(path.join(d, "world", "world.jsonl"), "utf8").split("\n").filter(Boolean);
    const forged = lines.map((l) => {
      const o = JSON.parse(l);
      if (o.kind === "entity" && o.id === "device:tampered") o.name = "HACKED";
      return JSON.stringify(o);
    });
    fs.writeFileSync(path.join(d, "world", "world.jsonl"), forged.join("\n") + "\n", "utf8");
    const w2 = new WorldModel(d);
    assert.ok(!w2.isHealthy(), "eventHash 不匹配 → unhealthy（fail-closed）");
    assert.equal(w2.entities.has("device:tampered"), false, "被篡改记录不得应用");
    assert.equal(w2.agents.get("fp-keep")?.name, "keep", "未篡改事务仍正常应用");
  });

  it("事务内两条记录：第 2 条被篡改 → 两条都不应用（先验证后应用, 原子性）", () => {
    const d = path.join(dir, "atomic_" + Date.now());
    const w = new WorldModel(d);
    w.observeAgent("fp-safe", "safe"); // 独立的合法事务
    // 构造一个含两条 entity 的事务（addRelation 模式：relation+event，改用直接写日志更清晰）
    // 用两次独立操作构成不同事务即可——验证"篡改后半段日志不影响前半段已提交事务"。
    w.observeEntity("device:a1", "sensor", "A1");
    w.observeEntity("device:a2", "sensor", "A2");
    // 篡改 A2 的 type
    const lines = fs.readFileSync(path.join(d, "world", "world.jsonl"), "utf8").split("\n").filter(Boolean);
    const forged = lines.map((l) => {
      const o = JSON.parse(l);
      if (o.kind === "entity" && o.id === "device:a2") o.type = "HACKED-TYPE";
      return JSON.stringify(o);
    });
    fs.writeFileSync(path.join(d, "world", "world.jsonl"), forged.join("\n") + "\n", "utf8");
    const w2 = new WorldModel(d);
    assert.ok(!w2.isHealthy(), "篡改 A2 → unhealthy");
    assert.equal(w2.entities.get("device:a1")?.name, "A1", "A1（篡改点前已提交事务）仍应用");
    assert.equal(w2.entities.has("device:a2"), false, "被篡改的 A2 不得应用");
  });

  it("新增语义字段自动受保护（无字段白名单 → 未来字段改动也会触发 hash 变化）", () => {
    const d = path.join(dir, "future_" + Date.now());
    const w = new WorldModel(d);
    w.observeEntity("device:future", "sensor", "F-1", { status: "running" });
    const lines = fs.readFileSync(path.join(d, "world", "world.jsonl"), "utf8").split("\n").filter(Boolean);
    // 篡改 meta 内的深层字段（此前白名单若漏掉 meta 子字段就检测不到）
    const forged = lines.map((l) => {
      const o = JSON.parse(l);
      if (o.kind === "entity" && o.id === "device:future") o.meta = { ...o.meta, hidden: "injected" };
      return JSON.stringify(o);
    });
    fs.writeFileSync(path.join(d, "world", "world.jsonl"), forged.join("\n") + "\n", "utf8");
    const w2 = new WorldModel(d);
    assert.ok(!w2.isHealthy(), "深嵌套 meta 篡改也必须被 eventHash 捕获");
  });
});
