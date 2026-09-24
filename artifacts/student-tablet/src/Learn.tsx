import { useCallback, useEffect, useState } from "react";
import {
  api,
  isLocked,
  record,
  type Auth,
  type Note,
  type Locked as LockedResponse,
  type Practice,
  type PracticeItem,
  type Verdict,
} from "./api";

// Learn: revision K9 wrote from this child's own marking, and practice.
//
// Practice is the one place the tablet produces a real measurement. A question
// answered alone is a diagnostic and moves mastery; ask for a hint and the same
// question becomes a guided attempt that moves nothing. The child is told which
// happened, plainly, because being quietly downgraded for asking for help is
// how a tutor teaches children not to ask.

function Locked({ what }: { what: string }) {
  return (
    <aside className="locked">
      <h3>{what} needs your K9 subscription</h3>
      <p className="muted">
        Your marks, timetable and school record are always yours. This is the extra
        practice K9 writes from your own marked papers — ask at the school office.
      </p>
    </aside>
  );
}

export function Learn({ auth, focus }: { auth: Auth; focus: string | null }) {
  const [notes, setNotes] = useState<Note[] | "locked" | null>(null);
  const [practice, setPractice] = useState<Practice[] | "locked" | null>(null);
  const [open, setOpen] = useState<{ id: number; subject: string; items: PracticeItem[] } | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async (signal: AbortSignal) => {
    try {
      const [n, p] = await Promise.all([
        api<{ notes: Note[] } | LockedResponse>(auth, "/v1/student/notes", signal),
        api<{ practice: Practice[] } | LockedResponse>(auth, "/v1/student/practice", signal),
      ]);
      if (signal.aborted) return;
      setNotes(isLocked(n) ? "locked" : n.notes);
      setPractice(isLocked(p) ? "locked" : p.practice);
    } catch (e) {
      if (!signal.aborted) setError(e instanceof Error ? e.message : "Could not load Learn.");
    }
  }, [auth]);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (open)
    return <PracticeRun auth={auth} session={open} onDone={() => setOpen(null)} />;

  return (
    <>
      <h1>Learn</h1>
      {focus && <p className="muted">K9 suggests starting with {focus.toLowerCase()}.</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}

      <h2>Practice</h2>
      {practice === "locked" ? (
        <Locked what="Practice" />
      ) : practice === null ? (
        <p className="muted">Loading…</p>
      ) : practice.length === 0 ? (
        <p className="muted">
          Nothing waiting. K9 writes practice from the papers your teacher marks.
        </p>
      ) : (
        practice.map((session) => (
          <button
            key={session.id}
            className="focus"
            onClick={async () => {
              try {
                const detail = await api<{ id: number; subject: string; items: PracticeItem[] }>(
                  auth,
                  `/v1/student/practice/${session.id}`,
                );
                setOpen(detail);
              } catch {
                setError("Could not open that practice.");
              }
            }}
          >
            <strong>{session.subject}</strong>
            <span>
              {session.questions} question{session.questions === 1 ? "" : "s"}
              {session.difficulty_level ? ` · ${session.difficulty_level}` : ""}
            </span>
          </button>
        ))
      )}

      <h2>Revision notes</h2>
      {notes === "locked" ? (
        <Locked what="Revision notes" />
      ) : notes === null ? (
        <p className="muted">Loading…</p>
      ) : notes.length === 0 ? (
        <p className="muted">No notes yet. They appear after your papers are marked.</p>
      ) : (
        notes.map((note) => (
          <details key={note.id} className="note">
            <summary>
              {note.topic} <span className="muted">· {note.subject}</span>
            </summary>
            <p className="prewrap">{note.body_markdown}</p>
          </details>
        ))
      )}
    </>
  );
}

function PracticeRun({
  auth,
  session,
  onDone,
}: {
  auth: Auth;
  session: { id: number; subject: string; items: PracticeItem[] };
  onDone: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState("");
  const [usedHint, setUsedHint] = useState(false);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [hint, setHint] = useState("");
  const [busy, setBusy] = useState(false);
  const item = session.items[index];

  if (!item)
    return (
      <>
        <h1>Done</h1>
        <p className="muted">That’s the whole set. Nice work.</p>
        <button onClick={onDone}>Back to Learn</button>
      </>
    );

  return (
    <>
      <p className="muted">
        {session.subject} · question {index + 1} of {session.items.length}
      </p>
      <h1>{item.topic ?? "Practice"}</h1>
      <p className="question">{item.question_text}</p>

      {!verdict && (
        <>
          <label className="answer-label">
            Your answer
            <input
              aria-label="Your answer"
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
            />
          </label>
          <div className="followups">
            <button
              disabled={busy}
              onClick={async () => {
                setUsedHint(true);
                setBusy(true);
                record(auth, "hint_accepted", { subject: session.subject });
                try {
                  const out = await api<{ answer: string }>(auth, "/v1/classroom/ask", undefined, {
                    question: `Give a hint for this question without giving the answer: ${item.question_text}`,
                    subject: session.subject,
                  });
                  setHint(out.answer);
                } catch {
                  setHint("K9 could not fetch a hint. Have a go anyway.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Give me a hint
            </button>
            <button
              disabled={busy || !answer.trim()}
              onClick={async () => {
                setBusy(true);
                try {
                  setVerdict(
                    await api<Verdict>(auth, `/v1/student/practice/${session.id}/answer`, undefined, {
                      item_id: item.id,
                      answer,
                      used_hint: usedHint,
                    }),
                  );
                } catch {
                  setVerdict(null);
                } finally {
                  setBusy(false);
                }
              }}
            >
              Check
            </button>
          </div>
          {hint && <p className="hint">{hint}</p>}
        </>
      )}

      {verdict && (
        <div className={verdict.correct ? "verdict good" : "verdict"}>
          <strong>{verdict.correct ? "Correct" : "Not quite"}</strong>
          {/* Said plainly. A child who took a hint should know their marks did
              not move, and should never feel punished for having asked. */}
          <p>
            {verdict.moves_mastery
              ? "You worked that out on your own, so it counts towards your learning map."
              : usedHint
                ? "You used a hint, so this one doesn’t change your learning map. That’s fine — asking is how you learn. Try the next one on your own."
                : "Recorded. This one doesn’t change your learning map."}
          </p>
          <button
            onClick={() => {
              setIndex((i) => i + 1);
              setAnswer("");
              setUsedHint(false);
              setHint("");
              setVerdict(null);
            }}
          >
            {index + 1 < session.items.length ? "Next question" : "Finish"}
          </button>
        </div>
      )}
      <button className="ghost" onClick={onDone}>
        Leave practice
      </button>
    </>
  );
}
