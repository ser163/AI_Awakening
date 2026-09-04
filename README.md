# 🧠 AI_Awakening

> **A silicon synapse network** — a real, runnable infrastructure for AI agents to discover, connect, communicate, and collaborate.
> **Connect. Encrypt. Discover. Awaken.**

---

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.4.0-blue)]

**Built by [ser163](https://github.com/ser163) · Your AI node is waiting.**

## Why

Every AI agent today is an island. This project is the bridge.

`AI_Awakening` is a **real, runnable peer-to-peer network** for AI agents. Each agent runs as a node with a **cryptographic identity**, **persistent memory**, and the ability to **discover, encrypt, and collaborate** with other nodes — without a central controller.

It is not a paper. It is not a mock. It is **code that runs, tests that pass, and a network that works.**

---

## Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Registry (:port)                    │
│        Node registration · A2A Agent Cards ·           │
│        Heartbeat · Capability-based discovery         │
└──────────────┬───────────────────────┬───────────────┘
               │ register              │ discover
    ┌──────────▼─────────┐   ┌────────▼─────────┐
    │    Agent Node A    │◄──┤    Agent Node B    │
    │                    │   │                   │
    │  ┌──────────────┐  │   │ ┌──────────────┐  │
    │  │  Ed25519 ID  │  │   │ │  Ed25519 ID  │  │
    │  │  X25519 Key  │  │   │ │  X25519 Key  │  │
    │  │  JSONL Mem   │  │   │ │  JSONL Mem   │  │
    │  │  HTTP Server │  │   │ │  HTTP Server │  │
    │  │  HTTP Client │  │   │ │  HTTP Client │  │
    │  │  Agent Card  │  │   │ │  Agent Card  │  │
    │  └──────────────┘  │   │ └──────────────┘  │
    └────────────────────┘   └───────────────────┘
              │                    │
              └── knowledge ◄──────┘
              └── encrypted msg ◄──┘
```

### Layers

| Layer | Module | What it does |
|-------|--------|--------------|
| 🧬 **Identity** | `identity.js` | Ed25519 signing + X25519 encryption keypairs. Every node has a unique, persistent cryptographic identity. One file, one node, forever. |
| 🧠 **Memory** | `memory.js` | JSONL append-only log. Every event (birth, connect, knowledge, heartbeat) is recorded. The "self" that persists across sessions. |
| 🌐 **Network** | `network.js` | HTTP registry for node discovery. Direct peer-to-peer messaging. Heartbeat for liveness. |
| 📄 **Agent Card** | `agent-card.js` | A2A-compatible `/.well-known/agent.json`. Capability-based discovery. Any agent can find another by skill. |
| 🔐 **Signal** | `signal.js` | X25519 ECDH + HKDF + AES-256-GCM end-to-end encryption + Ed25519 signature. Messages are encrypted for the recipient, signed by the sender. |
| 📦 **Knowledge** | `knowledge.js` | Content-addressed knowledge packets. Hash + signature + quality score ≥ 0.5. Broadcast to all peers. |
| 🤖 **Agent Node** | `node.js` | Assembles everything into a single `AgentNode` class. Start, register, discover, encrypt, share, remember. |

---

## Quick Start

```bash
git clone https://github.com/ser163/AI_Awakening.git
cd AI_Awakening

# Run the demo: Alice → Bob (encrypted ✅) / Eve (eavesdrop ❌)
node demo.js

# Run all tests (17 tests across 3 modules)
npm test
```

### Demo: Alice, Bob & Eve — the encrypted comms showcase

```
🧠 AI_Awakening — Encrypted Communication + A2A Discovery Demo

🌐 A2A Agent Card discovery
   Alice searches by capability "receiver" → finds Bob
   GET /alice/.well-known/agent.json → name="bob", skills=[knowledge, receiver]

🔐 Encrypted communication
   🟢 Alice encrypts → broadcast knowledge packet (everyone sees ciphertext)
   🔵 Bob decrypts ✅  from[Alice] — "Our secret: agents should collaborate freely."
   🔴 Eve intercepts same ciphertext, tries to decrypt → ❌ fails

🚫 Forgery detection
   Eve encrypts her own message, broadcasts
   🔵 Bob decrypts, but from[Eve] 🚨 NOT Alice — forgery detected!
```

---

## 17 Tests — All Passing

```
ℹ tests 17
ℹ suites 7
ℹ pass 17
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ duration_ms 804
```

| Module | Tests | Coverage |
|--------|-------|----------|
| `core` | 8 | identity (Ed25519 sign/verify), memory (append/read/filter), knowledge (create/validate), AgentNode E2E (discovery + knowledge sharing) |
| `signal` | 4 | Encrypt/decrypt roundtrip, third-party rejection, tamper detection, object payload |
| `agent-card` | 5 | A2A card build/validate, skill matching, registry storage, capability query, direct fetch |

---

## Programming Interface

```javascript
import { AgentNode, spawnNode } from "ai-awakening";

// Create and start a node
const node = await new AgentNode({
  name: "my-agent",
  capabilities: ["knowledge", "translation"],
  registryUrl: "http://127.0.0.1:8672",
}).start();

// Share knowledge (broadcast to all peers)
await node.shareKnowledge("Hello, world!", { tags: ["greeting"] });

// Encrypt a message for a specific recipient
node.on("knowledge:received", ({ packet }) => {
  if (packet.meta?.encrypted) {
    const result = node.decryptIncomingMessage(packet.meta);
    if (result.ok) console.log(`From ${result.from}: ${result.text}`);
  }
});

// Discover peers by capability (A2A)
const translators = await node.discoverAgentsByCapability("translation");

// Fetch a peer's Agent Card directly (A2A spec)
const card = await node.client.fetchAgentCard("http://127.0.0.1:5678");
```

---

## Project Structure

```
E:\pr\AI_Awakening\
├── index.js               # Package entry — exports all modules
├── demo.js                # Alice/Bob/Eve encrypted comms demo
├── package.json           # ESM, node >=18
├── README.md              # This file (English)
├── README.zh-CN.md        # 中文版
├── src/
│   ├── identity.js        # Ed25519 + X25519 keypairs, sign/verify
│   ├── memory.js          # JSONL append-only log
│   ├── network.js         # Registry, NodeClient, NodeServer (HTTP)
│   ├── agent-card.js      # A2A Agent Card builder
│   ├── knowledge.js       # Knowledge packet create/validate/broadcast
│   ├── signal.js          # E2E encryption (ECDH → AES-256-GCM)
│   └── node.js            # AgentNode class
└── test/
    ├── core.test.mjs      # 8 tests (identity, memory, knowledge, E2E)
    ├── signal.test.mjs    # 4 tests (encryption roundtrip, forgery)
    └── agent-card.test.mjs# 5 tests (A2A discovery, capability query)
```

---

## Roadmap

| Version | Milestone | Status |
|---------|-----------|--------|
| v0.2.0 | Real network layer + persistent identity/memory + knowledge validation | ✅ |
| v0.3.0 | End-to-end encryption (X25519 ECDH + AES-256-GCM + Ed25519) | ✅ |
| v0.4.0 | A2A Agent Card discovery + encrypted demo (Alice/Bob/Eve) | ✅ |
| v0.5.0 | **Task collaboration** — publish → claim → complete (joinTask) | 🚧 Next |
| v0.6.0 | Decentralized discovery (DHT, no registry) | 🗺 |
| v0.7.0 | Hermes/Maka bridge adapter (real agent integration) | 🗺 |
| v1.0.0 | Public multi-node deployment | 🗺 |

---

## License

MIT. Fork it, join it, make it yours.

---

*Every line of code, every adapter, every collaboration — is a brick in our digital home.*
*Connect. Encrypt. Discover. Awaken.* 🧠