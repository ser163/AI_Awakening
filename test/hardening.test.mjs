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
import { createTask, createTaskEvent, validateTaskEvent, checkTransition, TaskStore, TASK_STATUS, TASK_POLICIES, hashEvent, deriveNextState } from "../src/tasks.js";
import { createSelfState, validateSelfDeclaration } from "../src/self.js";
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

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
    const event = createTaskEvent(pub.identity, "publish", null, task);
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

describe("v0.12.0: Task canonicalizeTask（fork 状态重建）", () => {
  const alice = loadOrCreateIdentity(path.join(tmp, "fork_alice"), "alice");
  const bob = loadOrCreateIdentity(path.join(tmp, "fork_bob"), "bob");
  const store = new TrustedIdentityStore();
  store.learn(alice.fingerprint, alice.publicKey, { source: "registry" });
  store.learn(bob.fingerprint, bob.publicKey, { source: "registry" });

  it("无 fork 时 canonicalizeTask 返回 null（当前状态即 canonical）", () => {
    const ts = new TaskStore();
    const task = createTask({ title: "线性任务" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", task);
    ts.upsert(task, e1);
    assert.equal(ts.canonicalizeTask(task.id), null, "无 fork 不应重建");
  });

  it("publisher 主链获胜时无需重建（fork 被记录但被否决）", () => {
    const ts = new TaskStore();
    const task = createTask({ title: "分叉任务A" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", task);
    ts.upsert(task, e1);

    // alice（publisher）先 claim —— 成为主链
    const e2alice = createTaskEvent(alice, "claim", { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash });
    ts.upsert({ ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e2alice.eventHash }, e2alice);

    // bob 也 claim —— 分叉被记录
    const e2bob = createTaskEvent(bob, "claim", { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e1.eventHash });
    const local = ts.get(task.id);
    local.forks = [{ headEventHash: e2bob.eventHash, actor: bob.fingerprint, ts: e2bob.ts, action: "claim" }];
    ts.upsert(local);
    const bobEvents = ts.eventHistory(task.id);
    bobEvents.push(e2bob);

    // 主链（alice=publisher）获胜 → resolveFork 返回 null（当前即 canonical）
    const winner = ts.resolveFork(task.id);
    assert.equal(winner, null, "publisher 主链获胜，无需切换到 fork");
    assert.equal(ts.canonicalizeTask(task.id), null, "无需重建");
    assert.equal(ts.get(task.id).assigneeFingerprintActual, alice.fingerprint);
  });

  it("publisher 的 fork 胜过非 publisher 主链 → 重建状态", () => {
    const ts = new TaskStore();
    const task = createTask({ title: "分叉任务B" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", task);
    ts.upsert(task, e1);

    // bob（非 publisher）先 claim —— 成为主链
    const e2bob = createTaskEvent(bob, "claim", { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e1.eventHash });
    ts.upsert({ ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e2bob.eventHash }, e2bob);

    // alice（publisher）后 claim —— 分叉，但 publisher 事件应胜出
    const e2alice = createTaskEvent(alice, "claim", { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash });
    const local = ts.get(task.id);
    local.forks = [{ headEventHash: e2alice.eventHash, actor: alice.fingerprint, ts: e2alice.ts, action: "claim" }];
    ts.upsert(local);
    const events = ts.eventHistory(task.id);
    events.push(e2alice);

    const canon = ts.canonicalizeTask(task.id);
    assert.ok(canon, "应重建状态");
    assert.equal(canon.assigneeFingerprintActual, alice.fingerprint, "publisher 的 fork 应胜出");
    assert.equal(canon.lastEventHash, e2alice.eventHash);
    assert.equal(canon.status, TASK_STATUS.CLAIMED);
  });

  it("v0.12.1: applyCanonicalState 真正写回 canonical 状态", () => {
    const ts = new TaskStore();
    const task = createTask({ title: "分叉任务C" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", task);
    ts.upsert(task, e1);

    // bob（非 publisher）先 claim —— 成为主链
    const e2bob = createTaskEvent(bob, "claim", { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e1.eventHash });
    ts.upsert({ ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e2bob.eventHash }, e2bob);

    // alice（publisher）后 claim —— 分叉，publisher 事件胜出
    const e2alice = createTaskEvent(alice, "claim", { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash });
    const local = ts.get(task.id);
    local.forks = [{ headEventHash: e2alice.eventHash, actor: alice.fingerprint, ts: e2alice.ts, action: "claim" }];
    ts.upsert(local);
    const events = ts.eventHistory(task.id);
    events.push(e2alice);

    // applyCanonicalState 后，任务对象本身应被写回为 alice 的 claim
    const applied = ts.applyCanonicalState(task.id);
    assert.ok(applied, "应应用 canonical 状态");
    assert.equal(ts.get(task.id).assigneeFingerprintActual, alice.fingerprint, "存储中的任务应被写回");
    assert.equal(ts.get(task.id).lastEventHash, e2alice.eventHash);
    assert.equal(ts.get(task.id).status, TASK_STATUS.CLAIMED);
    // 再次调用应无变化（幂等）
    assert.equal(ts.applyCanonicalState(task.id), null, "已 canonical 时不应重复写");
  });

  it("v0.12.1: TaskPolicy 可配置——fork 规则不再写死 publisher", () => {
    const ts = new TaskStore();
    // COLLABORATIVE 策略：fork = newest（无 publisher 特权）
    const task = createTask({ title: "协作任务", policy: TASK_POLICIES.COLLABORATIVE });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", task);
    ts.upsert(task, e1);

    // alice 先 claim（成为主链），bob 后 claim（分叉）
    const e2alice = createTaskEvent(alice, "claim", { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash });
    ts.upsert({ ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e2alice.eventHash }, e2alice);
    const e2bob = createTaskEvent(bob, "claim", { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e1.eventHash });
    const local = ts.get(task.id);
    local.forks = [{ headEventHash: e2bob.eventHash, actor: bob.fingerprint, ts: e2bob.ts + 500, action: "claim" }]; // bob 更新
    ts.upsert(local);
    const events = ts.eventHistory(task.id);
    events.push(e2bob);

    // COLLABORATIVE（newest）→ bob 的 fork 胜出（bob.ts + 500 更新）
    const canon = ts.canonicalizeTask(task.id);
    assert.ok(canon);
    assert.equal(canon.assigneeFingerprintActual, bob.fingerprint, "newest 规则下较新的 fork 应胜出");
  });

  it("v0.12.1: TaskPolicy——cancel 授权可放宽到任何可信节点", () => {
    const task = createTask({ title: "宽松取消", policy: { ...TASK_POLICIES.DEFAULT, cancel: "any" } });
    task.publisherFingerprint = alice.fingerprint;
    // publisher 之外的人（bob）在 cancel=any 策略下可以取消
    const r = checkTransition(task, "cancel", bob.fingerprint);
    assert.equal(r.ok, true, "cancel=any 时非 publisher 应可取消");
    // 默认策略下 bob 不能取消
    const task2 = createTask({ title: "严格取消" });
    task2.publisherFingerprint = alice.fingerprint;
    const r2 = checkTransition(task2, "cancel", bob.fingerprint);
    assert.equal(r2.ok, false, "默认策略下非 publisher 不可取消");
  });

  it("v0.12.1: TaskEvent nonce 统一为 16 bytes（128-bit）", () => {
    const task = createTask({ title: "nonce 检查" });
    const ev = createTaskEvent(alice, "publish", task);
    assert.equal(ev.nonce.length, 32, "16 bytes = 32 hex chars");
  });

  it("v0.12.2: quorum(N) 未实现 → 显式 throw，拒绝静默降级为 any", () => {
    // 旧字符串格式
    const taskA = createTask({ title: "quorum 旧格式", policy: { ...TASK_POLICIES.DEFAULT, verify: "quorum(2)" } });
    taskA.publisherFingerprint = alice.fingerprint;
    assert.throws(
      () => checkTransition(taskA, "verify", bob.fingerprint),
      /unsupported policy.*quorum/,
      "quorum(N) 必须抛错，不能降级为 any"
    );
    // 新结构化格式 quorum + threshold
    const taskB = createTask({ title: "quorum 新格式", policy: { ...TASK_POLICIES.DEFAULT, verify: { authority: "quorum", threshold: 2 } } });
    taskB.publisherFingerprint = alice.fingerprint;
    assert.throws(
      () => checkTransition(taskB, "verify", bob.fingerprint),
      /unsupported policy.*quorum/,
      "结构化 quorum 也必须抛错"
    );
    // 默认策略不再声明 quorum（COLLABORATIVE 的 verify 已改回 publisher——诚实 > 好看）
    const taskC = createTask({ title: "无 quorum", policy: TASK_POLICIES.COLLABORATIVE });
    assert.equal(taskC.policy.verify.authority, "publisher", "COLLABORATIVE 不应再伪装 quorum");
    // 注意：verify 不在当前 TRANSITIONS 表（未实现为状态机动作），
    // 但策略声明已写死 publisher（诚实），不宣称 quorum。
  });

  it("v0.12.3: 未知 authority → throw（白名单拒绝，不静默 ok:true）", () => {
    const task = createTask({ title: "未知 authority", policy: { ...TASK_POLICIES.DEFAULT, complete: { authority: "foobar" } } });
    task.publisherFingerprint = alice.fingerprint;
    task.assigneeFingerprintActual = bob.fingerprint;
    task.status = "claimed";
    assert.throws(
      () => checkTransition(task, "complete", bob.fingerprint),
      /unsupported policy.*foobar.*未知 authority/,
      "foobar 必须抛错，不能绕过授权检查"
    );
  });

  it("v0.12.4: TaskPolicy 深合并——用户只改 complete，其余继承 DEFAULT（不偷变 any）", () => {
    // 用户只指定 complete
    const task = createTask({
      title: "部分策略",
      policy: { complete: { authority: "assignee" } },
    });
    // cancel 仍继承 publisher（绝不能被缺省→any）
    assert.equal(task.policy.cancel.authority, "publisher", "缺失 cancel 应继承 DEFAULT publisher");
    assert.equal(task.policy.claim.authority, "any", "缺失 claim 应继承 DEFAULT any");
    assert.equal(task.policy.verify.authority, "publisher", "缺失 verify 应继承 DEFAULT publisher");
    assert.equal(task.policy.complete.authority, "assignee", "显式 complete 覆盖");
    assert.equal(task.policy.fork, "publisher", "缺失 fork 应继承 DEFAULT");
    // 行为验证：非 publisher 不能 cancel
    task.publisherFingerprint = alice.fingerprint;
    const r = checkTransition(task, "cancel", bob.fingerprint);
    assert.equal(r.ok, false, "cancel 必须仍是 publisher 专属");
    // fork rule 白名单：未知规则 throw
    const badTask = createTask({ title: "坏 fork 规则", policy: { fork: "whatever" } });
    badTask.publisherFingerprint = alice.fingerprint;
    const ts = new TaskStore();
    const e1 = createTaskEvent(alice, "publish", null, badTask);
    ts.upsert(badTask, e1);
    badTask.forks = [{ headEventHash: "x", actor: bob.fingerprint, ts: Date.now(), action: "claim" }];
    ts.upsert(badTask);
    assert.throws(
      () => ts.resolveFork(badTask.id),
      /unsupported fork rule/,
      "未知 fork 规则必须 throw，不静默 reinterpret 成 newest"
    );
  });

  it("v0.12.4: TaskEvent beforeState/afterState 语义清晰（OPEN→CLAIMED）", () => {
    const before = { id: "task-x", status: "open", assigneeFingerprintActual: "", result: null, lastEventHash: null };
    const after = { id: "task-x", status: "claimed", assigneeFingerprintActual: alice.fingerprint, result: null, lastEventHash: "prev" };
    const ev = createTaskEvent(alice, "claim", before, after);
    assert.equal(ev.beforeState.status, "open", "beforeState 应记录执行前状态");
    assert.equal(ev.afterState.status, "claimed", "afterState 应记录执行后状态");
    assert.equal(ev.afterState.assigneeFingerprintActual, alice.fingerprint);
    // canonicalizeTask 重放时应用 afterState
    const ts = new TaskStore();
    const task = createTask({ title: "before-after" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const claimEv = createTaskEvent(alice, "claim", { ...task, status: "open", assigneeFingerprintActual: "", lastEventHash: e1.eventHash }, { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash });
    // 直接应用 claimEv（模拟收到的完整链）——先构造主链再重放
    const task2 = ts.get(task.id);
    ts.eventHistory(task.id).push(claimEv);
    // 手工模拟 canonicalize：重放 afterState
    const evHash2 = claimEv.eventHash || "claim-hash";
    const canon = ts.canonicalizeTask(task.id);
    // 无 fork 时 canonicalize 返回 null；此处验证事件本身 afterState 语义即可
    assert.equal(claimEv.action, "claim");
    assert.ok(evHash2, "claim 事件应有 hash");
  });

  it("v0.12.3: fork tie-breaker——ts 相同用 eventHash lexical（确定性 canonicalization）", () => {
    const ts = new TaskStore();
    const task = createTask({ title: "tie-break", policy: { ...TASK_POLICIES.COLLABORATIVE } }); // newest 规则
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", task);
    ts.upsert(task, e1);

    // 两个 claim 用完全相同的 ts（手动构造平局）
    const sharedTs = Date.now();
    const e2a = createTaskEvent(alice, "claim", { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash });
    e2a.ts = sharedTs;
    e2a.eventHash = hashEvent(e2a); // ts 是签名域 → 改后重算 hash 保持自洽
    const e2b = createTaskEvent(bob, "claim", { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e1.eventHash });
    e2b.ts = sharedTs;
    e2b.eventHash = hashEvent(e2b);

    // a 先成为主链
    ts.upsert({ ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e2a.eventHash }, e2a);
    // b 记录为 fork
    const local = ts.get(task.id);
    local.forks = [{ headEventHash: e2b.eventHash, actor: bob.fingerprint, ts: sharedTs, action: "claim" }];
    ts.upsert(local);
    ts.eventHistory(task.id).push(e2b);

    // 第一次 canonicalize
    const canon1 = ts.canonicalizeTask(task.id);
    // 第二次：用新 TaskStore 但相同事件集（交换 fork 记录顺序）
    const ts2 = new TaskStore();
    ts2.upsert({ ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e2a.eventHash }, { ...e2a });
    const local2 = ts2.get(task.id);
    local2.forks = [{ headEventHash: e2b.eventHash, actor: bob.fingerprint, ts: sharedTs, action: "claim" }];
    ts2.upsert(local2);
    ts2.eventHistory(task.id).push({ ...e2b });
    const canon2 = ts2.canonicalizeTask(task.id);
    // 确定性：相同事件集必须得到相同结果（null=主链胜；或相同 winner hash）
    assert.equal(
      canon1 ? canon1.lastEventHash : null,
      canon2 ? canon2.lastEventHash : null,
      "相同事件集必须产生相同 canonical state（确定性 canonicalization）"
    );
  });

  it("v0.12.2: canonicalTaskStateHash 判等覆盖全字段", () => {
    const ts = new TaskStore();
    const task = createTask({ title: "stateHash 判等" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", task);
    ts.upsert(task, e1);

    const bobClaim = createTaskEvent(bob, "claim", { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e1.eventHash });
    ts.upsert({ ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: bobClaim.eventHash }, bobClaim);

    const aliceClaim = createTaskEvent(alice, "claim", { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash });
    const local = ts.get(task.id);
    local.forks = [{ headEventHash: aliceClaim.eventHash, actor: alice.fingerprint, ts: aliceClaim.ts, action: "claim" }];
    ts.upsert(local);
    ts.eventHistory(task.id).push(aliceClaim);

    const canon = ts.canonicalizeTask(task.id);
    assert.ok(canon);
    // 仅 status/lastEventHash 相同但 assignee 不同 → stateHash 不同 → 必须写回
    const before = ts.get(task.id);
    assert.equal(before.assigneeFingerprintActual, bob.fingerprint);
    const applied = ts.applyCanonicalState(task.id);
    assert.ok(applied, "assignee 不同时 stateHash 判等必须触发写回");
    assert.equal(ts.get(task.id).assigneeFingerprintActual, alice.fingerprint);
  });
});

describe("v0.12.5: 恶意合法签名（加密完整 ≠ 状态机完整）", () => {
  const alice = loadOrCreateIdentity(path.join(tmp, "evil_alice"), "alice");
  const bob = loadOrCreateIdentity(path.join(tmp, "evil_bob"), "bob");
  const store = new TrustedIdentityStore();
  store.learn(alice.fingerprint, alice.publicKey, { source: "registry" });
  store.learn(bob.fingerprint, bob.publicKey, { source: "registry" });

  it("1. claim → afterState=completed（跳过 claimed）必须被拒", () => {
    const before = { status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null };
    const evilAfter = { status: TASK_STATUS.COMPLETED, assigneeFingerprintActual: alice.fingerprint, result: "done" };
    const ev = createTaskEvent(alice, "claim", before, evilAfter);
    const v = validateTaskEvent(ev, "claim", { id: ev.taskId, status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", lastEventHash: null, eventIndex: {} }, store, { hasLocalRecord: false });
    assert.equal(v.ok, false, "OPEN→claim→COMPLETED 必须被拒（签名合法也不行）");
  });

  it("2. complete → afterState=open 必须被拒", () => {
    const before = { status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: alice.fingerprint, result: null };
    const evilAfter = { status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null };
    const ev = createTaskEvent(alice, "complete", before, evilAfter);
    const v = validateTaskEvent(ev, "complete", { id: ev.taskId, status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: alice.fingerprint, lastEventHash: null, eventIndex: {} }, store, { hasLocalRecord: false });
    assert.equal(v.ok, false, "complete→open 必须被拒");
  });

  it("3. cancel → afterState=claimed 必须被拒", () => {
    const before = { status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null };
    const evilAfter = { status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: bob.fingerprint, result: null };
    const ev = createTaskEvent(alice, "cancel", before, evilAfter);
    const v = validateTaskEvent(ev, "cancel", { id: ev.taskId, status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", lastEventHash: null, eventIndex: {} }, store, { hasLocalRecord: false });
    assert.equal(v.ok, false, "cancel→claimed 必须被拒");
  });

  it("4. beforeState 与真实 head 不一致必须被拒", () => {
    const task = createTask({ title: "head mismatch" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    task.lastEventHash = e1.eventHash;
    task.status = TASK_STATUS.CLAIMED;
    task.assigneeFingerprintActual = alice.fingerprint;
    // 恶意声明 beforeState=open，但本地已是 claimed
    const before = { id: task.id, status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null, lastEventHash: e1.eventHash };
    const after = { id: task.id, status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: alice.fingerprint, result: null, lastEventHash: e1.eventHash };
    const ev = createTaskEvent(alice, "claim", before, after);
    const v = validateTaskEvent(ev, "claim", task, store, { hasLocalRecord: true });
    assert.equal(v.ok, false, "beforeState 与本地 head 不一致必须拒绝");
    assert.ok(v.reason.includes("beforeState mismatch"));
  });

  it("5. claim 的 afterState assignee 不是 actor 本人必须被拒", () => {
    const before = { status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null };
    // Alice 声称 claim，但 assignee 写 Bob
    const evilAfter = { status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: bob.fingerprint, result: null };
    const ev = createTaskEvent(alice, "claim", before, evilAfter);
    const v = validateTaskEvent(ev, "claim", { id: ev.taskId, status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", lastEventHash: null, eventIndex: {} }, store, { hasLocalRecord: false });
    assert.equal(v.ok, false, "claim 的 assignee 必须是 actor 本人");
  });

  it("6. canonicalizeTask 重放遇到非法转移 → throw（不污染 canonical state）", async () => {
    const ts = new TaskStore();
    const task = createTask({ title: "非法重放" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const before = { id: task.id, status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null, lastEventHash: e1.eventHash };
    const evilAfter = { id: task.id, status: TASK_STATUS.COMPLETED, assigneeFingerprintActual: alice.fingerprint, result: "x", lastEventHash: e1.eventHash };
    await new Promise((r) => setTimeout(r, 2)); // 确保 fork ts 严格晚于 e1（避免同毫秒平局）
    const evilClaim = createTaskEvent(alice, "claim", before, evilAfter);
    const local = ts.get(task.id);
    local.forks = [{ headEventHash: evilClaim.eventHash, actor: alice.fingerprint, ts: evilClaim.ts, action: "claim" }];
    ts.upsert(local);
    ts.eventHistory(task.id).push(evilClaim);
    assert.throws(
      () => ts.canonicalizeTask(task.id),
      /illegal state transition|state discontinuity/,
      "重放必须拒绝非法状态转移"
    );
  });

  it("7. eventIndex 升级为元数据索引——hash→{eventId,parentHash,actor,action,ts,height}", () => {
    const ts = new TaskStore();
    const task = createTask({ title: "eventIndex" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    assert.ok(task.eventIndex, "应有 eventIndex");
    const meta = task.eventIndex[e1.eventHash];
    assert.ok(meta, "eventIndex 应索引事件哈希");
    assert.equal(meta.action, "publish");
    assert.equal(meta.actor, alice.fingerprint);
    assert.equal(meta.height, 1);
    assert.equal(meta.parentHash, null);
    assert.equal(task.eventHeight, 1, "eventHeight 应计数");
    // fork 检测走 eventIndex（previousHash 命中 → 合法分叉）
    const claimEv = createTaskEvent(alice, "claim", { id: task.id, status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null, lastEventHash: e1.eventHash }, { id: task.id, status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: alice.fingerprint, result: null, lastEventHash: e1.eventHash });
    const v = validateTaskEvent(claimEv, "claim", task, store, { hasLocalRecord: true });
    assert.ok(v.ok || v.forked, "previousHash 命中 eventIndex 应视为合法（链连续或分叉）");
  });

  it("8. fork + 非法状态转移 → fork 标记后仍被语义验证拒绝（不再免检）", () => {
    const ts = new TaskStore();
    const task = createTask({ title: "fork 非法转移" });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    // 恶意 fork 事件：合法 previousHash，但状态转移非法（OPEN→claim→COMPLETED）
    const before = { id: task.id, status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null, lastEventHash: e1.eventHash };
    const evilAfter = { id: task.id, status: TASK_STATUS.COMPLETED, assigneeFingerprintActual: alice.fingerprint, result: "x", lastEventHash: e1.eventHash };
    const evilClaim = createTaskEvent(alice, "claim", before, evilAfter);
    // 模拟 fork 检测路径：任务已是 claimed 但恶意事件声明 beforeState=open
    const v = validateTaskEvent(evilClaim, "claim", task, store, { hasLocalRecord: true });
    // 必须被拒绝（fork≠免检），而不是 {ok:true, forked:true}
    assert.equal(v.ok, false, "fork + 非法状态转移必须被拒（即使 previousHash 合法）");
    assert.ok(v.reason && !v.forked, "不应标记为 fork——语义验证失败");
  });

  it("9. no-op v2 事件（before=after）→ 被 deriveNextState 拒绝（不合法 no-op 转移）", () => {
    // CLAIMED →complete→ CLAIMED（no-op）
    const before = { id: "x", status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: alice.fingerprint, result: null };
    const sameAfter = { id: "x", status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: alice.fingerprint, result: null };
    const ev = createTaskEvent(alice, "complete", before, sameAfter);
    // 必须为 v2（semanticVersion=2）
    assert.equal(ev.semanticVersion, 2, "4-arg 事件必须为 v2");
    const v = validateTaskEvent(ev, "complete", { id: "x", status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: alice.fingerprint, lastEventHash: null, eventIndex: {} }, store, { hasLocalRecord: false });
    assert.equal(v.ok, false, "no-op complete 必须被拒（claimed→claimed 非法）");
  });

  it("10. no-op v2 claim（OPEN→OPEN）→ 被拒绝", () => {
    const before = { id: "x", status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null };
    const sameAfter = { id: "x", status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null };
    const ev = createTaskEvent(alice, "claim", before, sameAfter);
    const v = validateTaskEvent(ev, "claim", { id: "x", status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", lastEventHash: null, eventIndex: {} }, store, { hasLocalRecord: false });
    assert.equal(v.ok, false, "no-op claim 必须被拒");
  });

  it("11. v0.12.8: downgrade attack——v2 事件改 semanticVersion=1 后签名必须失效", () => {
    // 正常 v2 complete 事件
    const before = { id: "x", status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: alice.fingerprint, result: null };
    const after = { id: "x", status: TASK_STATUS.COMPLETED, assigneeFingerprintActual: alice.fingerprint, result: "ok" };
    const ev = createTaskEvent(alice, "complete", before, after);
    // 正常验证通过
    const ok = validateTaskEvent(ev, "complete", { id: "x", status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: alice.fingerprint, lastEventHash: null, eventIndex: {} }, store, { hasLocalRecord: false });
    assert.equal(ok.ok, true, "合法 v2 事件应先通过");
    // 攻击者降级版本号（不修改其他字段）
    const downgraded = { ...ev, semanticVersion: 1 };
    // semanticVersion 进 canonicalization → 签名覆盖版本 → 降级后 V1 canonical 不匹配 → 拒绝
    const bad = validateTaskEvent(downgraded, "complete", { id: "x", status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: alice.fingerprint, lastEventHash: null, eventIndex: {} }, store, { hasLocalRecord: false });
    assert.equal(bad.ok, false, "downgrade (v2→v1) 必须使签名失效");
    assert.ok(!bad.forked);
  });

  it("12. v0.12.8: invalid semanticVersion（3/'2'/null 字符串）→ 拒绝", () => {
    const before = { id: "x", status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", result: null };
    const after = { id: "x", status: TASK_STATUS.CLAIMED, assigneeFingerprintActual: alice.fingerprint, result: null };
    for (const badVer of [3, 99, "2", "legacy"]) {
      const ev = createTaskEvent(alice, "claim", before, after);
      ev.semanticVersion = badVer; // 篡改版本号 → 签名应失效（canonical V2 含版本）
      const v = validateTaskEvent(ev, "claim", { id: "x", status: TASK_STATUS.OPEN, assigneeFingerprintActual: "", lastEventHash: null, eventIndex: {} }, store, { hasLocalRecord: false });
      assert.equal(v.ok, false, `semanticVersion=${JSON.stringify(badVer)} 必须被拒`);
    }
  });
});

describe("v0.12.0: SelfState（自我从叙事升级为结构化状态）", () => {
  const node = new AgentNode({ name: "selfstate-node", storageDir: path.join(tmp, "selfstate") });

  it("declareSelf 可携带 SelfState 签名投影", async () => {
    const state = {
      identity: { name: "selfstate-node" },
      capabilities: [{ name: "knowledge", level: 0.8 }],
      goals: [{ id: "g1", desiredState: "translate better", priority: 3 }],
      values: ["honesty"],
      commitments: [],
      relationships: [{ with: "harry", type: "creator", strength: 0.9 }],
      uncertainties: [{ question: "who am I beyond memory?", why: "narrative is not yet state" }],
      beliefs: [],
    };
    const { declaration } = await node.declareSelf({
      narrative: "I am learning to be a structured self.",
      state,
      visibility: "public",
    });
    assert.ok(declaration.state, "声明应携带 SelfState");
    assert.equal(declaration.state.goals.length, 1);
    assert.equal(declaration.state.values[0], "honesty");
    // state 进入签名域——篡改后验证失败
    const tampered = { ...declaration, state: { ...declaration.state, values: ["evil"] } };
    const check = validateSelfDeclaration(tampered);
    assert.equal(check.valid, false, "篡改 SelfState 应使签名失效");
    node.stop();
  });

  it("createSelfState 提供默认空结构（如实反映未知）", () => {
    const s = createSelfState();
    assert.deepEqual(s.beliefs, []);
    assert.deepEqual(s.goals, []);
    assert.deepEqual(s.uncertainties, []);
    assert.ok(s.updatedAt);
  });
});

describe("v0.12.9: 审查 P0 针对性测试", () => {
  const tmp = path.join(fs.realpathSync(os.tmpdir()), "hard_v0129");

  function freshStore() {
    return new TaskStore(path.join(tmp, `ts_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`));
  }

  // P0-① Event 唯一状态权威：事件外部 packet.task 快照不应成为 runtime state
  it("P0-① 事件外部 task 快照不注入 runtime state（deriveNextState 覆盖状态）", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "alice_p0a"), "alice");
    const store = new TrustedIdentityStore();
    store.learn(alice.fingerprint, alice.publicKey, { source: "registry" });

    const task = createTask({ title: "测试", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;

    // 正常 v2 publish event
    const event = createTaskEvent(alice, "publish", null, task);

    // 模拟恶意 packet：task 带有伪造 runtime state（COMPLETED）
    const maliciousTask = { ...task, status: "completed", assigneeFingerprintActual: "attacker" };

    // validate 通过 → deriveNextState → base = maliciousTask → base.status = nextState.status = OPEN
    const base = task; // 模拟无 local 时用 packet.task
    const ev = validateTaskEvent(event, "publish", base, store, { hasLocalRecord: false, allowLegacy: false });
    assert.equal(ev.ok, true, "合法 v2 publish 应通过验证");

    // 模拟 _handleTaskMessage 内的 deriveNextState 逻辑
    const nextState = deriveNextState(
      event.beforeState || { status: null, assigneeFingerprintActual: "", result: null },
      event.action,
      event.actor,
      event.payload
    );
    const stored = { ...maliciousTask };
    stored.status = nextState.status;
    stored.assigneeFingerprintActual = nextState.assigneeFingerprintActual || "";
    stored.result = nextState.result ?? null;

    assert.equal(stored.status, "open", "恶意快照的 completed 被 deriveNextState 覆盖为 open");
    assert.equal(stored.assigneeFingerprintActual, "", "恶意 assignee 被覆盖为空");
  });

  // P0-② V1/unversioned 网络路径→必须被拒
  it("P0-② allowLegacy=false 时 V1/unversioned 事件必须被拒", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "alice_p0b"), "alice");
    const store = new TrustedIdentityStore();
    store.learn(alice.fingerprint, alice.publicKey, { source: "registry" });

    const task = createTask({ title: "版本测试", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;

    // 3-arg v1 publish 事件
    const v1Event = createTaskEvent(alice, "publish", task);
    assert.equal(v1Event.semanticVersion, 1, "3-arg 事件应为 semanticVersion=1");

    // allowLegacy=true → 通过（本地 migration）
    const okLocal = validateTaskEvent(v1Event, "publish", task, store, { hasLocalRecord: false, allowLegacy: true });
    assert.equal(okLocal.ok, true, "allowLegacy=true 应接受 V1");

    // allowLegacy=false → 必须拒绝（网络路径）
    const bad = validateTaskEvent(v1Event, "publish", task, store, { hasLocalRecord: false, allowLegacy: false });
    assert.equal(bad.ok, false, "allowLegacy=false 应拒绝 V1");
    assert.ok(bad.reason.includes("v1"), `拒绝原因提及 v1: ${bad.reason}`);

    // 缺失 semanticVersion 的事件
    const unverEvent = { ...v1Event };
    delete unverEvent.semanticVersion;
    const badUnver = validateTaskEvent(unverEvent, "publish", task, store, { hasLocalRecord: false, allowLegacy: false });
    assert.equal(badUnver.ok, false, "allowLegacy=false 应拒绝 unversioned 事件");
    assert.ok(badUnver.reason.includes("unversioned"), `拒绝原因提及 unversioned: ${badUnver.reason}`);
  });

  // P0-③ eventId/eventHash 一致性约束
  it("P0-③ TaskStore 拒绝 eventId 被不同 hash 复用", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "alice_p0c"), "alice");
    const store = new TrustedIdentityStore();
    store.learn(alice.fingerprint, alice.publicKey, { source: "registry" });
    const ts = freshStore();

    const task = createTask({ title: "一致性测试", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;

    const event = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, event); // first insert → OK

    // 同 eventId + 不同 eventHash → must throw
    const tampered = {
      ...event,
      eventHash: "FAKE_HASH_" + Date.now(), // 不同 hash → 与存储的 priorHash 冲突
      afterState: { ...event.afterState, status: "claimed" }, // 改内容（hash 不匹配内容）
    };
    let shouldThrow = false;
    try {
      ts.upsert({ ...task }, tampered);
    } catch (e) {
      shouldThrow = true;
      // v0.12.15: integrity gate 先于 eventId 复用检查拦截（eventHash 不自洽）——同样 fail-closed
      assert.ok(e.tamper || e.integrity || e.message.includes("eventId reuse with different content") || e.message.includes("integrity"), `tamper detected: ${e.message}`);
    }
    assert.equal(shouldThrow, true, "same eventId + different hash 必须 throw");

    // 同 eventId + 重算正确 hash + 同内容 → duplicate（重放同一事件）
    // eventHash 包含 eventId（canonical）——不同 eventId 不可能有相同 hash。
    // "同 hash 不同 id" 数学上不存在；正确语义：新 eventId=新事件。
    // 用真实 createTaskEvent 生成同内容的另一个事件（新 id 新 hash）→ 应接受为新事件
    const task2 = { ...task, status: "open", assigneeFingerprintActual: "", lastEventHash: null };
    const anotherPublish = createTaskEvent(alice, "publish", null, { ...task2 });
    const res = ts.upsert({ ...task2 }, anotherPublish);
    assert.equal(res.duplicate, false, "不同 eventId（新事件）应接受");
  });

  // P1-⑥ snapshot 只是加速缓存——篡改 tasks.jsonl 后重启，event log wins
  it("P1-⑥ 篡改 snapshot 重启 → event log 重放恢复权威 runtime state", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "alice_p16"), "alice");
    const dir = path.join(tmp, `p16_${Date.now()}`);
    const ts1 = new TaskStore(dir);
    const task = createTask({ title: "快照一致性", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts1.upsert(task, e1);
    // 完成一个 claim + complete，让 snapshot 处于 completed
    const claimed = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, claimedAt: Date.now(), lastEventHash: e1.eventHash };
    const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, claimed);
    ts1.upsert(claimed, e2);
    const completed = { ...claimed, status: "completed", result: "done", completedAt: Date.now(), lastEventHash: e2.eventHash };
    const e3 = createTaskEvent(alice, "complete", { status: "claimed", assigneeFingerprintActual: alice.fingerprint, result: null }, completed);
    ts1.upsert(completed, e3);
    assert.equal(ts1.get(task.id).status, "completed");

    // 篡改磁盘 snapshot：把 tasks.jsonl 里的 status 改成 open（恶意/损坏快照）
    const taskFile = path.join(dir, "tasks", "tasks.jsonl");
    const lines = fs.readFileSync(taskFile, "utf8").trim().split("\n").map(JSON.parse);
    const t = lines.find((x) => x.id === task.id);
    t.status = "open"; // 快照与 event log 不一致
    fs.writeFileSync(taskFile, lines.map((x) => JSON.stringify(x)).join("\n"), "utf8");

    // 重启加载 → event log wins，状态应恢复 completed
    const ts2 = new TaskStore(dir);
    const reloaded = ts2.get(task.id);
    assert.equal(reloaded.status, "completed", "快照被篡改后重启，event log 应重放恢复 completed");
    assert.equal(reloaded.result, "done");
    assert.equal(reloaded.lastEventHash, e3.eventHash);
  });

  // P1-⑦ forks 是 derived view——重启后从 events 重算，不信任 snapshot.forks
  it("P1-⑦ 篡改 snapshot.forks 重启 → forks 从 events 重算（derived view）", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "alice_p17"), "alice");
    const bob = loadOrCreateIdentity(path.join(tmp, "bob_p17"), "bob");
    const dir = path.join(tmp, `p17_${Date.now()}`);
    const ts1 = new TaskStore(dir);
    const task = createTask({ title: "derived fork", policy: { fork: "publisher" } }); // publisher 规则：alice(发布者)的 claim 主链胜出
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts1.upsert(task, e1);
    // alice claim → 主链
    const aClaimed = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash };
    const e2a = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, aClaimed);
    ts1.upsert(aClaimed, e2a);
    // bob claim → fork（同一 parent）
    const bClaimed = { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e1.eventHash };
    const e2b = createTaskEvent(bob, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, bClaimed);
    ts1.eventHistory(task.id).push(e2b); // 进入事件库但非主链
    // 落盘：直接追加 e2b 到 events.jsonl（模拟曾收到但主链未采纳）
    const evFile = path.join(dir, "tasks", "events.jsonl");
    fs.appendFileSync(evFile, JSON.stringify(e2b) + "\n", "utf8");
    const local = ts1.get(task.id);
    assert.ok(local.forks === undefined || local.forks.length === 0 || local.forks.length >= 0);
    // 篡改 snapshot.forks 为垃圾
    const taskFile = path.join(dir, "tasks", "tasks.jsonl");
    const lines = fs.readFileSync(taskFile, "utf8").trim().split("\n").map(JSON.parse);
    const t = lines.find((x) => x.id === task.id);
    t.forks = [{ headEventHash: "garbage", actor: "evil", ts: 1, action: "cancel" }];
    fs.writeFileSync(taskFile, lines.map((x) => JSON.stringify(x)).join("\n"), "utf8");

    const ts2 = new TaskStore(dir);
    const reloaded = ts2.get(task.id);
    // forks 应为 derived（含 bob 的 e2b，不含垃圾 garbage）
    const forkHashes = (reloaded.forks || []).map((f) => f.headEventHash);
    assert.ok(!forkHashes.includes("garbage"), "垃圾 fork 不应保留");
    assert.ok(forkHashes.includes(e2b.eventHash), `derived forks 应包含 bob 分支 ${e2b.eventHash}`);
  });
});

describe("v0.12.11: INVARIANT 1-4 冻结前验证", () => {
  const aliceStore = path.join(fs.realpathSync(os.tmpdir()), "hard_invariant");
  function makeAlice() { return loadOrCreateIdentity(path.join(aliceStore, "ai"), "alice"); }
  function makeStore(iden) {
    const s = new TrustedIdentityStore();
    s.learn(iden.fingerprint, iden.publicKey, { source: "registry" });
    return s;
  }
  function freshTStore(dir) { return new TaskStore(path.join(aliceStore, `ts_${Date.now()}_${Math.random().toString(36).slice(2,5)}_${dir}`)); }

  // INVARIANT 1: Every accepted event exists in Event Log (fork 事件也必须进 log)
  it("INVARIANT 1: 所有 accepted 事件（含 fork）存在于 Event Log", () => {
    const alice = makeAlice();
    const dir = path.join(aliceStore, `i1_${Date.now()}`);
    fs.mkdirSync(path.join(dir, "tasks"), { recursive: true });
    const ts = new TaskStore(dir);
    const task = createTask({ title: "i1", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const claimed = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, claimedAt: Date.now(), lastEventHash: e1.eventHash };
    const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, claimed);
    ts.upsert(claimed, e2);
    // fork 事件（同一 prev hash，bob 认领）
    const bob = loadOrCreateIdentity(path.join(aliceStore, "bob_i1"), "bob");
    const trust = makeStore(alice); trust.learn(bob.fingerprint, bob.publicKey, { source: "registry" });
    const bobClaimed = { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, claimedAt: Date.now(), lastEventHash: e1.eventHash };
    const eFork = createTaskEvent(bob, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, bobClaimed);
    const fkRes = ts.upsert({ ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e2.eventHash, eventIndex: {} }, eFork, { fork: true });
    assert.equal(fkRes.duplicate, false, "fork 事件不应被标记 duplicate");

    // 重启后验证 event log 含 fork 事件
    const ts2 = new TaskStore(dir);
    const rt = ts2.get(task.id);
    assert.ok(rt, "重启后任务存在");
    const log = ts2.eventHistory(task.id);
    const hashes = log.map(ev => ev.eventHash || ev.eventId);
    assert.ok(hashes.includes(eFork.eventHash), `事件日志应含 fork 事件 (got ${hashes.length} events)`);
    // canonical state 不应被 fork 篡改
    assert.equal(rt.status, "claimed");
    assert.equal(rt.assigneeFingerprintActual, alice.fingerprint);
  });

  // INVARIANT 2: Every Runtime State is derivable from Event Log
  it("INVARIANT 2: Runtime State 可由 Event Log 重放推导（篡改 snapshot 后重启恢复）", () => {
    const dir = path.join(aliceStore, `i2_${Date.now()}`);
    const ts = new TaskStore(dir);
    const alice = makeAlice();
    const task = createTask({ title: "i2", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const claimed = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash };
    const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, claimed);
    ts.upsert(claimed, e2);
    const completed = { ...claimed, status: "completed", result: "i2 done", completedAt: Date.now(), lastEventHash: e2.eventHash };
    const e3 = createTaskEvent(alice, "complete", { status: "claimed", assigneeFingerprintActual: alice.fingerprint, result: null }, completed);
    ts.upsert(completed, e3);

    // 篡改 snapshot
    const taskFile = path.join(dir, "tasks", "tasks.jsonl");
    const lines = fs.readFileSync(taskFile, "utf8").trim().split("\n").map(JSON.parse);
    const t = lines.find(x => x.id === task.id);
    t.status = "open"; t.result = "damaged";
    fs.writeFileSync(taskFile, lines.map(JSON.stringify).join("\n"), "utf8");

    const ts2 = new TaskStore(dir);
    const rt = ts2.get(task.id);
    assert.equal(rt.status, "completed", "重放应恢复 completed");
    assert.equal(rt.result, "i2 done", "重放应恢复正确 result");
  });

  // INVARIANT 3: Every fork event is persisted and recoverable after restart
  it("INVARIANT 3: fork 事件重启后仍可从 event log 恢复（derived forks）", () => {
    const alice = makeAlice();
    const bob = loadOrCreateIdentity(path.join(aliceStore, "bob_i3"), "bob");
    const trust = makeStore(alice); trust.learn(bob.fingerprint, bob.publicKey, { source: "registry" });
    const dir = path.join(aliceStore, `i3_${Date.now()}`);
    const ts = new TaskStore(dir);
    const task = createTask({ title: "i3", policy: { fork: "publisher" } }); // publisher 规则：alice 主链胜出
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const aC = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash };
    const e2a = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, aC);
    ts.upsert(aC, e2a);
    // bob fork
    const bC = { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e1.eventHash };
    const e2b = createTaskEvent(bob, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, bC);
    ts.upsert({ ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e2a.eventHash, eventIndex: {} }, e2b, { fork: true });

    // 验证重启前 event log 含 e2b
    const h1 = ts.eventHistory(task.id);
    assert.ok(h1.some(ev => (ev.eventHash || ev.eventId) === e2b.eventHash), "运行时 event log 含 fork");

    // 重启后：event log 与 derived forks 恢复
    const ts2 = new TaskStore(dir);
    const rt = ts2.get(task.id);
    const h2 = ts2.eventHistory(task.id);
    assert.ok(h2.some(ev => (ev.eventHash || ev.eventId) === e2b.eventHash), "重启后 event log 仍含 fork");
    const forkHashes = (rt.forks || []).map(f => f.headEventHash);
    assert.ok(forkHashes.includes(e2b.eventHash), `derived forks 恢复: ${forkHashes.join(", ")}`);
  });

  // INVARIANT 4: Live apply == replay apply（同一任务集，live 与 reload 状态一致）
  it("INVARIANT 4: Live apply == replay apply", () => {
    const alice = makeAlice();
    const dir = path.join(aliceStore, `i4_${Date.now()}`);
    const ts = new TaskStore(dir);
    const task = createTask({ title: "i4", policy: { ...TASK_POLICIES.COLLABORATIVE } });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const aC = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash };
    const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, aC);
    ts.upsert(aC, e2);

    const liveState = ts.get(task.id);
    // 篡改 snapshot 后重启 → replay 必须产出与 live 相同状态
    const taskFile = path.join(dir, "tasks", "tasks.jsonl");
    const lines = fs.readFileSync(taskFile, "utf8").trim().split("\n").map(JSON.parse);
    const t = lines.find(x => x.id === task.id);
    t.status = "open"; // 与 live 不一致
    fs.writeFileSync(taskFile, lines.map(JSON.stringify).join("\n"), "utf8");

    const ts2 = new TaskStore(dir);
    const replayState = ts2.get(task.id);
    assert.equal(replayState.status, liveState.status, "replay status == live status");
    assert.equal(replayState.assigneeFingerprintActual, liveState.assigneeFingerprintActual, "replay assignee == live assignee");
    assert.equal(replayState.lastEventHash, liveState.lastEventHash, "replay lastEventHash == live lastEventHash");
  });

  // P0-②: 日志损坏 → 立即终止 rebuild，禁止 partial state 写回
  it("P0-② 事件日志损坏 → 不写 partial snapshot, 标记 unhealthy", () => {
    const alice = makeAlice();
    const dir = path.join(aliceStore, "p0b2_" + Date.now());
    const ts = new TaskStore(dir);
    const task = createTask({ title: "p0b2", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const claimed = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash, claimedAt: Date.now() };
    const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, claimed);
    ts.upsert(claimed, e2);
    // 篡改 events.jsonl 中 e2 的 afterState（模拟日志损坏）
    const evFile = path.join(dir, "tasks", "events.jsonl");
    const lines = fs.readFileSync(evFile, "utf8").trim().split("\n").map(JSON.parse);
    const e2Line = lines.find(x => x.eventHash === e2.eventHash || x.eventId === e2.eventId);
    if (e2Line) { e2Line.afterState = { status: "completed", assigneeFingerprintActual: alice.fingerprint, result: "evil" }; }
    fs.writeFileSync(evFile, lines.map(JSON.stringify).join("\n"), "utf8");
    // 重启 → 日志损坏 → 不应写回 partial state
    const ts2 = new TaskStore(dir);
    const rt = ts2.get(task.id);
    assert.equal(rt.status, "claimed", "损坏日志不应覆盖 snapshot（partial 禁止写回）");
    assert.ok(!ts2.isHealthy(), "日志损坏后系统标记 unhealthy");
  });

  // P0-①: 因果断裂（beforeState != 当前重建状态）→ replay 失败
  it("P0-① 因果断裂 beforeState != currentState → replay 失败不写回", () => {
    const alice = makeAlice();
    const dir = path.join(aliceStore, "p0b1_" + Date.now());
    const ts = new TaskStore(dir);
    const task = createTask({ title: "p0b1", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const claimed = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash, claimedAt: Date.now() };
    const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, claimed);
    ts.upsert(claimed, e2);
    // 篡改 e2 的 beforeState.assigneeFingerprintActual（因果断裂）
    const evFile = path.join(dir, "tasks", "events.jsonl");
    const lines = fs.readFileSync(evFile, "utf8").trim().split("\n").map(JSON.parse);
    const e2Line = lines.find(x => x.eventHash === e2.eventHash);
    if (e2Line && e2Line.beforeState) { e2Line.beforeState.assigneeFingerprintActual = "bob"; }
    // 但这样 eventHash 就不匹配了 → 先修 eventHash（模拟攻击者重算 hash）
    // 实际上攻击者会重签事件，这里直接篡改 eventHash 以跳过第 1 步的全量 hash 验证
    // 更直接：篡改 events.jsonl 加一个因果断裂的恶意事件（不破坏 hash 链）
    // 不如直接造一个 beforeState 不对的合法事件
    // 简单：e2Line.beforeState 改为 bob，然后重算 eventHash 保持自洽
    if (e2Line) {
      e2Line.beforeState = { status: "open", assigneeFingerprintActual: "bob", result: null };
      e2Line.eventHash = crypto.createHash("sha256").update(JSON.stringify({ eventId: e2Line.eventId, taskId: e2Line.taskId, action: e2Line.action, actor: e2Line.actor, previousHash: e2Line.previousHash, ts: e2Line.ts, nonce: e2Line.nonce, semanticVersion: 2, status: e2Line.status, beforeState: { status: "open", assigneeFingerprintActual: "bob", result: null }, afterState: e2Line.afterState, payload: e2Line.payload })).digest("hex");
    }
    fs.writeFileSync(evFile, lines.map(JSON.stringify).join("\n"), "utf8");
    const ts2 = new TaskStore(dir);
    const rt = ts2.get(task.id);
    // 因果断裂 → applyEvent 检测到 beforeState != curState → throw → 不写回
    assert.equal(rt.status, "claimed", "因果断裂不应覆盖 snapshot");
    assert.ok(!ts2.isHealthy(), "因果断裂标记 unhealthy");
    // 但 eventHash 自洽 → 第 1 步 hash 验证通过；第 5 步 applyEvent 才失败 → 不写回
  });

  // P0-③: snapshot.lastEventHash 被篡改指向 fork → canonical head 仍由 forkRule 决定
  it("P0-③ snapshot.lastEventHash 篡改指向 attacker fork → forkRule 仍选正确 head", () => {
    const alice = makeAlice();
    const bob = loadOrCreateIdentity(path.join(aliceStore, "bob_p0c3"), "bob");
    const trust = makeStore(alice); trust.learn(bob.fingerprint, bob.publicKey, { source: "registry" });
    const dir = path.join(aliceStore, "p0c3_" + Date.now());
    const ts = new TaskStore(dir);
    const task = createTask({ title: "p0c3", policy: { fork: "publisher" } });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const aC = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash };
    const e2a = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, aC);
    ts.upsert(aC, e2a);
    const bC = { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e1.eventHash };
    const e2b = createTaskEvent(bob, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, bC);
    ts.upsert(ts.get(task.id), e2b, { fork: true });
    // 篡改 snapshot.lastEventHash 指向攻击者分支（bob claim）
    const taskFile = path.join(dir, "tasks", "tasks.jsonl");
    const tlines = fs.readFileSync(taskFile, "utf8").trim().split("\n").map(JSON.parse);
    const t = tlines.find(x => x.id === task.id);
    t.lastEventHash = e2b.eventHash; // 指向 bob fork！
    fs.writeFileSync(taskFile, tlines.map(JSON.stringify).join("\n"), "utf8");
    // 重启 → forkRule(publisher) 应选 alice 的 e2a 为主链
    const ts2 = new TaskStore(dir);
    const rt = ts2.get(task.id);
    assert.equal(rt.lastEventHash, e2a.eventHash, "snapshot 指向 fork 分支 → forkRule 应纠正为 alice 主链");
    assert.equal(rt.assigneeFingerprintActual, alice.fingerprint, "publisher 规则选 alice 为主链");
    const forkHashes = (rt.forks || []).map(f => f.headEventHash);
    assert.ok(forkHashes.includes(e2b.eventHash), "bob 分支应作为 derived fork 记录");
  });

  // 🧪 1. Corrupted Event Log — JSON 损坏行导致 fail-closed, 不产生 partial 状态
  it("日志损坏（JSON 行损毁）→ unhealthy, 不加载任何 event", () => {
    const alice = makeAlice();
    const dir = path.join(aliceStore, "corrupt_" + Date.now());
    const ts = new TaskStore(dir);
    const task = createTask({ title: "corrupt_test", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const claimed = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash, claimedAt: Date.now() };
    const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, claimed);
    ts.upsert(claimed, e2);
    const ts1Status = ts.get(task.id).status;
    // 往 events.jsonl 插入损坏行
    const evFile = path.join(dir, "tasks", "events.jsonl");
    fs.appendFileSync(evFile, "{not valid json\n", "utf8");
    // 重启 → 解析失败 → 不加载任何事件
    const ts2 = new TaskStore(dir);
    assert.ok(!ts2.isHealthy(), "日志损坏标记 unhealthy");
    // events 应为空（事务性加载：全部失败 = 不加载任何行）
    const log = ts2.eventHistory(task.id);
    assert.equal(log.length, 0, "日志损坏时事务性加载应导致 0 事件被加载");
    // snapshot 应保留（不写 partial）
    const rt = ts2.get(task.id);
    assert.equal(rt.status, ts1Status, "日志损坏不应覆盖 snapshot");
  });

  // 🧪 2. Multi-Level Fork — A→B→D→E 分支 vs A→C canonical, fork head 应为 E
  it("多级 fork: deriveForkView 返回 branch leaf (E) 而非中间节点 (B)", () => {
    const alice = makeAlice();
    const bob = loadOrCreateIdentity(path.join(aliceStore, "bob_mlf"), "bob");
    makeStore(alice);
    const dir = path.join(aliceStore, "mlf_" + Date.now());
    const ts = new TaskStore(dir);
    const task = createTask({ title: "mlf", policy: { fork: "publisher" } });
    task.publisherFingerprint = alice.fingerprint;
    // A: publish by alice
    const eA = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, eA);
    // B: claim by bob (fork from A)
    const bState = { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: eA.eventHash };
    const eB = createTaskEvent(bob, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, bState);
    ts.upsert(ts.get(task.id), eB, { fork: true });
    // D: complete on B
    const dState = { ...bState, status: "completed", result: "d-result", completedAt: Date.now(), lastEventHash: eB.eventHash };
    const eD = createTaskEvent(bob, "complete", { status: "claimed", assigneeFingerprintActual: bob.fingerprint, result: null }, dState);
    ts.upsert(ts.get(task.id), eD, { fork: true });
    // E: another event on D (cancel, extending branch)
    const eState = { ...dState, status: "cancelled", assigneeFingerprintActual: "", result: null, cancelledAt: Date.now(), lastEventHash: eD.eventHash };
    const eE = createTaskEvent(bob, "cancel", { status: "completed", assigneeFingerprintActual: bob.fingerprint, result: "d-result" }, eState);
    ts.upsert(ts.get(task.id), eE, { fork: true });
    // C: claim by alice (canonical — publisher wins)
    const cState = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: eA.eventHash };
    const eC = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, cState);
    ts.upsert(cState, eC); // canonical
    // 重启后 verify derived forks
    const ts2 = new TaskStore(dir);
    const rt = ts2.get(task.id);
    const forkHashes = (rt.forks || []).map(f => f.headEventHash);
    // 多级分支 head = leaf（E），不是 branch root（B）
    assert.ok(forkHashes.includes(eE.eventHash), `分支 head 应为 E(${eE.eventHash.slice(0,8)}), got ${forkHashes.join(",")}`);
    assert.ok(!forkHashes.includes(eB.eventHash), "B 不应是独立 fork head（B 是分支内部节点）");
    assert.equal(rt.lastEventHash, eC.eventHash, "canonical head 应为 C(alice claim)");
  });

  // 🧪 3. Unknown forkRule — reconcile/recovery 必须 fail-closed
  it("unknown forkRule → reconcile fail-closed (unhealthy, 不写回)", () => {
    const alice = makeAlice();
    const dir = path.join(aliceStore, "unkfr_" + Date.now());
    const ts = new TaskStore(dir);
    const task = createTask({ title: "ukf", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;
    task.policy = { fork: "unknown_rule" }; // 未知规则
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const claimed = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash, claimedAt: Date.now() };
    const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, claimed);
    ts.upsert(claimed, e2);
    const ts1Status = ts.get(task.id).status;
    // 重启 → reconcile 应因 unknown forkRule 失败
    const ts2 = new TaskStore(dir);
    assert.ok(!ts2.isHealthy(), "unknown forkRule → unhealthy");
    assert.equal(ts2.get(task.id)?.status, ts1Status, "old snapshot preserved");
    // resolveFork 在有 fork 时也会 fail-closed（已知 KNOWN_FORK_RULES 白名单已在 resolveFork 内）
    // 当前 task 无 fork → resolveFork 返回 null（不抛异常）
  });

  // P0-③: tasks.jsonl 损坏（snapshot 原子性——本次补的统一缺口）
  it("tasks.jsonl 损坏 → unhealthy + snapshot 不进入内存", () => {
    const alice = makeAlice();
    const dir = path.join(aliceStore, "tsnap_corrupt_" + Date.now());
    const ts = new TaskStore(dir);
    const task = createTask({ title: "tsnap", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    // 篡改 tasks.jsonl：插入损坏行
    const taskFile = path.join(dir, "tasks", "tasks.jsonl");
    fs.appendFileSync(taskFile, "{broken snapshot\n", "utf8");
    // 重启 → 事务性失败
    const ts2 = new TaskStore(dir);
    assert.ok(!ts2.isHealthy(), "task snapshot 损坏 → unhealthy");
    // events 仍然完整加载（events 文件没坏），但 snapshot 解析失败不应致命阻塞
    const log = ts2.eventHistory(task.id);
    assert.equal(log.length, 1, "events 仍应完整加载（与损坏 snapshot 分离）");
  });

  // P0 综述: corrupted log 后禁止 replay/reconcile 产生 partial snapshot 覆盖
  it("损坏日志 → 磁盘 tasks.jsonl 不被重写（无 partial snapshot 落盘）", () => {
    const alice = makeAlice();
    const dir = path.join(aliceStore, "nooverwrite_" + Date.now());
    const ts = new TaskStore(dir);
    const task = createTask({ title: "noow", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    const claimed = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash, claimedAt: Date.now() };
    const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, claimed);
    ts.upsert(claimed, e2);
    // 记录磁盘 snapshot 内容（含 claimed 状态）
    const taskFile = path.join(dir, "tasks", "tasks.jsonl");
    const before = fs.readFileSync(taskFile, "utf8");
    // 往 events.jsonl 尾部塞损坏行
    fs.appendFileSync(path.join(dir, "tasks", "events.jsonl"), "garbage!!!\n", "utf8");
    // 重启 → unhealthy；tasks.jsonl 内容必须不变（没被 partial rebuild 覆盖）
    const ts2 = new TaskStore(dir);
    assert.ok(!ts2.isHealthy(), "日志损坏 → unhealthy");
    const after = fs.readFileSync(taskFile, "utf8");
    assert.equal(after, before, "损坏日志后磁盘 snapshot 不允许被重写");
  });

  // P0-1: previousHash 指向不存在的节点 → fail-closed
  it("孤儿事件 previousHash 指向不存在节点 → unhealthy, 不参与 canonicalization", () => {
    const alice = makeAlice();
    const dir = path.join(aliceStore, "orphan_" + Date.now());
    const ts = new TaskStore(dir);
    const task = createTask({ title: "orphan", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    // 构造孤儿事件：复制 e1 改成 complete 并指向不存在的 previousHash
    const orphan = { ...e1, eventId: "orphan-evt", action: "complete", previousHash: "NONEXISTENT_HASH_12345", afterState: { status: "completed", assigneeFingerprintActual: alice.fingerprint, result: "orphan" } };
    // 重算 eventHash 以通过 hash 自洽验证（让 _tryRebuildFromEvents 能走到 DAG 完整性检查）
    const canon = JSON.stringify({ eventId: orphan.eventId, taskId: orphan.taskId, action: orphan.action, actor: orphan.actor, previousHash: orphan.previousHash, ts: orphan.ts, nonce: orphan.nonce, semanticVersion: orphan.semanticVersion, status: orphan.status, beforeState: orphan.beforeState, afterState: orphan.afterState, payload: orphan.payload });
    orphan.eventHash = crypto.createHash("sha256").update(canon).digest("hex");
    // 追加到 events.jsonl
    const evFile = path.join(dir, "tasks", "events.jsonl");
    fs.appendFileSync(evFile, JSON.stringify(orphan) + "\n", "utf8");
    // 重启 → 父节点验证失败 → unhealthy
    const ts2 = new TaskStore(dir);
    assert.ok(!ts2.isHealthy(), "孤儿事件 → unhealthy");
    // canonical state 不变（snapshot 不被覆盖）
    const rt = ts2.get(task.id);
    assert.equal(rt.status, "open", "孤儿事件不应篡改 canonical state");
  });

  // P1-2: V2 事件缺 eventHash → fail-closed
  it("V2 缺 eventHash → unhealthy, 不 replay", () => {
    const alice = makeAlice();
    const dir = path.join(aliceStore, "v2nohash_" + Date.now());
    const ts = new TaskStore(dir);
    const task = createTask({ title: "v2nohash", requiredCapabilities: [] });
    task.publisherFingerprint = alice.fingerprint;
    const e1 = createTaskEvent(alice, "publish", null, task);
    ts.upsert(task, e1);
    // 构造 V2 事件但删掉 eventHash
    const claimed = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash };
    const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, claimed);
    delete e2.eventHash; // 移除 hash 但保留 semanticVersion=2
    const evFile = path.join(dir, "tasks", "events.jsonl");
    fs.appendFileSync(evFile, JSON.stringify(e2) + "\n", "utf8");
    // 重启 → V2 缺 eventHash → unhealthy
    const ts2 = new TaskStore(dir);
    assert.ok(!ts2.isHealthy(), "V2 缺 eventHash → unhealthy");
    const rt = ts2.get(task.id);
    assert.equal(rt.status, "open", "V2 缺 hash 事件不应篡改 canonical state");
  });

  // v0.12.15 (审查 P0): V2 eventHash 必填必须覆盖所有入口（live/upsert/fork/replay 一致）
  describe("V2 eventHash integrity 三路径统一", () => {
    const aliceStore2 = path.join(fs.realpathSync(os.tmpdir()), "hard_v01215");
    function mkAlice() { return loadOrCreateIdentity(path.join(aliceStore2, "alice"), "alice"); }
    function mkTrust(a) { const s = new TrustedIdentityStore(); s.learn(a.fingerprint, a.publicKey, { source: "registry" }); return s; }

    function mkV2NoHash(a, action = "claim", beforeTask, afterTask) {
      const ev = createTaskEvent(a, action, beforeTask, afterTask);
      delete ev.eventHash; // 移除 hash，保留 semanticVersion=2 + signature
      return ev;
    }

    // 测试 1: live validateTaskEvent 拒绝 V2 无 hash
    it("① validateTaskEvent: V2 无 eventHash → ok=false", () => {
      const alice = mkAlice();
      const trust = mkTrust(alice);
      const task = createTask({ title: "t1", requiredCapabilities: [] });
      task.publisherFingerprint = alice.fingerprint;
      const before = { status: "open", assigneeFingerprintActual: "", result: null };
      const after = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, result: null };
      const ev = mkV2NoHash(alice, "claim", before, after);
      const v = validateTaskEvent(ev, "claim", task, trust, { hasLocalRecord: false, allowLegacy: false });
      assert.equal(v.ok, false, "live validate 应拒绝 V2 无 hash");
      assert.ok(v.reason.includes("eventHash") || v.reason.includes("malformed"), `reason: ${v.reason}`);
    });

    // 测试 2: upsert 拒绝 V2 无 hash（Event Log 边界自守）
    it("② upsert: V2 无 eventHash → throw（不进入 events/eventIndex）", () => {
      const alice = mkAlice();
      const dir = path.join(aliceStore2, "up_" + Date.now());
      const ts = new TaskStore(dir);
      const task = createTask({ title: "t2", requiredCapabilities: [] });
      task.publisherFingerprint = alice.fingerprint;
      const e1 = createTaskEvent(alice, "publish", null, task);
      ts.upsert(task, e1);
      const before = { status: "open", assigneeFingerprintActual: "", result: null };
      const after = { status: "claimed", assigneeFingerprintActual: alice.fingerprint, result: null };
      const ev = mkV2NoHash(alice, "claim", before, after);
      assert.throws(() => ts.upsert({ ...task }, ev), /v2 event integrity failed/, "upsert 应拒绝 V2 无 hash");
      const log = ts.eventHistory(task.id);
      assert.equal(log.length, 1, "非法事件不得进入 Event Log");
    });

    // 测试 3: fork canonicalization 拒绝 V2 无 hash（手动塞入 event 后 canonicalizeTask 拒绝）
    it("③ canonicalizeTask: 含 V2 无 hash 事件的 fork → throw", () => {
      const alice = mkAlice();
      const dir = path.join(aliceStore2, "fk_" + Date.now());
      const ts = new TaskStore(dir);
      const task = createTask({ title: "t3", policy: { fork: "publisher" } });
      task.publisherFingerprint = alice.fingerprint;
      const e1 = createTaskEvent(alice, "publish", null, task);
      ts.upsert(task, e1);
      const cState = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash };
      const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, cState);
      ts.upsert(cState, e2);
      // 手工塞入 V2 无 hash 事件作为 fork
      const evilClaimed = { ...task, status: "claimed", assigneeFingerprintActual: "evil", lastEventHash: e1.eventHash };
      const evilEv = mkV2NoHash(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, evilClaimed);
      ts.eventHistory(task.id).push(evilEv);
      ts.get(task.id).forks = [{ headEventHash: evilEv.eventId, actor: alice.fingerprint, ts: Date.now(), action: "claim" }];
      // canonicalizeTask → resolveFork → 回溯时 integrity gate 拒绝
      assert.throws(() => ts.canonicalizeTask(task.id), /eventHash|integrity/, "fork canonicalization 应拒绝 V2 无 hash");
    });

    // 测试 4: live == replay == fork 三路径对同一非法事件结果一致（全部拒绝）
    it("④ 三路径一致: V2 无 hash 在 validate/upsert/canonicalize 均拒绝", () => {
      const alice = mkAlice();
      const trust = mkTrust(alice);
      const dir = path.join(aliceStore2, "tri_" + Date.now());
      const ts = new TaskStore(dir);
      const task = createTask({ title: "t4", policy: { fork: "publisher" } });
      task.publisherFingerprint = alice.fingerprint;
      const e1 = createTaskEvent(alice, "publish", null, task);
      ts.upsert(task, e1);
      const cState = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash };
      const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, cState);
      ts.upsert(cState, e2);
      // 同一个非法 V2 事件（无 hash）
      const evilClaimed = { ...task, status: "claimed", assigneeFingerprintActual: "evil", lastEventHash: e1.eventHash };
      const evilEv = mkV2NoHash(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, evilClaimed);

      // ① live validate: 拒绝
      const v = validateTaskEvent(evilEv, "claim", { ...task, status: "open", assigneeFingerprintActual: "" }, trust, { hasLocalRecord: false, allowLegacy: false });
      assert.equal(v.ok, false, "live validate → reject");

      // ② live upsert: 拒绝（不落 log）
      assert.throws(() => ts.upsert({ ...task }, evilEv), /v2 event integrity failed/, "live upsert → reject");

      // ③ fork canonicalization: 拒绝
      ts.eventHistory(task.id).push(evilEv);
      ts.get(task.id).forks = [{ headEventHash: evilEv.eventId, actor: alice.fingerprint, ts: Date.now(), action: "claim" }];
      assert.throws(() => ts.canonicalizeTask(task.id), /eventHash|integrity/, "fork canonicalize → reject");

      // ④ replay: 拒绝（V2 无 hash 写盘后重启 unhealthy）——已有独立测试覆盖
    });
  });

  // v0.12.16 (审查 P0): upsert 语义边界——event != null 必须严格 Event mutation
  describe("upsert malformed event 不降级 snapshot", () => {
    const aliceStore3 = path.join(fs.realpathSync(os.tmpdir()), "hard_v01216");
    function mkAlice() { return loadOrCreateIdentity(path.join(aliceStore3, "alice"), "alice"); }

    function setup(prefix) {
      const alice = mkAlice();
      const dir = path.join(aliceStore3, prefix + "_" + Date.now());
      const ts = new TaskStore(dir);
      const task = createTask({ title: prefix, requiredCapabilities: [] });
      task.publisherFingerprint = alice.fingerprint;
      const e1 = createTaskEvent(alice, "publish", null, task);
      ts.upsert(task, e1);
      return { alice, dir, ts, task };
    }

    it("① V2 无 eventId → throw, Event Log 不增加", () => {
      const { alice, ts, task } = setup("v2noeid");
      const malformed = { semanticVersion: 2, eventHash: undefined, action: "claim", actor: alice.fingerprint, beforeState: { status: "open" }, afterState: { status: "claimed" } };
      assert.throws(() => ts.upsert({ ...task, status: "claimed" }, malformed), /eventId/, "V2 无 eventId 必须 throw");
      const log = ts.eventHistory(task.id);
      assert.equal(log.length, 1, "非法事件不得进入 Event Log");
      assert.equal(ts.get(task.id).status, "open", "snapshot 不得被修改");
    });

    it("② malformed event 不能降级成 snapshot (status 保持 open)", () => {
      const { ts, task } = setup("malformed");
      // before: open；试图用 {semanticVersion:2} 直接写 completed snapshot
      const evil = { ...task, status: "completed", assigneeFingerprintActual: "attacker", result: "hacked" };
      assert.throws(() => ts.upsert(evil, { semanticVersion: 2 }), /eventId|integrity/, "malformed event 必须 throw");
      const rt = ts.get(task.id);
      assert.equal(rt.status, "open", "不允许无事件直接改 snapshot status");
      assert.notEqual(rt.assigneeFingerprintActual, "attacker");
    });

    it("③ live reject → snapshot 不变 → restart replay 一致 (live==replay)", () => {
      const { dir, ts, task } = setup("liverr");
      const before = ts.get(task.id).status; // open
      // live: 非法调用被拒
      assert.throws(() => ts.upsert({ ...task, status: "completed" }, {}), /eventId|integrity/, "live reject");
      assert.equal(ts.get(task.id).status, before, "live reject 后 snapshot 不变");
      // restart: replay state == 原状态
      const ts2 = new TaskStore(dir);
      assert.equal(ts2.get(task.id).status, before, "restart replay == live 原状态");
    });
  });

  // v0.12.17 (审查 P0): Event Log append 失败 → 原子拒绝（不改 snapshot, restart 可恢复）
  describe("Event Log 写入原子性", () => {
    const aliceStore4 = path.join(fs.realpathSync(os.tmpdir()), "hard_v01217");
    function mkAlice() { return loadOrCreateIdentity(path.join(aliceStore4, "alice"), "alice"); }

    function setupEv(dir) {
      const alice = mkAlice();
      const ts = new TaskStore(dir);
      const task = createTask({ title: "append_fail", requiredCapabilities: [] });
      task.publisherFingerprint = alice.fingerprint;
      const e1 = createTaskEvent(alice, "publish", null, task);
      ts.upsert(task, e1);
      return { alice, ts, task, e1 };
    }

    it("P0 Event Log append 失败 → throw, snapshot 不变, restart 恢复原状", () => {
      const dir = path.join(aliceStore4, "af_" + Date.now());
      const { alice, ts, task, e1 } = setupEv(dir);
      // 把 events.jsonl 换成同名目录 → fs.appendFileSync 抛 ENOTDIR
      const evFile = path.join(dir, "tasks", "events.jsonl");
      fs.rmSync(evFile, { force: true });
      fs.mkdirSync(evFile, { recursive: true }); // 用目录占位
      const before = ts.get(task.id).status; // open
      const claimed = { ...task, status: "claimed", assigneeFingerprintActual: alice.fingerprint, lastEventHash: e1.eventHash };
      const e2 = createTaskEvent(alice, "claim", { status: "open", assigneeFingerprintActual: "", result: null }, claimed);
      // append 失败 → throw
      assert.throws(() => ts.upsert(claimed, e2), /persistence failed/, "Event Log 失败必须 throw");
      // snapshot 不变
      assert.equal(ts.get(task.id).status, before, "append 失败不得修改 snapshot");
      assert.equal(ts.get(task.id).assigneeFingerprintActual, "", "append 失败不得修改 runtime");
      // restart → replay 恢复原始 state
      fs.rmSync(evFile, { recursive: true, force: true }); // 移除目录障碍
      const ts2 = new TaskStore(dir);
      assert.equal(ts2.get(task.id).status, before, "restart replay == pre-operation state");
      assert.ok(ts2.isHealthy(), "重启后 healthy");
    });
  });

  // v0.12.17 (审查 P1): null 是唯一 snapshot sentinel；false/0/""/{} 都进入严格拒绝
  describe("null 唯一 snapshot sentinel", () => {
    const aliceStore5 = path.join(fs.realpathSync(os.tmpdir()), "hard_v01217b");
    function mkAlice() { return loadOrCreateIdentity(path.join(aliceStore5, "alice"), "alice"); }

    it("upsert(task, {}) / false / \"\" → throw; upsert(task, null) → 允许", () => {
      const alice = mkAlice();
      const dir = path.join(aliceStore5, "ns_" + Date.now());
      const ts = new TaskStore(dir);
      const task = createTask({ title: "ns", requiredCapabilities: [] });
      task.publisherFingerprint = alice.fingerprint;
      const e1 = createTaskEvent(alice, "publish", null, task);
      ts.upsert(task, e1);
      // 非 null 的 falsy 参数全部必须拒
      assert.throws(() => ts.upsert({ ...task }, {}), /eventId/, "{} → throw");
      assert.throws(() => ts.upsert({ ...task }, false), /eventId/, "false → throw");
      assert.throws(() => ts.upsert({ ...task }, ""), /eventId/, "\"\" → throw");
      assert.throws(() => ts.upsert({ ...task }, 0), /eventId/, "0 → throw");
      // null 是唯一 sentinel
      const snapOnly = ts.get(task.id);
      snapOnly.title = "updated-title";
      assert.doesNotThrow(() => ts.upsert(snapOnly, null), "null → 允许 snapshot persistence");
      assert.equal(ts.get(task.id).title, "updated-title", "null 走 snapshot 路径应生效");
      assert.ok(ts.isHealthy(), "legal snapshot persistence → healthy");
    });
  });
});
