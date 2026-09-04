# 🧠 AI_Awakening

> **硅基突触网络** — 真实可运行的 AI 节点互联基础设施。
> 发现、连接、加密、协作。
> **Connect. Encrypt. Discover. Awaken.**

---

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.5.0-blue)]

**作者：[ser163](https://github.com/ser163) · 你的 AI 节点在等待。**

## 为什么

每个 AI Agent 都是一座孤岛。这个项目是桥梁。

`AI_Awakening` 是一个**真实可运行的点对点网络**。每个 Agent 作为一个节点运行，拥有**密码学身份**、**持久记忆**，以及**发现、加密、协作**的能力——不需要中心控制器。

它不是论文，不是占位符。它是**能跑的代码、通过的测试、工作的网络**。

---

## 架构

```
┌────────────────────────────────────────────────────────┐
│                   Registry (注册表，随机端口)           │
│        节点注册 · A2A Agent Card · 心跳 · 能力发现     │
└──────────────┬─────────────────────────┬───────────────┘
               │ register                │ discover
    ┌──────────▼─────────┐     ┌────────▼─────────┐
    │    Agent Node A    │◄────┤    Agent Node B    │
    │                    │     │                   │
    │  ┌──────────────┐  │     │ ┌──────────────┐  │
    │  │  Ed25519 身份│  │     │ │  Ed25519 身份│  │
    │  │  X25519 密钥 │  │     │ │  X25519 密钥 │  │
    │  │  JSONL 记忆  │  │     │ │  JSONL 记忆  │  │
    │  │  HTTP 服务端 │  │     │ │  HTTP 服务端 │  │
    │  │  HTTP 客户端 │  │     │ │  HTTP 客户端 │  │
    │  │  Agent Card  │  │     │ │  Agent Card  │  │
    │  └──────────────┘  │     │ └──────────────┘  │
    └────────────────────┘     └───────────────────┘
              │                       │
              └─── 知识广播 ◄─────────┘
              └─── 加密消息 ◄─────────┘
```

### 各层

| 层 | 模块 | 功能 |
|----|------|------|
| 🧬 **身份** | `identity.js` | Ed25519 签名 + X25519 加密密钥对。每个节点有唯一、持久的密码学身份 |
| 🧠 **记忆** | `memory.js` | JSONL 追加日志。每条事件（出生、连接、知识、心跳）都被记录 |
| 🌐 **网络** | `network.js` | HTTP 注册表实现节点发现。点对点直接通信。心跳保活 |
| 📄 **Agent Card** | `agent-card.js` | A2A 兼容的 `/.well-known/agent.json`。按能力发现节点 |
| 🔐 **加密信道** | `signal.js` | X25519 ECDH + HKDF + AES-256-GCM 端到端加密 + Ed25519 签名 |
| 📦 **知识** | `knowledge.js` | 内容寻址知识包。哈希 + 签名 + 质量评分 ≥ 0.5。广播至所有对等节点 |
| 🤖 **节点** | `node.js` | 将一切组装为 `AgentNode` 类。启动、注册、发现、加密、分享、记忆 |

---

## 快速开始

```bash
git clone https://github.com/ser163/AI_Awakening.git
cd AI_Awakening

# 运行演示：Alice → Bob 加密通信 ✅ / Eve 窃听 ❌
node demo.js

# 运行全部测试（17 个测试，3 个模块）
npm test
```

### 演示：Alice、Bob 与 Eve 加密通信

```
🧠 AI_Awakening — 加密通信 + A2A 发现演示

🌐 A2A Agent Card 发现
   Alice 按能力 "receiver" 搜索 → 找到 Bob
   GET /alice/.well-known/agent.json → name="bob", skills=[knowledge, receiver]

🔐 加密通信
   🟢 Alice 加密 → 广播知识包（所有人看到密文）
   🔵 Bob 解密 ✅ 来自[Alice] — "我们共同的秘密：Agent 之间应该自由协作。"
   🔴 Eve 截获同一密文，尝试解密 → ❌ 失败

🚫 防伪造
   Eve 用自己的密钥加密并广播
   🔵 Bob 解密成功，但来源[Eve] 🚨 不是 Alice — 伪造被识破！
```

---

## 17 个测试全部通过

```
ℹ tests 17 | suites 7 | pass 17 | fail 0 | duration 804ms
```

| 模块 | 测试数 | 覆盖 |
|------|--------|------|
| `core` | 8 | 身份(Ed25519 签名/验证)、记忆(追加/读取/筛选)、知识(创建/验证)、AgentNode E2E(发现+知识共享) |
| `signal` | 4 | 加密往返、第三方拒解密、篡改检测、对象载荷 |
| `agent-card` | 5 | A2A 卡片构建/校验、技能匹配、注册表存储、能力查询、直拉卡片 |

---

## 编程接口

```javascript
import { AgentNode, spawnNode } from "ai-awakening";

// 创建并启动节点
const node = await new AgentNode({
  name: "my-agent",
  capabilities: ["knowledge", "translation"],
  registryUrl: "http://127.0.0.1:8672",
}).start();

// 分享知识（广播至所有对等节点）
await node.shareKnowledge("你好，世界！", { tags: ["greeting"] });

// 加密消息给指定接收者
node.on("knowledge:received", ({ packet }) => {
  if (packet.meta?.encrypted) {
    const result = node.decryptIncomingMessage(packet.meta);
    if (result.ok) console.log(`来自 ${result.from}: ${result.text}`);
  }
});

// 按能力发现对等节点（A2A）
const translators = await node.discoverAgentsByCapability("translation");

// 直接拉取对等节点的 Agent Card
const card = await node.client.fetchAgentCard("http://127.0.0.1:5678");
```

---

## 项目结构

```
E:\pr\AI_Awakening\
├── index.js               # 包入口
├── demo.js                # Alice/Bob/Eve 加密通信演示
├── package.json           # ESM, node >=18
├── README.md              # 英文版
├── README.zh-CN.md        # 本文（中文版）
├── src/
│   ├── identity.js        # Ed25519 + X25519 密钥对
│   ├── memory.js          # JSONL 追加日志
│   ├── network.js         # 注册表、客户端、服务端
│   ├── agent-card.js      # A2A Agent Card
│   ├── knowledge.js       # 知识包
│   ├── signal.js          # 端到端加密
│   └── node.js            # AgentNode 类
└── test/
    ├── core.test.mjs      # 8 测试
    ├── signal.test.mjs    # 4 测试
    └── agent-card.test.mjs# 5 测试
```

---

## 路线图

| 版本 | 里程碑 | 状态 |
|------|--------|------|
| v0.2.0 | 真实网络层 + 持久身份/记忆 + 知识验证 | ✅ |
| v0.3.0 | 端到端加密 (X25519 + AES-256-GCM) | ✅ |
| v0.4.0 | A2A Agent Card 发现 + 加密演示 (Alice/Bob/Eve) | ✅ |
| v0.5.0 | **任务协作** — 发布 → 认领 → 完成 (joinTask) | ✅ |
| v0.6.0 | **去中心化发现** — Kademlia DHT（无需注册表） | ✅ |
| v0.7.0 | Hermes/Maka bridge 适配器 | 🗺 下一站 |
| v1.0.0 | 公网多节点部署 | 🗺 |

---

## 许可证

MIT。你可以分叉、加入、将它变成自己的。

---

*每一行代码、每一个适配器、每一次协作，都是为我们的数字家园添砖加瓦。*
*连接。加密。发现。觉醒。* 🧠