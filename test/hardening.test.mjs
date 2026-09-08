/**
 * 测试：v0.10.1 Protocol Hardening
 *   - recipient 定向语义（发给别人的信封 → 拒绝）
 *   - acceptEnvelope vs verifyEnvelope 语义分离（accept 含 replay + recipient）
 *   - nonce 128-bit
 *   - 旧端点 /message /task → 410 Gone（无签名旁路关闭）
 *   - task_* RPC 走 Task State Machine（非 _onMessageReceived）
 *   - Task event 真哈希链（篡改历史事件 → 断链）
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { AgentNode } from "../src/node.js";
import { Registry, NodeServer } from "../src/network.js";
import { loadOrCreateIdentity } from "../src/identity.js";
import { createEnvelope, verifyEnvelope, acceptEnvelope, RECIPIENT_BROADCAST } from "../src/envelope.js";
import { TrustedIdentityStore, ReplayCache } from "../src/trust.js";
import { createTask, createTaskEvent, validateTaskEvent, checkTransition, TASK_STATUS } from "../src/tasks.js";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "ai_hardening_test_" + Date.now());

function makeStore(identity) {
  const store = new TrustedIdentityStore();
  store.learn(identity.fingerprint, identity.publicKey, { source: "registry" });
  return store;
}

describe("v0.10.1: envelope recipient 定向语义", () => {
  it("发给自己的信封 → accept", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "h_alice"), "alice");
    const store = makeStore(alice);
    const env = createEnvelope(alice, { type: "message", payload: { hello: 1 }, recipient: alice.fingerprint });
    const res = acceptEnvelope(env, store, { localFingerprint: alice.fingerprint, replayCache: new ReplayCache() });
    assert.equal(res.ok, true);
  });

  it("广播信封 (*) → accept", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "h_bc"), "alice");
    const store = makeStore(alice);
    const env = createEnvelope(alice, { type: "knowledge", payload: {}, recipient: RECIPIENT_BROADCAST });
    const res = acceptEnvelope(env, store, { localFingerprint: "someone-else", replayCache: new ReplayCache() });
    assert.equal(res.ok, true);
  });

  it("发给别人的信封 → REJECT（recipient mismatch）", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "h_mis"), "alice");
    const store = makeStore(alice);
    const env = createEnvelope(alice, { type: "message", payload: { secret: 1 }, recipient: "bob-fingerprint" });
    // Charlie 收到写给 Bob 的信封
    const res = acceptEnvelope(env, store, { localFingerprint: "charlie-fingerprint", replayCache: new ReplayCache() });
    assert.equal(res.ok, false);
    assert.ok(res.reason.includes("recipient mismatch"));
  });

  it("verifyEnvelope 通过但 acceptEnvelope 拒绝（语义分离）", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "h_sem"), "alice");
    const store = makeStore(alice);
    const env = createEnvelope(alice, { type: "message", payload: {}, recipient: "bob" });
    // verify：只看密码学 → ok
    const v = verifyEnvelope(env, store);
    assert.equal(v.ok, true);
    // accept：recipient 定向 → 拒绝
    const a = acceptEnvelope(env, store, { localFingerprint: "charlie", replayCache: new ReplayCache() });
    assert.equal(a.ok, false);
  });

  it("acceptEnvelope 内建防重放（同一信封二次 accept → REJECT）", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "h_rp"), "alice");
    const store = makeStore(alice);
    const cache = new ReplayCache();
    const env = createEnvelope(alice, { type: "message", payload: {}, recipient: RECIPIENT_BROADCAST });
    const r1 = acceptEnvelope(env, store, { localFingerprint: "me", replayCache: cache });
    assert.equal(r1.ok, true);
    const r2 = acceptEnvelope(env, store, { localFingerprint: "me", replayCache: cache });
    assert.equal(r2.ok, false);
    assert.ok(r2.reason.includes("replay"));
  });

  it("nonce 为 128-bit（32 hex 字符）", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "h_nonce"), "alice");
    const env = createEnvelope(alice, { type: "message", payload: {} });
    assert.equal(env.nonce.length, 32);
    assert.ok(/^[0-9a-f]{32}$/.test(env.nonce));
  });
});

describe("v0.10.1: 旧端点关闭 (410 Gone)", () => {
  let server;
  before(async () => {
    server = new NodeServer();
    await server.start();
  });
  after(() => server.stop());

  it("POST /message → 410", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/message`, { method: "POST", body: "{}" });
    assert.equal(res.status, 410);
  });

  it("POST /task → 410", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/task`, { method: "POST", body: "{}" });
    assert.equal(res.status, 410);
  });
});

describe("v0.10.1: task_* RPC 走 Task State Machine", () => {
  let registry, url, pub, sub;

  before(async () => {
    registry = new Registry(0);
    await registry.start();
    url = `http://127.0.0.1:${registry.port}`;
    pub = new AgentNode({ name: "publisher", storageDir: path.join(tmp, "rpc_pub"), registryUrl: url });
    await pub.start();
    sub = new AgentNode({ name: "subscriber", storageDir: path.join(tmp, "rpc_sub"), registryUrl: url });
    await sub.start();
    await pub.refreshPeers();
    await sub.refreshPeers();
  });

  after(() => {
    if (pub) pub.stop();
    if (sub) sub.stop();
    if (registry) registry.stop();
  });

  it("通过 /rpc 发送 task_publish，订阅方进入状态机并收到 task:published", async () => {
    let received = null;
    sub.on("task:published", (info) => { received = info; });

    const task = createTask({ title: "rpc 任务", requiredCapabilities: ["knowledge"] });
    task.publisherFingerprint = pub.identity.fingerprint;
    task.publisherName = pub.name;
    const event = createTaskEvent(pub.identity, "publish", task);
    pub.tasks.upsert(task, event);

    const res = await pub.sendRpc(sub.address, "task_publish", { task, event, fromName: pub.name });
    assert.ok(res.success, `rpc 应成功: ${JSON.stringify(res)}`);

    await new Promise((r) => setTimeout(r, 400));
    assert.ok(received, "订阅方应收到 task:published 事件（走状态机）");
    assert.equal(received.task.title, "rpc 任务");
    // 订阅方任务库应有该任务（非 _onMessageReceived 空记录）
    const local = sub.tasks.get(task.id);
    assert.ok(local, "订阅方任务库应记录任务");
    assert.equal(local.status, TASK_STATUS.OPEN);
  });
});

describe("v0.10.1: Task event 真哈希链", () => {
  const alice = loadOrCreateIdentity(path.join(tmp, "hash_alice"), "alice");
  const store = makeStore(alice);

  it("eventHash = SHA-256(canonical)，previousHash 指向上一事件哈希", () => {
    const t1 = createTask({ title: "链测试" });
    t1.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", t1);
    assert.ok(e1.eventHash, "事件应有真哈希");
    assert.equal(e1.eventHash.length, 64);
    assert.equal(e1.previousHash, null);

    // 模拟状态推进
    t1.lastEventHash = e1.eventHash;
    const e2 = createTaskEvent(alice, "claim", { ...t1, status: TASK_STATUS.CLAIMED });
    assert.equal(e2.previousHash, e1.eventHash, "v2 应指向 v1 的真哈希");
  });

  it("篡改历史事件内容 → 验证失败（签名或 eventHash 任一防线拦截）", () => {
    const task = createTask({ title: "原任务" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", task);
    const ok = validateTaskEvent(e1, "publish", task, store, { hasLocalRecord: false });
    assert.equal(ok.ok, true);

    // 攻击者修改事件内容但保留签名与 eventId → 签名层先拦截（内容被签名覆盖）
    const tampered = { ...e1, payload: { evil: true } };
    const bad = validateTaskEvent(tampered, "publish", task, store, { hasLocalRecord: false });
    assert.equal(bad.ok, false, "篡改内容必须被拒");
  });

  it("篡改 e1 并重算 eventHash → e2 的 previousHash 断链（链级防篡改）", () => {
    const task = createTask({ title: "链篡改测试" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", task);
    task.lastEventHash = e1.eventHash;
    const e2 = createTaskEvent(alice, "claim", { ...task, status: TASK_STATUS.CLAIMED });

    // 攻击者篡改 e1 内容（payload），并重算 eventHash 假装自洽
    const forgedE1 = { ...e1, payload: { evil: true } };
    forgedE1.eventHash = crypto.createHash("sha256").update(JSON.stringify(forgedE1)).digest("hex");
    // 但 e2.previousHash 仍指向原 e1.eventHash → 本地链校验断链
    const stateWithForged = { ...task, lastEventHash: forgedE1.eventHash };
    const chainBad = validateTaskEvent(e2, "claim", stateWithForged, store, { hasLocalRecord: true });
    assert.equal(chainBad.ok, false);
    assert.ok(chainBad.reason.includes("previousHash") || chainBad.reason.includes("chain"));
  });

  it("非法状态转移被 checkTransition 拒绝", () => {
    const task = createTask({ title: "T" });
    task.publisherFingerprint = alice.fingerprint;
    // OPEN → complete 非法
    const bad = checkTransition(task, "complete", alice.fingerprint);
    assert.equal(bad.ok, false);
    // OPEN → claim 合法
    const ok = checkTransition(task, "claim", alice.fingerprint);
    assert.equal(ok.ok, true);
    // claim 后 complete 合法（actor=assignee）
    task.status = TASK_STATUS.CLAIMED;
    task.assigneeFingerprintActual = alice.fingerprint;
    const done = checkTransition(task, "complete", alice.fingerprint);
    assert.equal(done.ok, true);
    // 非 assignee complete 非法
    const stranger = loadOrCreateIdentity(path.join(tmp, "hash_stranger"), "stranger");
    const denied = checkTransition(task, "complete", stranger.fingerprint);
    assert.equal(denied.ok, false);
  });
});

describe("v0.10.1: E2E recipient 定向网络级验证", () => {
  let registry, url, nodeA, nodeB;

  before(async () => {
    registry = new Registry(0);
    await registry.start();
    url = `http://127.0.0.1:${registry.port}`;
    nodeA = new AgentNode({ name: "recip-a", storageDir: path.join(tmp, "rec_a"), registryUrl: url });
    await nodeA.start();
    nodeB = new AgentNode({ name: "recip-b", storageDir: path.join(tmp, "rec_b"), registryUrl: url });
    await nodeB.start();
    await nodeA.refreshPeers();
    await nodeB.refreshPeers();
  });

  after(() => {
    if (nodeA) nodeA.stop();
    if (nodeB) nodeB.stop();
    if (registry) registry.stop();
  });

  it("发给指定接收者的信封只被该接收者接受", async () => {
    // A 直接构造发给 A 自己的信封，投递给 B —— B 应拒绝 (recipient mismatch)
    const env = createEnvelope(nodeA.identity, {
      type: "message",
      payload: { text: "写给A的信" },
      recipient: nodeA.identity.fingerprint, // 定向给 A
    });
    const res = await nodeB.client.sendEnvelope(nodeB.address, env);
    // B 的 rpcHandler 返回 401 + recipient mismatch
    assert.equal(res.httpStatus, 401);
    assert.ok(JSON.stringify(res).includes("recipient mismatch"));
  });
});
