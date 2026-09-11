import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Config — same three env vars regardless of mode.
// Run:
//   VITE_KOBEAI_API_BASE=https://school.local \
//   VITE_KOBEAI_KIOSK_SECRET=... \
//   VITE_KOBEAI_KIOSK_ID=form-3a-tv \
//   pnpm --filter @workspace/classroom-tv run build
//
// Mode routing: default is "display" (the classroom TV kiosk). Add
// ?mode=dashboard for the big-print live-status board or ?mode=assistant
// for the teacher AI chat. Modes are URL-driven so kiosks in different
// roles boot into different views without a rebuild.
// ---------------------------------------------------------------------------
const API_BASE = (import.meta.env.VITE_KOBEAI_API_BASE ?? "").replace(/\/$/, "");
const KIOSK_SECRET = import.meta.env.VITE_KOBEAI_KIOSK_SECRET ?? "";
const KIOSK_ID = import.meta.env.VITE_KOBEAI_KIOSK_ID ?? "classroom-tv";

const CELEBRATION_POLL_MS = 20_000;
const CELEBRATION_DISPLAY_MS = 30_000;
const CLOCK_TICK_MS = 15_000;
const CONTEXT_POLL_MS = 60_000;
const MISMATCH_POLL_MS = 25_000;

type Celebration = {
  id: number;
  student_code: string;
  student_name: string | null;
  birthday: string;
  celebration_date: string;
  status: string;
};

type Period = {
  period_id: number;
  class_id: number | null;
  class_name: string | null;
  subject: string;
  room: string | null;
  start_minute: number;
  end_minute: number;
};

type Mismatch = {
  student_code: string;
  student_name: string | null;
  zone_name: string | null;
  zone_type: string | null;
  expected_zone_name: string | null;
  expected_zone_type: string | null;
  mismatch_status: string;
  seen_at: string;
};

type Mode = "display" | "dashboard" | "assistant";

function resolveMode(): Mode {
  const params = new URLSearchParams(window.location.search);
  const raw = (params.get("mode") ?? "").toLowerCase();
  if (raw === "dashboard" || raw === "assistant" || raw === "display") return raw;
  return "display";
}

