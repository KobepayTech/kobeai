// Demo data, so the tablet can be seen without a school server behind it.
//
//   npm run build && open index.html?mock=1
//
// Switched on only by `?mock=1` in the URL. It intercepts fetch rather than
// branching inside the app, so every screen renders through exactly the same
// code path a real school uses — if the mock looks right, the real thing will
// too. Nothing here ships enabled: with no flag, the file installs nothing.
//
// The data is a Form 2A in a Tanzanian secondary school: NECTA subjects, a
// Thursday timetable, and a learning map that deliberately shows all four
// bands plus one skill K9 has not seen enough of to judge.

const NAMES = { student: "Amani", code: "K9-0142" } as const;

const today = ((new Date().getDay() + 6) % 7) + 1;

const nowMinute = () => new Date().getHours() * 60 + new Date().getMinutes();

/**
 * The demo day is anchored around the current time, not fixed to 08:00.
 *
 * A fixed morning timetable means anyone opening the demo in the afternoon sees
 * every lesson ticked off and "No lesson right now" — which is the one state
 * that shows none of the design. Two periods have already happened, one is
 * running now, two are still to come, whenever you look.
 */
function demoDay() {
  const current = Math.max(100, nowMinute());
  const slots = [-170, -85, 0, 85, 170];
  const lessons = [
    { subject: "Mathematics", room: "A3" },
    { subject: "Physics", room: "Lab 1" },
    { subject: "Chemistry", room: "Lab 2" },
    { subject: "Break", room: null },
    { subject: "Kiswahili", room: "A3" },
  ];
  return lessons.map((lesson, i) => ({
    period_id: i + 1,
    ...lesson,
    // The "now" lesson started 15 minutes ago, so it reads as in progress
    // rather than about to begin.
    start_minute: Math.max(0, current + slots[i]! - 15),
    end_minute: Math.max(40, current + slots[i]! + 25),
  }));
}

const PERIODS = demoDay();

function state(p: { start_minute: number; end_minute: number }) {
  const now = nowMinute();
  return p.end_minute <= now ? "done" : p.start_minute <= now ? "now" : "upcoming";
}

const skill = (
  skill_id: number,
  name: string,
  subject: string,
  band: string | null,
  pips: number,
  label: string,
  moving: "up" | "down" | null = null,
) => ({ skill_id, name, subject, band, pips, label, moving, needs_practice_to_tell: band === null });

const PHYSICS = [
  skill(11, "Speed and velocity", "Physics", "strong", 4, "Strong"),
  skill(12, "Acceleration", "Physics", "practising", 3, "Practising", "up"),
  skill(13, "Negative acceleration", "Physics", "learning", 2, "Learning", "down"),
  skill(14, "Motion graphs", "Physics", null, 0, "Not enough practice yet"),
];

const MATHS = [
  skill(21, "Linear equations", "Mathematics", "strong", 4, "Strong"),
  skill(22, "Fractions", "Mathematics", "practising", 3, "Practising"),
  skill(23, "Signed numbers", "Mathematics", "learning", 2, "Learning", "up"),
  skill(24, "Factorisation", "Mathematics", "starting", 1, "Starting", "down"),
];

