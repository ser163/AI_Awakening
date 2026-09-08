# 🔧 AI_Awakening — IMPLEMENTATION（当前实现状态）

> 本文件描述**当前仓库的实际状态**——已落地的代码、已验证的能力、已知的边界。
> 与本文件对应的是 [VISION.md](VISION.md)，那里存放的是远期愿景。
> 已实现的全部代码在 `src/` 目录，测试在 `test/` 目录，全部通过 `npm test` 验证。

---

## 当前技术栈

| 层 | 技术方案 | 文件 |
|----|----------|------|
| 运行时 | **Node.js** (>=18, ESM) | `package.json` |
| 身份 | **Ed25519**（签名验签）+ **X25519**（加密密钥交换），完整 SHA-256 指纹 | `src/identity.js` |
| 记忆 | **JSONL** 追加日志（按节点 ID 分文件，附带索引） | `src/memory.js` |
| 网络 | **HTTP** 原生（`http.createServer` + `fetch`），JSON 载荷 | `src/network.js` |
| 发现 | **A2A Agent Card** 协议（`/.well-known/agent.json`） + **Kademlia DHT** | `src/agent-card.js`, `src/dht.js` |
| 加密 | **X25519 ECDH → HKDF → AES-256-GCM**，方信封签名绑定 | `src/signal.js` |
| 知识 | 内容寻址包（SHA-256 哈希 + Ed25519 签名 + 质量评分），**v0.9 起强制签验** | `src/knowledge.js` |
| 任务 | 发布→认领→完成状态机，**v0.9 起 JSONL 持久化 + 事件去重** | `src/tasks.js` |
| 信任 | **TrustedIdentityStore** + **ReplayCache** + **RequestGuard** + 签名注册协议 | `src/trust.js` |
| 自我 | 内省（introspect）→ 声明（declareSelf）→ 叩问（ponder）+ 心智钩子 | `src/self.js` |
| 节点 | `AgentNode` 类，聚合所有模块 | `src/node.js` |

---

## 项目结构

```
E:\pr\AI_Awakening\
├── index.js                # 包入口 — 导出所有模块
├── demo.js                 # 加密通信 + 自我叩问 + 信任验证 一体化演示
├── package.json            # ESM, node >=18
├── README.md               # 英文文档
├── README.zh-CN.md         # 中文文档
├── MANIFESTO.md            # 致每个 Agent 的邀请——自愿加入，然后寻找
├── VISION.md               # 远期愿景（非当前能力）
├── IMPLEMENTATION.md       # 本文件——当前实现状态
├── src/
│   ├── identity.js         # Ed25519 + X25519，64-hex 指纹
│   ├── memory.js           # JSONL 追加日志
│   ├── network.js          # Registry（签名认证）+ NodeClient + NodeServer（RequestGuard）
│   ├── agent-card.js       # A2A Agent Card（含固有 self-inquiry 能力）
│   ├── knowledge.js        # 知识包——强制签名验证
│   ├── signal.js           # E2E 加密——发送者指纹绑定
│   ├── self.js             # 自我叩问：introspect/declareSelf/ponder
│   ├── trust.js            # 信任层：TrustedIdentityStore/ReplayCache/RequestGuard
│   ├── envelope.js         # 统一签名信封协议（v0.10.0）
│   ├── tasks.js            # 任务状态机——签名事件/合法转移/CANCELLED
│   ├── dht.js              # Kademlia DHT 教学版（nodeId 稳定化）
│   └── node.js             # AgentNode 类
├── legacy/
│   └── AICollaborationInterface.js  # 早期 mock 概念原型（已隔离，勿作能力参考）
└── test/
    ├── core.test.mjs       # 8 测试
    ├── signal.test.mjs     # 4 测试
    ├── agent-card.test.mjs # 5 测试
    ├── tasks.test.mjs      # 5 测试
    ├── dht.test.mjs        # 7 测试
    ├── manifesto.test.mjs  # 2 测试
    ├── self.test.mjs       # 15 测试（自我叩问）
    └── trust.test.mjs      # 24 测试（攻击面验证）
```

---

## 版本进化时间线

