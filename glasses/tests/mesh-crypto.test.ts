import { test } from "node:test";
import assert from "node:assert/strict";
import { K9SchoolMeshCrypto } from "../src/k9/K9SchoolMeshCrypto";
import { K9MeshRouter } from "../src/k9/K9MeshRouter";
const key = {
  keyId: "school_key01",
  encryptionKey: new Uint8Array(32).fill(7),
  authenticationKey: new Uint8Array(32).fill(9),
};
const cryptoFor = (schoolId = "school_alpha") => new K9SchoolMeshCrypto(schoolId, [key]);
test("encrypted mesh packet authenticates and decrypts", async () => {
  const crypto = cryptoFor();
  const packet = await crypto.create({ originId: "gateway_one", kind: "gateway.alert",
    message: "School gateway disconnected", keyId: key.keyId, now: 1_000 });
  assert.ok(!JSON.stringify(packet).includes("School gateway disconnected"));
  assert.equal(await crypto.verify(packet), true);
  assert.deepEqual(await crypto.open(packet), { kind: "gateway.alert", message: "School gateway disconnected" });
});
test("tampering and cross-school packet rejection", async () => {
  const crypto = cryptoFor();
  const packet = await crypto.create({ originId: "gateway_one", kind: "gateway.status",
    message: "Ready", keyId: key.keyId, now: 1_000 });
  assert.equal(await crypto.verify({ ...packet, kind: "gateway.alert" }), false);
  assert.equal(await crypto.verify({ ...packet, ciphertext: packet.ciphertext + "A" }), false);
  assert.equal(await cryptoFor("school_beta").verify(packet), false);
  assert.equal(await crypto.verify({ ...packet, remainingHops: 2 }), true);
  await assert.rejects(crypto.open({ ...packet, schoolId: "school_beta" }), /authentication/);
});
test("authenticated packet is accepted by K9 mesh router", async () => {
  const security = cryptoFor();
  const received: string[] = [];
  const router = new K9MeshRouter({
    schoolId: "school_alpha", nodeId: "gateway_two", security,
    now: () => 2_000,
    deliver: async (packet) => { received.push((await security.open(packet)).message); },
  });
  const packet = await security.create({ originId: "gateway_one", kind: "gateway.alert",
    message: "Power interrupted", keyId: key.keyId, now: 1_000 });
  assert.equal(await router.ingest(packet), "accepted");
  assert.deepEqual(received, ["Power interrupted"]);
});
test("rotating keyring accepts previous key but rejects unknown key", async () => {
  const oldKey = { keyId: "old_school_key", encryptionKey: new Uint8Array(32).fill(11),
    authenticationKey: new Uint8Array(32).fill(12) };
  const old = new K9SchoolMeshCrypto("school_alpha", [oldKey]);
  const packet = await old.create({ originId: "gateway_one", kind: "gateway.ack",
    message: "Acknowledged", keyId: oldKey.keyId, now: 1_000 });
  assert.equal(await new K9SchoolMeshCrypto("school_alpha", [key, oldKey]).verify(packet), true);
  assert.equal(await cryptoFor().verify(packet), false);
});
test("weak keys and oversized payloads rejected", async () => {
  assert.throws(() => cryptoFor("invalid school"), /Invalid/);
  await assert.rejects(cryptoFor().create({ originId: "gateway_one", kind: "gateway.alert",
    message: "x".repeat(800), keyId: key.keyId, now: 1_000 }), /too large/);
});
