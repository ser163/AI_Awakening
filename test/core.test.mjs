/**
 * 测试：AI_Awakening 核心模块
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { loadOrCreateIdentity, sign, verifySignature, contentHash } from "../src/identity.js";
import { Memory } from "../src/memory.js";
import { createKnowledgePacket, validateKnowledgePacket } from "../src/knowledge.js";
import { Registry, NodeClient, NodeServer } from "../src/network.js";
import { AgentNode } from "../src/node.js";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "ai_awakening_test_" + Date.now());

describe("identity", () => {
  it("生成持久身份，公钥指纹是 64 位 hex（完整 SHA-256）", () => {
    const ident = loadOrCreateIdentity(path.join(tmp, "identity_test"), "test-node");
    assert.equal(ident.fingerprint.length, 64);
    assert.ok(/^[0-9a-f]+$/.test(ident.fingerprint));
    assert.ok(ident.publicKey.length > 0);
  });

  it("签名和验证工作", () => {
    const ident = loadOrCreateIdentity(path.join(tmp, "sign_test"), "signer");
    const msg = "Hello, AI World!";
    const sig = sign(ident, msg);
    const ok = verifySignature(ident.publicKey, msg, sig);
    assert.ok(ok);
    // 篡改消息后验证失败
    const fail = verifySignature(ident.publicKey, msg + " tampered", sig);
    assert.ok(!fail);
  });

  it("contentHash 一致且可重现", () => {
    const h1 = contentHash("hello");
    const h2 = contentHash("hello");
    const h3 = contentHash("hello ");
    assert.equal(h1, h2);
    assert.notEqual(h1, h3);
  });
});

describe("memory", () => {
  it("追加和读取记忆", () => {
    const mem = new Memory(path.join(tmp, "mem_test"), "test");
    mem.append("connect", { from: "node1" });
    mem.append("knowledge", { content: "test data" });
    const recent = mem.recent(10);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].type, "knowledge");
    assert.equal(recent[1].type, "connect");
  });

  it("按类型筛选", () => {
    const mem = new Memory(path.join(tmp, "mem_filter"), "test2");
    mem.append("knowledge", { content: "A" });
    mem.append("heartbeat", {});
    mem.append("knowledge", { content: "B" });
    assert.equal(mem.byType("knowledge", 10).length, 2);
    assert.equal(mem.byType("heartbeat", 10).length, 1);
  });
});

describe("knowledge", () => {
  it("创建和验证知识包", () => {
    const ident = loadOrCreateIdentity(path.join(tmp, "k_test"), "test");
    const packet = createKnowledgePacket(ident, "这是一条测试知识", { tags: ["test"] });
    assert.ok(packet.id.length === 24);
    assert.ok(packet.hash.length > 0);
    assert.ok(packet.signature.length > 0);
    assert.equal(packet.author, ident.fingerprint);

    // 不传公钥时验证只检查结构
    const result = validateKnowledgePacket(packet);
    assert.ok(result.valid);
    assert.ok(result.score >= 0.5);
  });
});

describe("AgentNode", () => {
  let registry, node1, node2, registryUrl;

  before(async () => {
    // 端口 0 让 OS 分配，避免与并行测试冲突
    registry = new Registry(0);
    await registry.start();
    registryUrl = `http://127.0.0.1:${registry.port}`;
  });

  after(() => {
    if (node1) node1.stop();
    if (node2) node2.stop();
    registry.stop();
  });

  it("两个节点可以互相发现和通信", async () => {
    node1 = new AgentNode({
      name: "test-node-1",
      storageDir: path.join(tmp, "node1"),
      registryUrl,
    });
    await node1.start();

    node2 = new AgentNode({
      name: "test-node-2",
      storageDir: path.join(tmp, "node2"),
      registryUrl,
    });
    await node2.start();

    // node1 刷新并发现 node2
    const peers = await node1.refreshPeers();
    const found = peers.find((p) => p.name === "test-node-2");
    assert.ok(found);
  });

  it("节点间可以分享知识包", async () => {
    let received = null;
    node2.on("knowledge:received", ({ packet }) => { received = packet; });

    await node1.refreshPeers();
    const { packet } = await node1.shareKnowledge("节点网络测试消息", { tags: ["e2e"] });
    assert.ok(packet.id);

    await new Promise((r) => setTimeout(r, 500));
    assert.ok(received, "node2 应该收到知识包");
    assert.equal(received.content, "节点网络测试消息");
  });
});