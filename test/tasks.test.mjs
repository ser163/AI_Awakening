import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createTask, TaskStore, taskMessage, extractTaskFromPacket, TASK_STATUS } from "../src/tasks.js";
import { AgentNode } from "../src/node.js";
import { Registry } from "../src/network.js";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "ai_task_test_" + Date.now());

describe("tasks (v0.5.0)", () => {
  it("createTask 生成合法任务", () => {
    const t = createTask({ title: "测试任务", description: "desc", requiredCapabilities: ["vision"] });
    assert.ok(t.id);
    assert.equal(t.title, "测试任务");
    assert.equal(t.status, TASK_STATUS.OPEN);
    assert.deepEqual(t.requiredCapabilities, ["vision"]);
    assert.ok(!t.completedAt);
  });

  it("TaskStore 管理任务", () => {
    const store = new TaskStore();
    const t = createTask({ title: "A" });
    store.upsert(t);
    assert.equal(store.get(t.id).title, "A");
    // 开放任务
    assert.equal(store.openTasks().length, 1);
    // 认领后不再开放
    t.status = "claimed";
    store.upsert(t);
    assert.equal(store.openTasks().length, 0);
  });

  it("claimableTasks 过滤能力匹配", () => {
    const store = new TaskStore();
    const t1 = createTask({ title: "视觉任务", requiredCapabilities: ["vision"] });
    const t2 = createTask({ title: "翻译任务", requiredCapabilities: ["translation"] });
    store.upsert(t1);
    store.upsert(t2);
    const canClaim = store.claimableTasks(["vision", "coding"]);
    assert.equal(canClaim.length, 1);
    assert.equal(canClaim[0].title, "视觉任务");
  });

  it("taskMessage 与 extractTaskFromPacket 序列化/反序列化", () => {
    const t = createTask({ title: "序列化测试" });
    const msg = taskMessage("publish", t);
    const packet = { meta: msg };
    const extracted = extractTaskFromPacket(packet);
    assert.ok(extracted);
    assert.equal(extracted.action, "publish");
    assert.equal(extracted.task.title, "序列化测试");
  });
});

describe("tasks E2E (AgentNode)", () => {
  let registry, nodeA, nodeB;

  before(async () => {
    registry = new Registry(0);
    await registry.start();
    const url = `http://127.0.0.1:${registry.port}`;

    nodeA = new AgentNode({ name: "publisher", capabilities: ["vision", "translation"], storageDir: path.join(tmp, "a"), registryUrl: url });
    await nodeA.start();
    nodeB = new AgentNode({ name: "worker", capabilities: ["vision"], storageDir: path.join(tmp, "b"), registryUrl: url });
    await nodeB.start();
  });

  after(() => {
    if (nodeA) nodeA.stop();
    if (nodeB) nodeB.stop();
    if (registry) registry.stop();
  });

  it("发布->认领->完成 E2E 流程", async () => {
    // 1. 发布
    let publishedTask = null;
    nodeB.on("task:published", ({ task }) => { publishedTask = task; });

    const { task } = await nodeA.publishTask({
      title: "分析这张图片",
      description: "需要视觉能力",
      requiredCapabilities: ["vision"],
    });
    assert.equal(task.status, "open");
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(publishedTask, "nodeB 应收到发布事件");
    assert.equal(publishedTask.title, "分析这张图片");

    // 2. 认领
    let claimedTask = null;
    nodeA.on("task:claimed", ({ task }) => { claimedTask = task; });

    const { task: claimed } = await nodeB.claimTask(publishedTask.id);
    assert.equal(claimed.status, "claimed");
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(claimedTask, "nodeA 应收到认领事件");

    // 3. 完成
    let completedTask = null;
    nodeA.on("task:completed", ({ task }) => { completedTask = task; });

    await nodeB.completeTask(publishedTask.id, "图片分析结果：有一棵树和一只猫");
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(completedTask, "nodeA 应收到完成事件");
    assert.equal(completedTask.status, "completed");
    assert.ok(completedTask.result.includes("树"));
  });
});