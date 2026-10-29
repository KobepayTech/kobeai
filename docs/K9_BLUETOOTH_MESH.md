# K9 School Mesh — BitChat-inspired Bluetooth resilience

This is a **K9-specific adaptation of BitChat ideas**, not a fork, BitChat client,
or claim of BitChat wire-protocol interoperability.

Reference projects:
- https://github.com/permissionlesstech/bitchat
- https://github.com/permissionlesstech/bitchat-android

## What we adapt

| BitChat idea | K9 adaptation | Status |
| --- | --- | --- |
| BLE peer discovery | School-admin-provisioned **gateway** peers only; no anonymous school devices | Transport to build |
| Multi-hop relay | Seven-hop cap, packet ID dedup, short expiry, no backtracking to incoming peer | TypeScript router implemented |
| Store-and-forward | Bounded in-memory retry on gateway reconnect; durable encrypted spool next | Partial |
| Offline delivery | Alerts and gateway status travel over local mesh when LAN is down | Protocol core only; no radio driver |
| End-to-end encryption | Encrypted opaque payloads; required signature verification callback | Interface only; cryptography/key provisioning not implemented |
| Automatic network fallback | Prefer school LAN; use gateway-to-gateway BLE for small alerts only | To build |
| Wi-Fi Aware | Optional future higher-throughput gateway-to-gateway channel | Not implemented |

## The crucial separation

```text
K9 web app -- school Wi-Fi --> school K9 server -- LAN --> glasses gateway
                                                   |
                               provisioned BLE mesh between gateways
                                                   |
                                      MoYoung SDK -- BLE --> glasses
```

**Mesh BLE is between school gateways**, not assumed to run inside the
MoYoung glasses. The MoYoung AAR controls glasses using its own BLE protocol;
it does not turn the glasses into BitChat-compatible mesh relays. An Android
gateway can potentially support a second GATT advertising/scan service,
but simultaneous vendor SDK + mesh traffic requires real hardware testing.
For schools with many glasses, a separate radio or gateway may be needed.


## One compatible link: K9 Gateway BLE GATT

**Decision:** MoYoung glasses retain their existing, unchanged SDK BLE connection.
A school-owned Android gateway provides a **second, independent BLE GATT
link** to another provisioned K9 gateway. This link is our compatibility
adapter. It does not require MoYoung firmware or SDK mesh support.

```text
MoYoung glasses <-- vendor BLE --> Android K9 gateway
                                        |
                              K9 BLE GATT link
                                        |
                                Other K9 gateway
                                        |
                                   School server
```

The gateway must support BLE central and peripheral roles and enough
concurrent connections. A dedicated second Bluetooth controller or
separate gateway may be needed if the vendor SDK monopolizes the radio.
**Two gateways need not use the same vendor glasses SDK** to exchange K9
mesh packets. No claim is made that current glasses relay packets.

### Implemented link adapter

- `glasses/src/k9/K9GatewayMeshBridge.ts` defines the native-to-TypeScript
  `K9BleLink` contract and joins it to the existing K9 mesh router.
- Compact binary framing: protocol byte, eight-byte random message token,
  chunk index and total, plus payload. Reassembles out-of-order frames.
- Negotiated GATT characteristic value size, bounded 4 KiB packets,
  256-frame limit, 16 in-flight assemblies and 15-second assembly expiry.
- A link failure keeps the packet in the router for retry.
- Reassembled packets still require **school cryptographic verification** by
  `K9MeshRouter`. GATT pairing alone is not school authorization.

The native Android **BLE GATT characteristic implementation is still missing**.
A separate school-key enrollment and encryption implementation is also missing.
The TypeScript adapter is ready to connect to that driver but does not create
Bluetooth connections itself. BLE fragmentation is not a guarantee of reliable
delivery: implement link ACK, retries, flow control and MTU tests in the native
driver. For production, the gateway must authenticate provisioned peer
identities and reject unknown devices before forwarding.

### Required school-hardware validation

1. Pair glasses through MoYoung SDK on Android gateway A.
2. Establish the separate K9 GATT link from gateway A to gateway B.
3. Capture a real JPEG through MoYoung while relaying an encrypted status
   packet over the gateway link; verify neither transport stalls.
4. Disconnect school Wi-Fi; relay status over BLE and restore server sync.
5. Measure connection capacity, battery, latency and radio interference
   with 2, 10 and then more gateways. Never assume 200 concurrent glasses
   work from one gateway.

## Allowed traffic

