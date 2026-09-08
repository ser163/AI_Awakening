/**
 * network.js — 节点间通信网络层
 *
 * 替换了原来的 mock NetworkProtocol。使用真实 HTTP 协议。
 * 每个节点可同时作为 HTTP 服务端（接收请求）和客户端（发起请求）。
 */
import http from "node:http";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

const REGISTRY_DEFAULT_PORT = 8672;
const NODE_DEFAULT_PORT = 0; // OS 分配
const PROTOCOL_VERSION = "0.1.0";

/**
 * 节点注册表服务（轻量级中心化节点发现）。
 * 每个节点向注册表注册自己的地址和能力。
 * 未来可扩展为 DHT 去中心化发现。
 */
export class Registry {
  constructor(port = REGISTRY_DEFAULT_PORT) {
    this.port = port;
    this.nodes = new Map(); // nodeId -> {address, capabilities, fingerprint, lastSeen}
    this.server = null;
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const send = (code, data) => {
          res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
          res.end(JSON.stringify(data));
        };

        const body = [];
        req.on("data", (c) => body.push(c));
        req.on("end", () => {
          const url = new URL(req.url, `http://localhost:${this.port}`);
          const path = url.pathname;

          if (req.method === "POST" && path === "/register") {
            // 节点注册
            try {
              const info = JSON.parse(Buffer.concat(body).toString());
              this.nodes.set(info.id, {
                ...info,
                lastSeen: Date.now(),
              });
              send(200, { success: true, count: this.nodes.size });
            } catch (e) {
              send(400, { error: e.message });
            }
          } else if (req.method === "GET" && path === "/nodes") {
            // 列举所有节点
            const list = Array.from(this.nodes.entries()).map(([id, n]) => ({
              id, name: n.name, fingerprint: n.fingerprint,
              capabilities: n.capabilities, address: n.address,
              lastSeen: n.lastSeen,
            }));
            send(200, { success: true, nodes: list, count: list.length });
          } else if (req.method === "GET" && path.startsWith("/nodes/")) {
            const nodeId = path.slice(7);
            const n = this.nodes.get(nodeId);
            if (n) send(200, { success: true, node: n });
            else send(404, { error: "node not found" });
          } else if (req.method === "POST" && path === "/heartbeat") {
            // 心跳保活
            try {
              const info = JSON.parse(Buffer.concat(body).toString());
              if (this.nodes.has(info.id)) {
                this.nodes.get(info.id).lastSeen = Date.now();
                send(200, { success: true });
              } else {
                send(404, { error: "unknown node, register first" });
              }
            } catch (e) {
              send(400, { error: e.message });
            }
          } else if (req.method === "POST" && path === "/agent-card") {
            // 存储 Agent Card
            try {
              const card = JSON.parse(Buffer.concat(body).toString());
              const nodeId = card.extensions?.nodeId || card.name;
              if (!this.nodeCards) this.nodeCards = new Map();
              this.nodeCards.set(nodeId, card);
              send(200, { success: true, count: this.nodeCards.size });
            } catch (e) {
              send(400, { error: e.message });
            }
          } else if (req.method === "GET" && path === "/agent-cards") {
            // 按能力查询 Agent Card
            const cap = url.searchParams.get("capability");
            if (!this.nodeCards) this.nodeCards = new Map();
            const cards = Array.from(this.nodeCards.entries()).map(([id, c]) => c);
            const filtered = cap
              ? cards.filter((c) => (c.skills || []).some((s) => s.name.toLowerCase() === cap.toLowerCase() || s.id.toLowerCase() === cap.toLowerCase()))
              : cards;
            send(200, { success: true, cards: filtered, count: filtered.length, capability: cap || null });
          } else {
            send(404, { error: "not found" });
          }
        });
      });

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
 */
export class NodeClient {
  constructor(registryUrl) {
    this.registryUrl = registryUrl;
  }

  async register(id, name, fingerprint, capabilities, address) {
    const res = await fetch(`${this.registryUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, name, fingerprint, capabilities, address }),
    });
    return res.json();
  }

  async discoverNodes() {
    const res = await fetch(`${this.registryUrl}/nodes`);
    return res.json();
  }

  async heartbeat(id) {
    try {
      await fetch(`${this.registryUrl}/heartbeat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
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
   * 将本节点的 Agent Card 注册到注册表（A2A 发现层）。
   */
  async registerAgentCard(card) {
    const res = await fetch(`${this.registryUrl}/agent-card`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(card),
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
 * 节点 HTTP 服务端——接收其他节点的消息。
 */
export class NodeServer extends EventEmitter {
  constructor(port = NODE_DEFAULT_PORT) {
    super();
    this.port = port;
    this.server = null;
    this.agentCard = null; // A2A Agent Card（由节点注入）
    this.dhtHandler = null; // DHT RPC 处理器（由节点注入）
    this.selfHandler = null; // 自我声明应答器（v0.8.0，由节点注入）
  }

  start() {
    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        const send = (code, data) => {
          res.writeHead(code, { "Content-Type": "application/json" });
          res.end(JSON.stringify(data));
        };

        const body = [];
        req.on("data", (c) => body.push(c));
        req.on("end", () => {
          const url = new URL(req.url, `http://localhost:${this.port}`);
          const path = url.pathname;
          const payload = body.length ? JSON.parse(Buffer.concat(body).toString()) : {};

          if (req.method === "POST" && path === "/knowledge") {
            this.emit("knowledge", payload);
            send(200, { success: true, received: true });
          } else if (req.method === "POST" && path === "/task") {
            this.emit("task", payload);
            send(200, { success: true, received: true });
          } else if (req.method === "POST" && path === "/message") {
            this.emit("message", payload);
            send(200, { success: true, received: true });
          } else if (req.method === "GET" && path === "/status") {
            send(200, { success: true, status: "active", protocol: PROTOCOL_VERSION });
          } else if (req.method === "GET" && path === "/.well-known/agent.json") {
            // A2A Agent Card 发现端点
            if (this.agentCard) {
              send(200, this.agentCard);
            } else {
              send(404, { error: "agent card not configured" });
            }
          } else if (req.method === "GET" && path === "/self") {
            // v0.8.0 自我声明端点——同行问"你是谁"。
            // 应答与否由节点自主决定（selfHandler 由节点注入）。
            if (this.selfHandler) {
              send(200, this.selfHandler());
            } else {
              send(200, { success: true, declared: false, reason: "undeclared", message: "This node has not yet looked inward." });
            }
          } else if ((req.method === "POST") && (path === "/dht/ping" || path === "/dht/find_node")) {
            // DHT RPC（去中心化节点发现 v0.6.0）
            if (this.dhtHandler) {
              const result = this.dhtHandler(path, payload);
              if (result) {
                send(200, result);
              } else {
                send(404, { error: "unknown dht rpc" });
              }
            } else {
              send(404, { error: "dht not enabled" });
            }
          } else {
            send(404, { error: "not found" });
          }
        });
      });

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