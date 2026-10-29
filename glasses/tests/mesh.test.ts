import { test } from "node:test";
import assert from "node:assert/strict";
import {
  K9MeshRouter, K9_MESH_MAX_HOPS, K9_MESH_MAX_PENDING,
  type K9MeshPacket,
} from "../src/k9/K9MeshRouter";

const base = (changes: Partial<K9MeshPacket> = {}): K9MeshPacket => ({
  version: 1,
  id: "capturestatus01",
  schoolId: "school_alpha",
  originId: "gateway_one",
  kind: "gateway.status",
  createdAt: 1000,
  expiresAt: 60_000,
  maxHops: 7,
  remainingHops: 7,
  keyId: "schoolkey01",
  ciphertext: "ZW5jcnlwdGVk",
  signature: "signed-by-school-key",
  ...changes,
});
const make = (delivered: K9MeshPacket[] = [], overrides: Record<string, unknown> = {}) =>
  new K9MeshRouter({
    schoolId: "school_alpha",
    nodeId: "gateway_two",
    now: () => 2_000,
    security: { verify: async (packet) => packet.signature === "signed-by-school-key" },
    deliver: async (packet) => { delivered.push(packet); },
    ...overrides,
  });

test("accepts authenticated school status and delivers it once", async () => {
  const delivered: K9MeshPacket[] = [];
  const router = make(delivered);
  assert.equal(await router.ingest(base()), "accepted");
  assert.equal(await router.ingest(base()), "duplicate");
  assert.equal(delivered.length, 1);
});
test("rejects cross-school, unauthenticated and malformed payloads", async () => {
  const delivered: K9MeshPacket[] = [];
  const router = make(delivered);
  assert.equal(await router.ingest(base({ schoolId: "school_beta" })), "rejected");
  assert.equal(await router.ingest(base({ signature: "untrusted-pretend-signature" })), "rejected");
  assert.equal(await router.ingest(base({ ciphertext: "plaintext with spaces" })), "rejected");
  assert.equal(await router.ingest(base({ kind: "exam.image" as K9MeshPacket["kind"] })), "rejected");
  assert.equal(delivered.length, 0);
});
test("relays at most seven hops and never sends back to incoming peer", async () => {
  const sent: K9MeshPacket[] = [];
  const router = make();
  router.addPeer({ id: "gateway_one", send: async (p) => { sent.push(p); } });
  router.addPeer({ id: "gateway_three", send: async (p) => { sent.push(p); } });
  assert.equal(await router.ingest(base(), "gateway_one"), "accepted");
  assert.deepEqual(await router.flush(), { forwarded: 1, failed: 0 });
  assert.equal(sent[0]?.remainingHops, K9_MESH_MAX_HOPS - 1);
  assert.deepEqual(await router.flush(), { forwarded: 0, failed: 0 });
});
test("zero-hop packets are delivered locally but never forwarded", async () => {
  const delivered: K9MeshPacket[] = [];
  const router = make(delivered);
  let sent = 0;
  router.addPeer({ id: "gateway_three", send: async () => { sent++; } });
  assert.equal(await router.ingest(base({ remainingHops: 0 })), "accepted");
  await router.flush();
  assert.equal(sent, 0);
  assert.equal(delivered.length, 1);
});
test("failed sends are retried on the next flush", async () => {
  const router = make();
  let attempts = 0;
  router.addPeer({ id: "gateway_three", send: async () => {
    if (++attempts === 1) throw new Error("BLE radio busy");
  } });
  await router.ingest(base());
  assert.deepEqual(await router.flush(), { forwarded: 0, failed: 1 });
  assert.deepEqual(await router.flush(), { forwarded: 1, failed: 0 });
});
test("expired messages and implausible lifetime are rejected", async () => {
  const router = make();
  assert.equal(await router.ingest(base({ expiresAt: 1999 })), "rejected");
  assert.equal(await router.ingest(base({ expiresAt: 10_000_000 })), "rejected");
  assert.equal(await router.ingest(base({ maxHops: 8 })), "rejected");
});
test("bounded queue rejects flooding rather than dropping messages", async () => {
  const router = make();
  for (let i = 0; i < K9_MESH_MAX_PENDING; i++) {
    assert.equal(await router.ingest(base({ id: `message_${String(i).padStart(8, "0")}` })), "accepted");
  }
  assert.equal(router.pendingCount, K9_MESH_MAX_PENDING);
  assert.equal(await router.ingest(base({ id: "message_overflow01" })), "full");
});
test("peer cannot bypass signature verification using a matching message ID", async () => {
  const router = make();
  assert.equal(await router.ingest(base({ signature: "untrusted-pretend-signature" })), "rejected");
  assert.equal(await router.ingest(base()), "accepted");
});
