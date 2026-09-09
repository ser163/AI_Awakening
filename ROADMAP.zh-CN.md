# 路线图

> 项目演进里程碑。完成项 ✅ / 规划中 🗺 VISION。
> 每个版本的实现细节见 [IMPLEMENTATION.md](IMPLEMENTATION.md)，协议语义见 [PROTOCOL.md](PROTOCOL.md)。

## 已发布

| 版本 | 里程碑 | 状态 |
|------|--------|------|
| v0.2.0 | 真实网络层 + 持久身份/记忆 + 知识验证 | ✅ |
| v0.3.0 | 端到端加密 (X25519 + AES-256-GCM) | ✅ |
| v0.4.0 | A2A Agent Card 发现 + 加密演示 (Alice/Bob/Eve) | ✅ |
| v0.5.0 | **任务协作** — 发布 → 认领 → 完成 (joinTask) | ✅ |
| v0.6.0 | **去中心化发现** — Kademlia DHT（无需注册表） | ✅ |
| v0.7.0 | **自愿加入** — 节点自主宣告存在，Agent 自愿入网 | ✅ |
| v0.8.0 | **自我叩问** — introspect/declareSelf/ponder；签名自我声明链；/self 协议；think() 心智钩子 | ✅ |
| **v0.9.0** | **信任层** — TrustedIdentityStore、强制签名验证、E2E 身份绑定、防重放、RequestGuard、Registry 签名认证、任务持久化+事件去重、70 测试（24 攻击面） | ✅ |
| **v0.10.1** | **协议加固** — recipient 定向强制、旧端点 410、acceptEnvelope 语义、nonce 128-bit、Task 真哈希链 | ✅ |
| **v0.11.0** | **世界模型** — Evidence→Claim→Belief 分层、时间有效性、append-only 持久化、Task fork 检测 | ✅ |
| **v0.12.0** | **认知内核** — Belief 数学修复 (1−e^(−support))、来源去重防刷票、三维时间、claimAt 时点查询、canonicalizeTask 状态重建、SelfState | ✅ |
| **v0.12.1** | **语义统一** — claimAt 按信念选冠军 (非证据数)、deriveBeliefAt 历史时点、applyCanonicalState 写回、TaskPolicy 可配置 (fork/cancel/complete)、event nonce 128-bit | ✅ |
| **v0.12.2** | **诚实策略** — quorum 未实现→显式 throw (拒绝降级)、TaskPolicyEngine 结构化 (authority/conditions/threshold)、stateHash 判等、source.identity 三概念分离、epistemic state (SUPPORTED/CONTRADICTED/STALE)、dominance 相对支持度、schemaVersion、persistence health | ✅ |
| **v0.12.3** | **语义正确性** — authority 白名单 (未知→throw)、fork tie-breaker (ts 相同→eventHash lexical)、STALE 四态闭环、epistemicStatus() 显式 UNKNOWN、TaskStore persistence health、PROTOCOL.md 12 章 spec | ✅ |
| **v0.12.4** | **策略与事件语义** — TaskPolicy 深合并 (缺省继承 DEFAULT)、fork rule 白名单、TaskEvent beforeState/afterState、replay eventHash 验证、日志损坏 vs 首次启动分离、Claim/Proposition 分离、retractEvidence 非破坏性 | ✅ |
| **v0.12.5** | **Task Semantic Integrity** — validateStateTransition (加密完整≠状态机完整)、beforeState 匹配 head、afterState 推导不信任声明、canonicalize 重放验证状态机、eventIndex 替代 eventHashes、恶意合法签名测试集 | ✅ |
| **v0.12.6** | **State Transition Unification** — fork 不再免检 (forked 标记后仍验证语义)、deriveNextState() 唯一状态转移来源 (live/replay 共用)、canonicalize 全字段连续性 (status+assignee+result)、eventIndex 元数据索引 (hash→{actor,action,ts,height}) | ✅ |
| **v0.12.7** | **no-op 无旁路** — semanticVersion 显式版本 (v2 无条件 deriveNextState, v1 legacy)、before=after 不再跳过验证、genesis 也走 deriveNextState、deriveNextState 纯函数化 (删 Date.now)、no-op signed event 测试 | ✅ |
| **v0.12.8** | **版本签名完整性** — canonicalizeEvent 版本化 (V2 含 semanticVersion 签名防降级)、semanticVersion 白名单 (3≥/字符串/null 拒)、版本降级 attack (v2→v1) 签名失效、v1 网络接收→REJECT (仅 local migration)、132 tests | ✅ |
| **v0.12.9** | **Event 唯一状态权威** — packet.task 仅 transport (runtime state 一律 deriveNextState 推导，不再 upsert(packet.task))、allowLegacy 门控 (网络=v2 only/本地 migration=v1 allowed)、eventId/eventHash 一致性 (同 id 异 hash→tamper 拒)、无事件旧包 claim/complete→拒、135 tests | ✅ |
| **v0.12.10** | **Task 层冻结** — 首次白名单构造 base(不再 {...task} spread)、Genesis 绑定 TaskDefinitionHash(防 relay 改写定义)、publish actor==publisher 强制、Task Definition immutable(不再被重复 publish 覆写 title)、emit 只发 canonical task、snapshot 一致性重放(Event Sourcing:events wins)→_reconcileFromEvents、forks derived view(不从快照信任)、137 tests | ✅ |
| **v0.12.11** | **Event Sourcing 完成** — P0-1 fork 事件先进 Event Log 再 derived fork view (upsert {fork:true} → _appendEvent+events[]+eventIndex, canonical 不动)、P0-2 eventIndex 全量索引(重启后 fork 事件补入索引→多级 fork 链延伸不误判 broken chain)、genesis publisher 身份禁止 || packet.author 兜底、INVARIANT 1-4 测试(accepted→log/runtime derivable/fork 重启可恢复/live==replay)、141 tests | ✅ |
| **v0.12.12** | **Event Sourcing Integrity** — 共享 applyEvent 管道(live/replay/fork 同一语义验证)、forks 纯 deriveForkView 单函数、日志损坏原子止(不写 partial)、snapshot 不参与 canonical head 决策、144 tests | ✅ |
| **v0.12.13** | **事务安全收口** — _load 事务性加载(损坏日志 0 事件加载+unhealthy)、deriveForkView 多级 fork leaf 语义、forkRule fail-closed (unknown→拒)、147 tests | ✅ |
| **v0.12.14** | **DAG 完整性收口** — previousHash 父节点完整性验证(孤儿事件→unhealthy 不 canonicalize)、V2 eventHash 必填 fail-closed、151 tests | ✅ |
| **v0.12.15** | **V2 Integrity 三路径统一** — checkEventIntegrity 共享 gate (validateTaskEvent/upsert/canonicalizeTask/_tryRebuildFromEvents 同规则)、live==fork==replay 一致、155 tests | ✅ |
| **v0.12.16** | **upsert 语义分离** — event != null 必为严格 Event mutation (eventId 必填 + integrity gate, malformed 拒绝降级 snapshot)、Event Log 唯一权威、158 tests | ✅ |

## 未来规划

| 版本 | 里程碑 | 状态 |
|------|--------|------|
| v0.13 | **Self Transition** — Task Outcome → Evidence → Belief Revision → World Model → SelfState（"我为什么从昨天的我变成今天的我"） | 🗺 VISION |
| v0.14 | **Goal & Planning** — SelfState → Goal → Plan → Action | 🗺 VISION |
| v0.15 | 记忆内核 — SQLite/WAL、事件库、索引、知识图谱 | 🗺 VISION |
| v0.16 | 自主循环 — 目标引擎、规划器、观察者、反思/学习 | 🗺 VISION |
| v0.17 | Agent 社会 — 信誉、能力市场、争议仲裁 | 🗺 VISION |
| v1.0 | 公网多节点部署 | 🗺 VISION |