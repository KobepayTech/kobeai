const BASE = import.meta.env.BASE_URL;

export function authHeader(): Record<string, string> {
  const t = localStorage.getItem("teacher_token");
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}api${path}`, { headers: authHeader() });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}api${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

export async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}api${path}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}api${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeader() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}api${path}`, { method: "DELETE", headers: authHeader() });
  if (!res.ok) throw new ApiError(res.status, await res.text());
  return res.json();
}

/** The readable part of an API error: the JSON `error`/`detail` field when there is one. */
export function apiErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  try {
    const body = JSON.parse(err.message);
    return body.detail ?? body.error ?? err.message;
  } catch {
    return err.message;
  }
}

export async function uploadToPresigned(url: string, file: File): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/pdf" },
    body: file,
  });
  if (!res.ok) throw new ApiError(res.status, `Upload failed: ${res.status}`);
}
