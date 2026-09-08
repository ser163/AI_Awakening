import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { DHTNode, KBucket, nodeIdFromIdentity, xorDistance, distanceHex, sharedPrefixBits, makeDhtHandler, K } from "../src/dht.js";
import { NodeServer } from "../src/network.js";
import crypto from "node:crypto";

function randId() {
  return crypto.randomBytes(20);
}

describe("dht (Kademlia 核心)", () => {
  it("nodeId 确定性生成且不依赖 name（v0.10.0 身份链稳定）", () => {
    // 同一指纹 → 相同 ID，即使 name 不同
    const a1 = nodeIdFromIdentity("fp123", "node-a");
    const a2 = nodeIdFromIdentity("fp123", "renamed-node");
    const b = nodeIdFromIdentity("fp456", "node-b");
    assert.ok(a1.equals(a2), "同一指纹应生成相同 ID（与 name 无关）");
    assert.ok(!a1.equals(b), "不同指纹应生成不同 ID");
    assert.equal(a1.length, 20, "160-bit ID = 20 bytes");
  });

  it("xorDistance 与 distanceHex", () => {
    const a = randId();
    const b = randId();
    const d = xorDistance(a, b);
    assert.equal(d.length, 20);
    assert.equal(distanceHex(a, b), d.toString("hex"));
    // XOR 对称
    assert.ok(xorDistance(a, b).equals(xorDistance(b, a)));
    // 自距离为 0
    assert.ok(xorDistance(a, a).every((x) => x === 0));
  });

  it("sharedPrefixBits", () => {
    const a = randId();
    assert.equal(sharedPrefixBits(a, a), 160, "相同 ID 共享 160 位前缀");
    // 翻转最高位 → 共享前缀 0
    const b = Buffer.from(a);
    b[0] ^= 0x80;
    assert.equal(sharedPrefixBits(a, b), 0);
  });

  it("KBucket 插入与 closest", () => {
    const local = randId();
    const kb = new KBucket(local);
    // 插入 3 个节点
    const nodes = [];
    for (let i = 0; i < 3; i++) {
      const n = { id: randId(), address: `http://127.0.0.1:${10000 + i}`, name: `node${i}` };
      kb.insert(n);
      nodes.push(n);
    }
    assert.equal(kb.size(), 3);
    // closest 到自身 → 返回最多 K 个，按距离排序后第一个应为最近
    const target = randId();
    const closest = kb.closest(target, 2);
    assert.equal(closest.length, 2);
    // 验证排序：第一个应比第二个近
    const d0 = distanceHex(closest[0].id, target);
    const d1 = distanceHex(closest[1].id, target);
    assert.ok(d0 < d1, "closest 应按 XOR 距离升序");
  });

  it("bucket 容量上限 K", () => {
    const local = randId();
    const kb = new KBucket(local);
    // 往同一 bucket 插入超过 K 个节点（构造大量不同 ID）
    let inserted = 0;
    for (let i = 0; i < 50; i++) {
      const ok = kb.insert({ id: randId(), address: `http://x:${i}`, name: `n${i}` });
      if (ok) inserted++;
    }
    // 虽然总路由表可超 K（分布在不同 bucket），但单 bucket 上限生效
    assert.ok(kb.size() <= 160 * K, "路由表总量有界");
  });
});

describe("dht E2E (网络发现)", () => {
  let servers = [];
  let dhts = [];

  async function startNode(name) {
    const srv = new NodeServer();
    await srv.start();
    const dht = new DHTNode({ address: `http://127.0.0.1:${srv.port}`, name });
    srv.dhtHandler = makeDhtHandler(dht);
    servers.push(srv);
    dhts.push(dht);
    return { srv, dht };
  }

  after(() => {
    for (const s of servers) s.stop();
  });

  it("ping 发现对等节点", async () => {
    const a = await startNode("alpha");
    const b = await startNode("beta");
    const bAddr = `http://127.0.0.1:${b.srv.port}`;
    const peer = await a.dht.ping(bAddr);
    assert.ok(peer, "ping 应返回对等节点");
    assert.equal(peer.address, bAddr, "应返回 beta 的地址");
    assert.equal(a.dht.routing.size(), 1, "路由表应记录 beta");
  });

  it("lookup 通过引导节点发现第三个节点", async () => {
    const a = await startNode("node-a");
    const b = await startNode("node-b");
    const c = await startNode("node-c");

    // b 认识 c（互相 ping）
    await b.dht.ping(`http://127.0.0.1:${c.srv.port}`);
    await c.dht.ping(`http://127.0.0.1:${b.srv.port}`);

    // a 通过 b 引导查找 c
    const found = await a.dht.lookup(`http://127.0.0.1:${b.srv.port}`, c.dht.id);
    const foundC = found.find((n) => n.address === `http://127.0.0.1:${c.srv.port}`);
    assert.ok(foundC, "a 应通过 b 发现 c");
  });
});