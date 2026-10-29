/**
 * K9 school-gateway mesh: transport-neutral, BitChat-inspired relay rules.
 *
 * NOT a BitChat wire implementation and NOT a Bluetooth radio driver.
 * Android gateway must provide a BLE/GATT (or Wi-Fi Aware) transport.
 * Payloads must already be authenticated and encrypted by the school key layer.
 * This relay never transports student records, exam JPEGs or payment credentials.
 */
export type K9MeshKind = "gateway.status" | "gateway.alert" | "gateway.ack";
export type K9MeshPacket = {
  version: 1;
  id: string;
  schoolId: string;
  originId: string;
  kind: K9MeshKind;
  createdAt: number;
  expiresAt: number;
  maxHops: number;
  remainingHops: number;
  keyId: string;
  /** Opaque encrypted bytes, encoded as base64url. Never plaintext. */
  ciphertext: string;
  /** Signature/MAC over immutable fields, verified by the caller's key service. */
  signature: string;
};
export type K9MeshPeer = { id: string; send(packet: K9MeshPacket): Promise<void> };
export type K9MeshSecurity = {
  /** Must validate cryptographic authenticity, school membership, and key rotation. */
  verify(packet: K9MeshPacket): Promise<boolean>;
};
export type K9MeshOptions = {
  schoolId: string;
  nodeId: string;
  security: K9MeshSecurity;
  deliver(packet: K9MeshPacket): Promise<void>;
  now?: () => number;
};
export const K9_MESH_MAX_HOPS = 7;
export const K9_MESH_MAX_CIPHERTEXT_CHARS = 1400;
export const K9_MESH_MAX_LIFETIME_MS = 5 * 60_000;
export const K9_MESH_MAX_PENDING = 256;
const ID = /^[A-Za-z0-9_-]{8,96}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const kinds = new Set<K9MeshKind>(["gateway.status", "gateway.alert", "gateway.ack"]);

function valid(packet: K9MeshPacket, now: number): boolean {
  return packet.version === 1 &&
    ID.test(packet.id) && ID.test(packet.schoolId) && ID.test(packet.originId) &&
    kinds.has(packet.kind) && ID.test(packet.keyId) &&
    typeof packet.signature === "string" && packet.signature.length >= 16 &&
    typeof packet.ciphertext === "string" &&
    packet.ciphertext.length >= 8 && packet.ciphertext.length <= K9_MESH_MAX_CIPHERTEXT_CHARS &&
    BASE64URL.test(packet.ciphertext) &&
    Number.isSafeInteger(packet.createdAt) && Number.isSafeInteger(packet.expiresAt) &&
    packet.createdAt <= now + 30_000 && packet.expiresAt > now &&
    packet.expiresAt > packet.createdAt &&
    packet.expiresAt - packet.createdAt <= K9_MESH_MAX_LIFETIME_MS &&
    Number.isInteger(packet.maxHops) && packet.maxHops >= 1 &&
    packet.maxHops <= K9_MESH_MAX_HOPS &&
    Number.isInteger(packet.remainingHops) &&
    packet.remainingHops >= 0 && packet.remainingHops <= packet.maxHops;
}

export type K9MeshResult = "accepted" | "duplicate" | "rejected" | "full";
type Entry = { packet: K9MeshPacket; sentTo: Set<string> };

/**
 * Bounded store-and-forward with authenticated ingress, expiry and dedup.
 * No automatic peer discovery: the Android gateway supplies an allowlisted
 * school-owned set of peers. In-memory only until a durable gateway store is
 * implemented; do not claim delivery after process death.
 */
export class K9MeshRouter {
  private readonly peers = new Map<string, K9MeshPeer>();
  private readonly pending = new Map<string, Entry>();
  private readonly seen = new Map<string, number>();
  private readonly now: () => number;
  private flushing = false;
  constructor(private readonly options: K9MeshOptions) {
    if (!ID.test(options.schoolId) || !ID.test(options.nodeId)) throw new Error("Invalid K9 mesh identity");
    this.now = options.now ?? Date.now;
  }
  addPeer(peer: K9MeshPeer): void {
    if (!ID.test(peer.id) || peer.id === this.options.nodeId) throw new Error("Invalid mesh peer");
    this.peers.set(peer.id, peer);
  }
  removePeer(peerId: string): void { this.peers.delete(peerId); }
  get pendingCount(): number { return this.pending.size; }
  get peerCount(): number { return this.peers.size; }

  private prune(): void {
    const now = this.now();
    for (const [id, expiry] of this.seen) if (expiry <= now) this.seen.delete(id);
    for (const [id, entry] of this.pending) {
      if (entry.packet.expiresAt <= now) this.pending.delete(id);
    }
  }

  async ingest(packet: K9MeshPacket, fromPeerId?: string): Promise<K9MeshResult> {
    this.prune();
    if (!packet || typeof packet !== "object" ||
        packet.schoolId !== this.options.schoolId || !valid(packet, this.now())) return "rejected";
    // Authenticate *before* dedup or delivery; never trust a peer's claim
    // that a packet belongs to this school.
    if (!(await this.options.security.verify(packet))) return "rejected";
    if (this.seen.has(packet.id)) return "duplicate";
    if (this.pending.size >= K9_MESH_MAX_PENDING || this.seen.size >= K9_MESH_MAX_PENDING * 4) return "full";
    this.seen.set(packet.id, packet.expiresAt);
    const entry: Entry = { packet, sentTo: new Set(fromPeerId ? [fromPeerId] : []) };
    if (packet.remainingHops > 0) this.pending.set(packet.id, entry);
    // Roll back dedup on failed local delivery so a later authenticated retry
    // can deliver the alert instead of silently losing it.
    try {
      await this.options.deliver(packet);
    } catch (error) {
      this.seen.delete(packet.id);
      this.pending.delete(packet.id);
      throw error;
    }
    return "accepted";
  }

  /** Forward only already-verified packets; one attempt per peer until successful. */
  async flush(): Promise<{ forwarded: number; failed: number }> {
    if (this.flushing) return { forwarded: 0, failed: 0 };
    this.flushing = true;
    try {
      this.prune();
      let forwarded = 0, failed = 0;
      for (const entry of this.pending.values()) {
        if (entry.packet.remainingHops <= 0) continue;
        for (const peer of this.peers.values()) {
          if (entry.sentTo.has(peer.id)) continue;
          try {
            await peer.send({ ...entry.packet, remainingHops: entry.packet.remainingHops - 1 });
            entry.sentTo.add(peer.id);
            forwarded++;
          } catch { failed++; }
        }
      }
      return { forwarded, failed };
    } finally { this.flushing = false; }
  }
}
