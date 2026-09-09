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
import { WorldModel, SOURCE_TYPES, SOURCE_KINDS } from "../src/world.js";
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
    assert.ok(w2.isHealthy());
  });
});
