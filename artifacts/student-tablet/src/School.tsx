import { useEffect, useState } from "react";
import { api, type Auth, type SchoolView } from "./api";

// School: the child's own record. None of it is gated.
//
// Exam marks appear as numbers here, and that is deliberate — the
// no-percentages rule (lib/mastery-bands.ts) is about K9's *inference* of
// mastery, which four questions cannot support to a decimal place. A mark a
// teacher awarded is the school's record of its own pupil and has always been
// the child's to see. Conflating the two would hide a child's real marks from
// them, which would be a strange kind of protection.

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const clock = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function School({ auth }: { auth: Auth }) {
  const [view, setView] = useState<SchoolView | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    void api<SchoolView>(auth, "/v1/student/school", controller.signal)
      .then((data) => !controller.signal.aborted && setView(data))
      .catch((e) => {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : "Could not load your school page.");
      });
    return () => controller.abort();
  }, [auth]);

  if (error)
    return (
      <>
        <h1>School</h1>
        <p role="alert" className="error">
          {error}
        </p>
      </>
    );
  if (!view)
    return (
      <>
        <h1>School</h1>
        <p className="muted">Loading…</p>
      </>
    );

  const byDay = new Map<number, SchoolView["week"]>();
  for (const period of view.week) {
    const list = byDay.get(period.day_of_week) ?? [];
    list.push(period);
    byDay.set(period.day_of_week, list);
  }
  const today = ((new Date().getDay() + 6) % 7) + 1;

  return (
    <>
      <h1>School</h1>

      <div className="week">
        <p>
          <strong>{view.attendance_rate == null ? "—" : `${view.attendance_rate}%`}</strong>
          <span>attendance</span>
        </p>
        <p>
          <strong>{view.kp_balance}</strong>
          <span>KP</span>
        </p>
      </div>

      {view.subscription && (
        <p className={`sub ${view.subscription.status}`}>
          K9 learning subscription: <strong>{view.subscription.status}</strong>
          {view.subscription.expires_at
            ? ` until ${new Date(view.subscription.expires_at).toLocaleDateString()}`
            : ""}
        </p>
      )}

      <h2>Your timetable</h2>
      {byDay.size === 0 ? (
        <p className="muted">No timetable yet.</p>
      ) : (
        [...byDay.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([day, periods]) => (
            <section key={day}>
              <h3 className={day === today ? "day now" : "day"}>
                {DAYS[day - 1] ?? `Day ${day}`}
                {day === today ? " · today" : ""}
              </h3>
              {periods.map((period, i) => (
                <p key={i} className="period">
                  <span>{clock(period.start_minute)}</span>
                  <strong>{period.subject}</strong>
                  <span className="state">{period.room ?? ""}</span>
                </p>
              ))}
            </section>
          ))
      )}

      <h2>Your marks</h2>
      {view.results.length === 0 ? (
        <p className="muted">No marked papers yet.</p>
      ) : (
        view.results.map((result, i) => (
          <p key={i} className="period">
            <span>{new Date(result.created_at).toLocaleDateString()}</span>
            <strong>{result.subject}</strong>
            <span className="state">
              {result.marks_awarded == null || result.marks_possible == null
                ? "—"
                : `${result.marks_awarded}/${result.marks_possible}`}
            </span>
          </p>
        ))
      )}
    </>
  );
}
