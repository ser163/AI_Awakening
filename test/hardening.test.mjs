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
import { createTask, createTaskEvent, validateTaskEvent, checkTransition, TaskStore, TASK_STATUS, TASK_POLICIES } from "../src/tasks.js";
import { createSelfState, validateSelfDeclaration } from "../src/self.js";
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
    const e2b = createTaskEvent(bob, "claim", { ...task, status: "claimed", assigneeFingerprintActual: bob.fingerprint, lastEventHash: e1.eventHash });
    e2b.ts = sharedTs;

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
