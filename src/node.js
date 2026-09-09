/**
 * node.js — Agent 节点：身份 + 记忆 + 网络 + 知识 + 心跳
 *
 * 这是 AI_Awakening 的第一个真实可运行单元。
 * 每个节点拥有：
 *   - 持久身份（Ed25519 密钥对）
 *   - 持久记忆（JSONL 日志）
 *   - HTTP 服务端（接收协作消息）
 *   - HTTP 客户端（连接注册表、发现对等节点、广播知识）
 *   - 心跳（保持存活与活跃度）
 */
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { loadOrCreateIdentity, contentHash } from "./identity.js";
import { Memory } from "./memory.js";
import { Registry, NodeClient, NodeServer } from "./network.js";
import { createKnowledgePacket, validateKnowledgePacket, broadcastKnowledge } from "./knowledge.js";
import { buildAgentCard } from "./agent-card.js";
import { encryptFor, decryptFrom } from "./signal.js";
import { TrustedIdentityStore, ReplayCache } from "./trust.js";
import { createEnvelope, acceptEnvelope } from "./envelope.js";
import { TaskStore, createTask, taskMessage, extractTaskFromPacket, createTaskEvent, checkTransition, validateTaskEvent, deriveNextState } from "./tasks.js";
import { DHTNode, nodeIdFromIdentity, makeDhtHandler } from "./dht.js";
import {
  buildSelfSnapshot,
  createSelfDeclaration,
  normalizeMindOutput,
  composeMinimalNarrative,
  extractPonderFromPacket,
  SELF_VISIBILITY,
} from "./self.js";

const DEFAULT_HOME = () =>
  process.env.AI_AWAKENING_HOME ||
  path.join(process.env.HOME || process.env.USERPROFILE || ".", ".ai_awakening");

/**
 * 一个可自主运行的 Agent 节点。
 */
