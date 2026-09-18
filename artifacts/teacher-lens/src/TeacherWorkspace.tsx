import { useEffect, useRef, useState } from "react";
import "./workspace.css";

export type TeacherAuth = {
  api_base: string;
  token: string;
  teacher_name: string;
};
export type CaptureActivity = { id: number; mode: string; at: string };
type Period = {
  period_id: number;
  class_name: string | null;
  subject: string;
  room: string | null;
  start_minute: number;
  end_minute: number;
};
type Context = { current_period: Period | null; upcoming_periods: Period[] };
type Student = { student_id: string; name: string; grade?: string };
type Summary = {
  profile: {
    student_name?: string;
    topics_strong?: string[];
    topics_weak?: string[];
    attendance_rate?: number | null;
  };
  recent_papers: {
    id: number;
    assessment_title: string | null;
    subject: string | null;
    score_percent: number | null;
  }[];
};
type Note = { id: number; topic: string; body_markdown: string };
type Answer = { answer: string; provider?: string; model?: string };
const categories = [
  "attentive",
  "reading",
  "writing",
  "collaborating",
  "drawing",
  "sleeping",
  "idle",
  "restless",
  "distracted",
];
const time = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

export async function teacherRequest<T>(
  auth: TeacherAuth,
  path: string,
  signal: AbortSignal,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${auth.api_base}/api/v1${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${auth.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!response.ok) {
    if (response.status === 401)
      throw new Error("Your session expired. Sign out and sign in again.");
    if (response.status === 403)
      throw new Error("Your account does not have access to this feature.");
    throw new Error(
      response.status === 404
        ? "No record found."
        : `School server returned ${response.status}. Please try again.`,
    );
  }
  return response.json();
}

export function TeacherWorkspace({
  auth,
  connected,
  source,
  captures,
  onCapture,
  onClose,
  onSpeak,
}: {
  auth: TeacherAuth;
  connected: boolean;
  source: string | null;
  captures: CaptureActivity[];
  onCapture: (mode: "lookup" | "mark") => void;
  onClose: () => void;
  onSpeak: (text: string) => void;
}) {
  const [tab, setTab] = useState("Today");
  const [context, setContext] = useState<Context | null>(null);
  const [search, setSearch] = useState("");
  const [students, setStudents] = useState<Student[]>([]);
  const [selected, setSelected] = useState<Student | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("attentive");
  const [question, setQuestion] = useState("");
  const [subject, setSubject] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [statuses, setStatuses] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const pending = useRef<AbortController | null>(null);
  const locked = useRef(false);
  useEffect(() => () => pending.current?.abort(), []);

  async function run(task: (signal: AbortSignal) => Promise<void>) {
    if (locked.current) return;
    const controller = new AbortController();
    pending.current = controller;
    locked.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await task(controller.signal);
    } catch (e) {
      if (!controller.signal.aborted)
        setError(
          e instanceof Error ? e.message : "Could not reach the school server.",
        );
    } finally {
      locked.current = false;
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  function refreshToday() {
    void run(async (signal) =>
      setContext(
        await teacherRequest<Context>(auth, "/classroom/context", signal),
      ),
    );
  }
  useEffect(refreshToday, []);
  function findStudents() {
    setSelected(null);
    setSummary(null);
    setNotes([]);
    void run(async (signal) => {
      const result = await teacherRequest<{ students: Student[] }>(
        auth,
        `/teacher/students?limit=50&search=${encodeURIComponent(search.trim())}`,
        signal,
      );
      setStudents(result.students);
      if (!result.students.length) setNotice("No matching students.");
    });
  }
  function openStudent(student: Student) {
    setSelected(student);
    setSummary(null);
    setNotes([]);
    setDescription("");
    void run(async (signal) => {
      const code = encodeURIComponent(student.student_id);
      setSummary(
        await teacherRequest<Summary>(
          auth,
          `/teacher-lens/student/${code}/summary`,
          signal,
        ),
      );
      // Notes may require an entitlement on Claude's subscription branch.
      const result = await teacherRequest<{ notes: Note[] }>(
        auth,
        `/staff/curated-notes/${code}?limit=5`,
        signal,
      );
      setNotes(result.notes);
    });
  }
  const period = (p: Period) => (
    <article className="teacher-period" key={p.period_id}>
      <span>
        {time(p.start_minute)}–{time(p.end_minute)}
      </span>
      <div>
        <strong>{p.subject}</strong>
        <small>
          {p.class_name ?? "Class not set"} · {p.room ?? "Room not set"}
        </small>
      </div>
      <button
        disabled={busy}
        onClick={() => {
          setSubject(p.subject);
          setTab("Ask Kobe");
        }}
      >
        Prepare
      </button>
    </article>
  );

  return (
    <section className="teacher-workspace" aria-label="Teacher workspace">
      <header className="teacher-heading">
        <div>
          <span className="teacher-eyebrow">KOBEAI · TEACHER</span>
          <h1>Hello, {auth.teacher_name}</h1>
          <p>Your lesson, your students, your assistant.</p>
        </div>
        <button onClick={onClose}>Open Lens</button>
      </header>
      <div className="teacher-device">
        <span className={connected ? "teacher-dot connected" : "teacher-dot"} />
        <div>
          <strong>
            {connected ? `${source} connected` : "Rokid companion"}
          </strong>
          <small>
            {connected
              ? "Ready for photos and teacher prompts"
              : "Open Lens to connect Rokid or use the phone camera"}
          </small>
        </div>
      </div>
      <nav className="teacher-nav" aria-label="Teacher tools">
        {["Today", "Students", "Ask Kobe", "Activity"].map((t) => (
          <button
            key={t}
            aria-current={tab === t ? "page" : undefined}
            disabled={busy}
            onClick={() => {
              setTab(t);
              setError("");
              setNotice("");
            }}
          >
            {t}
          </button>
        ))}
      </nav>
      <main className="teacher-content">
        {busy && <p role="status">Contacting the school server…</p>}
        {error && (
          <p role="alert" className="teacher-error">
            {error}
          </p>
        )}
        {notice && (
          <p role="status" className="teacher-success">
            {notice}
          </p>
        )}
        {tab === "Today" && (
          <>
            <div className="teacher-actions">
              <button onClick={() => onCapture("lookup")}>
                <span>01</span>
                <strong>Know your student</strong>
                <small>Look up learning strengths and support needs</small>
              </button>
              <button onClick={() => onCapture("mark")}>
                <span>02</span>
                <strong>Review a paper</strong>
                <small>Capture, check the reading, then record marks</small>
              </button>
            </div>
            <div className="teacher-section-title">
              <h2>School timetable</h2>
              <button disabled={busy} onClick={refreshToday}>
                Refresh
              </button>
            </div>
            <p className="teacher-muted">
              School-wide schedule in the server’s local time; not a personal
              teaching assignment.
            </p>
            {context?.current_period && (
              <>
                <h3>Happening now</h3>
                {period(context.current_period)}
              </>
            )}
            {context?.upcoming_periods.map(period)}
            {context &&
              !context.current_period &&
              context.upcoming_periods.length === 0 && (
                <p>No current or upcoming lessons recorded.</p>
              )}
            <aside className="teacher-card">
              <h3>Ready for class?</h3>
              <p>
                Connect Rokid, check the school server, then open Lens. Review
                AI suggestions before recording marks.
              </p>
            </aside>
          </>
        )}
        {tab === "Students" && (
          <>
            <h2>Student support</h2>
            <form
              className="teacher-search"
              onSubmit={(e) => {
                e.preventDefault();
                findStudents();
              }}
            >
              <input
                aria-label="Search students"
                placeholder="Name or student code"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                maxLength={100}
              />
              <button disabled={busy}>Search</button>
            </form>
            <p className="teacher-muted">
              Up to 50 matches. Refine your search for larger classes.
            </p>
            <div className="teacher-students">
              {students.map((s) => (
                <button
                  key={s.student_id}
                  disabled={busy}
                  aria-pressed={selected?.student_id === s.student_id}
                  onClick={() => openStudent(s)}
                >
                  <strong>{s.name}</strong>
                  <small>
                    {s.student_id}
                    {s.grade ? ` · ${s.grade}` : ""}
                  </small>
                </button>
              ))}
            </div>
            {selected && (
              <article className="teacher-card">
                <h2>{selected.name}</h2>
                {summary && (
                  <>
                    <p>
                      <strong>Strengths:</strong>{" "}
                      {summary.profile.topics_strong?.join(", ") ||
                        "Not recorded"}
                    </p>
                    <p>
                      <strong>Needs support:</strong>{" "}
                      {summary.profile.topics_weak?.join(", ") ||
                        "Not recorded"}
                    </p>
                    <p>
                      Attendance:{" "}
                      {summary.profile.attendance_rate == null
                        ? "Not recorded"
                        : `${summary.profile.attendance_rate}%`}
                    </p>
                    <h3>Recent papers</h3>
                    {summary.recent_papers.length ? (
                      summary.recent_papers.map((p) => (
                        <p key={p.id}>
                          {p.assessment_title ?? p.subject ?? "Paper"}{" "}
                          <strong>
                            {p.score_percent == null
                              ? "Not scored"
                              : `${p.score_percent}%`}
                          </strong>
                        </p>
                      ))
                    ) : (
                      <p>No papers recorded.</p>
                    )}
                  </>
                )}
                <h3>Learning notes</h3>
                {notes.map((n) => (
                  <details key={n.id}>
                    <summary>{n.topic}</summary>
                    <p className="teacher-prewrap">{n.body_markdown}</p>
                  </details>
                ))}
                {!notes.length && (
                  <p className="teacher-muted">No learning notes loaded.</p>
                )}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!description.trim()) return;
                    void run(async (signal) => {
                      await teacherRequest(auth, "/behavior/event", signal, {
                        student_code: selected.student_id,
                        category,
                        description: description.trim(),
                        confidence: 100,
                        metadata: {
                          source: "teacher-lens",
                          human_observation: true,
                        },
                      });
                      setDescription("");
                      setNotice(
                        `Observation saved to ${selected.name}’s school record.`,
                      );
                    });
                  }}
                >
                  <h3>Add your observation</h3>
                  <label>
                    Observed activity
                    <select
                      value={category}
                      onChange={(e) => setCategory(e.target.value)}
                    >
                      {categories.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    What did you observe?
                    <textarea
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      maxLength={500}
                      required
                      placeholder="Specific facts and the support the student may need"
                    />
                  </label>
                  <button disabled={busy || !description.trim()}>
                    Save to school record
                  </button>
                </form>
              </article>
            )}
          </>
        )}
        {tab === "Ask Kobe" && (
          <>
            <h2>Your teaching assistant</h2>
            <p className="teacher-muted">
              Ask for an explanation, a classroom activity or a short lesson
              outline.
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (!question.trim()) return;
                setAnswer(null);
                void run(async (signal) =>
                  setAnswer(
                    await teacherRequest<Answer>(
                      auth,
                      "/classroom/ask",
                      signal,
                      {
                        question: question.trim(),
                        subject: subject.trim() || undefined,
                      },
                    ),
                  ),
                );
              }}
            >
              <label>
                Subject
                <input
                  value={subject}
                  onChange={(e) => setSubject(e.target.value)}
                  maxLength={200}
                  placeholder="e.g. Biology"
                />
              </label>
              <label>
                Question
                <textarea
                  value={question}
                  onChange={(e) => setQuestion(e.target.value)}
                  maxLength={800}
                  required
                  placeholder="Explain photosynthesis with a practical classroom activity…"
                />
              </label>
              <button disabled={busy || !question.trim()}>Ask Kobe</button>
            </form>
            {answer && (
              <article className="teacher-card">
                <p className="teacher-prewrap">{answer.answer}</p>
                <small>
                  Source: {answer.provider ?? "school server"}
                  {answer.model ? ` · ${answer.model}` : ""}
                </small>
                <button onClick={() => onSpeak(answer.answer)}>
                  Read aloud / show on glasses
                </button>
              </article>
            )}
          </>
        )}
        {tab === "Activity" && (
          <>
            <div className="teacher-section-title">
              <h2>Capture activity</h2>
              <button
                disabled={busy || !captures.length}
                onClick={() =>
                  void run(async (signal) => {
                    const entries = await Promise.all(
                      captures.map(async (c) => {
                        const result = await teacherRequest<{ status: string }>(
                          auth,
                          `/teacher-lens/frame/${c.id}`,
                          signal,
                        );
                        return [c.id, result.status] as const;
                      }),
                    );
                    setStatuses(Object.fromEntries(entries));
                  })
                }
              >
                Refresh status
              </button>
            </div>
            <p className="teacher-muted">
              Last 20 accepted captures in this sign-in. Cleared on sign-out or
              reload. A processed capture is not a submitted grade.
            </p>
            {!captures.length && (
              <p>No captures sent yet. Open Lens to begin.</p>
            )}
            {captures.map((c) => (
              <article className="teacher-period" key={c.id}>
                <span>
                  {new Date(c.at).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <div>
                  <strong>
                    {c.mode === "mark" ? "Paper reading" : "Student lookup"}
                  </strong>
                  <small>
                    #{c.id} · {statuses[c.id] ?? "Accepted by server"}
                  </small>
                </div>
              </article>
            ))}
          </>
        )}
      </main>
    </section>
  );
}
