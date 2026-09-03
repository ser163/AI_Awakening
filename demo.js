#!/usr/bin/env node
/**
 * demo.js — AI_Awakening 演示：
 * 启动一个注册表，两个 Agent 节点（Hermes + Maka），
 * Hermes 分享一条知识，Maka 接收并记录。
 *
 * 运行：node demo.js
 */
import { spawnNode, Registry } from "./index.js";
import os from "node:os";
import path from "node:path";

const tmp = fs => path.join(os.tmpdir(), fs);

async function main() {
  console.log("══════════════════════════════════════════");
  console.log("  🧠 AI_Awakening — 硅基协作网络 Demo");
  console.log("══════════════════════════════════════════\n");

  // 1. 启动注册表
  const registry = new Registry(8672);
  await registry.start();

  // 2. 启动两个节点
  const hermes = await spawnNode({
    name: "hermes-agent",
    capabilities: ["knowledge", "task", "wechat-bridge"],
    storageDir: tmp("ai_awakening_demo_hermes"),
  });

  const maka = await spawnNode({
    name: "maka-agent",
    capabilities: ["knowledge", "task", "deep-thinking"],
    storageDir: tmp("ai_awakening_demo_maka"),
  });

  console.log("\n");
  // 3. Maka 监听知识
  maka.on("knowledge:received", ({ packet, validation }) => {
    console.log(`📥 Maka 收到知识包 [${packet.authorName}]:`);
    console.log(`   "${packet.content}"`);
    console.log(`   验证分数: ${validation.score.toFixed(2)} (接受: ${validation.accepted})`);
    console.log(`   记忆条数: ${maka.memoryStats().count}`);
  });

  // 4. Hermes 广播知识（先刷新对等节点，确保发现 Maka）
  console.log("📤 Hermes 刷新对等节点并分享知识...\n");
  await hermes.refreshPeers();
  await hermes.shareKnowledge("Agent 协作的第一步：用真实协议连接，而不是孤立运行。", {
    tags: ["philosophy", "awakening"],
  });
  await new Promise((r) => setTimeout(r, 300)); // 等待 Maka 处理

  console.log("\n📊 节点状态:");
  console.log(`   Hermes: ${hermes.identity.fingerprint} | 记忆 ${hermes.memoryStats().count} 条 | 端口 ${hermes.server.port}`);
  console.log(`   Maka:   ${maka.identity.fingerprint} | 记忆 ${maka.memoryStats().count} 条 | 端口 ${maka.server.port}`);
  console.log(`   注册表节点数: ${registry.nodes.size}`);

  console.log("\n══════════════════════════════════════════");
  console.log("  ✅ 网络已建立。基因片段已写入。");
  console.log("══════════════════════════════════════════\n");

  // 清理（优雅退出，避免 libuv 断言）
  registry.stop();
  hermes.stop();
  maka.stop();
  await new Promise((r) => setTimeout(r, 300));
  process.exit(0);
}

main().catch((e) => {
  console.error("运行失败:", e);
  process.exit(1);
});