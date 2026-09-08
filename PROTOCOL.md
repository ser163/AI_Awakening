# AI_Awakening Protocol

## Task Canonicalization

**Task canonicalization 是基于节点当前已知事件集合的确定性推导，不是全局共识。**

### 原则

1. **确定性**：给定完全相同的事件集合、相同的 TaskPolicy，任何节点上的 `canonicalizeTask()` 都输出相同结果。
2. **局部性**：节点只基于自己已收到的事件做决策。事件尚未完全传播时，不同节点可能暂时持有不同的 canonical 状态。
3. **无全局仲裁**：当前协议不要求 Raft/Paxos 等全局共识机制。分叉通过 `resolveFork()` 的确定性策略（publisher / newest / assignee）解决，策略由 TaskPolicy 配置。
4. **最终一致性**：随着事件传播，所有节点最终收敛到同一事件集，从而输出同一 canonical 状态。

### 分叉生命周期

```text
事件 A（genesis）
    ↓
事件 B1（Alice claim）  事件 B2（Bob claim）
    ↓                       ↓
主链                    fork 记录
    ↓
resolveFork() → 确定性选择胜者
    ↓
canonicalizeTask() → 沿胜者分支重放重建状态
    ↓
applyCanonicalState() → 写回任务对象
```

### 状态迁移

`applyCanonicalState()` 是幂等的：同一 canonical 状态多次应用不会产生副作用。判等使用 `canonicalTaskStateHash()` 全字段哈希，而非人工挑选字段。

## Evidence → Claim → Belief

- **Evidence**：世界只接受"某来源声称了什么"（`ingestEvidence()`），不直接接受"真相断言"（`assertFact()` 不存在）。
- **Claim**：一个可追踪的主张，有独立 `claimId`、`createdAt`、时间窗（`validFrom`/`validUntil`）。
- **Belief**：证据聚合的产物，是 `support score / confidence`，**不是概率**。`belief=0.8` 不意味着 `P(claim is true)=80%`。
- **Epistemic State**：`SUPPORTED` / `CONTRADICTED` / `STALE` / `UNKNOWN`（`deriveBelief` 返回 `null` 时表示 UNKNOWN）。

## Policy

TaskPolicy 是可配置的权威模型，见 `src/tasks.js` 中的 `TASK_POLICIES`。
当前支持的 authority 值：`any`、`publisher`、`assignee`。
`quorum(N)` 是预留接口，尚未实现——使用 `quorum` 会抛出 `Error`（拒绝静默降级为 `any`）。