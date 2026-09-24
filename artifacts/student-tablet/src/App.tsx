import { useCallback, useEffect, useRef, useState } from "react";
import { DrawWorking, ScanQuestion } from "./capture";
import {
  api,
  loadAuth,
  record,
  saveAuth,
  type Auth,
  type LearningMap,
  type Period,
  type SkillView,
} from "./api";

// ===========================================================================
// K9 on a student's tablet.
//
// Deliberately not the school ERP. A child opening this should find something
// that belongs to them: their day, their questions, their learning — not a
// records system with their name at the top.
//
// Two rules the UI cannot break, because the server enforces them:
//   - no percentage ever reaches this screen (lib/mastery-bands.ts)
//   - a hinted right answer is not mastery (lib/evidence.ts)
// ===========================================================================

const TABS = ["Home", "Learn", "K9", "Me", "School"] as const;
type Tab = (typeof TABS)[number];

const clock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

function greeting(hour = new Date().getHours()): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/** Bands render as filled pips. There is no number to show. */
function Pips({ filled }: { filled: number }) {
  return (
    <span className="pips" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <i key={i} className={i < filled ? "on" : ""} />
      ))}
    </span>
  );
}

function SkillRow({ skill }: { skill: SkillView }) {
  return (
    <p className="skill-row">
      <span className="skill-name">{skill.name}</span>
      <Pips filled={skill.pips} />
      <span className={`skill-label ${skill.band ?? "unknown"}`}>
        {skill.label}
        {skill.moving === "up" ? " ↑" : skill.moving === "down" ? " ↓" : ""}
      </span>
    </p>
  );
}