// ---------------------------------------------------------------------------
// Small typed fetch helper. Returns null on any non-2xx or network error so
// the UI can degrade gracefully; the kiosk should never crash if the server
// blips.
// ---------------------------------------------------------------------------
async function api<T>(path: string, init?: RequestInit): Promise<T | null> {
  if (!API_BASE || !KIOSK_SECRET) return null;
  try {
    const res = await fetch(`${API_BASE}/api${path}`, {
      ...init,
      headers: {
        "x-classroom-kiosk-secret": KIOSK_SECRET,
        "x-classroom-kiosk-id": KIOSK_ID,
        ...(init?.body ? { "content-type": "application/json" } : {}),
        ...(init?.headers ?? {}),
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

function minuteToLabel(minute: number): string {
  const h = Math.floor(minute / 60);
  const m = minute % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function fmtDate(date: Date): string {
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    day: "numeric",
    month: "long",
  });
}

function timeAgo(iso: string): string {
  try {
    const then = new Date(iso).getTime();
    const s = Math.max(0, Math.floor((Date.now() - then) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ago`;
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Setup gate
// ---------------------------------------------------------------------------
function SetupScreen() {
  return (
    <div className="tv-setup">
      <h1>KobeAI Classroom</h1>
      <p>This kiosk needs to be paired with the school server. Rebuild with:</p>
      <p>
        <code>VITE_KOBEAI_API_BASE=https://your-school-server</code>
        <br />
        <code>VITE_KOBEAI_KIOSK_SECRET=&lt;matches CLASSROOM_KIOSK_SECRET&gt;</code>
        <br />
        <code>VITE_KOBEAI_KIOSK_ID=form-3a-tv</code>
      </p>
      <p style={{ marginTop: "3vh" }}>
        Then load{" "}
        <code>?mode=display</code>, <code>?mode=dashboard</code>, or <code>?mode=assistant</code>.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared header + mode switcher (visible in dashboard + assistant modes;
// hidden in display mode so the TV stays clean)
// ---------------------------------------------------------------------------
function ModeBadge({ mode }: { mode: Mode }) {
  const label =
    mode === "dashboard" ? "Dashboard" : mode === "assistant" ? "Teaching assistant" : "Display";
  return <span className="tv-mode-badge">{label}</span>;
}

function ClockHeader({ now, connected, mode }: { now: Date; connected: boolean | null; mode: Mode }) {
  return (
    <header className="tv-header">
      <div className="tv-brand">
        KobeAI · {KIOSK_ID} <ModeBadge mode={mode} />
      </div>
      <div>
        <div className="tv-clock">{fmtHM(now)}</div>
        <div className="tv-date">
          <span className={"dot " + (connected ? "ok" : "bad")} /> {fmtDate(now)}
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Birthday overlay (used in every mode)
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
// Shared hooks (celebrations poll, timetable context)
// ---------------------------------------------------------------------------
function useCelebrations() {
  const [celebration, setCelebration] = useState<Celebration | null>(null);
  const [connected, setConnected] = useState<null | boolean>(null);
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
      setCelebration((c) => c ?? res.celebration ?? null);
    }
    tick();
    const t = setInterval(tick, CELEBRATION_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  return { celebration, dismiss: () => setCelebration(null), connected };
}

function useClassroomContext() {
  const [context, setContext] = useState<{ current: Period | null; upcoming: Period[] } | null>(null);
  useEffect(() => {
    if (!API_BASE || !KIOSK_SECRET) return;
    let cancelled = false;
    async function tick() {
      const res = await api<{
        current_period: Period | null;
        upcoming_periods: Period[];
      }>(`/v1/classroom/context?kiosk_id=${encodeURIComponent(KIOSK_ID)}`);
      if (cancelled) return;
      if (res)
        setContext({ current: res.current_period, upcoming: res.upcoming_periods ?? [] });
    }
    tick();
    const t = setInterval(tick, CONTEXT_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);
  return context;
}

// ---------------------------------------------------------------------------
// Mode: display — the classroom TV kiosk (current lesson + upcoming schedule)
// ---------------------------------------------------------------------------
function DisplayMode({ now, connected }: { now: Date; connected: boolean | null }) {
  const context = useClassroomContext();
  const current = context?.current ?? null;
  const upcoming = (context?.upcoming ?? []).slice(0, 5);

  return (
    <div className="tv">
      <ClockHeader now={now} connected={connected} mode="display" />
      <main className="tv-main">
        <section className="tv-now">
          <div className="tv-now-label">Right now</div>
          {current ? (
            <>
              <h1 className="tv-now-subject">{current.subject}</h1>
              <div className="tv-now-class">
                {current.class_name ?? "—"}
                {current.room ? ` · ${current.room}` : ""}
              </div>
              <div className="tv-now-time">
                {minuteToLabel(current.start_minute)} – {minuteToLabel(current.end_minute)}
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
            <div className="tv-schedule-empty">No more lessons scheduled today.</div>
          ) : (
            upcoming.map((p) => (
              <div key={p.period_id} className="tv-schedule-item">
                <div className="tv-schedule-time">{minuteToLabel(p.start_minute)}</div>
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
  );
}

// ---------------------------------------------------------------------------
// Mode: dashboard — big-print live mismatches, for a wall-mounted admin TV
// ---------------------------------------------------------------------------
function DashboardMode({ now, connected }: { now: Date; connected: boolean | null }) {
  const [mismatches, setMismatches] = useState<Mismatch[]>([]);
  useEffect(() => {
    if (!API_BASE || !KIOSK_SECRET) return;
    let cancelled = false;
    async function tick() {
      const res = await api<{ mismatches: Mismatch[] }>(
        "/v1/classroom/live/mismatches?since_minutes=30",
      );
      if (cancelled) return;
      if (res) setMismatches(res.mismatches ?? []);
    }
    tick();
    const t = setInterval(tick, MISMATCH_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const context = useClassroomContext();
  const current = context?.current ?? null;

  return (
    <div className="tv tv-dashboard">
      <ClockHeader now={now} connected={connected} mode="dashboard" />
      <main className="tv-dashboard-main">
        <section className="tv-dashboard-current">
          <div className="tv-now-label">Current period</div>
          <h1 className="tv-dashboard-headline">
            {current?.subject ?? "Between lessons"}
          </h1>
          <div className="tv-dashboard-sub">
            {current
              ? `${current.class_name ?? ""}${current.room ? ` · ${current.room}` : ""}`
              : `As of ${fmtHM(now)}`}
          </div>
        </section>

        <section className="tv-dashboard-alerts">
          <div className="tv-dashboard-alerts-header">
            <div>
              <div className="tv-schedule-title">Live location alerts</div>
              <div className="tv-dashboard-alerts-sub">
                Students seen somewhere other than their expected zone — last 30 min.
              </div>
            </div>
            <div className="tv-dashboard-count">{mismatches.length}</div>
          </div>
          {mismatches.length === 0 ? (
            <div className="tv-schedule-empty">
              Everyone is where they should be.
            </div>
          ) : (
            <ul className="tv-dashboard-list">
              {mismatches.slice(0, 8).map((m) => (
                <li key={m.student_code} className="tv-dashboard-row">
                  <div className="tv-dashboard-row-name">
                    {m.student_name ?? m.student_code}
                  </div>
                  <div className="tv-dashboard-row-detail">
                    seen in <strong>{m.zone_name ?? m.zone_type ?? "unknown"}</strong>{" "}
                    · expected{" "}
                    <strong>{m.expected_zone_name ?? m.expected_zone_type ?? "unknown"}</strong>
                  </div>
                  <div className="tv-dashboard-row-ago">{timeAgo(m.seen_at)}</div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
      <footer className="tv-footer">
        <div>
          <span className={"dot " + (connected ? "ok" : "bad")}></span>
          {connected ? "Live" : "Offline"}
        </div>
        <div>Kiosk id · {KIOSK_ID}</div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Mode: assistant — teacher AI chat surface. Speaks to /v1/classroom/ask.
// ---------------------------------------------------------------------------
type ChatTurn = { role: "teacher" | "kobe"; text: string };

function speakTTS(text: string): void {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = 1.03;
  u.pitch = 1.0;
  u.volume = 1.0;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(u);
}

function AssistantMode({ now, connected }: { now: Date; connected: boolean | null }) {
  const [input, setInput] = useState("");
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recognitionRef = useRef<any>(null);

  const askKobe = useCallback(
    async (question: string) => {
      const trimmed = question.trim();
      if (!trimmed || busy) return;
      setTurns((prev) => [...prev, { role: "teacher", text: trimmed }]);
      setBusy(true);
      const res = await api<{ answer: string }>("/v1/classroom/ask", {
        method: "POST",
        body: JSON.stringify({ question: trimmed, kiosk_id: KIOSK_ID }),
      });
      setBusy(false);
      const reply =
        res?.answer ?? "I couldn't reach KobeAI just now — try again in a moment.";
      setTurns((prev) => [...prev, { role: "kobe", text: reply }]);
      // Speak the reply through the classroom speakers.
      speakTTS(reply);
    },
    [busy],
  );

  const send = useCallback(async () => {
    const question = input;
    setInput("");
    await askKobe(question);
  }, [input, askKobe]);

  // Push-to-talk via webkitSpeechRecognition. On classroom PCs with
  // Chromium this works out of the box; on unsupported browsers the
  // button hides itself and the teacher can still type.
  const speechSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    return !!(w.SpeechRecognition ?? w.webkitSpeechRecognition);
  }, []);

  const startListening = useCallback(() => {
    if (!speechSupported || listening || busy) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = window as any;
    const SR = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rec: any = new SR();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = "en-US";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    rec.onresult = (ev: any) => {
      let interim = "";
      let final = "";
      for (let i = 0; i < ev.results.length; i += 1) {
        const r = ev.results[i];
        if (r?.isFinal) final += r[0]?.transcript ?? "";
        else interim += r[0]?.transcript ?? "";
      }
      if (final) {
        setInput("");
        setListening(false);
        askKobe(final);
      } else if (interim) {
        setInput(interim);
      }
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    try {
      rec.start();
      recognitionRef.current = rec;
      setListening(true);
    } catch {
      setListening(false);
    }
  }, [askKobe, busy, listening, speechSupported]);

  const stopListening = useCallback(() => {
    const rec = recognitionRef.current;
    if (rec) {
      try {
        rec.stop();
      } catch {
        /* ignore */
      }
    }
    setListening(false);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [turns]);

  return (
    <div className="tv tv-assistant">
      <ClockHeader now={now} connected={connected} mode="assistant" />
      <main className="tv-assistant-main">
        <div className="tv-assistant-scroll" ref={scrollRef}>
          {turns.length === 0 && (
            <div className="tv-assistant-empty">
              <h2>Ask Kobe anything</h2>
              <p>
                Try "Explain photosynthesis to Form 2A", "Give me three quick questions
                on Newton's second law", or "Summarize today's chemistry class."
              </p>
            </div>
          )}
          {turns.map((t, i) => (
            <div
              key={i}
              className={"tv-assistant-turn tv-assistant-turn-" + t.role}
            >
              <div className="tv-assistant-turn-label">
                {t.role === "teacher" ? "You" : "Kobe"}
              </div>
              <div className="tv-assistant-turn-text">{t.text}</div>
            </div>
          ))}
          {busy && (
            <div className="tv-assistant-turn tv-assistant-turn-kobe">
              <div className="tv-assistant-turn-label">Kobe</div>
              <div className="tv-assistant-turn-text tv-assistant-thinking">
                thinking…
              </div>
            </div>
          )}
        </div>
        <form
          className="tv-assistant-form"
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          style={{
            gridTemplateColumns: speechSupported ? "auto 1fr auto" : "1fr auto",
          }}
        >
          {speechSupported && (
            <button
              type="button"
              className={"tv-assistant-mic" + (listening ? " tv-assistant-mic-on" : "")}
              onClick={listening ? stopListening : startListening}
              disabled={busy}
              aria-label={listening ? "Stop listening" : "Push to talk"}
            >
              {listening ? "● Listening…" : "🎙️ Push to talk"}
            </button>
          )}
          <input
            className="tv-assistant-input"
            placeholder={listening ? "Say your question…" : "Ask KobeAI…"}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            disabled={busy}
            autoFocus
          />
          <button className="tv-assistant-send" disabled={busy || !input.trim()}>
            Send
          </button>
        </form>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main App — picks a mode from ?mode= and mounts it. Shared state
// (clock, celebration overlay) lives here so every mode gets it.
// ---------------------------------------------------------------------------
export function App() {
  const mode = useMemo(resolveMode, []);
  const [now, setNow] = useState(() => new Date());
  const { celebration, dismiss, connected } = useCelebrations();

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), CLOCK_TICK_MS);
    return () => clearInterval(t);
  }, []);

  if (!API_BASE || !KIOSK_SECRET) return <SetupScreen />;

  return (
    <>
      {mode === "display" && <DisplayMode now={now} connected={connected} />}
      {mode === "dashboard" && <DashboardMode now={now} connected={connected} />}
      {mode === "assistant" && <AssistantMode now={now} connected={connected} />}
      {celebration && (
        <BirthdayOverlay
          name={celebration.student_name ?? celebration.student_code}
          onDone={dismiss}
        />
      )}
    </>
  );
}
