function authHeader(): Record<string, string> {
  const t = localStorage.getItem("parent_token");
  return t ? { Authorization: `Bearer ${t}` } : {};
}

// Path-based routing: the Replit proxy routes "/api/*" to the api-server
// artifact regardless of which artifact the request originates from, so we
// always use an absolute "/api/..." URL (matching what the codegen client does).
export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { headers: authHeader() });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
