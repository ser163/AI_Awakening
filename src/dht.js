/**
 * dht.js — Kademlia 分布式哈希表 (v0.6.0)
 *
 * 去中心化节点发现：不再依赖中心 Registry。
 * 实现 Kademlia 协议核心（Maymounkov & Mazières, 2002）：
 *   - 160-bit 节点 ID（sha256 截断）
 *   - XOR 距离度量
 *   - k-bucket 路由表（k=20，按共享前缀分桶）
 *   - PING / FIND_NODE RPC（HTTP JSON 传输）
 *   - 迭代查找：α=3 并发，逐步收敛到最近节点
 *
 * 任一节点只要知道一个"引导节点"，就能加入网络并发现在线节点。
 */

import crypto from "node:crypto";

export const K = 20;          // 每个 bucket 容量
export const ALPHA = 3;       // 并发查询数
export const ID_BITS = 160;   // 节点 ID 位数
const ID_BYTES = ID_BITS / 8;

/** 计算节点 ID：SHA-256(fingerprint) 截断为 160 bit (v0.10.0)
 * 不再依赖 name——身份链稳定：Identity → Fingerprint → Node ID。 */
export function nodeIdFromFingerprint(fingerprint) {
  const h = crypto.createHash("sha256").update(fingerprint).digest();
  return h.subarray(0, ID_BYTES);
}
/** @deprecated 旧版 nodeIdFromIdentity 依赖 name，身份链不稳定 */
export const nodeIdFromIdentity = nodeIdFromFingerprint;

/** XOR 距离（Buffer 比较） */
export function xorDistance(a, b) {
  const out = Buffer.alloc(ID_BYTES);
  for (let i = 0; i < ID_BYTES; i++) out[i] = a[i] ^ b[i];
  return out;
}

/** 距离的十六进制表示（用于排序/比较） */
export function distanceHex(a, b) {
  return xorDistance(a, b).toString("hex");
}

/** 两个 ID 共享前缀长度（决定 bucket 索引） */
export function sharedPrefixBits(a, b) {
  let prefix = 0;
  for (let i = 0; i < ID_BYTES; i++) {
    const x = a[i] ^ b[i];
    if (x === 0) {
      prefix += 8;
      continue;
    }
    // 计算第一个非零字节的前导 0 数（= 该字节内共享位数）
    let shared = 0;
    let mask = 0x80;
    while (mask !== 0 && (x & mask) === 0) {
      shared++;
      mask >>= 1;
    }
    prefix += shared;
    break;
  }
  return prefix;
}

/**
 * k-bucket 路由表
 */
export class KBucket {
  constructor(localId) {
    this.localId = localId;
    this.buckets = Array.from({ length: ID_BITS }, () => []); // bucket[i] 存共享前缀恰为 i 的节点
    this.cache = new Map(); // idHex -> {id, address, name, lastSeen}
  }

  _bucketIndex(otherId) {
    return sharedPrefixBits(this.localId, otherId);
  }

  /**
   * 插入或更新一个节点。
   * 返回 true 表示插入成功/已存在，false 表示 bucket 满被拒绝（触发查找以腾位，简化：拒绝）。
   */
  insert(node) {
    const { id, address, name } = node;
    const idx = this._bucketIndex(id);
    const bucket = this.buckets[idx];
    const idHex = id.toString("hex");

    if (this.cache.has(idHex)) {
      // 已存在：刷新位置（移到尾部 = 最近活跃）
      this.cache.get(idHex).lastSeen = Date.now();
      const i = bucket.findIndex((n) => n.id.equals(id));
      if (i >= 0) bucket.splice(i, 1);
      bucket.push(this.cache.get(idHex));
      return true;
    }
    if (bucket.length >= K) return false; // bucket 满

    const entry = { id: Buffer.from(id), address, name, lastSeen: Date.now() };
    bucket.push(entry);
    this.cache.set(idHex, entry);
    return true;
  }

  /** 返回所有已知节点 */
  all() {
    return Array.from(this.cache.values());
  }

  /**
   * 返回离 targetId 最近的至多 count 个节点（按 XOR 距离排序）。
   */
  closest(targetId, count = K) {
    const dists = this.all().map((n) => ({ n, d: xorDistance(n.id, targetId) }));
    dists.sort((a, b) => a.d.compare(b.d));
    return dists.slice(0, count).map((x) => ({ id: x.n.id, address: x.n.address, name: x.n.name }));
  }

  size() {
    return this.cache.size;
  }
}

/**
 * DHT 节点：路由表 + RPC 客户端（HTTP）
 */
