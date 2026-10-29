import { test } from "node:test";
import assert from "node:assert/strict";
import { K9MeshRouter, type K9MeshPacket } from "../src/k9/K9MeshRouter";
import {
  K9BleReassembler, K9GatewayMeshBridge, frameK9Packet,
} from "../src/k9/K9GatewayMeshBridge";
const packet: K9MeshPacket = {
  version: 1, id: "status_packet01", schoolId: "school_alpha", originId: "gateway_one",
  kind: "gateway.status", createdAt: 1000, expiresAt: 20_000,
  maxHops: 7, remainingHops: 7, keyId: "school_key01",
  ciphertext: "ZW5jcnlwdGVkX3N0YXR1cw", signature: "authenticated-school-key",
};
const token = new Uint8Array([1,2,3,4,5,6,7,8]);
function router(delivered: K9MeshPacket[]) {
  return new K9MeshRouter({
    schoolId: "school_alpha", nodeId: "gateway_two", now: () => 2_000,
    security: { verify: async (p) => p.signature === "authenticated-school-key" },
    deliver: async (p) => { delivered.push(p); },
  });
}
test("GATT frames reassemble out of order and preserve packet", () => {
  const frames = frameK9Packet(packet, 45, token);
  assert.ok(frames.length > 1);
  const receiver = new K9BleReassembler(() => 2_000);
  let result: K9MeshPacket | null = null;
  for (const frame of [...frames].reverse()) {
    const next = receiver.receive("gateway_one", frame);
    if (next) result = next;
  }
  assert.deepEqual(result, packet);
});
test("BLE gateway link bridges a verified packet into the mesh", async () => {
  const delivered: K9MeshPacket[] = [];
  const mesh = router(delivered);
  const bridge = new K9GatewayMeshBridge(mesh);
  const sent: Uint8Array[] = [];
  bridge.attach({ peerId: "gateway_three", mtuPayloadBytes: 50,
    write: async (data) => { sent.push(data); } });
  await mesh.ingest(packet);
  assert.equal((await mesh.flush()).forwarded, 1);
  assert.ok(sent.length > 1);
  const downstream = new K9GatewayMeshBridge(router([]));
  for (const frame of sent) await downstream.receive("gateway_three", frame);
  assert.equal(delivered.length, 1);
});
test("duplicate frames are idempotent, conflicting frames rejected", () => {
  const receiver = new K9BleReassembler(() => 2_000);
  const frames = frameK9Packet(packet, 45, token);
  assert.equal(receiver.receive("gateway_one", frames[0]!), null);
  assert.equal(receiver.receive("gateway_one", frames[0]!), null);
  const corrupted = frames[0]!.slice();
  corrupted[corrupted.length - 1] ^= 1;
  assert.throws(() => receiver.receive("gateway_one", corrupted), /Conflicting/);
});
test("BLE reassembly rejects invalid counts and cross-peer collisions", () => {
  const receiver = new K9BleReassembler(() => 2_000);
  const frames = frameK9Packet(packet, 50, token);
  const broken = frames[0]!.slice();
  broken[11] = 0; broken[12] = 0;
  assert.throws(() => receiver.receive("gateway_one", broken), /count/);
  assert.equal(receiver.receive("gateway_one", frames[0]!), null);
  assert.equal(receiver.receive("gateway_other", frames[0]!), null);
});
test("a forged packet is not delivered after GATT reassembly", async () => {
  const delivered: K9MeshPacket[] = [];
  const bridge = new K9GatewayMeshBridge(router(delivered));
  const forged = { ...packet, signature: "forged-but-long-enough" };
  const frames = frameK9Packet(forged, 50, token);
  for (const frame of frames.slice(0, -1)) await bridge.receive("gateway_one", frame);
  await assert.rejects(bridge.receive("gateway_one", frames.at(-1)!), /rejected/);
  assert.equal(delivered.length, 0);
});
