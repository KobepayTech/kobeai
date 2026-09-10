import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// KobeAI Lens — a phone/glasses PWA for the teacher.
//
// Two modes:
//   Lookup      — teacher looks at a student, taps the shutter, and the
//                 phone speaks a whisper through the connected earbud
//                 ("Asha. Last Biology: 92 percent. Weak in Newton's laws.")
//   Mark paper  — teacher grades a paper. On shutter, a sheet slides up
//                 with an editable list of items (question → student
//                 answer → correct/wrong). "Send to KobeAI" submits.
//
// The camera streams via getUserMedia. Actual face-recognition / OCR
// happens server-side on the K9 GPU box; this client just captures a
// frame and posts JSON with whatever the teacher typed.
//
// Login is a one-time teacher email + password, cached in localStorage.
// Kept intentionally minimal — everything about lens style + workflow is
// the point, not auth chrome.
// ---------------------------------------------------------------------------

const DEFAULT_API_BASE =
  (import.meta.env.VITE_KOBEAI_API_BASE as string | undefined) ?? "";

type Mode = "lookup" | "mark";

type StoredAuth = {
  api_base: string;
  token: string;
  teacher_name: string;
};

function loadAuth(): StoredAuth | null {
  try {
    const raw = localStorage.getItem("k9-lens.auth");
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed?.token && parsed?.api_base) return parsed as StoredAuth;
    return null;
  } catch {
    return null;
  }
}

function saveAuth(a: StoredAuth): void {
  localStorage.setItem("k9-lens.auth", JSON.stringify(a));
}

function clearAuth(): void {
  localStorage.removeItem("k9-lens.auth");
}

