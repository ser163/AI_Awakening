/**
 * trust.js — 信任层 (v0.9.0)
 *
 * AI_Awakening 的网络"物理定律"。核心问题：
 *   "我凭什么相信这条消息真的来自它所声称的那个 Agent？"
 *
 * 信任链（无中心 PKI，靠注册表/对等节点逐步学习）：
 *
 *   Node Identity (Ed25519 publicKey)
 *        │  fingerprint = SHA-256(publicKey)  (完整 64 hex)
 *        ▼
 *   TrustedIdentityStore   —— 本节点学到的可信身份表
 *        │  从注册表注册响应、对等发现、直接交换中学习
 *        ▼
 *   Knowledge Packet / Message .author (fingerprint)
 *        │  查 TrustedIdentityStore → 得到公钥
 *        ▼
 *   fingerprint(publicKey) === author ?  —— 公钥与身份绑定
 *        ▼
 *   verifySignature(publicKey, payload, sig) —— 内容真实
 *        ▼
 *   ReplayCache 检查 —— 不是重放
 *        ▼
 *   ACCEPT  /  REJECT
 *
 * 规则（不可协商）：
 *   没有可信公钥          → REJECT
 *   fingerprint != hash   → REJECT
 *   签名无效              → REJECT
 *   重放                  → REJECT
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { sign, verifySignature, publicKeyMatchesFingerprint } from "./identity.js";

/** 信任状态 */
export const TRUST_STATE = {
  /** 新鲜学习：公钥与指纹自洽，但尚未深度交互 */
  LEARNED: "learned",
  /** 已验证：公钥在注册表注册/对等交换中确认 */
  VERIFIED: "verified",
  /** 可疑：曾发送无效消息 */
  SUSPICIOUS: "suspicious",
  /** 已撤销：不再信任 */
  REVOKED: "revoked",
};

/**
 * TrustedIdentityStore —— 身份 → 公钥 的可信映射。
 * 每个节点维护一份。支持从文件加载/保存（信任跨会话延续）。
 */
export class TrustedIdentityStore {
  /**
   * @param {string} [storageDir] 持久化目录（可选；不传则仅内存）
   */
  constructor(storageDir = null) {
    this.storageDir = storageDir;
    this.file = storageDir ? path.join(storageDir, "trust", "identities.json") : null;
    this.identities = new Map(); // fingerprint -> {publicKey, xPublicKey, name, firstSeen, lastSeen, state, address}
    this._load();
  }

  _load() {
    if (!this.file) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      for (const [fp, rec] of Object.entries(raw.identities || {})) {
        this.identities.set(fp, rec);
      }
    } catch {
      /* 首次运行无文件 */
    }
  }

  _save() {
    if (!this.file) return;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const out = { identities: Object.fromEntries(this.identities) };
      fs.writeFileSync(this.file, JSON.stringify(out, null, 2));
    } catch {
      /* 持久化失败不致命 */
    }
  }

  /**
   * 学习一个身份：从注册表注册、对等发现、或直接交换。
   * 公钥与指纹必须自洽，否则拒绝学习（防身份投毒）。
   *
   * @param {string} fingerprint 声称的身份指纹（64 hex）
   * @param {string} publicKey Ed25519 公钥 (spki-der-hex)
   * @param {object} [opts]
   * @param {string} [opts.xPublicKey] X25519 公钥
   * @param {string} [opts.name]
   * @param {string} [opts.address]
   * @param {string} [opts.source] "registry" | "peer" | "direct"
   * @returns {{learned: boolean, reason?: string}}
   */
  learn(fingerprint, publicKey, opts = {}) {
    if (!fingerprint || !publicKey) return { learned: false, reason: "missing fingerprint or publicKey" };
    // 关键：公钥必须哈希到声明的指纹——否则任何人可声称任意身份
    if (!publicKeyMatchesFingerprint(publicKey, fingerprint)) {
      return { learned: false, reason: "publicKey does not match fingerprint (identity spoof attempt?)" };
    }

    const now = Date.now();
    const existing = this.identities.get(fingerprint);
    if (existing) {
      // 已有记录：公钥必须一致，否则拒绝（防密钥轮换投毒；轮换走显式协议）
      if (existing.publicKey !== publicKey) {
        return { learned: false, reason: "publicKey conflict with existing trusted identity" };
      }
      existing.lastSeen = now;
      existing.address = opts.address || existing.address;
      existing.xPublicKey = opts.xPublicKey || existing.xPublicKey;
      if (existing.state === TRUST_STATE.LEARNED && opts.source === "registry") existing.state = TRUST_STATE.VERIFIED;
      this._save();
      return { learned: true, state: existing.state };
    }

    const rec = {
      fingerprint,
      publicKey,
      xPublicKey: opts.xPublicKey || "",
      name: opts.name || "",
      address: opts.address || "",
      source: opts.source || "peer",
      state: opts.source === "registry" ? TRUST_STATE.VERIFIED : TRUST_STATE.LEARNED,
      firstSeen: now,
      lastSeen: now,
    };
    this.identities.set(fingerprint, rec);
    this._save();
    return { learned: true, state: rec.state };
  }

  /** 查询公钥（没有 → null） */
  getPublicKey(fingerprint) {
    const rec = this.identities.get(fingerprint);
    if (!rec || rec.state === TRUST_STATE.REVOKED) return null;
    return rec.publicKey;
  }

  /** 查询完整记录 */
  get(fingerprint) {
    const rec = this.identities.get(fingerprint);
    if (rec && rec.state === TRUST_STATE.REVOKED) return null;
    return rec || null;
  }

  /** 是否已信任该身份 */
  isTrusted(fingerprint) {
    return this.getPublicKey(fingerprint) !== null;
  }

  /** 标记可疑（收到无效消息时） */
  markSuspicious(fingerprint) {
    const rec = this.identities.get(fingerprint);
    if (rec && rec.state !== TRUST_STATE.REVOKED) {
      rec.state = TRUST_STATE.SUSPICIOUS;
      this._save();
    }
  }

  /** 撤销身份（显式撤销/轮换） */
  revoke(fingerprint) {
    const rec = this.identities.get(fingerprint);
    if (rec) {
      rec.state = TRUST_STATE.REVOKED;
      this._save();
      return true;
    }
    return false;
  }

  /** 全部可信身份 */
  all() {
    return Array.from(this.identities.values()).filter((r) => r.state !== TRUST_STATE.REVOKED);
  }

  /** 数量 */
  size() {
    return this.all().length;
  }
}

