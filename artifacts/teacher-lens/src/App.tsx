import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCamera } from "./camera";

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
// Wake-word listener. Uses webkitSpeechRecognition (Chromium; iOS Safari
// exposes it under a vendor prefix). Falls back silently on unsupported
// browsers — the shutter still works. Only trigger on the word "Kobe".
// ---------------------------------------------------------------------------
type WakeWordOptions = { enabled: boolean; onFire: () => void };
function useWakeWord({ enabled, onFire }: WakeWordOptions) {
  useEffect(() => {
    if (!enabled) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyWindow = window as any;
    const SR = anyWindow.SpeechRecognition ?? anyWindow.webkitSpeechRecognition;
    if (!SR) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec: any = new SR();
    rec.continuous = true;
    rec.interimResults = false;
    rec.lang = "en-US";
    let stopped = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (ev: any) => {
      for (let i = ev.resultIndex; i < ev.results.length; i += 1) {
        const t = (ev.results[i]?.[0]?.transcript ?? "").toLowerCase().trim();
        if (!t) continue;
        if (/\bkobe\b/.test(t) || /\bcoby\b/.test(t) || /\bkobey\b/.test(t)) {
          onFire();
          break;
        }
      }
    };
    rec.onend = () => {
      // Chrome kills continuous recognition after ~60s. Restart while enabled.
      if (!stopped && enabled) {
        try {
          rec.start();
        } catch {
          /* ignore */
        }
      }
    };
    try {
      rec.start();
    } catch {
      /* already started or not permitted */
    }
    return () => {
      stopped = true;
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    };
  }, [enabled, onFire]);
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

type LensUpload = { request_id: number | null; image_key: string | null };

type ReadItem = {
  question_number: number;
  question_text: string | null;
  student_answer: string | null;
  expected_answer: string | null;
  is_correct: boolean | null;
  marks_awarded: number | null;
  marks_possible: number | null;
};

/** A lens frame request as the K9 worker left it (GET /v1/teacher-lens/frame/:id). */
type LensResult = {
  id: number;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  kind: string;
  response: null | {
    student_code?: string | null;
    student_name?: string | null;
    hint?: string;
    note?: string;
    items?: ReadItem[];
    total_marks_awarded?: number | null;
  };
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
                const r = await apiPost<{ answer: string }>(auth, "/v1/classroom/ask", {
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
  marks_awarded: string;
  marks_possible: string;
};

const isBlankItem = (it: MarkItem) =>
  !it.student_answer.trim() && !it.expected_answer.trim() && !it.question_topic.trim() && !it.marks_awarded.trim();

function newItem(n: number): MarkItem {
  return {
    question_number: n,
    question_topic: "",
    student_answer: "",
    expected_answer: "",
    is_correct: true,
    marks_awarded: "",
    marks_possible: "",
  };
}

// Exams are set up in the dashboard. Marking against one records the
// student's result live: report card, scoreboard and classroom TV update
// straight away, and the earbud whispers the grade and position.
type LensExam = {
  id: number;
  class_name?: string;
  subject: string;
  title: string;
  kind: "ca" | "terminal";
  total_marks: number;
};

type ExamStudent = { student_id: number; name: string; student_code: string | null; marks: number | null };

type PaperGraded = {
  summary: { total: number; correct: number; score_percent: number | null };
  result: null | {
    marks: number;
    percent: number;
    exam: LensExam;
    standing: null | {
      school_grade: string;
      necta_grade: string;
      subject_position: number;
      subject_out_of: number;
    };
  };
  curated_notes_generated: number;
  retest: { retest_id: number; items: number } | null;
};

const EXAM_STORAGE_KEY = "k9-lens.exam";

function storedExamId(): number | null {
  try {
    const id = Number(localStorage.getItem(EXAM_STORAGE_KEY));
    return id > 0 ? id : null;
  } catch {
    return null;
  }
}

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th"}`;
}

function errorDetail(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const start = message.indexOf("{");
  if (start >= 0) {
    try {
      const body = JSON.parse(message.slice(start));
      return body.detail ?? body.error ?? message;
    } catch {
      // not JSON
    }
  }
  return message;
}

function MarkPanel({
  auth,
  sessionId,
  paper,
  onClose,
}: {
  auth: StoredAuth;
  sessionId: number | null;
  /** The photo taken with the shutter, queued for the K9 brain to read. */
  paper: { requestId: number | null; imageKey: string | null };
  onClose: () => void;
}) {
  const [exams, setExams] = useState<LensExam[]>([]);
  const [examId, setExamId] = useState<number | null>(storedExamId);
  const [students, setStudents] = useState<ExamStudent[]>([]);
  const [studentCode, setStudentCode] = useState("");
  const [marksObtained, setMarksObtained] = useState("");
  const [subject, setSubject] = useState("");
  const [assessment, setAssessment] = useState("");
  const [items, setItems] = useState<MarkItem[]>(() => [newItem(1)]);
  const [busy, setBusy] = useState(false);
  const [lastResult, setLastResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const exam = exams.find((e) => e.id === examId) ?? null;

  useEffect(() => {
    let cancelled = false;
    apiGet<{ exams: LensExam[] }>(auth, "/v1/results/exams?status=open").then((r) => {
      if (cancelled) return;
      const list = r?.exams ?? [];
      setExams(list);
      setExamId((id) => (id !== null && list.some((e) => e.id === id) ? id : null));
    });
    return () => {
      cancelled = true;
    };
  }, [auth]);

  const loadStudents = useCallback(
    async (id: number) => {
      const r = await apiGet<{ students: ExamStudent[] }>(auth, `/v1/results/exams/${id}/results`);
      setStudents(r?.students ?? []);
    },
    [auth],
  );

  useEffect(() => {
    try {
      if (examId) localStorage.setItem(EXAM_STORAGE_KEY, String(examId));
      else localStorage.removeItem(EXAM_STORAGE_KEY);
    } catch {
      // storage unavailable — the picker still works for this sheet
    }
    setStudents([]);
    if (examId) loadStudents(examId);
  }, [examId, loadStudents]);

  // The brain reads the photo in the background; its answers fill the sheet
  // for the teacher to check before saving.
  const [paperImageKey, setPaperImageKey] = useState<string | null>(paper.imageKey);
  const [readState, setReadState] = useState<"none" | "reading" | "read" | "failed">(paper.requestId ? "reading" : "none");
  const [readNote, setReadNote] = useState<string | null>(null);

  useEffect(() => {
    if (!paper.requestId) return;
    let cancelled = false;
    (async () => {
      const deadline = Date.now() + 15 * 60_000;
      while (!cancelled && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const result = await apiGet<LensResult>(auth, `/v1/teacher-lens/frame/${paper.requestId}`);
        if (cancelled) return;
        if (!result || result.status === "pending" || result.status === "in_progress") continue;
        const found = result.status === "completed" ? (result.response?.items ?? []) : [];
        if (found.length === 0) {
          setReadState("failed");
          setReadNote(`Kobe couldn't read the paper: ${result.response?.note ?? "no answers found"}`);
          return;
        }
        setItems((prev) =>
          prev.length === 1 && isBlankItem(prev[0]!)
            ? found.map((it, i) => ({
                question_number: it.question_number ?? i + 1,
                question_topic: "",
                student_answer: it.student_answer ?? "",
                expected_answer: it.expected_answer ?? "",
                is_correct: it.is_correct ?? true,
                marks_awarded: it.marks_awarded != null ? String(it.marks_awarded) : "",
                marks_possible: it.marks_possible != null ? String(it.marks_possible) : "",
              }))
            : prev,
        );
        const codeOnPaper = result.response?.student_code;
        if (codeOnPaper) setStudentCode((code) => code || codeOnPaper);
        const total = result.response?.total_marks_awarded;
        if (total != null) setMarksObtained((marks) => marks || String(total));
        setReadState("read");
        setReadNote(
          `Kobe read ${found.length} answer${found.length === 1 ? "" : "s"}` +
            (result.response?.student_name ? ` for ${result.response.student_name}` : "") +
            " — check them before saving.",
        );
        return;
      }
      if (!cancelled) {
        setReadState("failed");
        setReadNote("Kobe is taking too long — enter the marks by hand.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [auth, paper.requestId]);

  const patch = (i: number, k: keyof MarkItem, v: MarkItem[keyof MarkItem]) => {
    setItems((prev) => {
      const copy = prev.slice();
      copy[i] = { ...copy[i], [k]: v } as MarkItem;
      return copy;
    });
  };

  const submit = async () => {
    const code = studentCode.trim();
    if (!code) return;
    const filled = items.filter(
      (it) => it.expected_answer.trim() !== "" || it.student_answer.trim() !== "" || it.marks_awarded.trim() !== "",
    );
    const marks = marksObtained.trim();
    if (filled.length === 0 && !(exam && marks !== "")) {
      speak(exam ? "Enter the marks or add a question first." : "Add at least one question first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const num = (value: string) => (value.trim() === "" ? undefined : Number(value));
      const payload = {
        session_id: sessionId,
        student_code: code,
        exam_id: exam?.id,
        marks_obtained: exam ? num(marks) : undefined,
        subject: exam ? undefined : subject.trim() || undefined,
        assessment_title: exam ? undefined : assessment.trim() || undefined,
        paper_image_key: paperImageKey ?? undefined,
        items: filled.map(({ marks_awarded, marks_possible, ...it }) => ({
          ...it,
          marks_awarded: num(marks_awarded),
          marks_possible: num(marks_possible),
        })),
      };
      const r = await apiPost<PaperGraded>(auth, "/v1/teacher-lens/paper-graded", payload);
      if (r.result) {
        // The server whispers the result through the earbud. Keep the sheet
        // open on the same exam so the next paper is one tap away.
        const standing = r.result.standing;
        const name = students.find((s) => s.student_code === code)?.name ?? code;
        setLastResult(
          `${name}: ${r.result.marks}/${r.result.exam.total_marks} (${r.result.percent}%)` +
            (standing
              ? ` · grade ${standing.school_grade} · NECTA ${standing.necta_grade} · ${ordinal(standing.subject_position)} of ${standing.subject_out_of}`
              : ""),
        );
        setStudentCode("");
        setMarksObtained("");
        setItems([newItem(1)]);
        setPaperImageKey(null);
        setReadState("none");
        if (exam) loadStudents(exam.id);
        return;
      }
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
      setError(errorDetail(err));
      speak("Couldn't save. Try again.");
    } finally {
      setBusy(false);
    }
  };

  const marked = students.filter((s) => s.marks !== null).length;
  const pickable = students.filter((s): s is ExamStudent & { student_code: string } => !!s.student_code);

  return (
    <div className="lens-sheet" onClick={onClose}>
      <div className="lens-sheet-body" onClick={(e) => e.stopPropagation()}>
        <h2>Mark paper</h2>
        <label className="mark-label">Exam</label>
        <select
          className="mark-input"
          value={examId ?? ""}
          onChange={(e) => {
            setExamId(e.target.value ? Number(e.target.value) : null);
            setLastResult(null);
            setError(null);
          }}
        >
          <option value="">No exam — practice marking</option>
          {exams.map((e) => (
            <option key={e.id} value={e.id}>
              {e.class_name ? `${e.class_name} · ` : ""}
              {e.subject} · {e.title} (out of {e.total_marks})
            </option>
          ))}
        </select>
        {exam ? (
          <p>
            Results go straight to report cards and the scoreboard · {marked} of {students.length} marked.
          </p>
        ) : (
          <p>Fill only what you need — the vision worker will fill the rest later.</p>
        )}
        {lastResult && <div className="mark-result">✓ {lastResult}</div>}
        {error && <div className="mark-error">{error}</div>}
        {readState !== "none" && (
          <div className={readState === "failed" ? "mark-error" : "mark-result"}>
            {readState === "reading" ? "📄 Kobe is reading the paper… you can start filling in meanwhile." : readNote}
          </div>
        )}

        <label className="mark-label">Student</label>
        {exam && pickable.length > 0 && (
          <select
            className="mark-input"
            value={pickable.some((s) => s.student_code === studentCode) ? studentCode : ""}
            onChange={(e) => setStudentCode(e.target.value)}
          >
            <option value="">Pick a student…</option>
            {pickable.map((s) => (
              <option key={s.student_id} value={s.student_code}>
                {s.name}
                {s.marks !== null ? ` ✓ ${s.marks}` : ""}
              </option>
            ))}
          </select>
        )}
        <input
          className="mark-input"
          value={studentCode}
          onChange={(e) => setStudentCode(e.target.value)}
          placeholder={exam ? "Or type a student code" : "K9-002"}
        />
        {exam ? (
          <>
            <div className="mark-row">
              <input
                className="mark-input"
                inputMode="decimal"
                value={marksObtained}
                onChange={(e) => setMarksObtained(e.target.value)}
                placeholder="Paper total"
              />
              <span className="mark-outof">out of {exam.total_marks}</span>
            </div>
            <p className="mark-hint">Enter the paper total, or mark questions below and KobeAI works the total out.</p>
          </>
        ) : (
          <div className="mark-row">
            <input className="mark-input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Subject" />
            <input className="mark-input" value={assessment} onChange={(e) => setAssessment(e.target.value)} placeholder="Assessment title" />
          </div>
        )}

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
            {exam && (
              <div className="mark-row">
                <input
                  className="mark-input"
                  inputMode="decimal"
                  value={it.marks_awarded}
                  onChange={(e) => patch(i, "marks_awarded", e.target.value)}
                  placeholder="Marks given"
                />
                <input
                  className="mark-input"
                  inputMode="decimal"
                  value={it.marks_possible}
                  onChange={(e) => patch(i, "marks_possible", e.target.value)}
                  placeholder="Question out of"
                />
              </div>
            )}
          </div>
        ))}
        <button className="mark-add" onClick={() => setItems((p) => [...p, newItem(p.length + 1)])}>
          + Add another question
        </button>
        <div className="mark-actions">
          <button className="mark-primary" onClick={submit} disabled={busy || !studentCode.trim()}>
            {busy ? "Sending…" : exam ? "Record result" : "Send to KobeAI"}
          </button>
          <button className="mark-ghost" onClick={onClose}>{lastResult ? "Done" : "Cancel"}</button>
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
  const [markOpen, setMarkOpen] = useState<null | { requestId: number | null; imageKey: string | null }>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [wakeWordOn, setWakeWordOn] = useState<boolean>(false);
  const [studentPicker, setStudentPicker] = useState<null | {
    students: Array<{ student_code: string; student_name: string | null }>;
    imageKey: string | null;
    requestId: number | null;
    recognising: boolean;
    hint: string | null;
  }>(null);
  const [rememberFace, setRememberFace] = useState(true);
  // The frame request the open picker is waiting on; cleared when it closes.
  const pickerRequest = useRef<number | null>(null);
  useEffect(() => {
    if (!studentPicker) pickerRequest.current = null;
  }, [studentPicker]);
  const { videoRef, ready: camReady, err: camErr, captureFrame, captureBlob } = useCamera();

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

  // Fetch a small recent-student picker so lookup mode always has a
  // list of names to tap while face-rec isn't running yet. Cached
  // per-session; refreshed lazily.
  const fetchRecentStudents = useCallback(async (): Promise<
    Array<{ student_code: string; student_name: string | null }>
  > => {
    if (!auth) return [];
    try {
      const res = await fetch(`${auth.api_base}/api/v1/teacher/students?limit=25`, {
        headers: { authorization: `Bearer ${auth.token}` },
      });
      if (!res.ok) return [];
      const body = await res.json();
      // /v1/teacher/students returns { students: [{ student_id, name, ... }] }
      // where student_id is the student_code.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (body?.students ?? []).map((s: any) => ({
        student_code: String(s.student_id ?? s.student_code ?? ""),
        student_name: s.name ?? null,
      })).filter((s: { student_code: string }) => s.student_code);
    } catch {
      return [];
    }
  }, [auth]);

  // Upload the current frame to /v1/teacher-lens/frame. The server saves it
  // and queues it for the K9 worker: faces are matched against enrolled
  // students, paper photos are read by the brain. Best effort — if it fails
  // the teacher still picks the student or types the marks.
  const uploadFrame = useCallback(async (): Promise<LensUpload | null> => {
    if (!auth) return null;
    const blob = await captureBlob(mode === "mark" ? 1600 : 1280);
    if (!blob) return null;
    const examId = mode === "mark" ? storedExamId() : null;
    try {
      const res = await fetch(`${auth.api_base}/api/v1/teacher-lens/frame`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${auth.token}`,
          "content-type": "image/jpeg",
          "x-lens-session-id": String(sessionId ?? ""),
          "x-lens-mode": mode,
          ...(examId ? { "x-lens-exam-id": String(examId) } : {}),
        },
        body: blob,
      });
      if (!res.ok) return null;
      const body = await res.json();
      return { request_id: body?.request?.id ?? null, image_key: body?.image_key ?? null };
    } catch {
      return null;
    }
  }, [auth, captureBlob, mode, sessionId]);

  const runLookup = useCallback(
    async (studentCode: string, quiet = false) => {
      if (!auth) return;
      pickerRequest.current = null;
      setStudentPicker(null);
      try {
        const r = await apiPost<StudentBrief>(auth, "/v1/teacher-lens/lookup", {
          student_code: studentCode,
          session_id: sessionId,
          quiet,
        });
        setLookupBrief(r);
      } catch (err) {
        setToast(err instanceof Error ? err.message : "lookup failed");
      }
    },
    [auth, sessionId],
  );

  // Waits for the worker to recognise the face. A match opens the brief (the
  // server has already whispered it); otherwise the picker stays open.
  const watchLookup = useCallback(
    async (requestId: number) => {
      if (!auth) return;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && pickerRequest.current === requestId) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const result = await apiGet<LensResult>(auth, `/v1/teacher-lens/frame/${requestId}`);
        if (pickerRequest.current !== requestId) return;
        if (!result || result.status === "pending" || result.status === "in_progress") continue;
        const code = result.status === "completed" ? result.response?.student_code : null;
        if (code) {
          runLookup(code, true);
        } else {
          setStudentPicker((p) =>
            p && p.requestId === requestId ? { ...p, recognising: false, hint: result.response?.hint ?? null } : p,
          );
        }
        return;
      }
      setStudentPicker((p) => (p && p.requestId === requestId ? { ...p, recognising: false } : p));
    },
    [auth, runLookup],
  );

  // The teacher picked the student; optionally remember the face from this frame.
  const pickStudent = useCallback(
    (studentCode: string) => {
      const imageKey = studentPicker?.imageKey;
      if (auth && imageKey && rememberFace) {
        apiPost(auth, "/v1/teacher-lens/enroll-face", { student_code: studentCode, image_key: imageKey }).catch((err) =>
          setToast(`Face not saved: ${errorDetail(err)}`),
        );
      }
      runLookup(studentCode);
    },
    [auth, rememberFace, runLookup, studentPicker],
  );

  const onShutter = useCallback(async () => {
    if (!auth) return;
    // Priming the SpeechSynthesis on the first user gesture is critical
    // on iOS/Android — later background whispers only fire if we've spoken
    // at least once from a direct tap.
    speak(mode === "lookup" ? "Looking up." : "Reading the paper.");
    captureFrame(); // for local UX polish; the upload path uses captureBlob

    if (mode === "lookup") {
      // The picker opens straight away; a recognised face replaces it.
      const upload = uploadFrame();
      const recent = await fetchRecentStudents();
      const uploaded = await upload;
      const requestId = uploaded?.request_id ?? null;
      pickerRequest.current = requestId;
      setStudentPicker({ students: recent, imageKey: uploaded?.image_key ?? null, requestId, recognising: requestId !== null, hint: null });
      if (requestId !== null) watchLookup(requestId);
    } else {
      const uploaded = await uploadFrame();
      setMarkOpen({ requestId: uploaded?.request_id ?? null, imageKey: uploaded?.image_key ?? null });
    }
  }, [auth, mode, captureFrame, uploadFrame, fetchRecentStudents, watchLookup]);

  // Wake-word toggle — when on, saying "Kobe" fires the shutter.
  useWakeWord({
    enabled: wakeWordOn,
    onFire: () => {
      if (mode === "lookup" && !studentPicker && !lookupBrief) onShutter();
      // Deliberately no auto-shutter in mark mode: the teacher usually
      // needs to line up the paper first, and a stray "Kobe" mention
      // shouldn't open the mark sheet mid-conversation.
    },
  });

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
          className={"lens-secondary" + (wakeWordOn ? " lens-wake-on" : "")}
          onClick={() => {
            setWakeWordOn((v) => !v);
            speak(!wakeWordOn ? "Listening for Kobe." : "Wake-word off.");
          }}
          aria-label="Wake word"
        >
          {wakeWordOn ? "🎙️ Kobe on" : "🎙️ Kobe off"}
        </button>
        <button className="lens-shutter" onClick={onShutter} aria-label="Shutter" />
        <button
          className="lens-secondary"
          onClick={() => {
            setLookupBrief(null);
            setStudentPicker(null);
          }}
          disabled={!lookupBrief && !studentPicker}
          aria-label="Close"
        >
          Close
        </button>
      </div>

      {toast && <div className="lens-toast">{toast}</div>}

      {studentPicker && (
        <div className="lens-sheet" onClick={() => setStudentPicker(null)}>
          <div className="lens-sheet-body" onClick={(e) => e.stopPropagation()}>
            <h2>Who are you looking at?</h2>
            <p>
              {studentPicker.recognising
                ? "Kobe is recognising the face… or pick the student now."
                : studentPicker.imageKey
                  ? (studentPicker.hint ?? "Pick the student.")
                  : "Couldn't send the frame — pick a student manually to continue."}
            </p>
            {studentPicker.imageKey && (
              <label className="mark-check">
                <input type="checkbox" checked={rememberFace} onChange={(e) => setRememberFace(e.target.checked)} />
                Remember this face so Kobe recognises them next time
              </label>
            )}
            <ul style={{ listStyle: "none", padding: 0, margin: 0, maxHeight: "50vh", overflowY: "auto" }}>
              {studentPicker.students.length === 0 ? (
                <li style={{ color: "var(--brand-muted)", padding: "8px 0" }}>No students loaded. Enter a code:</li>
              ) : (
                studentPicker.students.map((s) => (
                  <li key={s.student_code} style={{ borderBottom: "1px solid var(--brand-card-border)" }}>
                    <button
                      className="mark-add"
                      style={{ textAlign: "left", borderStyle: "solid", margin: "6px 0" }}
                      onClick={() => pickStudent(s.student_code)}
                    >
                      <strong>{s.student_name ?? s.student_code}</strong>
                      <span style={{ color: "var(--brand-muted)", marginLeft: 8, fontFamily: "SF Mono, monospace", fontSize: 12 }}>
                        {s.student_code}
                      </span>
                    </button>
                  </li>
                ))
              )}
            </ul>
            <div className="mark-actions">
              <input
                className="mark-input"
                placeholder="Or type a student code (e.g. K9-001)"
                onKeyDown={(e) => {
                  if (e.key !== "Enter") return;
                  const v = (e.target as HTMLInputElement).value.trim();
                  if (v) pickStudent(v);
                }}
              />
              <button className="mark-ghost" onClick={() => setStudentPicker(null)}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      <LookupPanel auth={auth} sessionId={sessionId} onClose={() => setLookupBrief(null)} brief={lookupBrief} />
      {markOpen && <MarkPanel auth={auth} sessionId={sessionId} paper={markOpen} onClose={() => setMarkOpen(null)} />}
    </div>
  );
}