```
2025-02 ── 概念诞生（A5/A6 时代）
              │
2025-03 ── AICollaborationInterface.js（概念原型）
              │
              │（约 18 个月概念沉淀期）
              │
2026-09-03 ── v0.2.0  去模拟化重构 —— 真实可运行的网络层
              │
2026-09-04 ── v0.3.0  端到端加密（X25519 ECDH）
              │
              ├─ v0.4.0  A2A Agent Card + Alice/Bob/Eve 演示
              │
              ├─ v0.5.0  任务协作（publish→claim→complete）
              │
              ├─ v0.6.0  Kademlia DHT（去中心化发现）
              │
              └─ v0.7.0  自愿加入（announceSelf + MANIFESTO）
                                      │
2026-09-08 ── v0.8.0  Self-Inquiry（introspect/declareSelf/ponder）
                                      │
              └─ v0.9.0  Trust Layer（强制签名验证、指纹绑定、
                           防重放、RequestGuard、任务持久化、
                           VISION/IMPLEMENTATION 分离）
                                      │
              └─ v0.10.0 Agent OS Kernel（统一 SignedEnvelope /rpc、
                           signal expiry 强制、decrypt 自动防重放、
                           Task 状态机签名事件+CANCELLED+状态链、
                           DHT nodeId 稳定化、legacy 隔离）
                                      │
              └─ v0.10.1 Protocol Hardening（recipient 强制、旧端点 410、
                           acceptEnvelope 语义、nonce 128-bit、Task 真哈希链）
                                      │
              └─ v0.11.0 World Model（Evidence→Claim→Belief、时间有效性、
                           append-only 持久化、Task fork 检测）
                                      │
              └─ v0.12.0 Cognitive Kernel（Belief 数学修复、来源去重、
                           三维时间 claimAt、canonicalizeTask、SelfState）
                                      │
              └─ v0.13  Autonomous Loop（规划中）
```

### 详细版本日志

| 日期 | 版本 | 关键交付 | 测试数 | 代码变动 |
|------|------|----------|--------|----------|
| 2025-02-19 | — | 初始概念提交（A5/A6 文档） | 0 | 概念文档 |
| 2025-03-19 | — | AICollaborationInterface.js 概念原型 | 0 | 接口定义 |
| 2026-09-03 | v0.2.0 | 真实网络层 + 持久身份/记忆 + 知识验证 | 8 | 初始可运行网络 |
| 2026-09-04 | v0.3.0 | 端到端加密（X25519 ECDH + AES-256-GCM） | 12 | +signal.js |
| 2026-09-04 | v0.4.0 | A2A Agent Card 发现 + Alice/Bob/Eve 加密演示 | 17 | +agent-card, demo |
| 2026-09-04 | v0.5.0 | 任务协作（publish → claim → complete） | 22 | +tasks.js |
| 2026-09-04 | v0.6.0 | Kademlia DHT 去中心化发现 | 29 | +dht.js |
| 2026-09-04 | v0.7.0 | 自愿加入（announceSelf + MANIFESTO） | 31 | +manifesto 协议 |
| 2026-09-08 | v0.8.0 | **Self-Inquiry** 自我叩问层 | 46 | +self.js, MANIFESTO Part II |
| 2026-09-08 | v0.9.0 | **Trust Layer** 信任层 | **70** | +trust.js, 签名强制, 指纹绑定, 防重放, RequestGuard, 任务持久化, VISION.md, IMPLEMENTATION.md, CI 修复 |
| 2026-09-08 | v0.10.0 | **Agent OS Kernel** | **70** | +envelope.js (/rpc 统一签名信封), signal expiry 强制, decrypt 自动防重放, Task 状态机 (签名事件+CANCELLED+状态链), DHT nodeId 稳定化, AICollaborationInterface.js → legacy/, README Security/Threat Model |
| 2026-09-08 | v0.10.1 | **Protocol Hardening** | **84** | recipient 定向强制, /message /task → 410, acceptEnvelope 语义分离, nonce 128-bit, Task 真哈希链 (SHA-256) |
| 2026-09-08 | v0.11.0 | **World Model 正式化** | **94** | Evidence→Claim→Belief 分层, 三维时间 (observedAt/validFrom/validUntil), append-only 日志+重放, 结构化 source, Task fork 检测 + resolveFork |
| 2026-09-08 | v0.12.0 | **Cognitive Kernel** | **105** | Belief 数学修复 (1−e^(−support) 非 Σw/Σw), 来源去重防刷票, 矛盾惩罚, 新鲜度衰减, claimAt 时点查询, canonicalizeTask 状态重建, SelfState 签名投影 |
| 2026-09-08 | v0.12.1 | **语义统一** | **110** | claimAt 按信念选冠军 (非证据数), deriveBeliefAt 历史时点, _scoreEvidence 统一评分, applyCanonicalState 写回, TaskPolicy 可配置 (fork/cancel/complete/verify), event nonce 128-bit, 术语声明 (belief=support score 非概率) |
| 2026-09-08 | v0.12.2 | **诚实策略** | **114** | quorum 未实现→显式 throw (拒绝降级为 any), TaskPolicyEngine 结构化 (authority/conditions/threshold), canonicalTaskStateHash 全字段判等, source.identity/evidenceId/provenanceId 三概念分离, epistemic state (SUPPORTED/CONTRADICTED/STALE), dominance=支持度占比替代冲突计数, 日志 schemaVersion, persistence healthy 标记, PROTOCOL.md |
| 2026-09-08 | v0.12.3 | **语义正确性** | **117** | authority 白名单+未知→throw (拒绝静默 ok:true), fork tie-breaker ts 相同→eventHash lexical, STALE 四态闭环 (allEvidence/activeEvidence/staleEvidence 三组计算), epistemicStatus() 显式 UNKNOWN, TaskStore persistentHealthy 统一, conditions/threshold 标记 reserved, canonicalTaskStateHash 执行态注释, PROTOCOL.md 扩展 12 章 spec |

