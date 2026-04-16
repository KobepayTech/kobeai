# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## KobeAI Print System (api-server)

- **Auth**: JWT bearer tokens issued by `/auth/*` and `/watch/login` routes; `requireAuth(roles?)` middleware (`lib/auth.ts`) protects all `/watch/*`, `/parent/*`, `/teacher/*`, and the watch-facing print routes (`/print/pairing/:id`, `/print/pairing-for-session/:id`, `/print/submit`, `/print/jobs/:id`). Tap-box endpoints (`/print/pair`, `/print/next`, `/print/jobs/:id/document`, `/print/jobs/:id/status`) still use `x-tap-box-secret`. Only the login routes themselves are public. Print routes additionally enforce per-student ownership; teacher routes restrict reads/writes to the teacher's own classes/documents (admin can act on all). `JWT_SECRET` is required in non-development environments — startup fails fast if unset.
- **Data model** (`@workspace/db`): `users`, `classes`, `class_memberships`, `documents`, `document_assignments`. Seed (`lib/seed.ts`) is idempotent and uploads two demo PDFs to object storage assigned to Form 1A.
- **Documents**: teacher uploads via presigned object-storage URL (`POST /teacher/documents/upload-url`), then registers (`POST /teacher/documents`) and assigns to class (`POST /teacher/documents/:docId/assign` with `{ class_id }`). Print pair endpoint resolves available files via class_memberships → document_assignments → documents joins; tap-box `/document` streams real bytes from object storage.
- **PrintStore** (`lib/print-store.ts`): pluggable store for pairings, jobs, and nonces. `RedisStore` (when `REDIS_URL` set) uses `SET EX/NX` for atomic nonce reservation and `LIST` per-printer queues. `MemoryStore` is the in-process fallback for dev. Restart persistence verified end-to-end with redis on port 6399.
- **Demo creds preserved**: student `TEST001/1234`, teacher `teacher@school.tz/teacher123`, admin `admin@school.tz/admin123`, parent pin `1234`. Watch APK does not need to be rebuilt — existing demo login flow now returns JWTs transparently.
- **Object storage env**: `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS`, `PRIVATE_OBJECT_DIR` are required.
