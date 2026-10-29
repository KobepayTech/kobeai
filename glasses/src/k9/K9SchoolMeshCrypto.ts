import type { K9MeshKind, K9MeshPacket, K9MeshSecurity } from "./K9MeshRouter";

/**
 * School-key AES-256-GCM encryption + HMAC-SHA-256 origin authentication.
 * Key material MUST be provisioned out-of-band on school gateways, never
 * included in web bundles or teacher browser storage.
 *
 * Key separation: two independent 32-byte keys, one for AEAD and one for MAC.
 * The signed fields deliberately exclude remainingHops, which each relay
 * decrements. It must not be used for authorization.
 */
export type K9SchoolMeshKey = {
  keyId: string;
  encryptionKey: Uint8Array;
  authenticationKey: Uint8Array;
};
export type K9MeshPlaintext = { kind: K9MeshKind; message: string };
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });
const VALID_ID = /^[A-Za-z0-9_-]{8,96}$/;
const MAX_MESSAGE_BYTES = 700;
const MAX_LIFETIME_MS = 300_000;
const base64url = (bytes: Uint8Array) => {
  let s = "";
  for (const byte of bytes) s += String.fromCharCode(byte);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const unbase64url = (s: string) => {
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error("Invalid encoded bytes");
  const normalized = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const result = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) result[i] = binary.charCodeAt(i);
  return result;
};
const immutableFields = (p: K9MeshPacket) =>
  JSON.stringify([p.version, p.id, p.schoolId, p.originId, p.kind,
    p.createdAt, p.expiresAt, p.maxHops, p.keyId, p.ciphertext]);
const associatedData = (p: K9MeshPacket) =>
  enc.encode(JSON.stringify([p.version, p.id, p.schoolId, p.originId,
    p.kind, p.createdAt, p.expiresAt, p.maxHops, p.keyId]));
async function importKeys(key: K9SchoolMeshKey) {
  if (!VALID_ID.test(key.keyId) ||
      key.encryptionKey.byteLength !== 32 || key.authenticationKey.byteLength !== 32)
    throw new Error("K9 mesh requires two separate 256-bit keys");
  if (key.encryptionKey.every((v) => v === 0) ||
      key.authenticationKey.every((v) => v === 0))
    throw new Error("Weak K9 mesh key");
  return {
    aes: await crypto.subtle.importKey("raw", key.encryptionKey as BufferSource,
      "AES-GCM", false, ["encrypt", "decrypt"]),
    mac: await crypto.subtle.importKey("raw", key.authenticationKey as BufferSource,
      { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]),
  };
}

export class K9SchoolMeshCrypto implements K9MeshSecurity {
  private readonly keys = new Map<string, ReturnType<typeof importKeys>>();
  constructor(private readonly schoolId: string, keyring: K9SchoolMeshKey[]) {
    if (!VALID_ID.test(schoolId) || keyring.length === 0 || keyring.length > 4)
      throw new Error("Invalid K9 school mesh keyring");
    for (const key of keyring) {
      if (this.keys.has(key.keyId)) throw new Error("Duplicate K9 mesh key ID");
      this.keys.set(key.keyId, importKeys(key));
    }
  }
  async create(args: {
    originId: string; kind: K9MeshKind; message: string;
    keyId: string; now?: number; lifetimeMs?: number; hops?: number;
  }): Promise<K9MeshPacket> {
    const pair = this.keys.get(args.keyId);
    if (!pair || !VALID_ID.test(args.originId)) throw new Error("Unknown K9 mesh identity/key");
    const { aes, mac } = await pair;
    const plaintext = enc.encode(args.message);
    if (plaintext.length > MAX_MESSAGE_BYTES) throw new Error("Mesh message too large");
    const now = args.now ?? Date.now();
    const lifetime = args.lifetimeMs ?? 60_000;
    const hops = args.hops ?? 3;
    if (!Number.isSafeInteger(now) || !Number.isInteger(lifetime) ||
        lifetime <= 0 || lifetime > MAX_LIFETIME_MS ||
        !Number.isInteger(hops) || hops < 1 || hops > 7)
      throw new Error("Invalid mesh packet lifetime/hops");
    const id = base64url(crypto.getRandomValues(new Uint8Array(16)));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const packet: K9MeshPacket = {
      version: 1, id, schoolId: this.schoolId, originId: args.originId,
      kind: args.kind, createdAt: now, expiresAt: now + lifetime,
      maxHops: hops, remainingHops: hops, keyId: args.keyId,
      ciphertext: "", signature: "",
    };
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({
      name: "AES-GCM", iv: nonce, additionalData: associatedData(packet),
      tagLength: 128,
    }, aes, plaintext));
    const sealed = new Uint8Array(nonce.length + encrypted.length);
    sealed.set(nonce); sealed.set(encrypted, nonce.length);
    packet.ciphertext = base64url(sealed);
    packet.signature = base64url(new Uint8Array(await crypto.subtle.sign(
      "HMAC", mac, enc.encode(immutableFields(packet)))));
    return packet;
  }
  async verify(packet: K9MeshPacket): Promise<boolean> {
    if (!packet || packet.schoolId !== this.schoolId ||
        typeof packet.signature !== "string" ||
        typeof packet.ciphertext !== "string") return false;
    const pair = this.keys.get(packet.keyId);
    if (!pair) return false;
    try {
      const { mac } = await pair;
      const signature = unbase64url(packet.signature);
      if (signature.length !== 32) return false;
      return await crypto.subtle.verify("HMAC", mac, signature,
        enc.encode(immutableFields(packet)));
    } catch { return false; }
  }
  async open(packet: K9MeshPacket): Promise<K9MeshPlaintext> {
    if (!(await this.verify(packet))) throw new Error("K9 mesh authentication failed");
    const pair = this.keys.get(packet.keyId);
    if (!pair) throw new Error("Unknown mesh key");
    const { aes } = await pair;
    const sealed = unbase64url(packet.ciphertext);
    if (sealed.length < 29) throw new Error("Invalid encrypted mesh packet");
    const plaintext = await crypto.subtle.decrypt({
      name: "AES-GCM", iv: sealed.subarray(0, 12),
      additionalData: associatedData(packet), tagLength: 128,
    }, aes, sealed.subarray(12));
    return { kind: packet.kind, message: dec.decode(plaintext) };
  }
}
