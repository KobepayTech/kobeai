// Both `./generated/api` (route-level zod schemas) and `./generated/types`
// (per-model zod schemas) are produced by orval and share many identical
// names. Consumers only ever need the route-level schemas, so we re-export
// `api.ts` only to avoid TS2308 duplicate-export errors. Anything from
// `./generated/types` can still be imported directly via subpath if needed.
export * from "./generated/api";
