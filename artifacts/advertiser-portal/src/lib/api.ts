function authHeader(): Record<string, string> {
  const t = localStorage.getItem("adv_token");
  return t ? { Authorization: `Bearer ${t}` } : {};
}

async function handle<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let msg = `HTTP ${res.status}`;
    try {
      const j = JSON.parse(text);
      if (j.error) msg = j.error;
    } catch {
      if (text) msg = text;
    }
    throw new Error(msg);
  }
  return res.json();
}

// Ads exchange runs as a separate Express service mounted by the platform
// proxy at `/ads-api/*`. The advertiser portal calls only ad-exchange
// endpoints, so every path here is prefixed with `/ads-api`.
const BASE = "/ads-api";

export async function apiGet<T>(path: string): Promise<T> {
  return handle<T>(await fetch(`${BASE}${path}`, { headers: authHeader() }));
}

export async function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return handle<T>(
    await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    }),
  );
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return handle<T>(
    await fetch(`${BASE}${path}`, {
      method: "PATCH",
      headers: { ...authHeader(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

export async function apiDelete<T>(path: string): Promise<T> {
  return handle<T>(
    await fetch(`${BASE}${path}`, { method: "DELETE", headers: authHeader() }),
  );
}
