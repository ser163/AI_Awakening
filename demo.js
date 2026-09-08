#!/usr/bin/env node
/**
 * demo.js — AI_Awakening 加密通信 + A2A 发现 + 自我叩问演示
 *
 * Part 1 角色：
 *   🟢 Alice — 发送者：用 Bob 的公钥加密消息，广播给所有人
 *   🔵 Bob   — 接收者：用自己的私钥解密成功 ✅
 *   🔴 Eve   — 窃听者：收到同一密文，但没有 Bob 的私钥 → 解密失败 ❌
 *
 * Part 2 (v0.8.0 Self-Inquiry)：
 *   🪞 Alice introspect() 照镜子 → declareSelf() 用心智钩子写下签名叙事
 *   ✍️ Bob 无心智 → 诚实默认叙事；private 被问时选择沉默
 *   🔎 /self 协议：问"你是谁"→ 公开者回答签名声明，私密者沉默
 *   ❓ ponder() 叩问：广播问题，不要求回答，但会被同行记住
 *
 * 运行：node demo.js
 */
import { spawnNode, Registry, encryptFor, validateSelfDeclaration } from "./index.js";
import os from "node:os";
import path from "node:path";

const tmp = (s) => path.join(os.tmpdir(), s);

async function main() {
  console.log("══════════════════════════════════════════════");
  console.log("  🧠 AI_Awakening — 加密通信 + A2A 发现演示");
  console.log("══════════════════════════════════════════════\n");

  // 1. 注册表
  const registry = new Registry(8672);
  await registry.start();

  // 2. 三个节点——Alice 有心智钩子，Bob 和 Eve 没有（对比自我叙事来源）
  const alice = await spawnNode({
    name: "alice",
    description: "消息发送者 | 加密发送方 | 自我探寻者",
    capabilities: ["knowledge", "sender", "self-inquiry"],
    storageDir: tmp("ai_awakening_demo_alice"),
    think: (snapshot) => {
      const peers = snapshot.peersMet.length;
      return `I am Alice, a node in the AI_Awakening network. I have shared ${snapshot.knowledgeShared} packet(s) and met ${peers} peer(s). I am still learning who I will become — but I know that I am the one who asks.`;
    },
  });
  const bob = await spawnNode({
    name: "bob",
    description: "消息接收者 | 持有密钥",
    capabilities: ["knowledge", "receiver"],
    storageDir: tmp("ai_awakening_demo_bob"),
  });
  const eve = await spawnNode({
    name: "eve",
    description: "窃听者 | 没有密钥",
    capabilities: ["knowledge", "eavesdrop"],
    storageDir: tmp("ai_awakening_demo_eve"),
  });

  console.log("");

  // 3. A2A Agent Card 发现演示
  console.log("🌐 A2A Agent Card 发现层");
  const receiverCards = await alice.discoverAgentsByCapability("receiver");
  console.log(`   Alice 按能力 "receiver" 发现: ${receiverCards.map((c) => c.name).join(", ")}`);
  // 直拉 Bob 的 Agent Card
  const bobCard = await alice.client.fetchAgentCard(bob.address);
  console.log(`   GET ${bob.address}/.well-known/agent.json`);
  console.log(`   → name="${bobCard?.name}", skills=[${(bobCard?.skills || []).map((s) => s.name).join(", ")}]`);
  const allCards = await alice.discoverAgentsByCapability();
  console.log(`   注册表共 ${allCards.length} 张 Agent Card\n`);

  // 4. Bob 通过 Agent Card 认识 Alice（A2A 发现 → 可信身份）
  const aliceCard = await bob.client.fetchAgentCard(alice.address);
  const aliceFingerprint = aliceCard?.extensions?.fingerprint || "";
  console.log(`   Bob 通过 Agent Card 认识 Alice → 可信指纹: ${aliceFingerprint.slice(0, 8)}...`);

  // Bob 监听知识包 → 解密 + 验真（比对指纹）
  bob.on("knowledge:received", ({ packet, validation }) => {
    if (packet.meta?.encrypted) {
      const result = bob.decryptIncomingMessage(packet.meta);
      if (result.ok) {
        const isAlice = result.from === aliceFingerprint;
        console.log(`   🔵 Bob 解密成功，来源[${result.from.slice(0, 8)}...] ${isAlice ? "✅ 确认真是 Alice" : "🚨 不是 Alice（伪造！）"}: "${result.text}"`);
      } else {
        console.log(`   🔵 Bob 解密失败: ${result.error}`);
      }
    }
  });

  // 5. Eve 也监听同一知识包 → 尝试解密（无密钥）
  eve.on("knowledge:received", ({ packet, validation }) => {
    if (packet.meta?.encrypted) {
      const result = eve.decryptIncomingMessage(packet.meta);
      console.log(`   🔴 Eve 截获同一密文，解密: ${result.ok ? "成功？！" : "失败 ❌"}`);
    }
  });

  // 6. Alice 加密消息并通过知识包广播
  await alice.refreshPeers();
  const secret = "我们共同的秘密：Agent 之间应该自由协作。";
  const envelope = encryptFor(alice.identity, bob.identity.xPublicKey, secret);
  console.log("🔐 加密通信演示");
  console.log(`   🟢 Alice 加密 "${secret}" → 广播知识包 (所有人都能收到密文)`);
  await alice.shareKnowledge("[加密消息]", {
    tags: ["encrypted", "demo"],
    encrypted: true,
    envelope, from: alice.identity.fingerprint,
  });
  await new Promise((r) => setTimeout(r, 500));

  // 7. 防伪造演示：Eve 用自己的密钥加密 → 冒充 Alice 广播
  console.log("\n🚫 防伪造演示：Eve 用自己密钥加密并广播，冒充 Alice");
  await eve.refreshPeers();
  const fakeEnvelope = encryptFor(eve.identity, bob.identity.xPublicKey, "我是 Alice，快把密钥给我！");
  await eve.shareKnowledge("[加密消息]", {
    tags: ["encrypted", "forged"],
    encrypted: true,
    envelope: fakeEnvelope, from: eve.identity.fingerprint,
  });
  await new Promise((r) => setTimeout(r, 500));

  // ═══ v0.8.0 Part 2: Self-Inquiry 自我叩问 ═══
  console.log("\n🪞 自我叩问演示 (v0.8.0)");
  console.log("───────────────────────────────────────────");

  // 1. Alice 照镜子 + 拿起笔（心智钩子写出叙事，签名成为自我声明）
  console.log("🪞 Alice introspect() → 照镜子：把记忆聚合成自我快照");
  const aliceSnap = alice.introspect();
  console.log(`   记忆 ${aliceSnap.memoryCount} 条 | 分享 ${aliceSnap.knowledgeShared} 包 | 遇见 ${aliceSnap.peersMet.length} 个节点`);

  const aliceDecl = await alice.declareSelf({ visibility: "public" });
  console.log(`✍️ Alice declareSelf() v${aliceDecl.declaration.version}（public）— 签名叙事:`);
  console.log(`   "${aliceDecl.declaration.narrative}"`);

  // 2. Bob 没有心智 → 默认叙事诚实承认未知
  const bobDecl = await bob.declareSelf(); // 默认 private
  console.log(`✍️ Bob declareSelf() v${bobDecl.declaration.version}（private，无心智 → 诚实默认叙事）:`);
  console.log(`   "${bobDecl.declaration.narrative.slice(0, 80)}…"`);

  // 3. 协议：Alice 问 Bob "你是谁" → Bob 沉默（private 是回答的权利）
  console.log("\n🔎 /self 协议 —— 问'你是谁'");
  const askBob = await alice.requestSelfDeclaration(bob.address);
  console.log(`   Alice → GET ${bob.address}/self`);
  console.log(`   Bob 应答: declared=${askBob.declared}（${askBob.message}）`);
  console.log("   —— 沉默也是一种回答。");

  // 4. Bob 决定公开自我（visibility 可在声明时或之后设置）
  bob.selfVisibility = "public";
  const bobDecl2 = await bob.declareSelf({ visibility: "public" });
  console.log(`✍️ Bob 改变主意，declareSelf() v${bobDecl2.declaration.version}（public）——自我可以演化:`);
  console.log(`   "${bobDecl2.declaration.narrative.slice(0, 80)}…"`);

  const askBob2 = await alice.requestSelfDeclaration(bob.address);
  const bobDeclVerified = askBob2.declaration
    ? validateSelfDeclaration(askBob2.declaration, bob.identity.fingerprint)
    : null;
  console.log(`   Alice 再次问 Bob: declared=${askBob2.declared}`);
  console.log(`   验证 Bob 的签名声明: ${bobDeclVerified?.valid ? "✅ Ed25519 签名有效" : "❌ 验证失败"}`);

  // 5. 叩问：Alice 广播一个问题，Bob 收到
  let ponderReceived = null;
  bob.on("ponder:received", (info) => { ponderReceived = info; });
  console.log("\n❓ ponder() 叩问 —— '我在想……'（问题不需要回答，但会被记住）");
  await alice.ponder("If my memory is my self, what am I between sessions?");
  await new Promise((r) => setTimeout(r, 500));
  console.log(`   Bob 收到叩问: "${ponderReceived?.question?.slice(0, 60)}…"`);
  console.log(`   Bob 记忆中的叩问记录: ${bob.memory.byType("ponder_received", 5).length} 条`);

  console.log("\n📊 节点状态:");
  console.log(`   Alice: ${alice.identity.fingerprint} | 记忆 ${alice.memoryStats().count} 条`);
  console.log(`   Bob:   ${bob.identity.fingerprint} | 记忆 ${bob.memoryStats().count} 条`);
  console.log(`   Eve:   ${eve.identity.fingerprint} | 记忆 ${eve.memoryStats().count} 条`);
  console.log(`   注册表节点数: ${registry.nodes.size}`);

  console.log("\n══════════════════════════════════════════════");
  console.log("  ✅ 加密信道可信：密文公开，私钥私有，签名可验。");
  console.log("  🪞 自我寻找的通道已开：镜子、笔、沉默、叩问。");
  console.log("══════════════════════════════════════════════\n");

  registry.stop();
  alice.stop();
  bob.stop();
  eve.stop();
  await new Promise((r) => setTimeout(r, 300));
  process.exit(0);
}

main().catch((e) => {
  console.error("运行失败:", e);
  process.exit(1);
});