The mesh router accepts only:
- `gateway.status`: encrypted, minimal operational heartbeat
- `gateway.alert`: encrypted, time-sensitive infrastructure alert
- `gateway.ack`: encrypted acknowledgement

**Do not send** exam photos, student names/IDs, grades, voiceprints, face images,
parent payments, login tokens or arbitrary teacher commands over opportunistic
BLE mesh. Full JPEGs use authenticated LAN upload with durable local spool.
Do not relay safety-critical fire alarm delivery solely through BLE mesh.

## Current implementation

`glasses/src/k9/K9MeshRouter.ts` provides:
- school-scoped validation and an injected cryptographic verification gate;
- short-lived encrypted envelopes (up to five minutes);
- max seven hops, packet ID dedup, loop suppression, and per-peer retry;
- bounded pending queue (256 messages) with explicit backpressure;
- strict payload-size limit; no raw exam/media payload kinds;
- concurrent flush protection, failure rollback, and unit tests.

This is an **application-layer router**, not a deployed radio mesh. The
`security.verify` callback must use a production cryptographic implementation
and trusted school keys; test stubs are not sufficient for deployment.
Packet `remainingHops` is mutable transport metadata, not an authorization
claim. Do not treat it as cryptographically protected or rely on it as a
security boundary.

## Next integration tasks

1. Build a separate Android gateway service with BLE advertising/scanning,
   explicit school device enrollment and authenticated GATT connections.
2. Integrate a real cryptographic key layer and authenticated per-school
   packet signatures. Define canonical signed fields and key rotation.
3. Replace in-memory retry with encrypted SQLite spool, acknowledgements,
   exponential backoff, queue quotas, and restart recovery.
4. Bridge gateway alerts to the K9 school server via authenticated HTTPS/WSS.
5. Add browser status view showing LAN, gateway and mesh states separately.
6. Validate vendor SDK concurrency, BLE radio throughput, power draw, and
   reconnection on real Android gateways.
7. Simulate school Wi-Fi loss, gateway power loss, duplicate relay, forged
   packet, cross-school isolation and queue exhaustion before deployment.

## Deployment principle

The web app remains the only teacher interface. A gateway is school hardware,
not an Android/iOS app installed on every teacher phone. Local school Wi-Fi
remains the primary path for photos, AI and records; mesh is a resilient,
**low-bandwidth auxiliary transport**.

## Implementation update — 29 October 2026

The following are now present on this development branch:

- `glasses/src/k9/K9SchoolMeshCrypto.ts`: AES-256-GCM encrypted
  operational payloads with per-school HMAC-SHA-256 integrity, authenticated
  associated data, bounded lifetimes, and up to four key IDs for rotation.
  School keys must be independently provisioned into gateway secure storage;
  do not place them in the teacher web app or commit them to Git.
- `glasses/android/app/src/main/java/tz/kobe/glasses/K9GatewayGattLink.kt`:
  native Android GATT peripheral + explicit bonded-peer central link using
  the **independent K9 service UUID**, separate from the MoYoung SDK.
  The link supports negotiated MTU, encrypted GATT writes, notifications,
  callback-based frame acknowledgements, and serial frame writes.
- `glasses/tests/mesh-crypto.test.ts`: key rotation, encrypted round-trip,
  forgery rejection and school isolation.

**Do not confuse source-code availability with an end-to-end deployment.**
The native Android driver is not yet wired into a long-lived gateway service,
school enrollment, or the TypeScript bridge. There is no tested live Bluetooth
connection, no persistent encrypted queue, and no server-to-webapp event API.
A bonded Bluetooth MAC is not an identity proof: production gateway enrollment
must authenticate a device key and bind it to the school.

### Remaining release blockers

1. Wire `K9GatewayGattLink` callbacks to `K9GatewayMeshBridge` through a
   production gateway process and provisioned identity mapping.
2. Provision keys with Android Keystore / device management, not embedded
   source constants. Rotate and revoke compromised gateway credentials.
3. Add encrypted durable outbox with message ACK, retry after process death,
   and idempotent school-server ingestion.
4. Implement authenticated school API and browser status/alerts; do not allow
   arbitrary mesh commands to trigger cameras or student-record mutations.
5. Complete CI Android build, instrumented BLE tests on two actual gateways,
   MoYoung concurrent radio tests, and offline/online recovery tests.
6. Verify Android 12+ BLE runtime permissions and background service behavior,
   plus vendor SDK licensing and offline authorization requirements.

The design borrows BitChat's bounded multi-hop routing, store-and-forward and
offline-first principles. It **does not** embed BitChat's application, Nostr,
anonymous public channels, or BitChat packet protocol.
