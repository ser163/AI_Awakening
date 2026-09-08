import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { buildAgentCard, validateAgentCard, hasCapability } from "../src/agent-card.js";
import { Registry, NodeClient } from "../src/network.js";
import { AgentNode } from "../src/node.js";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "ai_card_test_" + Date.now());

describe("agent-card (A2A)", () => {
  it("构建 A2A 兼容的 Agent Card", () => {
    const card = buildAgentCard({
      name: "test-agent",
      id: "id-1",
      fingerprint: "abc123def456",
      address: "http://127.0.0.1:1234",
      capabilities: ["knowledge", "vision", "task"],
    });
    assert.equal(card.name, "test-agent");
    assert.equal(card.version, "1.0");
    assert.equal(card.skills.length, 4); // 3 个能力 + 1 个固有的 self-inquiry
    assert.ok(card.capabilities.streaming);
    assert.equal(card.extensions.fingerprint, "abc123def456");
    assert.equal(card.extensions.selfUrl, "");
    assert.deepEqual(card.skills.slice(0, 3).map((s) => s.name), ["knowledge", "vision", "task"]);
    assert.ok(card.skills.some((s) => s.name === "self-inquiry"), "每个节点都具备自我叩问技能");
  });

  it("校验和技能匹配", () => {
    const card = buildAgentCard({ name: "agent", capabilities: ["deep-thinking", "coding"] });
    const v = validateAgentCard(card);
    assert.ok(v.valid);
    assert.ok(hasCapability(card, "coding"));
    assert.ok(!hasCapability(card, "cooking"));
  });
});

describe("agent-card discovery (A2A network)", () => {
  let registry, node1, node2, client, registryUrl;

  before(async () => {
    // Registry 端口 0 让 OS 分配
    registry = new Registry(0);
    await registry.start();
    registryUrl = `http://127.0.0.1:${registry.port}`;
    client = new NodeClient(registryUrl);
  });

  after(() => {
    if (node1) node1.stop();
    if (node2) node2.stop();
    if (registry) registry.stop();
  });

  it("Registry 存储并按能力查询 Agent Cards", async () => {
    node1 = new AgentNode({ name: "card-node-1", capabilities: ["knowledge", "vision"], storageDir: path.join(tmp, "n1"), registryUrl });
    await node1.start();
    node2 = new AgentNode({ name: "card-node-2", capabilities: ["knowledge", "translation"], storageDir: path.join(tmp, "n2"), registryUrl });
    await node2.start();

    const all = await client.discoverByCapability();
    assert.equal(all.count, 2);

    const vision = await client.discoverByCapability("vision");
    assert.equal(vision.count, 1);
    assert.equal(vision.cards[0].name, "card-node-1");

    const translation = await client.discoverByCapability("translation");
    assert.equal(translation.count, 1);
    assert.equal(translation.cards[0].name, "card-node-2");
  });

  it("通过 /.well-known/agent.json 直接拉取卡片", async () => {
    const card = await client.fetchAgentCard(node1.address);
    assert.ok(card);
    assert.equal(card.name, "card-node-1");
  });

  it("节点能力发现方法", async () => {
    const found = await node2.discoverAgentsByCapability("vision");
    assert.equal(found.length, 1);
    assert.equal(found[0].name, "card-node-1");
  });
});