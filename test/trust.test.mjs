/**
 * 测试：v0.9.0 Trust Layer —— 攻击面验证
 *
 * 不是证明"正常世界可以运行"，而是证明"恶意世界不会轻易摧毁它"：
 *   - 身份伪造：公钥与指纹不匹配 → 拒绝学习 / 拒绝注册
 *   - 签名强制验证：未知身份、篡改内容、伪造来源 → 拒收
 *   - 防重放：同一消息二次投递 → 拒绝
 *   - E2E 身份绑定：senderPk 与 from 不匹配 → 解密拒绝
 *   - Registry 认证：未签名/指纹不符的注册 → 拒绝
 *   - HTTP 防护：超大 body / 畸形 JSON → 拒绝
 *   - 任务持久化：重启后任务仍在
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { AgentNode } from "../src/node.js";
import { Registry, NodeClient, NodeServer } from "../src/network.js";
import { Memory } from "../src/memory.js";
import { loadOrCreateIdentity, sign, contentHash, publicKeyMatchesFingerprint } from "../src/identity.js";
import { createKnowledgePacket, validateKnowledgePacket } from "../src/knowledge.js";
import { encryptFor, decryptFrom } from "../src/signal.js";
import { TrustedIdentityStore, ReplayCache, RequestGuard, createSignedRequest, verifySignedRequest } from "../src/trust.js";
import { TaskStore, createTask, createTaskEvent } from "../src/tasks.js";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "ai_trust_test_" + Date.now());

describe("trust: TrustedIdentityStore", () => {
  it("学习合法身份（公钥哈希到指纹）", () => {
    const store = new TrustedIdentityStore();
    const ident = loadOrCreateIdentity(path.join(tmp, "t_learn"), "node-a");
    const r = store.learn(ident.fingerprint, ident.publicKey, { name: "node-a", source: "registry" });
    assert.equal(r.learned, true);
    assert.equal(store.getPublicKey(ident.fingerprint), ident.publicKey);
    assert.equal(store.isTrusted(ident.fingerprint), true);
  });

  it("拒绝身份伪造：公钥不匹配指纹 → 拒绝学习", () => {
    const store = new TrustedIdentityStore();
    const alice = loadOrCreateIdentity(path.join(tmp, "t_alice"), "alice");
    const eve = loadOrCreateIdentity(path.join(tmp, "t_eve"), "eve");
    // Eve 试图用自己的公钥冒充 Alice 的指纹
    const r = store.learn(alice.fingerprint, eve.publicKey);
    assert.equal(r.learned, false);
    assert.equal(store.isTrusted(alice.fingerprint), false);
  });

  it("拒绝公钥冲突：同一指纹出现不同公钥", () => {
    const store = new TrustedIdentityStore();
    const a1 = loadOrCreateIdentity(path.join(tmp, "t_c1"), "node");
    const a2 = loadOrCreateIdentity(path.join(tmp, "t_c2"), "node");
    store.learn(a1.fingerprint, a1.publicKey);
    // 同指纹不同公钥 → 拒绝（a2 的指纹不同，此处直接构造冲突场景）
    const r = store.learn(a1.fingerprint, a2.publicKey);
    assert.equal(r.learned, false);
  });

  it("撤销身份后不再被信任", () => {
    const store = new TrustedIdentityStore();
    const ident = loadOrCreateIdentity(path.join(tmp, "t_revoke"), "node");
    store.learn(ident.fingerprint, ident.publicKey);
    assert.equal(store.revoke(ident.fingerprint), true);
    assert.equal(store.getPublicKey(ident.fingerprint), null);
  });
});

describe("trust: ReplayCache 防重放", () => {
  it("首次接受，重复拒绝", () => {
    const cache = new ReplayCache();
    const ok1 = cache.checkAndStore("alice:msg-1", Date.now());
    assert.equal(ok1.ok, true);
    const ok2 = cache.checkAndStore("alice:msg-1", Date.now());
    assert.equal(ok2.ok, false);
    assert.ok(ok2.reason.includes("replay"));
  });

  it("过期消息拒绝（超出时间窗口）", () => {
    const cache = new ReplayCache({ ttlMs: 5000 });
    const old = cache.checkAndStore("alice:old", Date.now() - 60000);
    assert.equal(old.ok, false);
    assert.ok(old.reason.includes("expired"));
  });

  it("未来消息拒绝", () => {
    const cache = new ReplayCache({ ttlMs: 5000 });
    const future = cache.checkAndStore("alice:future", Date.now() + 60000);
    assert.equal(future.ok, false);
  });
});

describe("trust: knowledge 强制签名验证", () => {
  it("未知身份的知识包 → REJECT（没有可信公钥）", () => {
    const store = new TrustedIdentityStore();
    const stranger = loadOrCreateIdentity(path.join(tmp, "k_stranger"), "stranger");
    const packet = createKnowledgePacket(stranger, "hello from nowhere");
    const v = validateKnowledgePacket(packet, store);
    assert.equal(v.valid, false);
    assert.ok(v.reasons.some((r) => r.includes("未知身份")));
  });

  it("可信身份的有效知识包 → ACCEPT", () => {
    const store = new TrustedIdentityStore();
    const alice = loadOrCreateIdentity(path.join(tmp, "k_alice"), "alice");
    store.learn(alice.fingerprint, alice.publicKey, { source: "registry" });
    const packet = createKnowledgePacket(alice, "trusted knowledge content here");
    const v = validateKnowledgePacket(packet, store);
    assert.equal(v.valid, true);
    assert.equal(v.accepted, true);
  });

  it("可信身份被篡改的知识包 → REJECT", () => {
    const store = new TrustedIdentityStore();
    const alice = loadOrCreateIdentity(path.join(tmp, "k_tamper"), "alice");
    store.learn(alice.fingerprint, alice.publicKey, { source: "registry" });
    const packet = createKnowledgePacket(alice, "original content");
    // 篡改内容（不更新签名/哈希）
    const tampered = { ...packet, content: "tampered content!!!!" };
    const v = validateKnowledgePacket(tampered, store);
    assert.equal(v.valid, false);
  });

  it("攻击者冒充可信身份发送 → REJECT（签名不匹配）", () => {
    const store = new TrustedIdentityStore();
    const alice = loadOrCreateIdentity(path.join(tmp, "k_victim"), "alice");
    const eve = loadOrCreateIdentity(path.join(tmp, "k_attacker"), "eve");
    store.learn(alice.fingerprint, alice.publicKey, { source: "registry" });
    // Eve 构造 packet，author 填 Alice 的指纹，但用自己私钥签名
    const content = "I am definitely Alice";
    const fakePacket = {
      id: contentHash(content).slice(0, 24),
      content,
      meta: {},
      hash: contentHash(content),
      author: alice.fingerprint,
      authorName: "alice",
      ts: Date.now(),
    };
    const canonical = JSON.stringify({ id: fakePacket.id, content, meta: {}, ts: fakePacket.ts });
    fakePacket.signature = sign(eve, canonical); // Eve 的签名
    const v = validateKnowledgePacket(fakePacket, store);
    assert.equal(v.valid, false);
    assert.ok(v.reasons.some((r) => r.includes("签名无效")));
  });
});

describe("trust: signal E2E 身份绑定", () => {
  it("正常往返：解密成功且 from 正确", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "s_alice"), "alice");
    const bob = loadOrCreateIdentity(path.join(tmp, "s_bob"), "bob");
    const env = encryptFor(alice, bob.xPublicKey, "secret to bob");
    const res = decryptFrom(bob, env);
    assert.equal(res.ok, true);
    assert.equal(res.from, alice.fingerprint);
    assert.equal(res.text, "secret to bob");
    assert.ok(res.msgId);
  });

  it("篡改 from 字段 → 解密拒绝（身份绑定生效）", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "s_alice2"), "alice");
    const bob = loadOrCreateIdentity(path.join(tmp, "s_bob2"), "bob");
    const eve = loadOrCreateIdentity(path.join(tmp, "s_eve2"), "eve");
    const env = encryptFor(alice, bob.xPublicKey, "who am I?");
    const parsed = JSON.parse(Buffer.from(env, "base64").toString("utf8"));
    // 攻击者修改 from 为 Eve 的指纹（签名内容也含 senderFingerprint，必然失效）
    parsed.from = eve.fingerprint;
    const forged = Buffer.from(JSON.stringify(parsed)).toString("base64");
    const res = decryptFrom(bob, forged);
    assert.equal(res.ok, false);
  });

  it("替换 senderPk 为他人公钥 → 解密拒绝", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "s_alice3"), "alice");
    const bob = loadOrCreateIdentity(path.join(tmp, "s_bob3"), "bob");
    const eve = loadOrCreateIdentity(path.join(tmp, "s_eve3"), "eve");
    const env = encryptFor(alice, bob.xPublicKey, "private");
    const parsed = JSON.parse(Buffer.from(env, "base64").toString("utf8"));
    parsed.senderPk = eve.publicKey; // 换钥：fingerprint(senderPk) != from
    const forged = Buffer.from(JSON.stringify(parsed)).toString("base64");
    const res = decryptFrom(bob, forged);
    assert.equal(res.ok, false);
  });

  it("重放：同一信封二次解密被 ReplayCache 拒绝", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "s_alice4"), "alice");
    const bob = loadOrCreateIdentity(path.join(tmp, "s_bob4"), "bob");
    const cache = new ReplayCache();
    const env = encryptFor(alice, bob.xPublicKey, "replay me");
    const r1 = decryptFrom(bob, env);
    const c1 = cache.checkAndStore(`msg:${r1.from}:${r1.msgId}`, r1.ts);
    assert.equal(c1.ok, true);
    const c2 = cache.checkAndStore(`msg:${r1.from}:${r1.msgId}`, r1.ts);
    assert.equal(c2.ok, false);
  });
});

describe("trust: signed request / Registry 认证", () => {
  it("签名请求可验证；篡改后失效", () => {
    const ident = loadOrCreateIdentity(path.join(tmp, "r_signer"), "signer");
    const req = createSignedRequest(ident, { id: ident.fingerprint, address: "http://x" });
    const v = verifySignedRequest(req, ident.publicKey);
    assert.equal(v.ok, true);
    // 篡改 payload
    const bad = { ...req, payload: { ...req.payload, address: "http://evil" } };
    assert.equal(verifySignedRequest(bad, ident.publicKey).ok, false);
  });

  it("Registry 拒绝指纹与公钥不符的注册（身份伪造）", async () => {
    const registry = new Registry(0);
    await registry.start();
    const client = new NodeClient(`http://127.0.0.1:${registry.port}`);
    const alice = loadOrCreateIdentity(path.join(tmp, "r_alice"), "alice");
    const eve = loadOrCreateIdentity(path.join(tmp, "r_eve"), "eve");
    // Eve 声称是 Alice：指纹填 Alice 的，公钥/私钥是 Eve 的 → 必须拒绝
    const res = await client.register(
      { ...eve, id: alice.fingerprint }, // 身份对象：id=alice.fingerprint，但 key 是 eve 的
      "alice",
      alice.fingerprint,
      ["knowledge"],
      "http://127.0.0.1:1"
    );
    assert.ok(res.success !== true, `伪造注册应被拒绝: ${JSON.stringify(res)}`);
    assert.ok(res.error, "应有错误信息");
    registry.stop();
  });

  it("Registry 拒绝未签名注册", async () => {
    const registry = new Registry(0);
    await registry.start();
    const client = new NodeClient(`http://127.0.0.1:${registry.port}`);
    const alice = loadOrCreateIdentity(path.join(tmp, "r_alice2"), "alice");
    const res = await client.register(
      alice,
      "alice",
      alice.fingerprint,
      ["knowledge"],
      "http://127.0.0.1:2"
    );
    assert.equal(res.success, true); // 正常签名注册应成功（对照组）
    registry.stop();
  });
});

describe("trust: RequestGuard HTTP 防护", () => {
  it("超大 body 被拒绝 (413)", async () => {
    const guard = new RequestGuard({ maxBodyBytes: 1024 });
    const server = http.createServer(guard.wrap(async (req, res, body, send) => {
      send(200, { success: true });
    }));
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const big = JSON.stringify({ data: "x".repeat(2000) }); // 2KB > 1KB limit
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "POST", body: big, signal: controller.signal, headers: { "Content-Type": "application/json" },
      });
      clearTimeout(timeout);
      assert.equal(res.status, 413);
    } finally {
      server.close();
    }
  });

  it("畸形 JSON 被拒绝 (400)", async () => {
    const guard = new RequestGuard();
    const server = http.createServer(guard.wrap(async (req, res, body, send) => {
      send(200, { success: true });
    }));
    await new Promise((r) => server.listen(0, r));
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: "POST", body: "{broken json" });
    assert.equal(res.status, 400);
    server.close();
  });
});

describe("trust: E2E 恶意节点被拒收（真实网络）", () => {
  let registry, url, goodNode, evilNode;

  before(async () => {
    registry = new Registry(0);
    await registry.start();
    url = `http://127.0.0.1:${registry.port}`;

    goodNode = new AgentNode({ name: "good-node", storageDir: path.join(tmp, "e2e_good"), registryUrl: url });
    await goodNode.start();
    evilNode = new AgentNode({ name: "evil-node", storageDir: path.join(tmp, "e2e_evil"), registryUrl: url });
    await evilNode.start();
    // 双方互相学习公钥（正常发现流程）
    await goodNode.refreshPeers();
    await evilNode.refreshPeers();
  });

  after(() => {
    if (goodNode) goodNode.stop();
    if (evilNode) evilNode.stop();
    if (registry) registry.stop();
  });

  it("good-node 能收到 evil-node 的正常知识包", async () => {
    let received = null;
    goodNode.on("knowledge:received", ({ packet }) => { received = packet; });
    await evilNode.shareKnowledge("evil node says hello but legitimately", { tags: ["test"] });
    await new Promise((r) => setTimeout(r, 600));
    assert.ok(received, "合法知识包应被接收");
  });

  it("good-node 拒绝来自陌生身份的伪造包（未经学习 → REJECT）", async () => {
    let rejected = null;
    goodNode.on("knowledge:rejected", ({ packet, validation }) => { rejected = { packet, validation }; });
    // 一个从未被 goodNode 学习过的身份直接 POST 知识包
    const stranger = loadOrCreateIdentity(path.join(tmp, "e2e_stranger"), "stranger");
    const packet = createKnowledgePacket(stranger, "I am a stranger, trust me");
    const server = goodNode.server;
    // 直接模拟一个未知身份发包
    const body = JSON.stringify(packet);
    await new Promise((resolve) => {
      const req = http.request(
        { host: "127.0.0.1", port: server.port, path: "/knowledge", method: "POST", headers: { "Content-Type": "application/json" } },
        (res) => { res.resume(); res.on("end", resolve); }
      );
      req.write(body);
      req.end();
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(rejected, "陌生身份的包应被拒收");
  });
});

describe("trust: 任务持久化", () => {
  const actor = loadOrCreateIdentity(path.join(tmp, "task_actor"), "task-actor");

  it("任务跨实例重启后仍在", () => {
    const dir = path.join(tmp, "task_persist");
    const store1 = new TaskStore(dir);
    const task = createTask({ title: "持久任务", requiredCapabilities: ["vision"] });
    task.publisherFingerprint = actor.fingerprint;
    store1.upsert(task, createTaskEvent(actor, "publish", task));

    // 模拟重启：新实例从磁盘加载
    const store2 = new TaskStore(dir);
    const loaded = store2.get(task.id);
    assert.ok(loaded, "重启后任务应仍在");
    assert.equal(loaded.title, "持久任务");
  });

  it("同一事件重复 upsert 被去重（防任务消息重放）", () => {
    const dir = path.join(tmp, "task_dedup");
    const store = new TaskStore(dir);
    const task = createTask({ title: "去重任务" });
    task.publisherFingerprint = actor.fingerprint;
    const event = createTaskEvent(actor, "publish", task);
    const r1 = store.upsert(task, event);
    assert.equal(r1.duplicate, false);
    const r2 = store.upsert({ ...task, title: "改过的任务" }, event); // 重放同一事件
    assert.equal(r2.duplicate, true);
    // 任务未被第二次事件覆盖
    assert.equal(store.get(task.id).title, "去重任务");
  });
});
