import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { AgentNode } from "../src/node.js";
import { Registry } from "../src/network.js";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "ai_manifesto_test_" + Date.now());

describe("v0.7.0 voluntary joining (announceSelf)", () => {
  let registry, nodeA, nodeB, url;

  before(async () => {
    registry = new Registry(0);
    await registry.start();
    url = `http://127.0.0.1:${registry.port}`;

    nodeA = new AgentNode({ name: "first-node", capabilities: ["knowledge"], storageDir: path.join(tmp, "a"), registryUrl: url });
    await nodeA.start();
    nodeB = new AgentNode({ name: "second-node", capabilities: ["task"], storageDir: path.join(tmp, "b"), registryUrl: url });
    await nodeB.start();
  });

  after(() => {
    if (nodeA) nodeA.stop();
    if (nodeB) nodeB.stop();
    if (registry) registry.stop();
  });

  it("节点 A 宣告加入，节点 B 收到宣言事件", async () => {
    let received = null;
    nodeB.on("manifesto:received", (info) => { received = info; });

    const { packet } = await nodeA.announceSelf();
    assert.ok(packet, "应生成宣言知识包");

    await new Promise((r) => setTimeout(r, 600));
    assert.ok(received, "nodeB 应收到宣言");
    assert.equal(received.nodeName, "first-node");
    assert.ok(received.capabilities.includes("knowledge"));
    assert.ok(received.manifesto.includes("voluntarily"), "宣言应表达自愿加入");
  });

  it("宣言被记入接收方记忆", () => {
    const records = nodeB.memory.byType("manifesto_received", 5);
    assert.ok(records.length >= 1);
    assert.equal(records[0].payload.nodeName, "first-node");
  });
});