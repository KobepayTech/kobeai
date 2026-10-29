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
