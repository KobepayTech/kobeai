# K9 offline / online continuity (KobeOS-style local-first foundation)

K9 follows the same **local-first** principle as KobeOS: the school computer/server is the authority for school records, and internet availability is not required when the phone can reach that school server over school Wi-Fi or a school hotspot.

## Connectivity and authority

| State | Teacher app | Examination data | AI |
| --- | --- | --- | --- |
| School Wi-Fi or hotspot, internet unavailable | Uses configured school server over LAN; all server endpoints remain available if the school server and local models are running. | School database remains authoritative. | Local models, if installed and healthy. |
| Internet available and school server reachable | Same school server and teacher account. | Same school database. | School-local AI, with separately configured specialist services where authorized. |
| Phone disconnected from school server | Production PWA shell can reopen offline after a successful online installation; bundled Android shell has its own assets. Camera can continue saving photos in IndexedDB. | Photos are queued under the **original school URL and teacher identity**. They do not appear as marked results until the school server accepts them and a teacher confirms them. | No server-backed OCR or AI result is claimed while disconnected. |
| Connection restored | Automatic upload retries, with capture-id idempotency; teacher can also retry manually. | Teacher confirms results; server writes student records and generates follow-up learning material. | Local school AI resumes. |

### Implemented browser behavior

- Production browser PWA registers `sw.js` for an offline shell. The worker precaches the generic HTML and built JavaScript/CSS and only runtime-caches static `/assets/` resources.
- **Never cache `/api/` or `/auth/` responses** in the service worker: these can contain sensitive student data, and a shared phone must not show another teacher's records.
- Captured photos use `uploadQueue.ts` IndexedDB stores, not the service-worker cache. Queues are isolated by school URL and authenticated teacher. Photos are retained until accepted; retries are idempotent.
- Phone camera or explicitly selected glasses must provide actual image bytes. There is no silent substitution from glasses to phone.
- Offline queue is finite (240 unsent photos or 160 MiB per account); it stops accepting new captures when full instead of silently discarding them.
- A teacher's selected examination ID is stored with each queued photograph, including across restarts.
- The connection indicator distinguishes an offline device from an unreachable school server.

### Security and limits

- **No automatic switching to an unrelated cloud API.** A token minted by one school server must never be sent to a second endpoint without a verified shared trust/tenant identity and explicit authentication. The existing queue deliberately pins every photo to its original school and teacher.
- The school LAN/hotspot must expose the same authenticated K9 API; on Android, use trusted HTTPS with a valid certificate. The phone cannot simply treat a disconnected Wi-Fi connection as a working school server.
- This change does not implement KobeOS's multi-node PostgreSQL replication, cloud disaster recovery, bidirectional conflict resolution, or a second writable cloud school database. Those require a separate, authenticated sync protocol with durable outboxes and reconciliation, not blind last-write-wins.
- The PWA shell must be opened successfully once while online to be available offline. The Android app already bundles its shell. Teacher sign-in requires a reachable school server on first login.
- A service worker is not a guarantee of background sync after the browser is closed. Upload retries resume when the app is running and connectivity returns.
- Local AI requires a running school AI server and the required models; cached HTML does not run AI inference on the phone.

## Verification

The `artifacts/teacher-lens/tests/upload-queue.cjs` browser tests cover offline app-shell reload, absence of student API responses in service-worker caches, queued uploads, restart recovery, teacher isolation, and examination ID persistence. Android builds and physical MoYoung/DA ECHO capture must still be validated on real hardware before school rollout.
