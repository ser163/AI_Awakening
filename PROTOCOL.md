# AI_Awakening Protocol

版本：0.1（草案） · 对应实现：v0.12.3 · 状态：**协议接口冻结进行中（Protocol Kernel 成熟，Cognitive Kernel 演进中）**

> 诚实声明（v0.12.2 起）：
> - AI_Awakening 目前**不是区块链共识系统**。Task canonicalization 是**确定性推导**，不是 global consensus。
> - `belief` 是 **support score / confidence**，不是概率。
> - 未实现的策略（quorum）**显式拒绝**，绝不静默降级。

每章统一按：Data Schema / Canonicalization / Signature Scope / Validation / Failure Behavior 描述。

---

## 1. Identity

```json
{
  "id": "alice",
  "name": "alice",
  "fingerprint": "<64-hex sha256 of publicKey>",
  "publicKey": "<ed25519 hex>",
  "privateKey": "<never transmitted>"
}
```

- **Schema**：Ed25519 密钥对；fingerprint = SHA-256(publicKey) 的 64-hex。
- **Canonicalization**：fingerprint 是身份的稳定 ID，改名不改变身份。
- **Signature Scope**：所有消息由私钥签名，publicKey 不参与签名内容（由 fingerprint 绑定）。
- **Validation**：`publicKeyMatchesFingerprint(publicKey, fingerprint)`。
- **Failure**：fingerprint ≠ SHA-256(publicKey) → REJECT。

## 2. SignedEnvelope（统一 RPC 信封）

```json
{
  "protocol": "ai-awakening",
  "version": 1,
  "type": "rpc",
  "sender": "<fingerprint>",
  "recipient": "<fingerprint | '*'>",
  "timestamp": 123,
  "nonce": "<16 bytes hex>",
  "payload": {},
  "signature": "<ed25519 base64>"
}
```

- **Canonicalization**：固定键序 JSON，见 `envelope.js canonicalize()`。
- **Signature Scope**：除 signature 外全部字段。
- **Validation**：`verifyEnvelope()` = 密码学+结构；`acceptEnvelope()` = verify + recipient(self|'*') + replay(nonce 128-bit)。
- **Failure**：recipient 定向错误 → REJECT（401）；nonce 重放 → REJECT；时间偏移超限 → REJECT。
- **兼容**：旧 `/message` `/task` 端点已移除（410 Gone），一律走 `/rpc`。

## 3. Replay

- 每 sender 每 nonce 只接受一次（ReplayCache）。
- nonce 长度：统一 **16 bytes（128-bit）**——envelope 与 task event 同标准。
- Failure：重复 → REJECT。

## 4. DHT Identity

- `nodeId = SHA-256(fingerprint)`（不依赖 name——改名不改变 DHT 身份）。
- DHT RPC 纳入 SignedEnvelope 认证域。

## 5. Knowledge Packet

- author → TrustedIdentityStore → publicKey → 强制验签。
- 无可信公钥 → REJECT；fingerprint ≠ hash(publicKey) → REJECT；签名无效 → REJECT。
- "没有可信 PublicKey 就拒绝" 是网络的物理定律。

## 6. Task Event

```json
{
  "eventId": "evt-...", "taskId": "task-...", "action": "publish|claim|complete|cancel",
  "actor": "<fingerprint>", "previousHash": "<eventHash|null>", "ts": 123,
  "nonce": "<16 bytes hex>", "status": "open|claimed|completed|cancelled",
  "payload": { "state": { "status": "...", "assigneeFingerprintActual": "...", "result": "..." } },
  "signature": "...", "eventHash": "<sha256>"
}
```

- **Canonicalization**：canonicalizeEvent()——除 signature/eventHash 外全部字段。
- **eventHash = SHA-256(canonicalizeEvent)**——内容篡改 → hash 不匹配 → 断链。
- **previousHash**：指向父事件；状态链是**真哈希链**。
- **Validation**：actor 可信 + 公钥绑定 + 签名有效 + eventHash 自洽 + 链连续。
- **首见引导**：无本地记录时信任由签名广播引导（不校验 previousHash）。
- **Failure**：断链 → REJECT；合法分叉（previousHash ∈ 本地历史）→ 记录 fork，不拒绝。

## 7. Task Canonicalization

**Task canonicalization 是基于节点当前已知事件集合的确定性推导，不是全局共识。**

- 确定性：相同事件集合 + 相同 TaskPolicy → 相同结果。tie-break 顺序：
  1. policy priority（publisher/assignee/newest 规则）
  2. timestamp（新者优先）
  3. eventHash lexical（ts 相同时的最终 tie-breaker）
