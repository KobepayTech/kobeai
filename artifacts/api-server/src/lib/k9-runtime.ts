import { loadK9Models } from "./k9-models";

// Client for the local K9 model runtime (services/k9-runtime), which runs the
// registry's vision and audio models. Its address comes from the registry
// (runtime.k9_runtime) unless K9_RUNTIME_URL overrides it.

export type K9RuntimeEngine = {
  state: "loaded" | "available" | "missing" | "blocked" | "not_integrated" | "error" | string;
  models: string[];
  needs_packages: string[];
  missing_models: string[];
  error: string | null;
  note: string;
};

export type K9RuntimeHealth = {
  url: string;
  reachable: boolean;
  error: string | null;
  engines: Record<string, K9RuntimeEngine>;
};

export function k9RuntimeUrl(): string {
  const explicit = process.env["K9_RUNTIME_URL"];
  if (explicit) return explicit.replace(/\/$/, "");
  try {
    const runtime = loadK9Models().config.runtime?.k9_runtime;
    return `http://${runtime?.host ?? "127.0.0.1"}:${runtime?.port ?? 8766}`;
  } catch {
    return "http://127.0.0.1:8766";
  }
}

/** POSTs to the K9 runtime; throws with the runtime's own detail when it refuses. */
export async function k9RuntimePost<T>(route: string, body: unknown, timeoutMs = 60_000): Promise<T> {
  const secret = process.env["K9_RUNTIME_SECRET"];
  const res = await fetch(`${k9RuntimeUrl()}${route}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(secret ? { "x-k9-runtime-secret": secret } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    throw new Error(`K9 runtime ${route} answered HTTP ${res.status}: ${String(payload["detail"] ?? payload["error"] ?? "no detail")}`);
  }
  return payload as T;
}

export async function fetchK9RuntimeHealth(timeoutMs = 3_000): Promise<K9RuntimeHealth> {
  const url = k9RuntimeUrl();
  const secret = process.env["K9_RUNTIME_SECRET"];
  try {
    const res = await fetch(`${url}/health`, {
      headers: secret ? { "x-k9-runtime-secret": secret } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { url, reachable: false, error: `HTTP ${res.status}`, engines: {} };
    const body = (await res.json()) as { engines?: Record<string, K9RuntimeEngine> };
    return { url, reachable: true, error: null, engines: body.engines ?? {} };
  } catch (err) {
    return { url, reachable: false, error: err instanceof Error ? err.message : String(err), engines: {} };
  }
}
