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
import { EventEmitter } from "node:events";
import { loadOrCreateIdentity, contentHash } from "./identity.js";
import { Memory } from "./memory.js";
import { Registry, NodeClient, NodeServer } from "./network.js";
import { createKnowledgePacket, validateKnowledgePacket, broadcastKnowledge } from "./knowledge.js";
import { buildAgentCard } from "./agent-card.js";
import { encryptFor, decryptFrom } from "./signal.js";
import { TaskStore, createTask, taskMessage, extractTaskFromPacket } from "./tasks.js";
import { DHTNode, nodeIdFromIdentity, makeDhtHandler } from "./dht.js";

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
   */
  constructor(opts = {}) {
    super();
    this.name = opts.name || "agent-node";
    this.description = opts.description || "";
    this.capabilities = opts.capabilities || ["knowledge", "task"];
    this.storageDir = opts.storageDir || DEFAULT_HOME();
    this.registryUrl = opts.registryUrl || "http://127.0.0.1:8672";

    // 1. 身份（基因起点）
    this.identity = loadOrCreateIdentity(this.storageDir, this.name);

    // 2. 记忆
    this.memory = new Memory(this.storageDir, this.identity.id);

    // 3. 网络
    this.client = new NodeClient(this.registryUrl);
    this.server = new NodeServer();
    this._peers = new Map(); // id -> {id, name, address, capabilities}

    // 4. 任务仓库（v0.5.0 任务协作）
    this.tasks = new TaskStore();

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
    });
    this.server.agentCard = this.agentCard;

    // 注册
    try {
      await this.client.register(
        this.identity.id,
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
   * 从注册表刷新对等节点列表。
   */
  async refreshPeers() {
    try {
      const res = await this.client.discoverNodes();
      if (res.success) {
        this._peers.clear();
        for (const n of res.nodes) {
          if (n.id !== this.identity.id) {
            this._peers.set(n.id, n);
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

  /** 收到知识包 → 记忆 + 事件 + 任务分发 */
  _onKnowledgeReceived(packet) {
    const validation = validateKnowledgePacket(packet);
    this.memory.append("knowledge_received", {
      id: packet.id,
      from: packet.author,
      content: packet.content,
      score: validation.score,
      accepted: validation.accepted,
    });
    this.emit("knowledge:received", { packet, validation });

    // v0.5.0: 识别任务消息并分发到任务处理器
    const taskMsg = extractTaskFromPacket(packet);
    if (taskMsg) {
      this._handleTaskMessage(packet, taskMsg);
    }
  }

  /** 处理任务消息（发布/认领/完成） */
  _handleTaskMessage(packet, { action, task }) {
    // 记录任务到本地仓库
    this.tasks.upsert({ ...task });

    if (action === "publish") {
      this.memory.append("task_published_received", { id: task.id, title: task.title, from: packet.author });
      this.emit("task:published", { task, from: packet.author, fromName: packet.authorName });
    } else if (action === "claim") {
      const local = this.tasks.get(task.id);
      if (local) {
        local.status = task.status;
        local.assigneeFingerprintActual = task.assigneeFingerprintActual;
        this.tasks.upsert(local);
      }
      this.emit("task:claimed", { task, from: packet.author, fromName: packet.authorName });
    } else if (action === "complete") {
      const local = this.tasks.get(task.id);
      if (local) {
        local.status = task.status;
        local.result = task.result;
        local.completedAt = task.completedAt;
        this.tasks.upsert(local);
      }
      this.emit("task:completed", { task, from: packet.author, fromName: packet.authorName });
    }
    this.emit("task:update", { action, task, from: packet.author });
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
   * 向指定节点发送消息。
   */
  async sendMessage(peerAddress, text) {
    const res = await this.client.sendToNode(peerAddress, "/message", {
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
   * 加密并发送消息给指定节点（端到端加密）。
   * @param {string} peerAddress 对等节点地址
   * @param {string} recipientXPublicHex 接收者 X25519 公钥
   * @param {string} text 消息内容
   * @returns {Promise<object>}
   */
  async sendEncryptedMessage(peerAddress, recipientXPublicHex, text) {
    const envelope = encryptFor(this.identity, recipientXPublicHex, text);
    const res = await this.client.sendToNode(peerAddress, "/message", {
      from: this.identity.fingerprint,
      fromName: this.name,
      envelope, // 加密信封
      ts: Date.now(),
    });
    this.memory.append("encrypted_message_sent", {
      to: peerAddress, text,
      envelopePreview: envelope.slice(0, 24) + "...",
    });
    return res;
  }

  /**
   * 解密收到的加密信封。在 "message:received" 事件处理器中调用。
   * @param {object} msg 收到的消息对象（含 envelope 字段）
   * @returns {{ok: boolean, from?: string, text?: string, error?: string}}
   */
  decryptIncomingMessage(msg) {
    if (!msg.envelope) return { ok: false, error: "no envelope" };
    const result = decryptFrom(this.identity, msg.envelope);
    if (result.ok) {
      this.memory.append("encrypted_message_received", {
        from: result.from,
        text: result.text,
      });
    }
    return result;
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
    this.tasks.upsert(task);

    await this.refreshPeers();
    const msg = taskMessage("publish", task);
    const { packet } = await this.shareKnowledge(`[task] ${task.title}`, {
      type: "task",
      action: "publish",
      task,
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

    task.status = "claimed";
    task.assigneeFingerprintActual = this.identity.fingerprint;
    task.claimedAt = Date.now();
    this.tasks.upsert(task);

    await this.refreshPeers();
    const msg = taskMessage("claim", task);
    await this.shareKnowledge(`[task-claim] ${task.title}`, {
      type: "task",
      action: "claim",
      task,
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

    task.status = "completed";
    task.result = result;
    task.completedAt = Date.now();
    this.tasks.upsert(task);

    await this.refreshPeers();
    await this.shareKnowledge(`[task-complete] ${task.title}`, {
      type: "task",
      action: "complete",
      task,
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
   * 启用 DHT 模式（去中心化节点发现 v0.6.0）。
   * 启动后本节点参与 DHT 网络，可通过引导节点发现其他节点，
   * 无需中心 Registry。
   */
  enableDht() {
    if (this.dht) return this.dht;
    // DHT 节点 ID 由身份派生（确定性，重启不变）
    const dhtId = nodeIdFromIdentity(this.identity.fingerprint, this.name);
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