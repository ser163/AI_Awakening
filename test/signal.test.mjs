import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { loadOrCreateIdentity } from "../src/identity.js";
import { encryptFor, decryptFrom } from "../src/signal.js";
import os from "node:os";
import path from "node:path";

const tmp = path.join(os.tmpdir(), "ai_signal_test_" + Date.now());

describe("signal (E2E encryption)", () => {
  it("两个节点之间加密/解密往返", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "alice"), "alice");
    const bob = loadOrCreateIdentity(path.join(tmp, "bob"), "bob");

    const msg = "这条消息只有 Bob 能读懂。";
    const env = encryptFor(alice, bob.xPublicKey, msg);
    assert.ok(env.length > 0);

    const result = decryptFrom(bob, env);
    assert.ok(result.ok);
    assert.equal(result.from, alice.fingerprint);
    assert.equal(result.text, msg);
  });

  it("第三方无法解密（没有 Bob 的私钥）", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "alice2"), "alice");
    const bob = loadOrCreateIdentity(path.join(tmp, "bob2"), "bob");
    const eve = loadOrCreateIdentity(path.join(tmp, "eve"), "eve");

    const env = encryptFor(alice, bob.xPublicKey, "秘密消息");
    const result = decryptFrom(eve, env);
    assert.ok(!result.ok); // Eve 解密失败
  });

  it("篡改密文后解密失败", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "alice3"), "alice");
    const bob = loadOrCreateIdentity(path.join(tmp, "bob3"), "bob");

    const env = encryptFor(alice, bob.xPublicKey, "hello");
    const buf = Buffer.from(env, "base64");
    const parsed = JSON.parse(buf.toString("utf8"));
    // 篡改密文
    parsed.ct = Buffer.from("tampered").toString("base64");
    const tampered = Buffer.from(JSON.stringify(parsed)).toString("base64");

    const result = decryptFrom(bob, tampered);
    assert.ok(!result.ok);
  });

  it("对象载荷正确序列化", () => {
    const alice = loadOrCreateIdentity(path.join(tmp, "alice4"), "alice");
    const bob = loadOrCreateIdentity(path.join(tmp, "bob4"), "bob");

    const payload = { type: "knowledge", content: "测试", tags: ["e2e"] };
    const env = encryptFor(alice, bob.xPublicKey, payload);
    const result = decryptFrom(bob, env);
    assert.ok(result.ok);
    const parsed = JSON.parse(result.text);
    assert.equal(parsed.type, "knowledge");
  });
});