- 局部性：节点只基于已收到事件决策；事件未完全传播时，不同节点可能暂时持有不同 canonical state。
- 最终一致性：事件集合收敛 → deterministic canonical state。
- 分叉生命周期：事件 A → B1/B2 并发 → resolveFork() 选胜者 → canonicalizeTask() 重放重建 → applyCanonicalState() 写回。
- `applyCanonicalState()` 幂等，判等用 `canonicalTaskStateHash()`（执行态字段：status/assignee/result/三时间戳/lastEventHash；静态字段不参与）。

## 8. Evidence

```json
{
  "evidenceId": "...", "subject": "agent:alice", "predicate": "located_at", "object": "Beijing",
  "source": { "type": "sensor|self|agent|registry|memory|network|relay",
              "id": "<session/event id>", "identity": "<stable subject id>",
              "kind": "assertion|observation|relay|measurement",
              "eventId": "...", "provenanceId": "..." },
  "observedAt": 123, "validFrom": 123, "validUntil": 456
}
```

- **哲学**：World 只接受"某来源声称了什么"（`ingestEvidence`），不接受"真相断言"（`assertFact` 不存在）。
- **三维时间**：observedAt（采集）/ validFrom（成立起）/ validUntil（失效止）——三者独立。
- **来源三概念**：identity（独立性依据）/ id（会话级）/ provenanceId（因果链，**reserved**——传播链去重尚未实现，见 §13）。
- Failure：缺 subject/predicate → throw。

## 9. Claim

```json
{
  "id": "agent:alice|located_at|Beijing",
  "claimId": "同 id", "subject": "...", "predicate": "...", "object": "...",
  "createdAt": 123, "evidence": [Evidence...]
}
```

- Claim 是可追踪主张容器：独立 claimId、createdAt、证据列表（证据级时间窗独立）。
- `claimAt(subject, predicate, atMs)`：时点世界状态查询——按信念选冠军（非证据数量）。

## 10. Belief

```text
support      = Σ(weight × freshness)         // 同 identity 去重；半衰期 7 天
belief       = 1 − exp(−support)              // support score，不是概率
dominance    = support(best) / Σ support(all) // 相对支持度（矛盾强度）
beliefFinal  = belief × dominance
epistemicState = SUPPORTED | CONTRADICTED | STALE | UNKNOWN
```

- **术语**：belief = confidence / support score。`belief=0.8` **不意味着** P(claim is true)=80%。
- **四态**（`epistemicStatus()` 显式查询）：
  - UNKNOWN：无任何证据
  - STALE：有证据但全部过期（validUntil 已过）
  - SUPPORTED：有活跃证据、无冲突
  - CONTRADICTED：有活跃证据、有冲突（dominance 反映强度）

## 11. World State

- **append-only 事件日志 + 启动重放重建内存状态**（Event Sourcing）。
- 每条日志带 `schemaVersion: 1`（为版本迁移做准备）。
- **持久化健康**：`_append()` 失败 → `persistentHealthy=false` + `persistenceError` 暴露——World Model 是权威状态，不静默吞异常。
- 概念分层（审查确立）：`Observation → Evidence → Claim → Belief`。World Model 是推理产物，不是 LLM 记事本。

## 12. Self State

```json
{
  "identity": {}, "beliefs": [], "goals": [], "capabilities": [],
  "values": [], "commitments": [], "relationships": [], "uncertainties": [],
  "updatedAt": 123
}
```

- SelfDeclaration 是 SelfState 的**签名投影**：schemaVersion/version/createdAt/nodeId/name/fingerprint/visibility/narrative/beliefs/questions/state/snapshotHash/previousHash 全部进入签名域。
- 篡改 state → 签名失效。
- **已知边界**：SelfState 是连续签名的 snapshot，还不是有因果历史的状态机（SelfTransition 事件见 v0.13 路线图）。

---

## 13. Policy（TaskPolicyEngine）

- authority 白名单：`any | publisher | assignee | quorum`。
- 未知 authority → **throw**（拒绝加载任务，不静默 ok:true，不自动 default）。
- quorum → **throw**（未实现，拒绝假安全）。conditions/threshold：**reserved**（尚无 evaluator）。
- fork 规则：`publisher | newest | assignee`（确定性 tie-break 见 §7）。

## 14. Known Boundaries（诚实声明）

| 能力 | 状态 |
|------|------|
| Global consensus | 未实现（不上 Raft/Paxos）——确定性推导 + 最终一致性 |
| Quorum verify | 未实现（显式 throw） |
| conditions evaluator | reserved |
| Evidence provenance DAG | reserved（传播链去重待实现） |
| SelfTransition（因果状态） | 路线图 v0.13 |
| Goal/Plan/Action loop | 路线图 v0.13 |
