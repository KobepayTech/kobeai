// The hub side: how glasses reach K9. This deliberately calls the endpoints the
// school server already has for Teacher Lens — frames, whispers, lookup and the
// classroom assistant — instead of adding a second API to keep in step.

export type K9ApiOptions = {
  /** e.g. http://192.168.1.10:8088 — the K9 school server on the LAN. */
  baseUrl: string;
  /** The teacher's own token; glasses act as that teacher, never as a kiosk. */
  token: string;
  fetchImpl?: typeof fetch;
};

export type LensFrameQueued = { requestId: number | null; imageKey: string | null };

export type LensFrameResult = {
  id: number;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  kind: string;
  response: Record<string, unknown> | null;
};

export class K9Api {
  private fetchImpl: typeof fetch;

  constructor(private options: K9ApiOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.options.baseUrl.replace(/\/$/, "")}/api${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.options.token}`, ...extra };
  }

  private async json<T>(path: string, init: RequestInit): Promise<T> {
    const res = await this.fetchImpl(this.url(path), init);
    if (!res.ok) throw new Error(`K9 ${path} answered HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Starts a lens session so whispers and frames are attributed to it. */
  async startSession(mode: "lookup" | "marking" = "lookup"): Promise<number> {
    const body = await this.json<{ session: { id: number } }>("/v1/teacher-lens/session", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ mode, device: "kobe-glasses" }),
    });
    return body.session.id;
  }

  async endSession(sessionId: number): Promise<void> {
    await this.fetchImpl(this.url(`/v1/teacher-lens/session/${sessionId}/end`), {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: "{}",
    }).catch(() => undefined);
  }

  /**
   * Sends a photo from the glasses. `mode` "lookup" recognises the student's
   * face; "mark" hands the paper to the K9 brain to read.
   */
  async sendFrame(
    bytes: Uint8Array,
    opts: { sessionId: number | null; mode: "lookup" | "mark"; examId?: number | null },
  ): Promise<LensFrameQueued> {
    const body = await this.json<{ request?: { id: number }; image_key?: string }>("/v1/teacher-lens/frame", {
      method: "POST",
      headers: this.headers({
        "content-type": "image/jpeg",
        "x-lens-session-id": String(opts.sessionId ?? ""),
        "x-lens-mode": opts.mode,
        ...(opts.examId ? { "x-lens-exam-id": String(opts.examId) } : {}),
      }),
      body: bytes as unknown as BodyInit,
    });
    return { requestId: body.request?.id ?? null, imageKey: body.image_key ?? null };
  }

  async frameResult(requestId: number): Promise<LensFrameResult> {
    return this.json<LensFrameResult>(`/v1/teacher-lens/frame/${requestId}`, { headers: this.headers() });
  }

  /** The next line K9 wants said in the teacher's ear, or null when quiet. */
  async nextWhisper(sessionId: number | null): Promise<string | null> {
    const res = await this.fetchImpl(
      this.url(`/v1/teacher-lens/whisper/next${sessionId ? `?session_id=${sessionId}` : ""}`),
      { headers: this.headers() },
    );
    if (res.status === 204 || !res.ok) return null;
    const body = (await res.json()) as { whisper?: { text?: string } };
    return body.whisper?.text ?? null;
  }

  /** The student brief K9 speaks and the glasses can show. */
  async lookup(studentCode: string, sessionId: number | null, quiet = false): Promise<{ student_name: string | null; whisper: string }> {
    return this.json("/v1/teacher-lens/lookup", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ student_code: studentCode, session_id: sessionId, quiet }),
    });
  }

  /** Remembers the face in a frame the glasses already sent. */
  async rememberFace(studentCode: string, imageKey: string): Promise<void> {
    await this.json("/v1/teacher-lens/enroll-face", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ student_code: studentCode, image_key: imageKey }),
    });
  }

  /** A question for the K9 brain, answered by the school's own models. */
  async ask(question: string, subject?: string): Promise<string> {
    const body = await this.json<{ answer?: string }>("/v1/classroom/ask", {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify({ question, ...(subject ? { subject } : {}) }),
    });
    return body.answer ?? "";
  }
}