export class DHTNode {
  /**
   * @param {object} opts
   * @param {string} opts.address   本节点 HTTP 地址（对外可达）
   * @param {Buffer} [opts.id]      节点 ID（默认随机）
   * @param {string} [opts.name]    节点名
   */
  constructor({ address, id, name = "dht-node" }) {
    this.address = address;
    this.id = id || crypto.randomBytes(ID_BYTES);
    this.name = name;
    this.routing = new KBucket(this.id);
  }

  /**
   * PING 一个节点，检查其是否在线并学习它的 ID。
   */
  async ping(address) {
    try {
      const res = await fetch(`${address}/dht/ping`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: this.id.toString("hex"), address: this.address, name: this.name }),
      });
      const data = await res.json();
      if (!data.ok) return null;
      const peer = {
        id: Buffer.from(data.id, "hex"),
        address,
        name: data.name || "peer",
      };
      this.routing.insert(peer);
      return peer;
    } catch {
      return null;
    }
  }

  /**
   * FIND_NODE：向 address 查询离 targetId 最近的节点。
   */
  async findNode(address, targetId, excludeHex = []) {
    try {
      const res = await fetch(`${address}/dht/find_node`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: this.id.toString("hex"),
          address: this.address,
          name: this.name,
          target: targetId.toString("hex"),
        }),
      });
      const data = await res.json();
      if (!data.ok) return [];
      // 学习返回的节点（除了自己）
      for (const n of data.nodes) {
        const pid = Buffer.from(n.id, "hex");
        if (!pid.equals(this.id)) {
          this.routing.insert({ id: pid, address: n.address, name: n.name });
        }
      }
      return data.nodes || [];
    } catch {
      return [];
    }
  }

  /**
   * 迭代查找：从引导节点出发，α 并发收敛到离 target 最近的节点。
   * @param {string} bootstrapAddress 已知节点地址
   * @param {Buffer} targetId 目标 ID
   * @returns {Promise<Array>} 最近的节点列表
   */
  async lookup(bootstrapAddress, targetId) {
    // 先 ping 引导节点
    await this.ping(bootstrapAddress);

    const visited = new Set();
    const candidates = this.routing.closest(targetId, K).map((n) => ({ ...n, dist: distanceHex(n.id, targetId) }));

    let improved = true;
    let rounds = 0;
    while (improved && rounds < 5) {
      improved = false;
      rounds++;
      // 取未访问的 α 个最近节点并发查询
      const batch = candidates.filter((c) => !visited.has(c.address)).slice(0, ALPHA);
      if (batch.length === 0) break;

      const results = await Promise.all(
        batch.map(async (c) => {
          visited.add(c.address);
          const nodes = await this.findNode(c.address, targetId);
          return nodes;
        })
      );

      for (const nodes of results) {
        for (const n of nodes) {
          const pid = Buffer.from(n.id, "hex");
          const addr = n.address;
          const entry = { id: pid, address: addr, name: n.name, dist: distanceHex(pid, targetId) };
          // 如果比当前最远候选更近，则加入并标记改进
          if (candidates.length < K || entry.dist < candidates[candidates.length - 1].dist) {
            candidates.push(entry);
            improved = true;
          }
        }
      }
      candidates.sort((a, b) => (a.dist < b.dist ? -1 : a.dist > b.dist ? 1 : 0));
      candidates.splice(K);
    }
    return candidates.slice(0, K).map(({ id, address, name }) => ({ id, address, name }));
  }
}

/**
 * 为 HTTP 服务端创建 DHT RPC 处理器（挂到 NodeServer 上）。
 * @param {DHTNode} dht
 * @returns {Function} (path, payload) => response 或 null
 */
export function makeDhtHandler(dht) {
  return (path, payload) => {
    if (path === "/dht/ping") {
      // 记录调用者
      const caller = { id: Buffer.from(payload.id, "hex"), address: payload.address, name: payload.name };
      dht.routing.insert(caller);
      return { ok: true, id: dht.id.toString("hex"), name: dht.name };
    }
    if (path === "/dht/find_node") {
      const caller = { id: Buffer.from(payload.id, "hex"), address: payload.address, name: payload.name };
      dht.routing.insert(caller);
      const target = Buffer.from(payload.target, "hex");
      const closest = dht.routing.closest(target, K)
        .filter((n) => !n.id.equals(caller.id))
        .map((n) => ({ id: n.id.toString("hex"), address: n.address, name: n.name }));
      return { ok: true, nodes: closest };
    }
    return null;
  };
}