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
type TaskState = { busy: boolean; error: string; notice: string };
const IDLE: TaskState = { busy: false, error: "", notice: "" };

/**
 * The per-skill picture built from this teacher's own marking
 * (docs/K9_SKILL_ENGINE.md). `entitled: false` comes back when the student has
 * no K9 learning subscription — the school's own marks still arrive, so the
 * panel shows those rather than an empty box.
 */
type SkillRow = {
  skill_id: number;
  name: string;
  subject: string;
  mastery: number;
  confidence: number;
  trend: number;
  attempts: number;
  dominant_error: string | null;
};
type SkillProfile =
  | {
      entitled?: true;
      subjects: Array<{ subject: string; average: number; skills: SkillRow[] }>;
      priority: SkillRow[];
    }
  | {
      entitled: false;
      message: string;
      baseline: { subjects: Array<{ subject: string; average: number; exams: number }> };
    };
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
  const [skills, setSkills] = useState<SkillProfile | null>(null);
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState("attentive");
  const [question, setQuestion] = useState("");
  const [subject, setSubject] = useState("");
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [statuses, setStatuses] = useState<Record<number, string>>({});

  // Request state is per task, not one global flag.
  //
  // It used to be a single `busy` that disabled every tab and a `locked` ref
  // that made a second press a silent no-op. On a school LAN with a 60-second
  // timeout that meant one slow student search froze the whole workspace mid
  // lesson, and pressing a button that did nothing at all taught teachers the
  // app was broken. Now a slow search only greys out the search.
  const [tasks, setTasks] = useState<Record<string, TaskState>>({});
  const pending = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const inFlight = pending.current;
    return () => inFlight.forEach((controller) => controller.abort());
  }, []);

  const task = (key: string): TaskState => tasks[key] ?? IDLE;
  const setTask = (key: string, state: Partial<TaskState>) =>
    setTasks((current) => ({ ...current, [key]: { ...(current[key] ?? IDLE), ...state } }));

  async function run(key: string, work: (signal: AbortSignal) => Promise<void>) {
    // Pressing the same button again supersedes the older request rather than
    // being dropped on the floor — the teacher meant the newer one.
    pending.current.get(key)?.abort();
    const controller = new AbortController();
    pending.current.set(key, controller);
    setTask(key, { busy: true, error: "", notice: "" });
    try {
      await work(controller.signal);
      if (!controller.signal.aborted) setTask(key, { busy: false });
    } catch (e) {
      if (controller.signal.aborted) return;
      setTask(key, {
        busy: false,
        error: e instanceof Error ? e.message : "Could not reach the school server.",
      });
    } finally {
      if (pending.current.get(key) === controller) pending.current.delete(key);
    }
  }
  function refreshToday() {
    void run("today", async (signal) =>
      setContext(
        await teacherRequest<Context>(auth, "/classroom/context", signal),
      ),
    );
  }
  useEffect(refreshToday, []);

  // Capture status polls itself while anything is still working.
  //
  // It used to need a "Refresh status" press, which is the wrong interaction
  // for the one loop that matters: the teacher photographs a paper and waits
  // for K9's answer. Polling stops the moment nothing is pending, so an idle
  // workspace makes no requests at all.
  const unresolved = captures.filter(
    (c) => !statuses[c.id] || statuses[c.id] === "pending" || statuses[c.id] === "running",
  );
  // Depend on WHICH captures are outstanding, not on the statuses object —
  // depending on `statuses` while also writing it restarts the timer on every
  // poll and turns a 4-second interval into a hot loop. This key only changes
  // when a capture actually resolves, which is exactly when the set should
  // shrink, and it reaches "" when everything is done.
  const unresolvedKey = unresolved.map((c) => c.id).join(",");
  useEffect(() => {
    if (!unresolvedKey) return;
    const ids = unresolvedKey.split(",").map(Number);
    const controller = new AbortController();
    const tick = async () => {
      try {
        const entries = await Promise.all(
          ids.map(async (id) => {
            const result = await teacherRequest<{ status: string }>(
              auth,
              `/teacher-lens/frame/${id}`,
              controller.signal,
            );
            return [id, result.status] as const;
          }),
        );
        if (!controller.signal.aborted) {
          setStatuses((current) => ({ ...current, ...Object.fromEntries(entries) }));
        }
      } catch {
        // A poll that fails is not worth an error banner — the next one
        // retries, and the manual refresh is still there.
      }
    };
    const timer = setInterval(() => void tick(), 4000);
    void tick();
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [unresolvedKey, auth]);
  function findStudents() {
    setSelected(null);
    setSummary(null);
    setNotes([]);
    setSkills(null);
    void run("search", async (signal) => {
      const result = await teacherRequest<{ students: Student[] }>(
        auth,
        `/teacher/students?limit=50&search=${encodeURIComponent(search.trim())}`,
        signal,
      );
      setStudents(result.students);
      if (!result.students.length) setTask("search", { notice: "No matching students." });
    });
  }
  function openStudent(student: Student) {
    setSelected(student);
    setSummary(null);
    setNotes([]);
    setSkills(null);
    setDescription("");
    const code = encodeURIComponent(student.student_id);

    void run("student", async (signal) => {
      setSummary(
        await teacherRequest<Summary>(
          auth,
          `/teacher-lens/student/${code}/summary`,
          signal,
        ),
      );
    });

    // The skill map and the notes are separate tasks on purpose: a student
    // with no learning subscription still gets their summary and their notes,
    // and one slow panel never blanks the others.
    void run("skills", async (signal) => {
      setSkills(await teacherRequest<SkillProfile>(auth, `/skills/students/${code}`, signal));
    });
    void run("notes", async (signal) => {
      const result = await teacherRequest<{ notes: Note[] }>(
        auth,
        `/staff/curated-notes/${code}?limit=5`,
        signal,
      );
      setNotes(result.notes ?? []);
    });
  }
  /** One panel's own busy / error / notice line. */
  const Status = ({ k }: { k: string }) => {
    const t = task(k);
    return (
      <>
        {t.busy && <p role="status" className="teacher-muted">Contacting the school server…</p>}
        {t.error && <p role="alert" className="teacher-error">{t.error}</p>}
        {t.notice && <p role="status" className="teacher-success">{t.notice}</p>}
      </>
    );
  };

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
      {/* A real tablist, and never disabled: a teacher mid-lesson must be able
          to leave a slow panel rather than wait on it. */}
      <div className="teacher-nav" role="tablist" aria-label="Teacher tools">
        {["Today", "Students", "Ask Kobe", "Activity"].map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
          >
            {t}
          </button>
        ))}
      </div>
      <main className="teacher-content" role="tabpanel">
        {tab === "Today" && (
          <>
            <Status k="today" />
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
              <button disabled={task("today").busy} onClick={refreshToday}>
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
            <Status k="search" />
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
              <button disabled={task("search").busy}>Search</button>
            </form>
            <p className="teacher-muted">
              Up to 50 matches. Refine your search for larger classes.
            </p>
            <div className="teacher-students">
              {students.map((s) => (
                <button
                  key={s.student_id}
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
                <Status k="student" />
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
                {/* The per-skill map, which is the thing a teacher can
                    actually act on. "48% in Mathematics" is a number;
                    "Trigonometry 31%, mostly wrong formula" is a lesson. */}
                <h3>What to teach next</h3>
                <Status k="skills" />
                {skills && skills.entitled === false && (
                  <p className="teacher-muted">
                    {skills.message ?? "No K9 learning subscription for this student."}{" "}
                    The school’s own marks are above; the skill
                    breakdown needs this student’s K9 learning subscription.
                  </p>
                )}
                {skills && skills.entitled !== false && (
                  <>
                    {(skills.priority ?? []).length > 0 ? (
                      <ol className="teacher-priority">
                        {(skills.priority ?? []).map((sk) => (
                          <li key={sk.skill_id}>
                            <strong>{sk.name}</strong>
                            <span className="teacher-mastery" aria-hidden="true">
                              <i style={{ width: `${Math.max(3, sk.mastery)}%` }} />
                            </span>
                            <small>
                              {sk.mastery}% · {sk.subject}
                              {sk.dominant_error ? ` · mostly ${sk.dominant_error}` : ""}
                              {sk.confidence < 40 ? " · not much evidence yet" : ""}
                              {sk.trend > 5 ? ` · improving +${sk.trend}` : ""}
                              {sk.trend < -5 ? ` · slipping ${sk.trend}` : ""}
                            </small>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="teacher-muted">
                        Nothing stands out yet — the picture fills in as you mark
                        their papers.
                      </p>
                    )}
                    {(skills.subjects ?? []).map((subjectRow) => (
                      <details key={subjectRow.subject}>
                        <summary>
                          {subjectRow.subject} · {subjectRow.average}% average
                        </summary>
                        {(subjectRow.skills ?? []).map((sk) => (
                          <p key={sk.skill_id} className="teacher-skill-row">
                            <span>{sk.name}</span>
                            <span className="teacher-mastery" aria-hidden="true">
                              <i style={{ width: `${Math.max(3, sk.mastery)}%` }} />
                            </span>
                            <b>{sk.mastery}%</b>
                          </p>
                        ))}
                      </details>
                    ))}
                  </>
                )}

                <h3>Learning notes</h3>
                <Status k="notes" />
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
                    void run("observation", async (signal) => {
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
                      setTask("observation", {
                        notice: `Observation saved to ${selected.name}’s school record.`,
                      });
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
                  <button disabled={task("observation").busy || !description.trim()}>
                    Save to school record
                  </button>
                  <Status k="observation" />
                </form>
              </article>
            )}
          </>
        )}
        {tab === "Ask Kobe" && (
          <>
            <Status k="ask" />
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
                void run("ask", async (signal) =>
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
              <button disabled={task("ask").busy || !question.trim()}>Ask Kobe</button>
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
            <Status k="captures" />
            <div className="teacher-section-title">
              <h2>Capture activity</h2>
              <button
                disabled={task("captures").busy || !captures.length}
                onClick={() =>
                  void run("captures", async (signal) => {
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
