import { useEffect, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// Config: the kiosk authenticates against the school API with a shared secret
// baked in via build-time env vars, so a teacher never has to type anything.
// Run with:
//   VITE_KOBEAI_API_BASE=https://school.local \
//   VITE_KOBEAI_KIOSK_SECRET=... \
//   VITE_KOBEAI_KIOSK_ID=form-3a-tv \
//   pnpm --filter @workspace/classroom-tv run build
// ---------------------------------------------------------------------------
const API_BASE = (import.meta.env.VITE_KOBEAI_API_BASE ?? "").replace(/\/$/, "");
const KIOSK_SECRET = import.meta.env.VITE_KOBEAI_KIOSK_SECRET ?? "";
const KIOSK_ID = import.meta.env.VITE_KOBEAI_KIOSK_ID ?? "classroom-tv";

const CELEBRATION_POLL_MS = 20_000;
const CELEBRATION_DISPLAY_MS = 30_000;
const CLOCK_TICK_MS = 15_000;

type Celebration = {
  id: number;
  student_code: string;
  student_name: string | null;
  birthday: string;
  celebration_date: string;
  status: string;
};

async function api<T>(path: string): Promise<T | null> {
  if (!API_BASE || !KIOSK_SECRET) return null;
  try {
    const res = await fetch(`${API_BASE}/api${path}`, {
      headers: {
        "x-classroom-kiosk-secret": KIOSK_SECRET,
        "x-classroom-kiosk-id": KIOSK_ID,
      },
    });
    if (res.status === 204) return null;
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function fmtHM(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

function fmtDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

// ---------------------------------------------------------------------------
// Setup gate: this kiosk refuses to talk to a school server it hasn't been
// paired with. We tell the operator exactly what env vars to set instead of
// silently 401'ing forever.
// ---------------------------------------------------------------------------
function SetupScreen() {
  return (
    <div className="tv-setup">
      <h1>KobeAI Classroom</h1>
      <p>
        This kiosk needs to be paired with the school server. Rebuild the
        classroom-tv artifact with these environment variables:
      </p>
      <p>
        <code>VITE_KOBEAI_API_BASE=https://your-school-server</code>
        <br />
        <code>VITE_KOBEAI_KIOSK_SECRET=&lt;matches CLASSROOM_KIOSK_SECRET&gt;</code>
        <br />
        <code>VITE_KOBEAI_KIOSK_ID=form-3a-tv</code>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Birthday celebration overlay — full-screen for CELEBRATION_DISPLAY_MS.
// ---------------------------------------------------------------------------
function BirthdayOverlay({ name, onDone }: { name: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, CELEBRATION_DISPLAY_MS);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className="tv-celebration" role="alert" aria-live="assertive">
      <h1>Happy Birthday</h1>
      <div className="name">{name}</div>
      <div className="hint">🎉  From your class and KobeAI  🎉</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------
export function App() {
  const [now, setNow] = useState(() => new Date());
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const [connected, setConnected] = useState<null | boolean>(null);

  // Clock tick (keeps the header current-time honest and drives the "now"
  // schedule highlight without re-rendering more than we need to).
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, []);

  // Celebration poll: claim the next approved-but-unplayed birthday
  // celebration for today. The API's SELECT-FOR-UPDATE-SKIP-LOCKED path
  // guarantees two kiosks won't both claim the same row.
  useEffect(() => {
    if (!API_BASE || !KIOSK_SECRET) return;
    let cancelled = false;
    async function tick() {
      const res = await api<{ celebration: Celebration }>("/v1/classroom/celebrations/next");
      if (cancelled) return;
      if (res == null) {
        setConnected((c) => (c === null ? true : c));
        return;
      }
      setConnected(true);
      if (res.celebration && !celebration) setCelebration(res.celebration);
    }
    tick();
    const t = setInterval(tick, CELEBRATION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [celebration]);

  // Simple stub schedule display — a follow-up will fetch the real
  // timetable via a public "/v1/classroom/context" endpoint keyed by the
  // kiosk's room. For today we render the current wall-clock and slot the
  // celebration hook alongside so the kiosk is useful on day one.
  const stubPeriods = useMemo(
    () => [
      { start: "08:00", end: "08:45", subject: "Assembly", room: "Hall" },
      { start: "09:00", end: "09:45", subject: "Biology", room: "Form 3A" },
      { start: "10:00", end: "10:45", subject: "Mathematics", room: "Form 3A" },
      { start: "11:00", end: "11:45", subject: "Kiswahili", room: "Form 3A" },
      { start: "12:00", end: "12:30", subject: "Lunch", room: "Dining Hall" },
      { start: "13:00", end: "13:45", subject: "Physics", room: "Physics Lab" },
      { start: "14:00", end: "14:45", subject: "Geography", room: "Form 3A" },
      { start: "15:00", end: "15:45", subject: "Sports", room: "Field" },
    ],
    [],
  );

  const minuteOfDay = now.getHours() * 60 + now.getMinutes();
  const currentIdx = stubPeriods.findIndex((p) => {
    const [sh, sm] = p.start.split(":").map(Number);
    const [eh, em] = p.end.split(":").map(Number);
    return sh! * 60 + sm! <= minuteOfDay && minuteOfDay < eh! * 60 + em!;
  });
  const current = currentIdx >= 0 ? stubPeriods[currentIdx] : null;
  const upcoming = stubPeriods.slice(currentIdx >= 0 ? currentIdx + 1 : 0, currentIdx + 5);

  if (!API_BASE || !KIOSK_SECRET) {
    return <SetupScreen />;
  }

  return (
    <>
      <div className="tv">
        <header className="tv-header">
          <div className="tv-brand">KobeAI · {KIOSK_ID}</div>
          <div>
            <div className="tv-clock">{fmtHM(now)}</div>
            <div className="tv-date">{fmtDate(now)}</div>
          </div>
        </header>

        <main className="tv-main">
          <section className="tv-now">
            <div className="tv-now-label">Right now</div>
            {current ? (
              <>
                <h1 className="tv-now-subject">{current.subject}</h1>
                <div className="tv-now-class">{current.room}</div>
                <div className="tv-now-time">
                  {current.start} – {current.end}
                </div>
              </>
            ) : (
              <>
                <h1 className="tv-now-subject">Free period</h1>
                <div className="tv-now-time">No lesson scheduled at {fmtHM(now)}</div>
              </>
            )}
          </section>

          <aside className="tv-schedule">
            <div className="tv-schedule-title">Coming up</div>
            {upcoming.length === 0 ? (
              <div className="tv-schedule-empty">No more lessons today.</div>
            ) : (
              upcoming.map((p) => (
                <div key={p.start} className="tv-schedule-item">
                  <div className="tv-schedule-time">{p.start}</div>
                  <div className="tv-schedule-subject">{p.subject}</div>
                </div>
              ))
            )}
          </aside>
        </main>

        <footer className="tv-footer">
          <div>
            <span className={"dot " + (connected ? "ok" : "bad")}></span>
            {connected ? "Connected to school server" : "Waiting for school server…"}
          </div>
          <div>Kiosk id · {KIOSK_ID}</div>
        </footer>
      </div>

      {celebration && (
        <BirthdayOverlay
          name={celebration.student_name ?? celebration.student_code}
          onDone={() => setCelebration(null)}
        />
      )}
    </>
  );
}
