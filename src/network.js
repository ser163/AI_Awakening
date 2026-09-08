/**
 * network.js — 节点间通信网络层 (v0.9.0)
 *
 * v0.9.0 Trust Layer 改动：
 *   1. Registry 注册需要签名证明（节点用私钥签名注册载荷）——防身份冒注
 *   2. Registry 存储并分发 publicKey —— 节点可据此建立 TrustedIdentityStore
 *   3. Agent Card 提交签名绑定（card 的 fingerprint 必须等于注册者身份）
 *   4. 心跳签名认证 + 防重放（ts + nonce）
 *   5. RequestGuard：body 上限 / JSON 解析隔离 / 速率限制，Server 与 Registry 共用
 *
 * 每个节点可同时作为 HTTP 服务端（接收请求）和客户端（发起请求）。
 */
import http from "node:http";
import { EventEmitter } from "node:events";
import { publicKeyMatchesFingerprint } from "./identity.js";
import { RequestGuard, ReplayCache, createSignedRequest, verifySignedRequest } from "./trust.js";

const REGISTRY_DEFAULT_PORT = 8672;
const NODE_DEFAULT_PORT = 0; // OS 分配
const PROTOCOL_VERSION = "0.9.0";

/**
 * 节点注册表服务（签名认证的轻量级中心化发现层）。
 *
 * 信任锚点：注册时节点提交 publicKey + fingerprint + 签名证明，
 * Registry 验证 fingerprint == SHA-256(publicKey) 且签名有效，
 * 然后才把该身份及其公钥登记、广播。其他节点从 Registry 学到公钥，
 * 建立自己的 TrustedIdentityStore。
 */
export class Registry {
  constructor(port = REGISTRY_DEFAULT_PORT) {
    this.port = port;
    this.nodes = new Map(); // nodeId -> {name, fingerprint, publicKey, xPublicKey, address, capabilities, lastSeen}
    this.nodeCards = new Map(); // nodeId -> Agent Card
    this.server = null;
    this.guard = new RequestGuard({ maxBodyBytes: 512 * 1024, rateLimit: 600 });
    this.replay = new ReplayCache({ ttlMs: 5 * 60 * 1000 });
  }

