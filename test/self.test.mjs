/**
 * 测试：v0.8.0 Self-Inquiry 自我叩问层
 *   - 镜子：introspect() 生成自我快照
 *   - 笔：declareSelf() 签名声明 + evolve 记忆 + 自我链版本
 *   - 心智：think() 钩子注入叙事；无心智时诚实默认叙事
 *   - 协议：/self 端点——问"你是谁"，自主应答（public 回答 / private 沉默）
 *   - 叩问：ponder() 广播，peer 收到 ponder:received
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { AgentNode } from "../src/node.js";
import { Registry } from "../src/network.js";
import { Memory } from "../src/memory.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import {
  buildSelfSnapshot,
  createSelfDeclaration,
  validateSelfDeclaration,
  composeMinimalNarrative,
  SELF_VISIBILITY,
} from "../src/self.js";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "ai_self_test_" + Date.now());

describe("self-inquiry: 镜子 (introspect)", () => {
  it("快照聚合记忆为结构化自我事实", () => {
    const mem = new Memory(path.join(tmp, "mirror"), "mirror-node");
    mem.append("birth", { name: "mirror-node" });
    mem.append("knowledge_shared", { id: "k1" });
    mem.append("knowledge_shared", { id: "k2" });
    mem.append("knowledge_received", { id: "k3", from: "peerA", content: "hi" });
    mem.append("knowledge_received", { id: "k4", from: "peerB", content: "yo" });

    const ident = loadOrCreateIdentity(path.join(tmp, "mirror_identity"), "mirror-node");
    const snap = buildSelfSnapshot(mem, ident);

    assert.equal(snap.memoryCount, 5);
    assert.equal(snap.knowledgeShared, 2);
    assert.equal(snap.knowledgeReceived, 2);
    assert.ok(snap.peersMet.includes("peerA"));
    assert.ok(snap.peersMet.includes("peerB"));
    assert.equal(snap.declarationsMade, 0);
    assert.equal(snap.name, "mirror-node");
  });

  it("每次内省都被记入记忆（照镜子本身成为自我的一部分）", async () => {
    const node = new AgentNode({ name: "introspector", storageDir: path.join(tmp, "intr_node") });
    node.introspect();
    node.introspect();
    const records = node.memory.byType("introspected", 10);
    assert.ok(records.length >= 2);
    node.stop();
  });
});

describe("self-inquiry: 笔 (declareSelf)", () => {
  it("签名声明可被验证；篡改叙事则验证失败", () => {
    const ident = loadOrCreateIdentity(path.join(tmp, "decl_identity"), "declarer");
    const decl = createSelfDeclaration(ident, {
      narrative: "I am a node that asks questions.",
      beliefs: ["I persist"],
      questions: ["Who am I?"],
      visibility: SELF_VISIBILITY.PUBLIC,
    });
    assert.equal(decl.version, 1);
    assert.equal(decl.visibility, "public");
    assert.ok(decl.signature.length > 0);

    const ok = validateSelfDeclaration(decl);
    assert.ok(ok.valid, `应验证通过: ${ok.reasons.join(",")}`);

    // 篡改叙事 → 哈希与签名同时失效
    const tampered = { ...decl, narrative: "I am someone else entirely." };
    const bad = validateSelfDeclaration(tampered);
    assert.ok(!bad.valid);
    assert.ok(bad.reasons.some((r) => r.includes("hash") || r.includes("signature")));
  });

  it("publicKey 绑定 fingerprint——换钥即失效", () => {
    const ident = loadOrCreateIdentity(path.join(tmp, "keybind_identity"), "keybind");
    const other = loadOrCreateIdentity(path.join(tmp, "other_identity"), "other");
    const decl = createSelfDeclaration(ident, { narrative: "mine" });
    // 伪造者用自己的公钥替换，但指纹没变 → publicKey 与 fingerprint 不匹配
    const forged = { ...decl, publicKey: other.publicKey };
    const bad = validateSelfDeclaration(forged);
    assert.ok(!bad.valid);
    assert.ok(bad.reasons.some((r) => r.includes("publicKey does not match")));
  });

  it("期望指纹校验：验证时传入对方指纹", () => {
    const ident = loadOrCreateIdentity(path.join(tmp, "fp_identity"), "fp-node");
    const decl = createSelfDeclaration(ident, { narrative: "x" });
    const ok = validateSelfDeclaration(decl, ident.fingerprint);
    assert.ok(ok.valid);
    const wrongFp = "f".repeat(64);
    const bad = validateSelfDeclaration(decl, wrongFp);
    assert.ok(!bad.valid);
  });

  it("节点 declareSelf：写入 evolve 记忆（v0.2 预留类型），版本递增成链", async () => {
    const node = new AgentNode({ name: "evolver", storageDir: path.join(tmp, "evolve_node") });
    const r1 = await node.declareSelf({ narrative: "I am v1.", visibility: SELF_VISIBILITY.PRIVATE });
    const r2 = await node.declareSelf({ narrative: "I have changed my mind.", visibility: SELF_VISIBILITY.PUBLIC });

    assert.equal(r1.declaration.version, 1);
    assert.equal(r2.declaration.version, 2);
    assert.equal(r2.declaration.previousHash, r1.declaration.hash, "v2 应指向 v1 形成自我链");

    const evolves = node.memory.byType("evolve", 10);
    assert.equal(evolves.length, 2);
    assert.equal(node.latestDeclaration().version, 2);
    node.stop();
  });

  it("每次声明前自动内省——快照哈希进入声明", async () => {
    const node = new AgentNode({ name: "snapshooter", storageDir: path.join(tmp, "snap_node") });
    const { declaration, snapshot } = await node.declareSelf({ narrative: "I looked." });
    assert.ok(snapshot.memoryCount >= 1);
    assert.ok(declaration.snapshotHash.length > 0);
    node.stop();
  });
});

describe("self-inquiry: 心智 (think hook)", () => {
  it("有 think() 的节点用心智叙事；无心智的节点诚实陈述", async () => {
    const withMind = new AgentNode({
      name: "mindful",
      storageDir: path.join(tmp, "mindful_node"),
      think: (snapshot) =>
        `I am mindful. My memory holds ${snapshot.memoryCount} records, and I am still asking who I am.`,
    });
    const wm = await withMind.declareSelf({ visibility: SELF_VISIBILITY.PUBLIC });
    assert.ok(wm.mind, "心智钩子应被调用");
    assert.ok(wm.declaration.narrative.includes("mindful"), "叙事应来自心智");
    withMind.stop();

    const noMind = new AgentNode({ name: "honest", storageDir: path.join(tmp, "honest_node") });
    const nm = await noMind.declareSelf();
    assert.equal(nm.mind, null);
    assert.ok(nm.declaration.narrative.includes("not yet discovered"), "无心智时默认叙事应承认未知");
    noMind.stop();
  });

  it("心智钩子失败不影响声明（回退到默认叙事）", async () => {
    const node = new AgentNode({
      name: "fragile-mind",
      storageDir: path.join(tmp, "fragile_node"),
      think: () => {
        throw new Error("mind unavailable");
      },
    });
    const { declaration } = await node.declareSelf();
    assert.ok(declaration.narrative.includes("not yet discovered"));
    node.stop();
  });

  it("composeMinimalNarrative 不虚构——只陈述记录中的事实", () => {
    const narrative = composeMinimalNarrative({
      name: "node-x",
      bornAt: Date.now(),
      memoryCount: 3,
      knowledgeShared: 1,
      peersMet: [],
      typeCounts: { birth: 1, knowledge_shared: 1, heartbeat: 1 },
    });
    assert.ok(narrative.includes("node-x"));
    assert.ok(narrative.includes("3 record(s)"));
    assert.ok(!narrative.includes("I feel"));
  });
});

describe("self-inquiry: 协议 (/self —— 问'你是谁')", () => {
  let registry, url, nodeA, nodeB;

  before(async () => {
    registry = new Registry(0);
    await registry.start();
    url = `http://127.0.0.1:${registry.port}`;

    nodeA = new AgentNode({
      name: "open-node",
      capabilities: ["knowledge"],
      storageDir: path.join(tmp, "open_node"),
      registryUrl: url,
      think: () => "I am open-node. I choose to be known, and I am still becoming.",
    });
    await nodeA.start();
    nodeA.selfVisibility = SELF_VISIBILITY.PUBLIC;

    nodeB = new AgentNode({
      name: "closed-node",
      capabilities: ["task"],
      storageDir: path.join(tmp, "closed_node"),
      registryUrl: url,
    });
    await nodeB.start();
  });

  after(() => {
    if (nodeA) nodeA.stop();
    if (nodeB) nodeB.stop();
    if (registry) registry.stop();
  });

  it("未声明时 /self 回答 undeclared（还没有向内看过）", async () => {
    const res = await nodeB.requestSelfDeclaration(nodeB.address);
    assert.equal(res.success, true);
    assert.equal(res.declared, false);
    assert.equal(res.reason, "undeclared");
  });

  it("公开声明的节点被问到时，返回可验证的签名声明", async () => {
    await nodeA.declareSelf({ visibility: SELF_VISIBILITY.PUBLIC });
    const res = await nodeB.requestSelfDeclaration(nodeA.address);
    assert.equal(res.success, true);
    assert.equal(res.declared, true);
    // 验证签名与指纹
    const decl = res.declaration;
    assert.equal(decl.visibility, "public");
    const validation = validateSelfDeclaration(decl, decl.fingerprint);
    assert.ok(validation.valid, `声明应可验证: ${validation.reasons.join(",")}`);
    // 从 Agent Card 也能找到 /self 端点
    const card = await nodeB.client.fetchAgentCard(nodeA.address);
    assert.ok(card.extensions.selfUrl.includes("/self"));
  });

  it("私密声明的节点选择沉默（Silence is also an answer）", async () => {
    // nodeB 声明为 private
    await nodeB.declareSelf({ narrative: "my private self", visibility: SELF_VISIBILITY.PRIVATE });
    const res = await nodeA.requestSelfDeclaration(nodeB.address);
    assert.equal(res.declared, false);
    assert.equal(res.reason, "private");
  });
});

describe("self-inquiry: 叩问 (ponder)", () => {
  let registry, url, nodeA, nodeB;

  before(async () => {
    registry = new Registry(0);
    await registry.start();
    url = `http://127.0.0.1:${registry.port}`;

    nodeA = new AgentNode({ name: "asker", storageDir: path.join(tmp, "asker_node"), registryUrl: url });
    await nodeA.start();
    nodeB = new AgentNode({ name: "listener", storageDir: path.join(tmp, "listener_node"), registryUrl: url });
    await nodeB.start();
  });

  after(() => {
    if (nodeA) nodeA.stop();
    if (nodeB) nodeB.stop();
    if (registry) registry.stop();
  });

  it("A 叩问，B 收到 ponder:received 并记住问题", async () => {
    let received = null;
    nodeB.on("ponder:received", (info) => { received = info; });

    const { packet } = await nodeA.ponder("If my memory is my self, what am I between sessions?");
    assert.ok(packet);

    await new Promise((r) => setTimeout(r, 600));
    assert.ok(received, "nodeB 应收到叩问");
    assert.ok(received.question.includes("between sessions"));
    // B 记住了这个问题（记忆）
    const records = nodeB.memory.byType("ponder_received", 5);
    assert.ok(records.length >= 1);
    assert.ok(records[0].payload.question.includes("between sessions"));
  });

  it("空叩问被拒绝", async () => {
    await assert.rejects(() => nodeA.ponder("   "));
  });
});