const ROUTES: [RegExp, () => unknown][] = [
  [/\/v1\/student\/today$/, () => ({
    now_minute: nowMinute(),
    periods: PERIODS.map((p) => ({ ...p, state: state(p) })),
  })],
  [/\/v1\/student\/me$/, () => ({
    subjects: [
      { subject: "Physics", skills: PHYSICS },
      { subject: "Mathematics", skills: MATHS },
    ],
    // The weakest skill K9 has enough evidence to judge — one thing, never a list.
    focus: MATHS[3],
    week: { questions_asked: 18, skills_practised: 12 },
  })],
  [/\/v1\/student\/notes$/, () => ({
    entitled: true,
    notes: [
      {
        id: 1,
        subject: "Mathematics",
        topic: "Why minus times minus is plus",
        body_markdown:
          "Think of -1 as a turn of 180°.\n\nTurning twice brings you back to facing forward, which is why\n(-2) x (-3) = +6.\n\nYour paper on 14 March lost 3 marks here — every one of them was a sign, not the arithmetic.",
      },
      {
        id: 2,
        subject: "Physics",
        topic: "Negative acceleration",
        body_markdown:
          "Negative acceleration does not mean going backwards. It means the acceleration points the opposite way to the motion.\n\nA car at +10 m/s with a = -2 m/s² is still travelling forward — it is slowing down.",
      },
    ],
  })],
  [/\/v1\/student\/practice$/, () => ({
    entitled: true,
    practice: [
      { id: 91, subject: "Mathematics", difficulty_level: "standard", questions: 3 },
      { id: 92, subject: "Physics", difficulty_level: "stretch", questions: 2 },
    ],
  })],
  [/\/v1\/student\/practice\/91$/, () => ({
    id: 91,
    subject: "Mathematics",
    items: [
      { id: 911, topic: "Signed numbers", question_text: "Work out (-4) x (-7)." },
      { id: 912, topic: "Signed numbers", question_text: "Work out (-15) ÷ 3." },
      { id: 913, topic: "Factorisation", question_text: "Factorise x² + 7x + 12." },
    ],
  })],
  [/\/v1\/student\/practice\/92$/, () => ({
    id: 92,
    subject: "Physics",
    items: [
      {
        id: 921,
        topic: "Negative acceleration",
        question_text: "A car travelling at 10 m/s decelerates at 2 m/s². What is its speed after 3 s?",
      },
      { id: 922, topic: "Motion graphs", question_text: "On a velocity–time graph, what does the gradient show?" },
    ],
  })],
  [/\/v1\/student\/school$/, () => ({
    week: [
      { day_of_week: 1, subject: "Mathematics", room: "A3", start_minute: 480, end_minute: 520 },
      { day_of_week: 1, subject: "Kiswahili", room: "A3", start_minute: 560, end_minute: 600 },
      { day_of_week: 2, subject: "Physics", room: "Lab 1", start_minute: 480, end_minute: 520 },
      { day_of_week: 3, subject: "Chemistry", room: "Lab 2", start_minute: 540, end_minute: 580 },
      { day_of_week: 4, subject: "Mathematics", room: "A3", start_minute: 480, end_minute: 520 },
      { day_of_week: 4, subject: "Physics", room: "Lab 1", start_minute: 560, end_minute: 600 },
      { day_of_week: 5, subject: "Civics", room: "B1", start_minute: 480, end_minute: 520 },
    ],
    results: [
      { subject: "Physics", marks_awarded: 34, marks_possible: 50, created_at: "2026-10-02T00:00:00Z" },
      { subject: "Mathematics", marks_awarded: 41, marks_possible: 60, created_at: "2026-09-18T00:00:00Z" },
      { subject: "Kiswahili", marks_awarded: 44, marks_possible: 50, created_at: "2026-09-11T00:00:00Z" },
    ],
    attendance_rate: 96,
    kp_balance: 340,
    subscription: { status: "active", expires_at: "2027-07-31T00:00:00Z" },
  })],
  [/\/v1\/classroom\/ask$/, () => ({
    answer:
      "Negative acceleration means the acceleration points the opposite way to the motion — not that the car is reversing.\n\nA car at +10 m/s with a = -2 m/s² is still going forward, just slowing by 2 m/s every second. After 3 seconds it is doing 4 m/s.",
    provider: "ollama",
    model: "qwen3",
  })],
  [/\/v1\/student\/listen$/, () => ({ text: "Why does acceleration become negative?" })],
  [/\/v1\/student\/scan$/, () => ({
    read: "v = u + at,  u = 10,  a = -2,  t = 3,  v = 10 + (-2)(3) = 16",
    answer:
      "Your method is right and the numbers are right — look at the last step. You added 6 instead of subtracting it: (-2) x 3 = -6, so v = 10 - 6 = 4 m/s.\n\nTry this one: a cyclist at 8 m/s brakes at 1.5 m/s² for 4 s. What speed are they doing?",
    moves_mastery: false,
  })],
  [/\/v1\/student\/practice\/\d+\/answer$/, () => null], // handled below, needs the body
  [/\/v1\/student\/interaction$/, () => ({
    record: true,
    moves_mastery: false,
    suggest_assessment: false,
    reason: "question_is_not_a_measurement",
  })],
];

/** Visible so a demo cannot be mistaken for a live school. */
function banner() {
  const strip = document.createElement("div");
  strip.textContent = "DEMO DATA · not a real student";
  strip.setAttribute("role", "note");
  strip.style.cssText =
    "position:fixed;top:0;left:0;right:0;z-index:999;background:#f2a03d;color:#20130a;" +
    "font:600 11px/1.9 Inter,sans-serif;text-align:center;letter-spacing:.08em";
  document.body.appendChild(strip);
  // Push the app down by the strip's height so it does not sit over the header.
  document.body.style.paddingTop = `${strip.offsetHeight}px`;
}

export function installMocks(): boolean {
  if (!new URLSearchParams(location.search).has("mock")) return false;

  localStorage.setItem(
    "k9-student.auth",
    JSON.stringify({
      api_base: location.origin,
      token: "demo",
      name: NAMES.student,
      student_code: NAMES.code,
    }),
  );
  localStorage.setItem(
    "k9-student.recent",
    JSON.stringify([
      "Why does acceleration become negative?",
      "Help me solve 3x + 7 = 22",
      "What is covalent bonding?",
    ]),
  );

  const real = window.fetch;
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(url, location.origin).pathname;

    // A practice answer depends on what was sent: the same correct answer is a
    // measurement alone and a record of a hint working otherwise. Mocking it
    // any other way would hide the one behaviour worth looking at.
    if (/\/v1\/student\/practice\/\d+\/answer$/.test(path)) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      return json({
        correct: true,
        moves_mastery: !body.used_hint,
        suggest_assessment: !!body.used_hint,
        reason: body.used_hint ? "assisted_attempt_measures_the_hint" : "independent_demonstration",
      });
    }
    for (const [pattern, payload] of ROUTES) {
      if (pattern.test(path)) {
        const value = payload();
        if (value !== null) return json(value);
      }
    }
    return real(input as RequestInfo, init);
  };

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", banner, { once: true });
  else banner();
  return true;
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