  start() {
    return new Promise((resolve) => {
      const handler = this.guard.wrap(async (req, res, body, send) => {
        const url = new URL(req.url, `http://localhost:${this.port}`);
        const path = url.pathname;

        if (req.method === "POST" && path === "/register") {
          // 签名注册：节点证明自己持有与 fingerprint 绑定的私钥
          const reg = body?.payload;
          if (!reg || !reg.id || !reg.fingerprint || !reg.publicKey || !reg.address) {
            return send(400, { error: "missing registration fields" });
          }
          if (reg.id !== reg.fingerprint || !publicKeyMatchesFingerprint(reg.publicKey, reg.fingerprint)) {
            return send(400, { error: "fingerprint does not match publicKey" });
          }
          const v = verifySignedRequest(body, reg.publicKey);
          if (!v.ok) return send(401, { error: `registration signature invalid: ${v.reason}` });

          // 防重放（同一 nonce 重复提交）
          const replayKey = `register:${reg.fingerprint}:${body.nonce}`;
          if (!this.replay.checkAndStore(replayKey, body.ts).ok) {
            return send(401, { error: "registration replay rejected" });
          }

          this.nodes.set(reg.id, {
            ...reg,
            lastSeen: Date.now(),
          });
          return send(200, { success: true, count: this.nodes.size });
        } else if (req.method === "GET" && path === "/nodes") {
          const list = Array.from(this.nodes.entries()).map(([id, n]) => ({
            id, name: n.name, fingerprint: n.fingerprint,
            publicKey: n.publicKey, xPublicKey: n.xPublicKey || "",
            capabilities: n.capabilities, address: n.address,
            lastSeen: n.lastSeen,
          }));
          return send(200, { success: true, nodes: list, count: list.length });
        } else if (req.method === "GET" && path.startsWith("/nodes/")) {
          const nodeId = path.slice(7);
          const n = this.nodes.get(nodeId);
          if (n) return send(200, { success: true, node: n });
          return send(404, { error: "node not found" });
        } else if (req.method === "POST" && path === "/heartbeat") {
          // 签名心跳：用注册时登记的公钥验证
          const hb = body?.payload;
          const stored = hb && this.nodes.get(hb.id);
          if (!stored) return send(404, { error: "unknown node, register first" });
          const v = verifySignedRequest(body, stored.publicKey);
          if (!v.ok) return send(401, { error: `heartbeat signature invalid: ${v.reason}` });
          const replayKey = `hb:${hb.id}:${body.nonce}`;
          if (!this.replay.checkAndStore(replayKey, body.ts).ok) {
            return send(401, { error: "heartbeat replay rejected" });
          }
          stored.lastSeen = Date.now();
          return send(200, { success: true });
        } else if (req.method === "POST" && path === "/agent-card") {
          // 签名提交 Agent Card：card 的 fingerprint 必须等于注册者身份
          const card = body?.payload?.card;
          const fp = card?.extensions?.fingerprint;
          const stored = fp && this.nodes.get(fp);
          if (!stored) return send(404, { error: "unknown node, register first" });
          const v = verifySignedRequest(body, stored.publicKey);
          if (!v.ok) return send(401, { error: `agent-card signature invalid: ${v.reason}` });
          const replayKey = `card:${fp}:${body.nonce}`;
          if (!this.replay.checkAndStore(replayKey, body.ts).ok) {
            return send(401, { error: "agent-card replay rejected" });
          }
          // 服务端把可信公钥附加到 card（供发现方学习身份）
          if (!card.extensions.publicKey) card.extensions.publicKey = stored.publicKey;
          this.nodeCards.set(card.extensions.nodeId || fp, card);
          return send(200, { success: true, count: this.nodeCards.size });
        } else if (req.method === "GET" && path === "/agent-cards") {
          const cap = url.searchParams.get("capability");
          const cards = Array.from(this.nodeCards.entries()).map(([, c]) => c);
          const filtered = cap
            ? cards.filter((c) => (c.skills || []).some((s) => s.name.toLowerCase() === cap.toLowerCase() || s.id.toLowerCase() === cap.toLowerCase()))
            : cards;
          return send(200, { success: true, cards: filtered, count: filtered.length, capability: cap || null });
        }
        return send(404, { error: "not found" });
      });

      this.server = http.createServer(handler);
      this.server.listen(this.port, () => {
        const addr = this.server.address();
        this.port = typeof addr === "object" ? addr.port : this.port;
        console.log(`🧬 Registry running on port ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}

/**
 * 节点 HTTP 客户端——向注册表注册、发现其他节点、发送消息。
 * 注册/心跳/Agent Card 提交均带签名（v0.9.0）。
 */
export class NodeClient {
  /**
   * @param {string} registryUrl 注册表 URL
   * @param {object} [identity]  本节点身份（签名操作需要）；可在构造后设置
   */
  constructor(registryUrl, identity = null) {
    this.registryUrl = registryUrl;
    this.identity = identity;
  }

  /** 签名注册 */
  async register(identity, name, fingerprint, capabilities, address, extra = {}) {
    const payload = {
      id: identity.id || fingerprint,
      name,
      fingerprint,
      publicKey: identity.publicKey,
      xPublicKey: identity.xPublicKey || "",
      address,
      capabilities,
      ...extra,
    };
    const req = createSignedRequest(identity, payload);
    const res = await fetch(`${this.registryUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    return res.json();
  }

  async discoverNodes() {
    const res = await fetch(`${this.registryUrl}/nodes`);
    return res.json();
  }

  /** 签名心跳 */
  async heartbeat(id) {
    try {
      const identity = this.identity;
      if (!identity) return { success: false, error: "no identity for signed heartbeat" };
      const req = createSignedRequest(identity, { id });
      await fetch(`${this.registryUrl}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
    } catch { /* 注册表离线时静默失败 */ }
  }

  /**
   * 向另一个节点发送消息（直接通信，不经过注册表）。
   */
  async sendToNode(address, endpoint, payload) {
    const res = await fetch(`${address}${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    return res.json();
  }

  /**
   * v0.10.0: 发送统一签名信封 RPC（/rpc 端点）。
   * 所有节点间 RPC 应优先走这里，而不是直接 POST 明文端点。
   *
   * @param {string} address 目标节点地址
   * @param {object} envelope 签名信封（createEnvelope 产物）
   * @returns {Promise<object>} {success, ...} 或 {error}
   */
  async sendEnvelope(address, envelope) {
    try {
      const res = await fetch(`${address}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(envelope),
      });
      const data = await res.json();
      return { httpStatus: res.status, ...data };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }

  /**
   * 将本节点的 Agent Card 签名注册到注册表（A2A 发现层）。
   */
  async registerAgentCard(card) {
    const identity = this.identity;
    if (!identity) return { success: false, error: "no identity for signed card" };
    const req = createSignedRequest(identity, { card });
    const res = await fetch(`${this.registryUrl}/agent-card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    return res.json();
  }

  /**
   * 按能力查询已注册的 Agent Cards。
   * @param {string} [capability] 能力名（可选，不传返回全部）
   */
  async discoverByCapability(capability) {
    const q = capability ? `?capability=${encodeURIComponent(capability)}` : "";
    const res = await fetch(`${this.registryUrl}/agent-cards${q}`);
    return res.json();
  }

  /**
   * 直接从一个节点的 `/.well-known/agent.json` 拉取其 Agent Card（A2A 标准）。
   */
  async fetchAgentCard(address) {
    const res = await fetch(`${address}/.well-known/agent.json`);
    if (!res.ok) return null;
    return res.json();
  }
}

/**
 * 节点 HTTP 服务端——接收其他节点的消息（RequestGuard 防护）。
 */
export class NodeServer extends EventEmitter {
  constructor(port = NODE_DEFAULT_PORT) {
    super();
    this.port = port;
    this.server = null;
    this.agentCard = null; // A2A Agent Card（由节点注入）
    this.dhtHandler = null; // DHT RPC 处理器（由节点注入）
    this.selfHandler = null; // 自我声明应答器（v0.8.0，由节点注入）
    this.rpcHandler = null; // 统一签名信封处理器（v0.10.0，由节点注入）
    this.guard = new RequestGuard({ maxBodyBytes: 512 * 1024, rateLimit: 600 });
  }

  start() {
    return new Promise((resolve) => {
      const handler = this.guard.wrap(async (req, res, body, send) => {
        const url = new URL(req.url, `http://localhost:${this.port}`);
        const path = url.pathname;

        if (req.method === "POST" && path === "/rpc") {
          // v0.10.0: 统一签名信封入口——所有节点间 RPC 走这里。
          // body = SignedEnvelope {protocol, version, type, sender, recipient, timestamp, nonce, requestId, payload, signature}
          // 验签/防重放由 AgentNode 注入的 rpcHandler 完成。
          if (!this.rpcHandler) return send(404, { error: "rpc not enabled" });
          const result = await this.rpcHandler(body);
          if (result?.ok) return send(200, { success: true, ...result });
          return send(401, { error: result?.reason || "rpc rejected" });
        } else if (req.method === "POST" && path === "/knowledge") {
          this.emit("knowledge", body);
          return send(200, { success: true, received: true });
        } else if (req.method === "POST" && path === "/task") {
          this.emit("task", body);
          return send(200, { success: true, received: true });
        } else if (req.method === "POST" && path === "/message") {
          this.emit("message", body);
          return send(200, { success: true, received: true });
        } else if (req.method === "GET" && path === "/status") {
          return send(200, { success: true, status: "active", protocol: PROTOCOL_VERSION });
        } else if (req.method === "GET" && path === "/.well-known/agent.json") {
          if (this.agentCard) return send(200, this.agentCard);
          return send(404, { error: "agent card not configured" });
        } else if (req.method === "GET" && path === "/self") {
          // v0.8.0 自我声明端点——同行问"你是谁"。
          if (this.selfHandler) return send(200, this.selfHandler());
          return send(200, { success: true, declared: false, reason: "undeclared", message: "This node has not yet looked inward." });
        } else if ((req.method === "POST") && (path === "/dht/ping" || path === "/dht/find_node")) {
          if (this.dhtHandler) {
            const result = this.dhtHandler(path, body);
            if (result) return send(200, result);
            return send(404, { error: "unknown dht rpc" });
          }
          return send(404, { error: "dht not enabled" });
        }
        return send(404, { error: "not found" });
      });

      this.server = http.createServer(handler);
      this.server.listen(this.port, () => {
        const addr = this.server.address();
        this.port = addr.port;
        console.log(`🔗 Node server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  stop() {
    if (this.server) this.server.close();
  }
}