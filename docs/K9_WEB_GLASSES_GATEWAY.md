# K9 Web Glasses Gateway — browser-first, no teacher Android/iOS application

## Decision

K9 teachers use the **same HTTPS web app on Android, iOS, Windows and macOS**. The browser does **not** need Bluetooth permissions, a proprietary SDK, or a native wrapper. Glasses pair to a **nearby dedicated hardware gateway**. The gateway owns Bluetooth/Wi-Fi hardware and SDK sessions and exposes authenticated commands to the school K9 server; the web app sends capture requests to the school server, not directly to glasses.

```text
Teacher browser (K9 web UI) --HTTPS/WSS--> K9 school API + event bus + AI + DB
                                                  |
                                         authenticated gateway session
                                                  |
                                  room gateway (BLE + Wi-Fi; native SDK)
                                                  |
                                      MoYoung / DA ECHO glasses
```

The **school server** is the central control plane, authorization authority, capture archive, AI processor and student database. The **gateway** is the physical radio/data plane. These can be the same physical machine *only if* the SDK runs on its operating system and the radios reach the glasses.

## Crucial SDK constraint

The current MoYoung implementation is an **Android AAR**, which cannot simply run in Node.js, Linux, Windows, or Cloudflare Workers. A compatible Android host near the glasses can run the SDK **headlessly as a gateway** (no teacher UI). If we obtain a licensed Linux/Windows SDK or documented BLE/Wi-Fi protocol, the gateway can instead be a small Linux box or the K9 school server itself. Do not promise that a virtualized Android instance can reliably access BLE and P2P radios without a verified passthrough path.

## User experience

1. Administrator provisions a gateway to a specific school and room using one-time credentials.
2. Gateway discovers and pairs permitted glasses locally, then reconnects independently of the teacher's browser.
3. Teacher signs into K9 web app, opens **Connections**, selects the authorized room/glasses, and starts exam marking.
4. Browser sends `capture.request` with exam ID and an idempotent request ID to K9 server.
5. Server checks teacher/room/exam authorization, publishes request to the correct connected gateway.
6. Gateway issues vendor SDK capture command and **waits for actual JPEG bytes**, not just command acknowledgement.
7. Gateway uploads JPEG and capture metadata to the school server over authenticated LAN HTTPS; server records a durable receipt and returns status.
8. K9 AI extracts paper/answers/marks. Teacher reviews uncertain results before finalizing the student record.
9. Browser receives `capture.completed`, `capture.failed`, and connection-state updates over WSS or authenticated SSE.

## Suggested authenticated protocol (design contract, not yet implemented)

- Gateway -> server: `gateway.hello {gatewayId, schoolId, roomId, capabilities, sdkVersion}`
- Gateway -> server: `glasses.status {deviceId, state, battery, lastSeenAt}`
- Browser -> server: `POST /api/v1/glasses/captures {deviceId, examId, requestId}`
- Server -> gateway: `capture.request {requestId, deviceId, examId, expiresAt}`
- Gateway -> server: `capture.accepted {requestId}`
- Gateway -> server: `capture.image {requestId, sha256, mimeType, bytes, capturedAt}` (binary transfer over authenticated upload endpoint, not JSON base64)
- Server -> browser: `capture.completed {requestId, paperId}` or `capture.failed {requestId, reason}`
- Server -> gateway: `capture.cancel {requestId}`

Use per-gateway short-lived credentials with rotation, tenant-scoped authorization, replay protection, rate limits, image size limits, audit logs and TLS. Never expose an unauthenticated BLE gateway or local HTTP server to the school network. Do not send teacher access tokens to a gateway.

## Offline continuity

- **No internet, LAN up:** K9 school server, gateway and web app work normally. Local K9 AI runs on the school machine.
- **School server temporarily down:** Gateway can spool encrypted JPEGs with stable capture IDs and retry; however, it must not independently assign marks or student IDs. Teacher web app can open its offline shell but live gateway control is unavailable until the server returns, unless a separately authorized direct-LAN fallback is built.
- **Teacher browser offline:** The gateway remains connected to glasses. Previously queued commands must have short expiries to avoid capturing at an unexpected time when the browser reconnects.
- **Cloud recovery:** school server synchronizes authorized records to cloud using a separately implemented durable outbox, not blind dual writes.

## Capacity and deployment

One gateway is **not** assumed to handle 200 BLE glasses simultaneously. Benchmark actual MoYoung connection limits, photo transfer latency, Wi-Fi/P2P contention, radio range and SDK concurrency. Provision multiple gateways per school/room with exclusive device leases. Record capture throughput and p95 delivery latency. No continuous video streaming is assumed.

## Migration from current code

- Retain `artifacts/teacher-lens/` as the universal web UI.
- Retain `glasses/android/` SDK code but turn it into a dedicated **gateway application/service**, not the teacher's app.
- Add server-side gateway registry, pairing assignment, authenticated command bus, capture ingestion and event stream.
- Add a `RemoteGatewayAdapter` to `artifacts/teacher-lens/src/glasses.tsx` so K9 can choose server-connected glasses or the local phone camera.
- Keep `artifacts/teacher-lens/src/uploadQueue.ts` for phone-camera capture; gateway photographs require a separate durable gateway spool and idempotent server ingestion.
- Build and test gateway SDK integration on real glasses. Current SDK implementation is not yet validated for headless service mode.

## Acceptance tests

- Same K9 URL controls assigned glasses from Safari iOS, Chrome Android, and desktop browsers without installing a teacher app.
- Two teachers cannot capture through each other's assigned glasses; no cross-school leakage.
- Capture returns actual JPEG and is associated with the correct exam; duplicate request IDs produce one stored capture.
- Internet disabled, LAN available: capture, AI marking and review still work.
- Browser refresh, gateway disconnect/reconnect, school server restart, low storage and glasses power-off produce visible recoverable states.
- 10/50/200-glasses tests record throughput and radio contention before capacity claims.