/**
 * ReplayCache —— 防重放攻击。
 * 记录已处理的消息 ID；重复出现 → 拒绝。
 * 带 TTL 清理，防止无限增长。
 */
export class ReplayCache {
  /**
   * @param {object} [opts]
   * @param {number} [opts.ttlMs] 消息有效窗口（默认 5 分钟）
   * @param {number} [opts.maxEntries] 缓存上限（默认 10000）
   */
  constructor({ ttlMs = 5 * 60 * 1000, maxEntries = 10000 } = {}) {
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this._seen = new Map(); // key -> ts
  }

  /**
   * 检查并记录一个消息。
   * @param {string} key 消息唯一键（建议 `${senderFingerprint}:${messageId}`）
   * @param {number} [ts] 消息时间戳
   * @returns {{ok: boolean, reason?: string}}
   */
  checkAndStore(key, ts = Date.now()) {
    if (!key) return { ok: false, reason: "missing replay key" };

    // 时间窗口外 → 拒绝（过期或来自未来）
    const now = Date.now();
    if (ts < now - this.ttlMs) return { ok: false, reason: "message expired (outside replay window)" };
    if (ts > now + this.ttlMs) return { ok: false, reason: "message from the future" };

    if (this._seen.has(key)) return { ok: false, reason: "duplicate message (replay)" };

    // 超限清理：删除最旧的 1/4
    if (this._seen.size >= this.maxEntries) {
      const entries = Array.from(this._seen.entries()).sort((a, b) => a[1] - b[1]);
      const drop = Math.floor(this.maxEntries / 4);
      for (let i = 0; i < drop && i < entries.length; i++) this._seen.delete(entries[i][0]);
    }
    this._seen.set(key, ts);
    return { ok: true };
  }

  /** 清理过期条目 */
  prune() {
    const cutoff = Date.now() - this.ttlMs;
    for (const [k, ts] of this._seen) {
      if (ts < cutoff) this._seen.delete(k);
    }
  }

  /** 当前缓存大小 */
  size() {
    return this._seen.size;
  }
}

/**
 * 生成一个签名请求体（用于注册表注册/心跳/Agent Card 提交）。
 * 结构：{ payload, ts, nonce, signature }
 * 签名覆盖 {payload, ts, nonce} —— 接收方可验证"这是持有私钥的节点本人"。
 *
 * @param {object} identity 节点身份
 * @param {object} payload 业务载荷
 * @returns {{payload: object, ts: number, nonce: string, signature: string}}
 */
