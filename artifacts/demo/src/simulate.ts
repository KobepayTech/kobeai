import { pool } from "@workspace/db";

// The world simulator. Runs in-process alongside the api-server and fires
// realistic camera events + classroom insights every few seconds so the live
// dashboards, presence tile, classroom-tv, and parent school-day view all
// visibly move. Safe to run against a fresh DB — every insert is best-effort
// and swallows errors so the demo keeps ticking even if a table is missing.

const TICK_MS = Number(process.env["KOBEAI_DEMO_TICK_MS"] ?? 8_000);

let ticker: NodeJS.Timeout | null = null;

type Scenario = {
  name: string;
  weight: number;
  run: () => Promise<void>;
};

// ---------------------------------------------------------------------------
// Camera events — the fast path. Each scenario picks a student + camera
// and inserts a presence event via the same code path the real KobeVision
// service uses.
// ---------------------------------------------------------------------------
async function pickCamera(zoneCode: string): Promise<string | null> {
  const rows = await pool.query(
    `SELECT c.camera_id FROM campus_cameras c
     LEFT JOIN campus_zones z ON z.id = c.zone_id
     WHERE z.code = $1 AND c.enabled = TRUE
     LIMIT 1`,
    [zoneCode],
  );
  return rows.rows[0]?.camera_id ?? null;
}

async function recordEvent(studentCode: string, zoneCode: string, confidence: number): Promise<void> {
  const camera = await pickCamera(zoneCode);
  if (!camera) return;
  const { recordPresenceEvent } = await import("../../api-server/src/lib/presence-monitor.js");
  await recordPresenceEvent({ studentCode, cameraId: camera, confidence });
}

const SCENARIOS: Scenario[] = [
  {
    name: "on-schedule-in-class",
    weight: 6,
    async run() {
      // The bulk of traffic: Form 3A students in Form 3A classroom.
      const students = ["K9-001", "K9-003", "K9-004", "K9-005", "K9-006"];
      const s = students[Math.floor(Math.random() * students.length)]!;
      await recordEvent(s, "form-3a", 0.92 + Math.random() * 0.06);
    },
  },
  {
    name: "wrong-location",
    weight: 1,
    async run() {
      // Juma keeps wandering to the library during Physics — this triggers
      // the wrong_location live tile and auto-enqueues a Youtu-VL question.
      await recordEvent("K9-002", "library", 0.9);
    },
  },
  {
    name: "low-confidence-corridor",
    weight: 1,
    async run() {
      await recordEvent("K9-005", "corridor-1", 0.72);
    },
  },
  {
    name: "arrival-departure",
    weight: 1,
    async run() {
      // Gate sightings drive the parent school-day arrival/departure fields.
      const students = ["K9-001", "K9-BDAY", "TEST001"];
      const s = students[Math.floor(Math.random() * students.length)]!;
      await recordEvent(s, "gate", 0.95);
    },
  },
];

// ---------------------------------------------------------------------------
// Occasional classroom-mic insight — feeds /v1/staff/classroom-insights and
// keeps the learning-profile rollup interesting.
// ---------------------------------------------------------------------------
const INSIGHTS = [
  { student: "K9-001", subject: "Biology", type: "question", text: "What's the difference between mitosis and meiosis?" },
  { student: "K9-002", subject: "Physics", type: "misunderstanding", text: "Still mixing up mass and weight." },
  { student: null, subject: "Mathematics", type: "theme", text: "Half the class had trouble with simultaneous equations." },
  { student: "K9-003", subject: "Geography", type: "answer", text: "Named all five African Great Lakes." },
  { student: "K9-004", subject: "Kiswahili", type: "question", text: "When do we use 'ku-' vs 'ki-' prefix?" },
];

async function fireInsight(): Promise<void> {
  const r = INSIGHTS[Math.floor(Math.random() * INSIGHTS.length)]!;
  await pool.query(
    `INSERT INTO classroom_discussion_insights
       (student_code, subject, insight_type, text, attribution_confidence, source_kiosk, captured_at)
     VALUES ($1, $2, $3, $4, $5, 'demo-simulator', NOW())`,
    [r.student, r.subject, r.type, r.text, r.student ? 91 : null],
  );
}

// ---------------------------------------------------------------------------
// Once-per-day: approve the demo birthday celebration so the classroom TV
// picks it up on the next poll and full-screens it.
// ---------------------------------------------------------------------------
async function approveDemoBirthday(): Promise<void> {
  try {
    await pool.query(
      `UPDATE birthday_celebrations
       SET status = 'approved', approved_at = NOW()
       WHERE student_code = 'K9-BDAY' AND status = 'pending'`,
    );
  } catch {
    // birthday_celebrations table not yet created — will retry next tick.
  }
}

// ---------------------------------------------------------------------------
// Loop
// ---------------------------------------------------------------------------
function pickWeighted(): Scenario {
  const total = SCENARIOS.reduce((s, x) => s + x.weight, 0);
  let n = Math.random() * total;
  for (const s of SCENARIOS) {
    if (n < s.weight) return s;
    n -= s.weight;
  }
  return SCENARIOS[0]!;
}

let sinceInsightTicks = 0;
let sinceBirthdayCheck = 0;

async function tick(): Promise<void> {
  try {
    const scenario = pickWeighted();
    await scenario.run();

    sinceInsightTicks += 1;
    if (sinceInsightTicks >= 4) {
      sinceInsightTicks = 0;
      await fireInsight();
    }

    sinceBirthdayCheck += 1;
    if (sinceBirthdayCheck >= 10) {
      sinceBirthdayCheck = 0;
      await approveDemoBirthday();
    }
  } catch (err) {
    // Never let the simulator crash the demo server.
    // eslint-disable-next-line no-console
    console.warn("[demo] simulator tick failed:", err instanceof Error ? err.message : err);
  }
}

export function startSimulator(): void {
  if (ticker) return;
  // Fire once immediately so the tile is populated before the first refresh.
  tick();
  ticker = setInterval(tick, TICK_MS);
  ticker.unref();
  // eslint-disable-next-line no-console
  console.log(`[demo] world simulator started (${TICK_MS} ms tick)`);
}

export function stopSimulator(): void {
  if (ticker) clearInterval(ticker);
  ticker = null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startSimulator();
  // Keep the process alive if run directly.
  setInterval(() => undefined, 1 << 30);
}
