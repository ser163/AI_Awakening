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
});