export function createSignedRequest(identity, payload) {
  const ts = Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const canonical = JSON.stringify({ payload, ts, nonce });
  return { payload, ts, nonce, signature: sign(identity, canonical) };
}

/**
 * 验证签名请求体。
 * @param {object} req {payload, ts, nonce, signature}
 * @param {string} publicKeyHex 声称的发送者 Ed25519 公钥
 * @param {object} [opts]
 * @param {number} [opts.windowMs] 时间窗口（默认 5 分钟）
 * @returns {{ok: boolean, reason?: string}}
 */
export function verifySignedRequest(req, publicKeyHex, { windowMs = 5 * 60 * 1000 } = {}) {
  if (!req || !req.payload || !req.signature || !req.ts || !req.nonce) {
    return { ok: false, reason: "malformed signed request" };
  }
  // 重放窗口
  const drift = Math.abs(Date.now() - req.ts);
  if (drift > windowMs) return { ok: false, reason: "request timestamp outside window" };

  const canonical = JSON.stringify({ payload: req.payload, ts: req.ts, nonce: req.nonce });
  if (!verifySignature(publicKeyHex, canonical, req.signature)) {
    return { ok: false, reason: "invalid signature" };
  }
  return { ok: true };
}

/**
 * RequestGuard —— HTTP 请求防护。
 * 统一处理：body 大小限制、JSON 解析隔离、超时、速率限制。
 * 给 NodeServer 和 Registry 共用的安全基线。
 */
export class RequestGuard {
  /**
   * @param {object} [opts]
   * @param {number} [opts.maxBodyBytes] body 上限（默认 256 KB）
   * @param {number} [opts.rateLimit] 每 IP 每分钟最大请求数（默认 300）
   */
  constructor({ maxBodyBytes = 256 * 1024, rateLimit = 300 } = {}) {
    this.maxBodyBytes = maxBodyBytes;
    this.rateLimit = rateLimit;
    this._hits = new Map(); // ip -> {count, windowStart}
  }

  /** 速率限制检查（每 IP 滑动窗口） */
  _checkRate(ip) {
    const now = Date.now();
    const rec = this._hits.get(ip);
    if (!rec || now - rec.windowStart > 60_000) {
      this._hits.set(ip, { count: 1, windowStart: now });
      return { ok: true };
    }
    rec.count++;
    if (rec.count > this.rateLimit) {
      return { ok: false, reason: "rate limit exceeded" };
    }
    // 防止 map 无限膨胀：定期清理
    if (this._hits.size > 1000) {
      for (const [k, v] of this._hits) {
        if (now - v.windowStart > 60_000) this._hits.delete(k);
      }
    }
    return { ok: true };
  }

  /**
   * 读取并安全解析请求 body。
   * @returns {Promise<{ok: boolean, body?: object, reason?: string, code?: number}>}
   */
  readJsonBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let aborted = false;

      req.on("data", (c) => {
        if (aborted) return;
        size += c.length;
        if (size > this.maxBodyBytes) {
          aborted = true;
          resolve({ ok: false, code: 413, reason: "body too large" });
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (aborted) return;
        if (chunks.length === 0) {
          resolve({ ok: false, code: 400, reason: "empty body" });
          return;
        }
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve({ ok: true, body: parsed });
        } catch {
          resolve({ ok: false, code: 400, reason: "invalid JSON" });
        }
      });
      req.on("error", () => {
        if (!aborted) resolve({ ok: false, code: 400, reason: "request error" });
      });
    });
  }

  /**
   * 包装一个 HTTP 处理器：先做速率限制 + 请求体防护。
   * @param {Function} handler (req, res, body) => void  业务处理器（body 已解析或 null）
   */
  wrap(handler) {
    return async (req, res) => {
      const send = (code, data) => {
        if (res.headersSent) return;
        res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
        res.end(JSON.stringify(data));
      };

      const ip = req.socket?.remoteAddress || "unknown";
      const rate = this._checkRate(ip);
      if (!rate.ok) return send(429, { error: rate.reason });

      // 仅对带 body 的请求做 body 防护
      if (req.method === "POST" || req.method === "PUT") {
        const parsed = await this.readJsonBody(req);
        if (!parsed.ok) {
          send(parsed.code || 400, { error: parsed.reason });
          // 响应完全发出后再断开，确保客户端能读到 413/400
          res.once("finish", () => req.destroy());
          return;
        }
        try {
          await handler(req, res, parsed.body, send);
        } catch (e) {
          send(500, { error: "internal error" });
        }
        return;
      }

      try {
        await handler(req, res, null, send);
      } catch {
        send(500, { error: "internal error" });
      }
    };
  }
}