function SignIn({ onDone }: { onDone: (auth: Auth) => void }) {
  const [base, setBase] = useState(location.origin);
  const [code, setCode] = useState("");
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <main className="signin">
      <h1>
        <span className="mark">K9</span>
      </h1>
      <p>Sign in with the details your school gave you.</p>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError("");
          try {
            const response = await fetch(`${base}/api/v1/auth/student/login`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ student_id: code.trim(), pin }),
              signal: AbortSignal.timeout(15_000),
            });
            if (!response.ok) throw new Error("Those details did not work. Try again.");
            const data = (await response.json()) as { token: string; name?: string };
            onDone({
              api_base: base,
              token: data.token,
              name: data.name ?? code.trim(),
              student_code: code.trim(),
            });
          } catch (e) {
            setError(e instanceof Error ? e.message : "Could not sign in.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          School server
          <input value={base} onChange={(e) => setBase(e.target.value)} inputMode="url" />
        </label>
        <label>
          Your student number
          <input value={code} onChange={(e) => setCode(e.target.value)} autoCapitalize="characters" />
        </label>
        <label>
          PIN
          <input value={pin} onChange={(e) => setPin(e.target.value)} type="password" inputMode="numeric" />
        </label>
        <button disabled={busy || !code.trim() || !pin}>{busy ? "Signing in…" : "Sign in"}</button>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}

type Turn = { from: "you" | "k9"; text: string; subject?: string | null };

export function App() {
  const [auth, setAuth] = useState<Auth | null>(loadAuth);
  const [tab, setTab] = useState<Tab>("Home");
  const [today, setToday] = useState<Period[] | null>(null);
  const [map, setMap] = useState<LearningMap | null>(null);
  const [error, setError] = useState("");
  const pending = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!auth) return;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    try {
      const [day, learning] = await Promise.all([
        api<{ periods: Period[] }>(auth, "/v1/student/today", controller.signal),
        api<LearningMap>(auth, "/v1/student/me", controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setToday(day.periods);
      setMap(learning);
      setError("");
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Something went wrong.");
    }
  }, [auth]);

  useEffect(() => {
    void load();
    return () => pending.current?.abort();
  }, [load]);

  if (!auth)
    return (
      <SignIn
        onDone={(next) => {
          saveAuth(next);
          setAuth(next);
        }}
      />
    );

  const now = today?.find((p) => p.state === "now") ?? null;

  return (
    <div className="app">
      <header className="top">
        <span className="mark">K9</span>
        <button
          className="linkish"
          onClick={() => {
            saveAuth(null);
            setAuth(null);
          }}
        >
          Sign out
        </button>
      </header>

      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <main>
        {tab === "Home" && (
          <>
            <h1>
              {greeting()}, {auth.name} 👋
            </h1>
            <p className="muted">
              {now ? `${now.subject} now` : "No lesson right now"}
            </p>

            <button className="hero" onClick={() => setTab("K9")}>
              <strong>Ask me anything</strong>
              <span>Type · Scan · Draw</span>
            </button>

            <h2>Your day</h2>
            {today?.length ? (
              today.map((period) => (
                <p key={period.period_id} className={`period ${period.state}`}>
                  <span>{clock(period.start_minute)}</span>
                  <strong>{period.subject}</strong>
                  <span className="state">
                    {period.state === "done" ? "✓" : period.state === "now" ? "NOW" : ""}
                  </span>
                </p>
              ))
            ) : (
              <p className="muted">No lessons on your timetable today.</p>
            )}

            <h2>Continue learning</h2>
            {map?.focus ? (
              <button className="focus" onClick={() => setTab("Me")}>
                <strong>{map.focus.name}</strong>
                <Pips filled={map.focus.pips} />
                <span>{map.focus.label}</span>
              </button>
            ) : (
              <p className="muted">
                Ask K9 a few questions and your learning map will fill in.
              </p>
            )}
          </>
        )}

        {tab === "K9" && <AskK9 auth={auth} subject={now?.subject ?? null} />}

        {tab === "Me" && (
          <>
            <h1>My learning</h1>
            {map ? (
              <>
                <div className="week">
                  <p>
                    <strong>{map.week.questions_asked}</strong>
                    <span>questions asked</span>
                  </p>
                  <p>
                    <strong>{map.week.skills_practised}</strong>
                    <span>skills practised</span>
                  </p>
                </div>
                {map.subjects.map((group) => (
                  <section key={group.subject}>
                    <h2>{group.subject}</h2>
                    {group.skills.map((skill) => (
                      <SkillRow key={skill.skill_id} skill={skill} />
                    ))}
                  </section>
                ))}
                {map.focus && (
                  <aside className="suggests">
                    <h3>K9 suggests</h3>
                    <p>
                      Let’s spend five minutes on {map.focus.name.toLowerCase()} before your
                      next lesson.
                    </p>
                    <button onClick={() => setTab("K9")}>Start</button>
                  </aside>
                )}
              </>
            ) : (
              <p className="muted">Loading your learning…</p>
            )}
          </>
        )}

        {(tab === "Learn" || tab === "School") && (
          <>
            <h1>{tab}</h1>
            <p className="muted">Coming soon.</p>
          </>
        )}
      </main>

      <nav role="tablist" aria-label="K9">
        {TABS.map((name) => (
          <button
            key={name}
            role="tab"
            aria-selected={tab === name}
            className={name === "K9" ? "centre" : undefined}
            onClick={() => setTab(name)}
          >
            {name}
          </button>
        ))}
      </nav>
    </div>
  );
}

/**
 * Ask K9.
 *
 * Every button under an answer reports what the child did, and the server's
 * evidence gate decides what it means. "I understand ✓" is a self-report and
 * moves nothing; "Explain simpler" says the first answer missed; a correct
 * answer after "Give an example" is not evidence of independent mastery.
 */
function AskK9({ auth, subject }: { auth: Auth; subject: string | null }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [capture, setCapture] = useState<"scan" | "draw" | null>(null);

  async function scan(image: string, kind: "question" | "working") {
    setCapture(null);
    setBusy(true);
    setNote("");
    setTurns((t) => [
      ...t,
      { from: "you", text: kind === "working" ? "Here is my working." : "Here is the question." },
    ]);
    try {
      const out = await api<{ read: string; answer: string }>(
        auth,
        "/v1/student/scan",
        undefined,
        { image, kind, subject },
      );
      setTurns((t) => [
        ...t,
        { from: "k9", text: `I read: ${out.read}` },
        { from: "k9", text: out.answer, subject },
      ]);
    } catch (e) {
      setTurns((t) => [
        ...t,
        {
          from: "k9",
          text:
            e instanceof Error
              ? e.message
              : "K9 could not read that. Try again with more light, or type it out.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  }

  if (capture === "scan")
    return <ScanQuestion onCapture={(image, kind) => void scan(image, kind)} onCancel={() => setCapture(null)} />;
  if (capture === "draw")
    return <DrawWorking onCapture={(image, kind) => void scan(image, kind)} onCancel={() => setCapture(null)} />;

  async function ask(text: string, kind = "question") {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setNote("");
    setTurns((t) => [...t, { from: "you", text: trimmed }]);
    setQuestion("");
    record(auth, kind, { subject, detail: trimmed });
    try {
      const answer = await api<{ answer: string }>(auth, "/v1/classroom/ask", undefined, {
        question: trimmed,
        subject,
      });
      setTurns((t) => [...t, { from: "k9", text: answer.answer, subject }]);
    } catch (e) {
      setTurns((t) => [
        ...t,
        { from: "k9", text: e instanceof Error ? e.message : "K9 could not answer just now." },
      ]);
    } finally {
      setBusy(false);
    }
  }

  const last = turns[turns.length - 1];

  return (
    <>
      <h1>Ask K9</h1>
      <p className="muted">{subject ? `${subject} right now` : "What are you trying to understand?"}</p>

      <div className="chat">
        {turns.map((turn, i) => (
          <p key={i} className={turn.from}>
            {turn.text}
          </p>
        ))}
        {busy && <p className="k9 thinking">Thinking…</p>}
      </div>

      {last?.from === "k9" && !busy && (
        <div className="followups">
          <button onClick={() => void ask("Explain that more simply.", "explanation_requested")}>
            Explain simpler
          </button>
          <button onClick={() => void ask("Give me an example.", "hint_accepted")}>
            Give an example
          </button>
          <button
            onClick={() => {
              record(auth, "self_reported_understanding", { subject });
              // Said plainly, because a child should never be left thinking a
              // button changed their marks.
              setNote("Noted — that doesn’t change your marks, it helps K9 know what to revisit.");
            }}
          >
            I understand ✓
          </button>
        </div>
      )}
      {note && (
        <p role="status" className="muted">
          {note}
        </p>
      )}

      <div className="ways">
        <button onClick={() => setCapture("scan")} disabled={busy}>
          📷 Scan a question
        </button>
        <button onClick={() => setCapture("draw")} disabled={busy}>
          ✏️ Show your working
        </button>
      </div>

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(question);
        }}
      >
        <input
          aria-label="Ask a question"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder={turns.length ? "Ask a follow-up…" : "Ask me anything…"}
        />
        <button disabled={busy || !question.trim()}>Ask</button>
      </form>
    </>
  );
}