async function apiPost<T>(auth: StoredAuth, path: string, body: unknown): Promise<T> {
  const res = await fetch(`${auth.api_base}/api${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${auth.token}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

async function apiGet<T>(auth: StoredAuth, path: string): Promise<T | null> {
  const res = await fetch(`${auth.api_base}/api${path}`, {
    headers: { authorization: `Bearer ${auth.token}` },
  });
  if (res.status === 204) return null;
  if (!res.ok) return null;
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------
// TTS whisper: use the platform SpeechSynthesis so the phone speaks
// through whatever audio output the OS is routed to (a paired earbud in
// practice). Falls back gracefully on browsers without support.
// ---------------------------------------------------------------------------
function speak(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.05;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

// ---------------------------------------------------------------------------
// Setup screen — one-time login. Uses the existing /v1/auth/teacher/login.
// ---------------------------------------------------------------------------
function Setup({ onReady }: { onReady: (a: StoredAuth) => void }) {
  const [apiBase, setApiBase] = useState(DEFAULT_API_BASE);
  const [email, setEmail] = useState("teacher@school.tz");
  const [password, setPassword] = useState("teacher123");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const login = async () => {
    setErr(null);
    setBusy(true);
    try {
      const base = apiBase.replace(/\/$/, "") || window.location.origin;
      const res = await fetch(`${base}/api/v1/auth/teacher/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text().catch(() => "")}`);
      const body = await res.json();
      const auth: StoredAuth = {
        api_base: base,
        token: body.access_token,
        teacher_name: body.teacher_name ?? "Teacher",
      };
      saveAuth(auth);
      onReady(auth);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="setup">
      <h1>
        <span style={{ color: "var(--brand-green)" }}>KobeAI</span> Lens
      </h1>
      <p style={{ color: "var(--brand-muted)", marginTop: -6, marginBottom: 20 }}>
        The teacher-worn phone / glasses client. Sign in once — the phone stays
        paired to the school after that.
      </p>
      <label>School server URL</label>
      <input value={apiBase} onChange={(e) => setApiBase(e.target.value)} placeholder="https://school.local" />
      <label>Email</label>
      <input value={email} onChange={(e) => setEmail(e.target.value)} />
      <label>Password</label>
      <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" />
      <button className="setup-btn" onClick={login} disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
      {err && <p style={{ color: "var(--brand-danger)", marginTop: 14 }}>{err}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Camera hook — starts a rear-facing video stream + gives back a
// captureFrame() that returns a data URL. The captured image is optional
// (server accepts the structured event without it) but ready for a future
// wire-up to /v1/teacher-lens/frame.
// ---------------------------------------------------------------------------
function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let stream: MediaStream | null = null;
    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        });
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
          setReady(true);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => stream?.getTracks().forEach((t) => t.stop());
  }, []);
  const captureFrame = useCallback((): string | null => {
    const v = videoRef.current;
    if (!v || v.videoWidth === 0) return null;
    const canvas = document.createElement("canvas");
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(v, 0, 0);
    return canvas.toDataURL("image/jpeg", 0.7);
  }, []);
  return { videoRef, ready, err, captureFrame };
}

// ---------------------------------------------------------------------------
// Whisper poll — drains /v1/teacher-lens/whisper/next every couple of
// seconds and speaks each one. Session-scoped so a different phone on
// the same account doesn't intercept another teacher's whispers.
// ---------------------------------------------------------------------------
function useWhisperPoll(auth: StoredAuth, sessionId: number | null) {
  useEffect(() => {
    if (sessionId == null) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await apiGet<{ whisper: { text: string } }>(
          auth,
          `/v1/teacher-lens/whisper/next?session_id=${sessionId}`,
        );
        if (!cancelled && res?.whisper?.text) speak(res.whisper.text);
      } catch {
        // ignore — next tick retries
      }
    };
    const t = setInterval(tick, 2000);
    tick();
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [auth, sessionId]);
}

// ---------------------------------------------------------------------------
// Mode: Lookup
// ---------------------------------------------------------------------------
type StudentBrief = {
  student_code: string;
  student_name: string | null;
  whisper: string;
  profile: {
    topics_strong: string[];
    topics_weak: string[];
    attendance_rate: number | null;
    questions_asked_count: number;
  };
  recent_papers: Array<{
    assessment_title: string | null;
    subject: string | null;
    score_percent: number | null;
    graded_at: string;
  }>;
};

function LookupPanel({
  auth,
  sessionId,
  onClose,
  brief,
}: {
  auth: StoredAuth;
  sessionId: number | null;
  onClose: () => void;
  brief: StudentBrief | null;
}) {
  if (!brief) return null;
  return (
    <div className="lens-sheet" onClick={onClose}>
      <div className="lens-sheet-body" onClick={(e) => e.stopPropagation()}>
        <h2>{brief.student_name ?? brief.student_code}</h2>
        <p style={{ color: "var(--brand-green)", marginBottom: 12 }}>{brief.whisper}</p>
        <div className="lens-pill-row">
          {brief.profile.topics_strong.map((t) => (
            <span key={"s-" + t} className="lens-pill lens-pill-strong">Strong · {t}</span>
          ))}
          {brief.profile.topics_weak.map((t) => (
            <span key={"w-" + t} className="lens-pill lens-pill-weak">Weak · {t}</span>
          ))}
          {brief.profile.attendance_rate != null && (
            <span className="lens-pill lens-pill-strong">Attendance {brief.profile.attendance_rate}%</span>
          )}
        </div>
        {brief.recent_papers.length > 0 && (
          <>
            <p style={{ color: "var(--brand-muted)", fontSize: 12, marginBottom: 6, marginTop: 8 }}>Recent papers</p>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {brief.recent_papers.slice(0, 5).map((p, i) => (
                <li
                  key={i}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    padding: "8px 0",
                    borderBottom: "1px solid var(--brand-card-border)",
                    fontSize: 14,
                  }}
                >
                  <span>
                    {p.assessment_title ?? "Untitled paper"}
                    {p.subject && (
                      <span style={{ color: "var(--brand-muted)", marginLeft: 6 }}>· {p.subject}</span>
                    )}
                  </span>
                  <span
                    style={{
                      fontWeight: 700,
                      color:
                        (p.score_percent ?? 0) >= 80
                          ? "var(--brand-green)"
                          : (p.score_percent ?? 0) >= 60
                            ? "var(--brand-warn)"
                            : "var(--brand-danger)",
                    }}
                  >
                    {p.score_percent ?? "—"}%
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
        <div className="mark-actions">
          <button className="mark-primary" onClick={() => { speak(brief.whisper); }}>
            Repeat whisper
          </button>
          <button
            className="mark-ghost"
            onClick={async () => {
              // Ask K9 for a longer summary via the on-prem tutor.
              try {
                const r = await apiPost<{ answer: string }>(auth, "/v1/watch/ask", {
                  question: `Summarise ${brief.student_name ?? brief.student_code} in three sentences for their teacher.`,
                });
                if (r?.answer) speak(r.answer);
              } catch {
                speak("Kobe is offline right now.");
              }
            }}
          >
            Ask Kobe
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode: Mark paper
// ---------------------------------------------------------------------------
type MarkItem = {
  question_number: number;
  question_topic: string;
  student_answer: string;
  expected_answer: string;
  is_correct: boolean;
};

function newItem(n: number): MarkItem {
  return {
    question_number: n,
    question_topic: "",
    student_answer: "",
    expected_answer: "",
    is_correct: true,
  };
}

function MarkPanel({
  auth,
  sessionId,
  onClose,
}: {
  auth: StoredAuth;
  sessionId: number | null;
  onClose: () => void;
}) {
  const [studentCode, setStudentCode] = useState("");
  const [subject, setSubject] = useState("");
  const [assessment, setAssessment] = useState("");
  const [items, setItems] = useState<MarkItem[]>(() => [newItem(1)]);
  const [busy, setBusy] = useState(false);

  const patch = (i: number, k: keyof MarkItem, v: MarkItem[keyof MarkItem]) => {
    setItems((prev) => {
      const copy = prev.slice();
      copy[i] = { ...copy[i], [k]: v } as MarkItem;
      return copy;
    });
  };

  const submit = async () => {
    if (!studentCode.trim()) return;
    setBusy(true);
    try {
      const payload = {
        session_id: sessionId,
        student_code: studentCode.trim(),
        subject: subject.trim() || undefined,
        assessment_title: assessment.trim() || undefined,
        items: items.filter(
          (it) => it.expected_answer.trim() !== "" || it.student_answer.trim() !== "",
        ),
      };
      if (payload.items.length === 0) {
        speak("Add at least one question first.");
        setBusy(false);
        return;
      }
      const r = await apiPost<{
        summary: { total: number; correct: number; score_percent: number | null };
        curated_notes_generated: number;
        retest: { retest_id: number; items: number } | null;
      }>(auth, "/v1/teacher-lens/paper-graded", payload);
      const parts: string[] = [];
      parts.push(
        `Saved ${studentCode}: ${r.summary.correct} of ${r.summary.total}` +
          (r.summary.score_percent != null ? `, ${r.summary.score_percent} percent` : "") +
          ".",
      );
      if (r.curated_notes_generated > 0) {
        parts.push(
          `${r.curated_notes_generated} curated note${r.curated_notes_generated === 1 ? "" : "s"} ready.`,
        );
      }
      if (r.retest) {
        parts.push(
          `Retest ${r.retest.items} question${r.retest.items === 1 ? "" : "s"} queued.`,
        );
      }
      speak(parts.join(" "));
      onClose();
    } catch (err) {
      speak("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lens-sheet" onClick={onClose}>
      <div className="lens-sheet-body" onClick={(e) => e.stopPropagation()}>
        <h2>Mark paper</h2>
        <p>Fill only what you need — the vision worker will fill the rest later.</p>
        <label style={{ display: "block", fontSize: 12, color: "var(--brand-muted)", marginBottom: 4 }}>Student code</label>
        <input className="mark-input" value={studentCode} onChange={(e) => setStudentCode(e.target.value)} placeholder="K9-002" />
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <input className="mark-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
          <input className="mark-input" value={assessment} onChange={(e) => setAssessment(e.target.value)} placeholder="Assessment title" />
        </div>

        {items.map((it, i) => (
          <div key={i} className="mark-item">
            <div className="mark-item-header">
              <span className="q">Q{it.question_number}</span>
              <div className="mark-toggle">
                <button
                  className={it.is_correct ? "on-right" : ""}
                  onClick={() => patch(i, "is_correct", true)}
                >
                  ✓ Right
                </button>
                <button
                  className={!it.is_correct ? "on-wrong" : ""}
                  onClick={() => patch(i, "is_correct", false)}
                >
                  ✗ Wrong
                </button>
              </div>
            </div>
            <input
              className="mark-input"
              value={it.question_topic}
              onChange={(e) => patch(i, "question_topic", e.target.value)}
              placeholder="Topic (e.g. multiplication basics)"
            />
            <input
              className="mark-input"
              value={it.student_answer}
              onChange={(e) => patch(i, "student_answer", e.target.value)}
              placeholder="Student's answer"
            />
            <input
              className="mark-input"
              value={it.expected_answer}
              onChange={(e) => patch(i, "expected_answer", e.target.value)}
              placeholder="Correct answer"
            />
          </div>
        ))}
        <button className="mark-add" onClick={() => setItems((p) => [...p, newItem(p.length + 1)])}>
          + Add another question
        </button>
        <div className="mark-actions">
          <button className="mark-primary" onClick={submit} disabled={busy || !studentCode.trim()}>
            {busy ? "Sending…" : "Send to KobeAI"}
          </button>
          <button className="mark-ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export function App() {
  const [auth, setAuth] = useState<StoredAuth | null>(() => loadAuth());
  const [mode, setMode] = useState<Mode>("lookup");
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [lookupBrief, setLookupBrief] = useState<StudentBrief | null>(null);
  const [markOpen, setMarkOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { videoRef, ready: camReady, err: camErr, captureFrame } = useCamera();

  // Start a session as soon as we have auth.
  useEffect(() => {
    if (!auth || sessionId != null) return;
    (async () => {
      try {
        const r = await apiPost<{ session: { id: number } }>(auth, "/v1/teacher-lens/session", {
          mode,
          device: navigator.userAgent,
        });
        setSessionId(r.session.id);
      } catch {
        setToast("Couldn't start lens session — check the server URL.");
      }
    })();
  }, [auth, mode, sessionId]);

  useWhisperPoll(auth ?? ({ api_base: "", token: "", teacher_name: "" } as StoredAuth), sessionId);

  // End the session on page hide (bfcache-friendly). Best effort.
  useEffect(() => {
    const handler = () => {
      if (auth && sessionId != null) {
        navigator.sendBeacon?.(
          `${auth.api_base}/api/v1/teacher-lens/session/${sessionId}/end`,
          new Blob([JSON.stringify({})], { type: "application/json" }),
        );
      }
    };
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  }, [auth, sessionId]);

  // Toast auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(t);
  }, [toast]);

  const onShutter = useCallback(async () => {
    if (!auth) return;
    // Priming the SpeechSynthesis on the first user gesture is critical
    // on iOS/Android — later background whispers only fire if we've spoken
    // at least once from a direct tap.
    speak(mode === "lookup" ? "Looking up." : "Ready to mark.");
    captureFrame(); // future: upload for on-device-less face rec

    if (mode === "lookup") {
      // For now the client asks the teacher which student they're looking
      // at via a small prompt. The full flow will use face recognition
      // via /v1/teacher-lens/frame once the vision worker is wired.
      const guess = window.prompt("Student code you're looking at:", "K9-001");
      const studentCode = guess?.trim();
      if (!studentCode) return;
      try {
        const r = await apiPost<StudentBrief>(auth, "/v1/teacher-lens/lookup", {
          student_code: studentCode,
          session_id: sessionId,
        });
        setLookupBrief(r);
      } catch (err) {
        setToast(err instanceof Error ? err.message : "lookup failed");
      }
    } else {
      setMarkOpen(true);
    }
  }, [auth, mode, sessionId, captureFrame]);

  const uptimeLabel = useMemo(() => `Session ${sessionId ?? "starting…"}`, [sessionId]);

  if (!auth) {
    return <Setup onReady={setAuth} />;
  }

  return (
    <div className="lens">
      <header className="lens-header">
        <div>
          <div className="lens-brand">
            <span className="k">Kobe</span>AI Lens
          </div>
          <div className="lens-mode">
            <span className={"lens-status-dot " + (camReady ? "ok" : "bad")} />
            {mode === "lookup" ? "Lookup" : "Mark paper"} · {uptimeLabel}
          </div>
        </div>
        <button
          className="lens-secondary"
          style={{ padding: "8px 12px", fontSize: 12 }}
          onClick={() => {
            clearAuth();
            setAuth(null);
          }}
        >
          Sign out
        </button>
      </header>

      <div className="lens-viewport">
        <video ref={videoRef} playsInline muted />
        {!camReady && !camErr && (
          <div className="frame-cover">Requesting camera access…</div>
        )}
        {camErr && (
          <div className="frame-cover">
            Camera unavailable: {camErr}. Lens still works — the shutter runs the
            same server call, just without a captured frame.
          </div>
        )}
        <div className="lens-overlay">
          <div className="headline">{mode === "lookup" ? "Point at a student" : "Point at a marked paper"}</div>
          <div className="sub">
            Tap the shutter — Kobe whispers back through your earbud.
          </div>
        </div>
      </div>

      <div className="lens-tabs">
        <button className={mode === "lookup" ? "active" : ""} onClick={() => setMode("lookup")}>
          Lookup
        </button>
        <button className={mode === "mark" ? "active" : ""} onClick={() => setMode("mark")}>
          Mark paper
        </button>
      </div>

      <div className="lens-actions">
        <button
          className="lens-secondary"
          onClick={() => speak("Sound check. If you hear this, your earbud is paired.")}
          aria-label="Sound check"
        >
          Test sound
        </button>
        <button className="lens-shutter" onClick={onShutter} aria-label="Shutter" />
        <button
          className="lens-secondary"
          onClick={() => setLookupBrief(null)}
          disabled={!lookupBrief}
          aria-label="Close"
        >
          Close
        </button>
      </div>

      {toast && <div className="lens-toast">{toast}</div>}

      <LookupPanel auth={auth} sessionId={sessionId} onClose={() => setLookupBrief(null)} brief={lookupBrief} />
      {markOpen && <MarkPanel auth={auth} sessionId={sessionId} onClose={() => setMarkOpen(false)} />}
    </div>
  );
}
