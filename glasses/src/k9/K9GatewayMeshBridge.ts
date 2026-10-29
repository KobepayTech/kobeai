import type { K9MeshPacket, K9MeshPeer, K9MeshRouter } from "./K9MeshRouter";

/**
 * A compatible BLE link is a separate GATT connection between K9 gateways.
 * MoYoung's private BLE session to the glasses is NOT a mesh participant.
 *
 * Native Android must implement GATT discovery/characteristic read/write,
 * MTU negotiation, peer provisioning and link authentication. This file
 * implements only the portable packet framing and bridge.
 */
export interface K9BleLink {
  /** School-provisioned gateway identity, verified at transport enrollment. */
  readonly peerId: string;
  /** Maximum value bytes accepted by the negotiated GATT characteristic. */
  readonly mtuPayloadBytes: number;
  write(value: Uint8Array): Promise<void>;
}
export const K9_BLE_FRAME_VERSION = 1;
export const K9_BLE_FRAME_HEADER = 13;
export const K9_BLE_MAX_PACKET_BYTES = 4_096;
export const K9_BLE_MAX_INFLIGHT = 16;
export const K9_BLE_REASSEMBLY_TTL_MS = 15_000;

/** Frame: version[1], random token[8], chunk index[2], total chunks[2], bytes. */
export function frameK9Packet(
  packet: K9MeshPacket,
  mtuPayloadBytes: number,
  token: Uint8Array,
): Uint8Array[] {
  if (token.length !== 8) throw new Error("BLE frame token must be 8 bytes");
  if (!Number.isSafeInteger(mtuPayloadBytes) || mtuPayloadBytes <= K9_BLE_FRAME_HEADER ||
      mtuPayloadBytes > 512) throw new Error("Invalid negotiated GATT value size");
  const bytes = new TextEncoder().encode(JSON.stringify(packet));
  if (bytes.length > K9_BLE_MAX_PACKET_BYTES) throw new Error("K9 mesh packet too large for BLE");
  const capacity = mtuPayloadBytes - K9_BLE_FRAME_HEADER;
  const total = Math.max(1, Math.ceil(bytes.length / capacity));
  if (total > 256) throw new Error("Too many BLE frames");
  const frames: Uint8Array[] = [];
  for (let index = 0; index < total; index++) {
    const part = bytes.subarray(index * capacity, (index + 1) * capacity);
    const frame = new Uint8Array(K9_BLE_FRAME_HEADER + part.length);
    const view = new DataView(frame.buffer);
    frame[0] = K9_BLE_FRAME_VERSION;
    frame.set(token, 1);
    view.setUint16(9, index);
    view.setUint16(11, total);
    frame.set(part, K9_BLE_FRAME_HEADER);
    frames.push(frame);
  }
  return frames;
}
type Assembly = {
  expiresAt: number;
  total: number;
  chunks: Map<number, Uint8Array>;
  length: number;
};

/** Reassembles bounded, potentially out-of-order BLE notifications. */
export class K9BleReassembler {
  private inflight = new Map<string, Assembly>();
  constructor(private readonly now: () => number = Date.now) {}
  receive(peerId: string, frame: Uint8Array): K9MeshPacket | null {
    const now = this.now();
    for (const [key, assembly] of this.inflight) {
      if (assembly.expiresAt <= now) this.inflight.delete(key);
    }
    if (!/^[A-Za-z0-9_-]{8,96}$/.test(peerId) ||
        frame.length <= K9_BLE_FRAME_HEADER || frame.length > 512 ||
        frame[0] !== K9_BLE_FRAME_VERSION) throw new Error("Invalid BLE frame");
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    const index = view.getUint16(9), total = view.getUint16(11);
    if (total === 0 || index >= total || total > 256) throw new Error("Invalid BLE chunk count");
    const token = Array.from(frame.subarray(1, 9), (b) => b.toString(16).padStart(2, "0")).join("");
    const key = `${peerId}:${token}`;
    let assembly = this.inflight.get(key);
    if (!assembly) {
      if (this.inflight.size >= K9_BLE_MAX_INFLIGHT) throw new Error("BLE reassembly capacity reached");
      assembly = { expiresAt: now + K9_BLE_REASSEMBLY_TTL_MS, total, chunks: new Map(), length: 0 };
      this.inflight.set(key, assembly);
    }
    if (assembly.total !== total) {
      this.inflight.delete(key);
      throw new Error("BLE chunk count changed mid-packet");
    }
    const chunk = frame.slice(K9_BLE_FRAME_HEADER);
    const prior = assembly.chunks.get(index);
    if (prior) {
      if (prior.length !== chunk.length || prior.some((byte, i) => byte !== chunk[i])) {
        this.inflight.delete(key);
        throw new Error("Conflicting BLE duplicate frame");
      }
      return null;
    }
    assembly.length += chunk.length;
    if (assembly.length > K9_BLE_MAX_PACKET_BYTES) {
      this.inflight.delete(key);
      throw new Error("BLE packet exceeds size limit");
    }
    assembly.chunks.set(index, chunk);
    if (assembly.chunks.size !== total) return null;
    this.inflight.delete(key);
    const complete = new Uint8Array(assembly.length);
    let offset = 0;
    for (let i = 0; i < total; i++) {
      const part = assembly.chunks.get(i);
      if (!part) throw new Error("Missing BLE chunk");
      complete.set(part, offset);
      offset += part.length;
    }
    let decoded: unknown;
    try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(complete)); }
    catch { throw new Error("Invalid BLE mesh envelope"); }
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded))
      throw new Error("Invalid BLE mesh packet");
    // The router authenticates and validates every field after reassembly.
    return decoded as K9MeshPacket;
  }
}

/** Transport bridge: register a separate BLE gateway peer with the mesh router. */
export class K9GatewayMeshBridge {
  private readonly reassembler = new K9BleReassembler();
  constructor(private readonly router: K9MeshRouter) {}
  attach(link: K9BleLink): void {
    if (!/^[A-Za-z0-9_-]{8,96}$/.test(link.peerId)) throw new Error("Invalid provisioned gateway");
    const peer: K9MeshPeer = {
      id: link.peerId,
      send: async (packet) => {
        const token = new Uint8Array(8);
        crypto.getRandomValues(token);
        for (const frame of frameK9Packet(packet, link.mtuPayloadBytes, token))
          await link.write(frame);
      },
    };
    this.router.addPeer(peer);
  }
  detach(peerId: string): void { this.router.removePeer(peerId); }
  async receive(peerId: string, frame: Uint8Array): Promise<void> {
    const packet = this.reassembler.receive(peerId, frame);
    if (!packet) return;
    const result = await this.router.ingest(packet, peerId);
    if (result === "rejected" || result === "full") throw new Error(`K9 mesh ${result}`);
  }
}