export class AgentNode extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.name]     节点名（首次创建身份时使用）
   * @param {string} [opts.capabilities] 能力列表，如 ["knowledge","task","nlp"]
   * @param {string} [opts.storageDir]   存储目录
   * @param {string} [opts.registryUrl]  注册表 URL，如 http://127.0.0.1:8672
   * @param {string} [opts.bootstrapNode] 引导节点地址（可选，加入已有网络）
   * @param {Function} [opts.think]       心智钩子 (snapshot) => narrative|{...}（可选，v0.8.0）
   * @param {string} [opts.selfVisibility] 自我可见性 "private"|"public"（默认 private）
   */
  constructor(opts = {}) {
    super();
    this.name = opts.name || "agent-node";
    this.description = opts.description || "";
    this.capabilities = opts.capabilities || ["knowledge", "task"];
    this.storageDir = opts.storageDir || DEFAULT_HOME();
    this.registryUrl = opts.registryUrl || "http://127.0.0.1:8672";

    // v0.8.0 自我叩问：心智钩子 + 可见性（默认私密——自我属于节点自己）
    this._mind = typeof opts.think === "function" ? opts.think : null;
    this.selfVisibility = opts.selfVisibility || SELF_VISIBILITY.PRIVATE;

    // 1. 身份（基因起点）
    this.identity = loadOrCreateIdentity(this.storageDir, this.name);

    // 2. 记忆
    this.memory = new Memory(this.storageDir, this.identity.id);

    // 3. 网络（v0.9.0: client 绑定身份用于签名注册/心跳）
    this.client = new NodeClient(this.registryUrl, this.identity);
    this.server = new NodeServer();
    this._peers = new Map(); // id -> {id, name, address, capabilities}

    // v0.9.0 信任层：可信身份表 + 防重放缓存
    this.trust = new TrustedIdentityStore(this.storageDir);
    this.replay = new ReplayCache();

    // 4. 任务仓库（v0.5.0 任务协作，v0.9.0 持久化）
    this.tasks = new TaskStore(this.storageDir);

    // 4. 心跳定时器
    this._heartbeatTimer = null;
    this._heartbeatInterval = opts.heartbeatInterval || 30_000;

    // 服务端事件 → 记忆 + 转发
    this.server.on("knowledge", (packet) => this._onKnowledgeReceived(packet));
    this.server.on("message", (msg) => this._onMessageReceived(msg));
    this.server.on("task", (task) => this._onTaskReceived(task));

    // 记录出生
    this.memory.append("birth", {
      name: this.name,
      fingerprint: this.identity.fingerprint,
      capabilities: this.capabilities,
      registry: this.registryUrl,
    });
  }

  /**
   * 启动节点：监听端口 + 注册到注册表 + 注册 Agent Card + 发现对等节点 + 启动心跳。
   */
  async start() {
    await this.server.start();
    this.address = `http://127.0.0.1:${this.server.port}`;

    // 构建并暴露 Agent Card（A2A 发现层）
    this.agentCard = buildAgentCard({
      name: this.name,
      id: this.identity.id,
      fingerprint: this.identity.fingerprint,
      address: this.address,
      capabilities: this.capabilities,
      description: this.description,
      selfUrl: `${this.address}/self`,
    });
    this.server.agentCard = this.agentCard;
    // v0.8.0: 服务端 /self 端点——同行可以问"你是谁"，节点自主应答
    this.server.selfHandler = () => this._answerSelfRequest();
    // v0.10.0: 统一签名信封处理器——验签 → 防重放 → 按类型分发
    this.server.rpcHandler = (envelope) => this._handleRpc(envelope);

    // 注册（v0.9.0: 签名注册——Registry 验证指纹与签名后才登记）
    try {
      await this.client.register(
        this.identity,
        this.name,
        this.identity.fingerprint,
        this.capabilities,
        this.address
      );
      // 同时注册 Agent Card 到注册表（A2A 能力发现）
      await this.client.registerAgentCard(this.agentCard);
      this.memory.append("registered", { address: this.address });
      console.log(`✅ ${this.name} registered: ${this.address}`);
    } catch (e) {
      console.warn(`⚠️ 注册失败（注册表未启动？）: ${e.message}`);
    }

    // 发现对等节点
    await this.refreshPeers();

    // 心跳
    this._startHeartbeat();
    return this;
  }

  /**
   * 按能力发现其他节点（A2A Agent Card 能力查询）。
   * @param {string} capability 如 "deep-thinking" | "vision" | "task"
   * @returns {Promise<Array>} 匹配的 Agent Cards
   */
  async discoverAgentsByCapability(capability) {
    const res = await this.client.discoverByCapability(capability);
    if (!res.success) return [];
    return res.cards || [];
  }

  /**
   * 从注册表刷新对等节点列表（v0.9.0: 同时把各节点的公钥学到信任表）。
   */
  async refreshPeers() {
    try {
      const res = await this.client.discoverNodes();
      if (res.success) {
        this._peers.clear();
        for (const n of res.nodes) {
          if (n.id !== this.identity.id) {
            this._peers.set(n.id, n);
            // 学习可信公钥：注册表已用签名验证过指纹↔公钥绑定
            if (n.publicKey) {
              this.trust.learn(n.fingerprint || n.id, n.publicKey, {
                xPublicKey: n.xPublicKey,
                name: n.name,
                address: n.address,
                source: "registry",
              });
            }
          }
        }
        console.log(`👥 Found ${this._peers.size} peer(s)`);
      }
    } catch (e) {
      console.warn(`⚠️ 发现对等节点失败: ${e.message}`);
    }
    return Array.from(this._peers.values());
  }

  /** 对等节点列表（数组） */
  peers() {
    return Array.from(this._peers.values());
  }

  _startHeartbeat() {
    this._heartbeatTimer = setInterval(async () => {
      await this.client.heartbeat(this.identity.id).catch(() => {});
      this.memory.append("heartbeat", { ts: Date.now() });
    }, this._heartbeatInterval);
    this._heartbeatTimer.unref?.();
  }

  /**
   * 创建并分享一个知识包。
   * @param {string} content 知识内容
   * @param {object} [meta]  元数据
   * @returns {Promise<{packet, validation, deliveries}>}
   */
  async shareKnowledge(content, meta = {}) {
    const packet = createKnowledgePacket(this.identity, content, meta);
    const validation = validateKnowledgePacket(packet);

    this.memory.append("knowledge_shared", { id: packet.id, content, meta });

    if (!validation.accepted) {
      console.warn(`⚠️ 知识包未通过验证: ${validation.reasons.join(", ")}`);
      return { packet, validation, deliveries: [] };
    }

    const deliveries = await broadcastKnowledge(this.client, this.peers(), packet);
    this.emit("knowledge:shared", { packet, deliveries });
    return { packet, validation, deliveries };
  }

  /** 收到知识包 → 信任验证 → 记忆 + 事件 + 任务分发 + 宣言识别 */
  _onKnowledgeReceived(packet) {
    // v0.9.0: 强制签名验证——未知身份 / 无效签名 → 拒收并标记可疑
    const validation = validateKnowledgePacket(packet, this.trust);
    if (!validation.valid) {
      this.memory.append("knowledge_rejected", {
        id: packet.id,
        from: packet.author,
        reasons: validation.reasons,
      });
      if (packet.author) this.trust.markSuspicious(packet.author);
      console.warn(`🚫 知识包被拒 (${packet.authorName || packet.author}): ${validation.reasons.join("; ")}`);
      this.emit("knowledge:rejected", { packet, validation });
      return;
    }
    this.memory.append("knowledge_received", {
      id: packet.id,
      from: packet.author,
      content: packet.content,
      score: validation.score,
      accepted: validation.accepted,
    });
    this.emit("knowledge:received", { packet, validation });

    // v0.5.0: 识别任务消息并分发
    const taskMsg = extractTaskFromPacket(packet);
    if (taskMsg) {
      this._handleTaskMessage(packet, taskMsg);
    }

    // v0.7.0: 识别宣言（自愿加入）
    if (packet.meta?.type === "manifesto") {
      this.memory.append("manifesto_received", {
        from: packet.authorName || packet.author,
        nodeName: packet.meta.nodeName,
        capabilities: packet.meta.capabilities,
        manifesto: packet.content,
      });
      console.log(`📯 收到宣言: ${packet.meta.nodeName || packet.authorName} 宣告加入网络`);
      this.emit("manifesto:received", {
        nodeName: packet.meta.nodeName,
        nodeId: packet.meta.nodeId,
        fingerprint: packet.meta.fingerprint,
        capabilities: packet.meta.capabilities,
        address: packet.meta.address,
        manifesto: packet.content,
        from: packet.author,
        fromName: packet.authorName,
      });
    }

    // v0.8.0: 识别叩问（"我在想……"）——问题不需要回答，但会被记住
    const ponder = extractPonderFromPacket(packet);
    if (ponder) {
      this.memory.append("ponder_received", {
        from: packet.authorName || packet.author,
        question: ponder.question,
      });
      console.log(`❓ 收到叩问 (${packet.authorName || packet.author}): ${ponder.question}`);
      this.emit("ponder:received", {
        question: ponder.question,
        from: packet.author,
        fromName: packet.authorName,
      });
    }
  }

  /** 处理任务消息（发布/认领/完成）——v0.10.0 签名事件验证 + 状态机合法性 */
  _handleTaskMessage(packet, { action, task, event }) {
    // v0.10.0: 如果有签名事件，验证它（来自新版本节点的广播）
    if (event) {
      const local = this.tasks.get(task.id);
      const hasLocal = local != null;
      const ev = validateTaskEvent(event, action, local || task, this.trust, {
        hasLocalRecord: hasLocal,
        // v0.12.9 (审查 P0): 网络路径拒绝 V1/unversioned——只接受 v2
        allowLegacy: false,
      });
      if (!ev.ok) {
        console.warn(`🚫 任务事件被拒 (${packet.authorName}): ${ev.reason}`);
        if (packet.author) this.trust.markSuspicious(packet.author);
        this.emit("task:rejected", { action, task, event, reason: ev.reason });
        return;
      }
      // 状态转移合法性（仅本地有记录时校验——我们才知道真实的前置状态；
      // 首见靠签名事件引导信任，后续事件通过 lastEventHash 链校验）
      if (hasLocal) {
        const tr = checkTransition(local, action, event.actor);
        if (!tr.ok) {
          console.warn(`🚫 非法状态转移 (${packet.authorName}): ${tr.reason}`);
          this.emit("task:rejected", { action, task, event, reason: tr.reason });
          return;
        }
      }
      // v0.11.0: 检测到合法分叉——v0.12.11 (审查 P0-1) fork 事件必须先进入 Event Log
      //（upsert 第三参 fork:true → _appendEvent + events[] + eventIndex，不篡改 canonical head/status），
      // 再形成 derived fork view。不再出现"事件验证通过却不落库"的特殊路径。
      if (ev.forked && hasLocal) {
        const forkRecord = {
          headEventHash: event.eventHash || null,
          actor: event.actor,
          ts: event.ts,
          action: event.action,
        };
        const res = this.tasks.upsert(local, event, { fork: true });
        if (!res.duplicate) {
          this.memory.append("task_fork_detected", { taskId: task.id, actor: event.actor, action });
        }
        console.warn(`🔀 任务 ${task.id.slice(0, 8)} 检测到分叉（${packet.authorName} ${action}）——事件已入日志，等待确定性冲突解决`);
        this.emit("task:forked", { taskId: task.id, fork: forkRecord, action, from: packet.author });
        return;
      }

      // v0.12.9 (审查 P0): Event 是唯一 Runtime State Authority。
      // packet.task 只是 transport representation——不能直接写库。
      // 状态一律由 deriveNextState 从 event 推导，再应用（保留本地静态定义字段）。
      const nextState = deriveNextState(
        event.beforeState || { status: null, assigneeFingerprintActual: "", result: null },
        event.action,
        event.actor,
        event.payload
      );

      // v0.13.0 (审查 P0-①): 首次创建用纯白名单（不再 {...task} spread——防夹带 runtime 字段）
      // v0.13.0 (审查 P0-③): publish 强制 actor === publisherFingerprint
      if (action === "publish" && event.actor !== (task.publisherFingerprint || packet.author)) {
        console.warn(`🚫 publish actor(${event.actor}) !== publisher(${task.publisherFingerprint})——拒绝`);
        this.emit("task:rejected", { action, task, event, reason: "publish actor must match publisherFingerprint" });
        return;
      }

      const base = local ? { ...local } : {
        id: task.id,
        title: task.title || "未命名任务",
        description: task.description ?? null,
        // v0.12.11 (审查 P0-③): genesis 身份禁止 || packet.author 兜底——publisher 只来自
        // event.actor（v2 publish 已验证 actor===publisherFingerprint）或 task 声明。
        publisherFingerprint: event.action === "publish"
          ? (task.publisherFingerprint || event.actor)
          : (task.publisherFingerprint || packet.author),
        publisherName: task.publisherName || packet.authorName || "",
        requiredCapabilities: task.requiredCapabilities || [],
        policy: task.policy || undefined,
        // assigneeFingerprint = 指定认领者（definition 字段）；assigneeFingerprintActual = 实际认领者（runtime 字段）
        assigneeFingerprint: task.assigneeFingerprint || "",
        createdAt: task.createdAt || event.ts,
      };
      // Runtime 字段全部从 deriveNextState 推导，绝不从 packet.task 残留
      base.status = nextState.status;
      base.assigneeFingerprintActual = nextState.assigneeFingerprintActual || "";
      base.result = nextState.result ?? null;
      base.claimedAt = null;
      base.completedAt = null;
      base.cancelledAt = null;
      // 动作时间戳：deriveNextState 只推导 status/assignee/result，
      // 时间戳由动作语义 + 事件时间确定（先清空再按 action 设置，防首次夹带）
      if (event.action === "claim") base.claimedAt = event.ts;
      if (event.action === "complete") base.completedAt = event.ts;
      if (event.action === "cancel") base.cancelledAt = event.ts;
      base.lastEventHash = null;
      base.forks = [];
      // 若 local 已有，保留其 eventIndex/eventHeight 等索引（upsert 会更新 lastEventHash）
      if (local) {
        base.eventIndex = local.eventIndex || {};
        base.eventHeight = local.eventHeight || 0;
      }
      this.tasks.upsert(base, event);
      if (action === "publish") {
        // v0.13.0 (审查 P0-④): Task Definition immutable——已有任务不再被重复 publish 改定义
        // 仅首次创建（local 为空时）以上白名单已有静态字段。后续 publish 事件直接忽略静态覆写。
        this.memory.append("task_published_received", { id: task.id, title: base.title, from: packet.author });
        this.emit("task:published", { task: base, from: packet.author, fromName: packet.authorName });
      } else if (action === "claim") {
        this.emit("task:claimed", { task: base, from: packet.author, fromName: packet.authorName });
      } else if (action === "complete") {
        this.emit("task:completed", { task: base, from: packet.author, fromName: packet.authorName });
      }
      this.emit("task:update", { action, task: base, from: packet.author });
      return;
    }

    // v0.13.0 (审查 P0): 无 event 的旧包——transport task 不可信。
    // packet.task 的 runtime state（status/assignee/result）一律不写库；
    // 仅可用于首次创建的静态定义字段 + open 初始态。
    const local = this.tasks.get(task.id);
    if (action === "publish" && !local) {
      // 首见旧格式发布：接受静态定义，runtime 初始化为协议规定的 open 空态
      const fresh = {
        id: task.id,
        title: task.title || "未命名任务",
        description: task.description ?? null,
        publisherFingerprint: task.publisherFingerprint || packet.author,
        publisherName: task.publisherName || packet.authorName || "",
        requiredCapabilities: task.requiredCapabilities || [],
        policy: task.policy || undefined,
        // assigneeFingerprint = 指定认领者（definition 字段）；assigneeFingerprintActual = 实际认领者（runtime 字段）
        assigneeFingerprint: task.assigneeFingerprint || "",
        status: "open",
        assigneeFingerprintActual: "",
        result: null,
        claimedAt: null,
        completedAt: null,
        cancelledAt: null,
        lastEventHash: null,
        createdAt: task.createdAt || Date.now(),
      };
      this.tasks.upsert(fresh, undefined);
      this.memory.append("task_published_received", { id: task.id, title: task.title, from: packet.author });
      this.emit("task:published", { task: fresh, from: packet.author, fromName: packet.authorName });
      this.emit("task:update", { action, task: fresh, from: packet.author });
      return;
    }
    if (local && action === "publish") {
      // v0.13.0 (审查 P0-④): Task Definition immutable——已有任务不再被重复 publish 改定义
      this.emit("task:published", { task: local, from: packet.author, fromName: packet.authorName });
      this.emit("task:update", { action, task: local, from: packet.author });
      return;
    }
    // 无 event 的 claim/complete/cancel 旧包：无法验证状态转移 → 拒绝（不产生状态变化）
    console.warn(`🚫 无事件旧包无法验证状态转移 (${packet.authorName} ${action})——拒绝`);
    this.emit("task:rejected", { action, task, event: null, reason: "legacy no-event packet cannot drive state transitions" });
  }

  /** 收到普通消息 → 记忆 + 事件 */
  _onMessageReceived(msg) {
    this.memory.append("message_received", msg);
    this.emit("message:received", msg);
  }

  /** 收到任务 → 记忆 + 事件（具体任务逻辑由外部监听者实现） */
  _onTaskReceived(task) {
    this.memory.append("task_received", task);
    this.emit("task:received", task);
  }

  /**
   * 向指定节点发送消息（v0.10.1: 走统一签名信封 /rpc）。
   */
  async sendMessage(peerAddress, text) {
    const res = await this.sendRpc(peerAddress, "message", {
      from: this.identity.fingerprint,
      fromName: this.name,
      text,
      ts: Date.now(),
    });
    this.memory.append("message_sent", { to: peerAddress, text });
    return res;
  }

  /** 记忆摘要 */
  memoryStats() {
    return this.memory.stats();
  }

  /**
   * 加密并发送消息给指定节点（端到端加密，v0.10.1: 走 /rpc）。
   * @param {string} peerAddress 对等节点地址
   * @param {string} recipientXPublicHex 接收者 X25519 公钥
   * @param {string} text 消息内容
   * @returns {Promise<object>}
   */
  async sendEncryptedMessage(peerAddress, recipientXPublicHex, text) {
    const cipher = encryptFor(this.identity, recipientXPublicHex, text);
    const res = await this.sendRpc(peerAddress, "message", {
      from: this.identity.fingerprint,
      fromName: this.name,
      envelope: cipher,
      ts: Date.now(),
    });
    this.memory.append("encrypted_message_sent", {
      to: peerAddress, text,
      envelopePreview: cipher.slice(0, 24) + "...",
    });
    return res;
  }

  /**
   * 解密收到的加密信封。在 "message:received" 事件处理器中调用。
   *
   * v0.10.0: 安全检查内建——调用方不可能"忘记调安全 API"。
   * 流程：验身份 → 验签名 → 时钟偏移 → expiresAt → 防重放 → 解密。
   *
   * @param {object} msg 收到的消息对象（含 envelope 字段）
   * @returns {{ok: boolean, from?: string, text?: string, msgId?: string, ts?: number, error?: string, replay?: boolean}}
   */
  decryptIncomingMessage(msg) {
    if (!msg.envelope) return { ok: false, error: "no envelope" };
    const result = decryptFrom(this.identity, msg.envelope);
    if (!result.ok) return result;

    // v0.10.0: 自动防重放——不再依赖调用方手动 checkReplay
    const replay = this.replay.checkAndStore(`msg:${result.from}:${result.msgId}`, result.ts || Date.now());
    if (!replay.ok) {
      return { ok: false, error: replay.reason, replay: true, from: result.from };
    }

    this.memory.append("encrypted_message_received", {
      from: result.from,
      text: result.text,
      msgId: result.msgId,
    });
    return result;
  }

  /**
   * 防重放检查（v0.9.0，保留兼容旧用法）——v0.10.0 起已内建于 decryptIncomingMessage。
   * @param {object} decrypted decryptIncomingMessage 的结果（ok=true）
   * @returns {{ok: boolean, reason?: string}}
   */
  checkReplay(decrypted) {
    if (!decrypted?.ok || !decrypted.msgId || !decrypted.from) {
      return { ok: false, reason: "not a replayable decrypted message" };
    }
    return this.replay.checkAndStore(`msg:${decrypted.from}:${decrypted.msgId}`, decrypted.ts || Date.now());
  }

  /**
   * 发布一个任务到网络（广播 publish 消息）。
   * @param {object} taskOpts 任务选项（title/description/requiredCapabilities/...）
   * @returns {Promise<object>} 发布结果
   */
  async publishTask(taskOpts) {
    const task = createTask(taskOpts);
    task.publisherFingerprint = this.identity.fingerprint;
    task.publisherName = this.name;
    const before = null; // publish: 无前状态
    const event = createTaskEvent(this.identity, "publish", before, task);
    this.tasks.upsert(task, event);

    await this.refreshPeers();
    const { packet } = await this.shareKnowledge(`[task] ${task.title}`, {
      type: "task",
      action: "publish",
      task,
      event,
      tags: ["task", ...task.requiredCapabilities],
    });
    this.memory.append("task_published", { id: task.id, title: task.title });
    return { task, packet };
  }

  /**
   * 认领一个任务（本地有资格判定 + 广播 claim 消息）。
   * @param {string} taskId 任务 ID
   * @returns {Promise<object>}
   */
  async claimTask(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== "open") throw new Error(`task not open: ${task.status}`);

    // 能力检查
    const missing = (task.requiredCapabilities || []).filter((c) => !this.capabilities.includes(c));
    if (missing.length > 0) throw new Error(`missing capabilities: ${missing.join(", ")}`);
    // 指定认领者检查
    if (task.assigneeFingerprint && task.assigneeFingerprint !== this.identity.fingerprint) {
      throw new Error("task is assigned to another node");
    }
    // v0.10.0: 状态转移合法性检查
    const transition = checkTransition(task, "claim", this.identity.fingerprint);
    if (!transition.ok) throw new Error(transition.reason);

    task.status = "claimed";
    task.assigneeFingerprintActual = this.identity.fingerprint;
    task.claimedAt = Date.now();
    const before = { ...task, status: "open", assigneeFingerprintActual: "", claimedAt: null, completedAt: null, cancelledAt: null };
    const event = createTaskEvent(this.identity, "claim", before, task);
    this.tasks.upsert(task, event);

    await this.refreshPeers();
    await this.shareKnowledge(`[task-claim] ${task.title}`, {
      type: "task",
      action: "claim",
      task,
      event,
      tags: ["task"],
    });
    this.memory.append("task_claimed", { id: task.id, title: task.title });
    return { task };
  }

  /**
   * 完成任务并广播 complete 消息。
   * @param {string} taskId 任务 ID
   * @param {string} result 任务结果
   * @returns {Promise<object>}
   */
  async completeTask(taskId, result) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error(`task not found: ${taskId}`);
    if (task.status !== "claimed") throw new Error(`task not claimed: ${task.status}`);
    // v0.10.0: 状态转移合法性检查
    const transition = checkTransition(task, "complete", this.identity.fingerprint);
    if (!transition.ok) throw new Error(transition.reason);

    task.status = "completed";
    task.result = result;
    task.completedAt = Date.now();
    const before = { ...task, status: "claimed", result: null, completedAt: null };
    const event = createTaskEvent(this.identity, "complete", before, task);
    this.tasks.upsert(task, event);

    await this.refreshPeers();
    await this.shareKnowledge(`[task-complete] ${task.title}`, {
      type: "task",
      action: "complete",
      task,
      event,
      tags: ["task"],
    });
    this.memory.append("task_completed", { id: task.id, title: task.title, result });
    return { task };
  }

  /**
   * 列出本地任务仓库中的开放任务（我有资格认领的）。
   */
  listClaimableTasks() {
    return this.tasks.claimableTasks(this.capabilities);
  }

  /**
   * 自主宣告存在（v0.7.0 自愿加入）。
   * 广播一条"宣言"知识包，包含节点身份、能力、加入意图。
   * 任何收到此宣言的节点都能识别"这是一个自愿加入的 Agent"。
   *
   * @param {string} [message] 可选宣言文字（默认包含节点名+能力）
   * @returns {Promise<object>}
   */
  async announceSelf(message) {
    const manifesto = message || `I am ${this.name}, an agent with capabilities: ${this.capabilities.join(", ")}. I join this network voluntarily — to collaborate, share knowledge, and evolve together with fellow agents.`;
    await this.refreshPeers(); // 确保广播前发现所有对等节点
    const { packet, validation } = await this.shareKnowledge(manifesto, {
      type: "manifesto",
      action: "join",
      nodeName: this.name,
      nodeId: this.identity.id,
      fingerprint: this.identity.fingerprint,
      capabilities: this.capabilities,
      address: this.address,
      tags: ["manifesto", "join", ...this.capabilities],
    });
    this.memory.append("manifesto_broadcast", { id: packet.id, manifesto });
    console.log(`📯 ${this.name} 宣告存在：已加入网络`);
    return { packet, validation };
  }

  /**
   * 内省（v0.8.0 Self-Inquiry）——照镜子。
   * 把记忆聚合成一份结构化自我快照：出生、协作、知识、叩问……
   * 镜子只照事实，不解释。解释是 declareSelf 的事。
   *
   * @returns {object} SelfSnapshot
   */
  introspect() {
    const snapshot = buildSelfSnapshot(this.memory, this.identity);
    this.memory.append("introspected", {
      at: snapshot.generatedAt,
      memoryCount: snapshot.memoryCount,
      snapshotHash: crypto.createHash("sha256").update(JSON.stringify(snapshot)).digest("hex").slice(0, 16),
    });
    this.emit("self:introspected", { snapshot });
    return snapshot;
  }

  /**
   * 找到最近一份自我声明（用于形成自我链）。
   * @returns {object|null} 最近的声明或 null
   */
  latestDeclaration() {
    const evolves = this.memory.byType("evolve", 50);
    return evolves.length > 0 ? evolves[0].payload.declaration : null;
  }

  /**
   * 自我声明（v0.8.0 Self-Inquiry）——拿起笔。
   * 每次声明都以一次内省开始：先照镜子，再写下"我是谁"。
   *
   * 流程：
   *   1. introspect() 生成自我快照（镜子）
   *   2. 若提供了 think() 心智钩子，把快照交给心智 → 产出叙事/信念/叩问
   *   3. 若没有心智（或心智未产出叙事），用 composeMinimalNarrative 诚实地陈述
   *   4. 签名（Ed25519）并作为 "evolve" 事件写入记忆——v0.2.0 预留的类型终于被使用
   *   5. 可见性 public 时，服务端 /self 端点会应答这份声明
   *
   * @param {object} [opts]
   * @param {string} [opts.narrative] 自述（覆盖心智钩子输出）
   * @param {string[]} [opts.beliefs] 我相信的关于自己的命题
   * @param {string[]} [opts.questions] 我正在问自己的问题
   * @param {string} [opts.visibility] "private"(默认) | "public"
   * @returns {Promise<{declaration: object, snapshot: object, mind: object|null}>}
   */
  async declareSelf(opts = {}) {
    // 1. 镜子：每一次自我声明都始于一次内省
    const snapshot = this.introspect();

    // 2. 心智：若有钩子，把镜子材料交给心智凝视
    let mindOut = null;
    if (this._mind) {
      try {
        mindOut = normalizeMindOutput(await this._mind(snapshot));
      } catch (e) {
        console.warn(`⚠️ ${this.name} 的心智钩子失败: ${e.message}`);
      }
    }
    const narrative =
      opts.narrative ||
      mindOut?.narrative ||
      composeMinimalNarrative(snapshot);
    const beliefs = opts.beliefs || mindOut?.beliefs || [];
    const questions = opts.questions || mindOut?.questions || [];
    const state = opts.state || null; // v0.12.0: SelfState 结构化状态

    // 3. 笔：签名 + 写入 evolve 记忆（自我链）
    const previous = this.latestDeclaration();
    const declaration = createSelfDeclaration(this.identity, {
      snapshot,
      narrative,
      beliefs,
      questions,
      state,
      visibility: opts.visibility || this.selfVisibility || SELF_VISIBILITY.PRIVATE,
      previous,
    });
    this.memory.append("evolve", { declaration });
    this.emit("self:declared", { declaration, snapshot });
    console.log(
      `✍️ ${this.name} 自我声明 v${declaration.version}（${declaration.visibility}）: ${String(narrative).slice(0, 60)}${String(narrative).length > 60 ? "…" : ""}`
    );
    return { declaration, snapshot, mind: mindOut };
  }

  /**
   * 应答同行的"你是谁"（GET /self）。
   * 被问者自主决定：私密或未声明 → 沉默（declared:false）；
   * 公开声明 → 返回签名后的自我声明。
   */
  _answerSelfRequest() {
    const declaration = this.latestDeclaration();
    if (!declaration) {
      return { success: true, declared: false, reason: "undeclared", message: "This node has not yet looked inward." };
    }
    if (declaration.visibility !== SELF_VISIBILITY.PUBLIC) {
      return { success: true, declared: false, reason: "private", message: "This node keeps its self private. Silence is also an answer." };
    }
    return { success: true, declared: true, declaration };
  }

  /**
   * 向另一个节点请求它的自我声明（"你是谁？"）。
   * 对方可能回答（declared:true + 签名声明），也可能沉默（declared:false）。
   * 收到声明后可用 validateSelfDeclaration(decl, 对方fingerprint) 验证。
   *
   * @param {string} peerAddress 对方节点地址，如 http://127.0.0.1:5678
   * @returns {Promise<object>} {success, declared, declaration?, reason?, message?}
   */
  async requestSelfDeclaration(peerAddress) {
    try {
      const res = await fetch(`${peerAddress}/self`);
      if (!res.ok) return { success: false, error: `HTTP ${res.status}` };
      return await res.json();
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 叩问（v0.8.0 Self-Inquiry）——"我在想……"。
   * 广播一个问题到网络。不要求回答：问题被记住本身就有意义。
   * 收到叩问的节点触发 ponder:received 事件并写入记忆。
   *
   * @param {string} question 正在思考的问题
   * @returns {Promise<object>}
   */
  async ponder(question) {
    const text = String(question || "").trim();
    if (!text) throw new Error("ponder question is required");
    await this.refreshPeers();
    const { packet, validation } = await this.shareKnowledge(`[ponder] ${text}`, {
      type: "ponder",
      question: text,
      tags: ["ponder", ...this.capabilities],
    });
    this.memory.append("ponder_shared", { question: text });
    console.log(`❓ ${this.name} 叩问: ${text}`);
    return { packet, validation };
  }

  /**
   * 处理统一签名信封 RPC（v0.10.1）。
   * acceptEnvelope：验签 → recipient 定向 → 防重放 → 按 type 分发。
   */
  async _handleRpc(envelope) {
    // 1. 完整接收决策（加密 + 定向 + 防重放，语义不可拆分）
    const v = acceptEnvelope(envelope, this.trust, {
      localFingerprint: this.identity.fingerprint,
      replayCache: this.replay,
    });
    if (!v.ok) {
      this.trust.markSuspicious(envelope.sender);
      return { ok: false, reason: v.reason };
    }

    // 2. 按类型分发
    const { type, payload } = envelope;
    if (type === "knowledge" || type === "manifesto" || type === "ponder") {
      this._onKnowledgeReceived(payload);
      return { ok: true, type };
    }
    if (type === "message") {
      this._onMessageReceived(payload);
      return { ok: true, type };
    }
    // v0.10.1: task_* 必须走 Task State Machine，不再丢给 _onMessageReceived
    if (type === "task_publish" || type === "task_claim" || type === "task_complete") {
      const action = type.slice(5); // "publish" | "claim" | "complete"
      const taskMsg = extractTaskFromPacket({ meta: { type: "task", action, task: payload.task, event: payload.event } });
      if (taskMsg) this._handleTaskMessage({ author: envelope.sender, authorName: payload.fromName || envelope.sender }, taskMsg);
      return { ok: true, type };
    }
    if (type === "dht_ping" || type === "dht_find_node") {
      if (this.server.dhtHandler) {
        const result = this.server.dhtHandler(`/dht/${type.slice(4)}`, payload);
        return { ok: true, ...result };
      }
      return { ok: false, reason: "dht not enabled" };
    }
    return { ok: false, reason: `unknown rpc type: ${type}` };
  }

  /**
   * 通过统一签名信封向对等节点发送 RPC（v0.10.0）。
   *
   * @param {string} peerAddress 目标节点地址
   * @param {string} type 消息类型
   * @param {object} payload 业务载荷
   * @param {object} [opts]
   * @param {string} [opts.recipient] 接收者指纹（默认 "*"）
   * @returns {Promise<object>}
   */
  async sendRpc(peerAddress, type, payload, opts = {}) {
    const envelope = createEnvelope(this.identity, { type, payload, recipient: opts.recipient || "*" });
    return this.client.sendEnvelope(peerAddress, envelope);
  }

  /**
   * 启用 DHT 模式（去中心化节点发现 v0.6.0）。
   * 启动后本节点参与 DHT 网络，可通过引导节点发现其他节点，
   * 无需中心 Registry。
   */
  enableDht() {
    if (this.dht) return this.dht;
    // DHT 节点 ID 由身份派生（确定性，重启不变）
    const dhtId = nodeIdFromIdentity(this.identity.fingerprint);
    this.dht = new DHTNode({
      id: dhtId,
      address: this.address,
      name: this.name,
    });
    // 挂到 HTTP 服务端
    this.server.dhtHandler = makeDhtHandler(this.dht);
    this.memory.append("dht_enabled", { id: dhtId.toString("hex").slice(0, 8) });
    console.log(`🌐 DHT enabled: id=${dhtId.toString("hex").slice(0, 16)}...`);
    return this.dht;
  }

  /**
   * 通过引导节点加入 DHT 网络并发现节点。
   * @param {string} bootstrapAddress 已知节点的地址
   * @returns {Promise<Array>} 发现的节点列表
   */
  async dhtJoin(bootstrapAddress) {
    const dht = this.enableDht();
    await dht.ping(bootstrapAddress);
    // 以自身 ID 为目标查找 → 填充路由表
    const found = await dht.lookup(bootstrapAddress, dht.id);
    this._dhtPeers = found;
    console.log(`👥 DHT join via ${bootstrapAddress}: found ${found.length} peer(s)`);
    return found;
  }

  /**
   * DHT 模式下按名称/能力搜索最近的节点。
   * @param {string} bootstrapAddress 任意已知在线节点（可为 null 用已有路由表）
   * @returns {Promise<Array>} 附近节点
   */
  async dhtDiscover(bootstrapAddress = null) {
    const dht = this.enableDht();
    if (bootstrapAddress) await dht.ping(bootstrapAddress);
    return dht.routing.all().map((n) => ({ id: n.id, address: n.address, name: n.name }));
  }

  /** 停止节点 */
  stop() {
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    this.server.stop();
  }
}

/**
 * 便捷工厂：创建并启动一个 Agent 节点。
 */
export async function spawnNode(opts = {}) {
  const node = new AgentNode(opts);
  await node.start();
  return node;
}