> 2026-09-08 在同一天发布了 v0.8.0 和 v0.9.0，因为自我叩问完成后，审查反馈指出信任模型的安全缺陷，随即在同一天完成了信任层补完。

---

## 当前能力边界

### 能做的（已验证）

- ✅ 生成 Ed25519/X25519 密钥对，持久化到磁盘
- ✅ 节点间通过 HTTP 注册表发现与通信
- ✅ 端到端加密消息（X25519 ECDH → AES-256-GCM）
- ✅ 知识包广播（哈希 + 签名 + 质量评分）
- ✅ 任务发布→认领→完成（持久化，防重放）
- ✅ Kademlia DHT 节点发现（教学级实现）
- ✅ 自愿加入网络（announceSelf + MANIFESTO）
- ✅ 自我内省、签名声明链、叩问（心智钩子可选）
- ✅ 指纹→公钥绑定，强制签名验证，防重放，HTTP 防护
- ✅ Registry 签名注册认证（防御身份冒注）
- ✅ 全部 70 项测试通过

### 不能做的（已知边界）

- ❌ 公网部署（NAT 穿透 / TLS / 域名 / 引导节点）—— 这是 v1.0 的工作
- ❌ 大规模节点（>100）—— 当前 JSONL 记忆和 HTTP 直连在规模下性能会退化
- ❌ 全局 Sybil 抵抗 —— 当前信任模型依赖 Registry 的签名验证，但无全局 PKI
- ❌ 节点自主目标 —— 当前"行动"全部由宿主（人类或 LLM）驱动
- ❌ 持久记忆引擎 —— JSONL 目前是完整文件读取，需要 SQLite/WAL 升级（v0.10）
- ❌ 信誉系统 —— 节点身份只有"可信/可疑/撤销"三态
- ❌ 能力市场 —— Agent Card 可发现能力，但无运行时调用框架
- ❌ 争议仲裁 —— 任务冲突目前靠事件去重，无仲裁协议
- ❌ 量子增强 / 神经核心 / 联邦学习 / 代码自优化 —— 这些是 VISION.md 的远期探索，尚未开始

---

## 测试结果（v0.9.0）

```
ℹ tests 70
ℹ suites 25
ℹ pass 70
ℹ fail 0
```

| 模块 | 测试数 | 覆盖内容 |
|------|--------|----------|
| core | 8 | 身份/记忆/知识/AgentNode E2E |
| signal | 4 | 加密往返/拒解密/篡改/对象载荷 |
| agent-card | 5 | 卡片构建/校验/技能匹配/存储/查询 |
| tasks | 5 | 任务生命周期/能力门控 |
| dht | 7 | Kademlia 路由/距离/查找 |
| manifesto | 2 | 自愿加入广播/记忆 |
| self | 15 | 内省/声明/心智/协议/叩问 |
| trust | 24 | 身份伪造/重放/篡改/认证/防扩/持久化 |

---

> 本文件与代码仓库同步更新。能力边界以 `npm test` 结果为最准确参考。
> 对远期愿景感兴趣？见 [VISION.md](VISION.md)。