import { pool, db, usersTable, classesTable, classMembershipsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

// Extra K9 seed layered on top of the api-server's own seedDemoData. Adds
// everything the school-AI experience needs to feel alive:
//   - a second demo class + more students
//   - today's timetable_periods for both classes
//   - campus zones + cameras
//   - a birthday-today student and a real learning profile
//   - some quiz history + classroom insights so the learning profile /
//     magazine surfaces are populated when you open them
//   - parent linkage so the demo parent can see their child's school day
//
// Idempotent: every insert uses ON CONFLICT DO NOTHING or a pre-check.

export async function seedK9DemoWorld(): Promise<void> {
  await ensureTables();
  await seedStudentsAndClasses();
  await seedTimetable();
  await seedZonesAndCameras();
  await seedLearningProfilesAndBirthday();
  await seedQuizAttempts();
  await seedClassroomInsights();
  await seedParentLink();
  await seedInitialPresence();
  console.log("[demo] K9 world seed complete");
}

// ---------------------------------------------------------------------------
// Prerequisite tables — seed can run before any route hits an ensure*.
// ---------------------------------------------------------------------------
async function ensureTables(): Promise<void> {
  const {
    ensurePresenceTables,
  } = await import("../../../artifacts/api-server/src/lib/presence-monitor.js");
  const {
    ensureLearningProfileTables,
  } = await import("../../../artifacts/api-server/src/lib/learning-profile.js");
  await ensurePresenceTables();
  await ensureLearningProfileTables();
}

// ---------------------------------------------------------------------------
// Students + classes
// ---------------------------------------------------------------------------
const STUDENTS: Array<{ code: string; name: string; grade: string; className: string }> = [
  { code: "TEST001", name: "John Doe", grade: "Form 1", className: "Form 1A" },
  { code: "K9-001", name: "Asha Mrema", grade: "Form 3", className: "Form 3A" },
  { code: "K9-002", name: "Juma Kimario", grade: "Form 3", className: "Form 3A" },
  { code: "K9-003", name: "Neema Kibwe", grade: "Form 3", className: "Form 3A" },
  { code: "K9-004", name: "Fatuma Ali", grade: "Form 3", className: "Form 3A" },
  { code: "K9-005", name: "Brian Mwenda", grade: "Form 3", className: "Form 3A" },
  { code: "K9-006", name: "Tumaini Shija", grade: "Form 3", className: "Form 3A" },
  { code: "K9-BDAY", name: "Aisha Ndayishimiye", grade: "Form 3", className: "Form 3A" },
];

async function seedStudentsAndClasses(): Promise<void> {
  for (const s of STUDENTS) {
    let student = (await db.select().from(usersTable).where(eq(usersTable.student_code, s.code)))[0];
    if (!student) {
      [student] = await db
        .insert(usersTable)
        .values({ role: "student", name: s.name, student_code: s.code, grade: s.grade })
        .returning();
    }
    let cls = (await db.select().from(classesTable).where(eq(classesTable.name, s.className)))[0];
    if (!cls) {
      [cls] = await db
        .insert(classesTable)
        .values({ name: s.className, grade: s.grade })
        .returning();
    }
    const membership = await db
      .select()
      .from(classMembershipsTable)
      .where(eq(classMembershipsTable.class_id, cls.id));
    if (!membership.find((m) => m.student_id === student.id)) {
      await db.insert(classMembershipsTable).values({ class_id: cls.id, student_id: student.id });
    }
  }
}

// ---------------------------------------------------------------------------
// Timetable — today (in the school TZ). Two classes, seven periods.
// ---------------------------------------------------------------------------
async function seedTimetable(): Promise<void> {
  // Existing timetable_periods table is created by the timetable route on
  // first hit — do a plain CREATE IF NOT EXISTS here so seed doesn't depend
  // on route order.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS timetable_periods (
      id SERIAL PRIMARY KEY,
      class_id INTEGER NOT NULL,
      day_of_week INTEGER NOT NULL,
      start_minute INTEGER NOT NULL,
      end_minute INTEGER NOT NULL,
      subject TEXT NOT NULL,
      room TEXT,
      teacher_name TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  const classes = await db.select().from(classesTable);
  const byName = new Map(classes.map((c) => [c.name, c.id]));
  const form3aId = byName.get("Form 3A");
  const form1aId = byName.get("Form 1A");
  if (!form3aId || !form1aId) return;

  const nowIsoDay = (new Date().getDay() + 6) % 7 + 1; // 1..7

  const periods: Array<{
    class_id: number;
    day_of_week: number;
    start_minute: number;
    end_minute: number;
    subject: string;
    room: string;
  }> = [
    { class_id: form3aId, day_of_week: nowIsoDay, start_minute: 8 * 60, end_minute: 8 * 60 + 45, subject: "Assembly", room: "Hall" },
    { class_id: form3aId, day_of_week: nowIsoDay, start_minute: 9 * 60, end_minute: 9 * 60 + 45, subject: "Biology", room: "Form 3A" },
    { class_id: form3aId, day_of_week: nowIsoDay, start_minute: 10 * 60, end_minute: 10 * 60 + 45, subject: "Mathematics", room: "Form 3A" },
    { class_id: form3aId, day_of_week: nowIsoDay, start_minute: 11 * 60, end_minute: 11 * 60 + 45, subject: "Physics", room: "Physics Lab" },
    { class_id: form3aId, day_of_week: nowIsoDay, start_minute: 12 * 60, end_minute: 12 * 60 + 30, subject: "Lunch", room: "Dining Hall" },
    { class_id: form3aId, day_of_week: nowIsoDay, start_minute: 13 * 60, end_minute: 13 * 60 + 45, subject: "Kiswahili", room: "Form 3A" },
    { class_id: form3aId, day_of_week: nowIsoDay, start_minute: 14 * 60, end_minute: 14 * 60 + 45, subject: "Geography", room: "Form 3A" },
    { class_id: form1aId, day_of_week: nowIsoDay, start_minute: 9 * 60, end_minute: 9 * 60 + 45, subject: "Mathematics", room: "Form 1A" },
    { class_id: form1aId, day_of_week: nowIsoDay, start_minute: 10 * 60, end_minute: 10 * 60 + 45, subject: "Kiswahili", room: "Form 1A" },
  ];

  for (const p of periods) {
    const existing = await pool.query(
      `SELECT id FROM timetable_periods
       WHERE class_id = $1 AND day_of_week = $2 AND start_minute = $3 AND subject = $4`,
      [p.class_id, p.day_of_week, p.start_minute, p.subject],
    );
    if (existing.rows.length > 0) continue;
    await pool.query(
      `INSERT INTO timetable_periods (class_id, day_of_week, start_minute, end_minute, subject, room, teacher_name)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [p.class_id, p.day_of_week, p.start_minute, p.end_minute, p.subject, p.room, "Ms. Sarah Kamau"],
    );
  }
}

// ---------------------------------------------------------------------------
// Zones + cameras — the campus map the presence engine reasons over.
// ---------------------------------------------------------------------------
const ZONES = [
  { code: "form-3a", name: "Form 3A classroom", zone_type: "classroom", room: "Form 3A" },
  { code: "form-1a", name: "Form 1A classroom", zone_type: "classroom", room: "Form 1A" },
  { code: "physics-lab", name: "Physics Lab", zone_type: "classroom", room: "Physics Lab" },
  { code: "library", name: "Library", zone_type: "library", room: null },
  { code: "dining", name: "Dining Hall", zone_type: "dining", room: null },
  { code: "hall", name: "Main Hall", zone_type: "other", room: "Hall" },
  { code: "gate", name: "Front Gate", zone_type: "other", room: null },
  { code: "corridor-1", name: "Main Corridor", zone_type: "corridor", room: null },
];

async function seedZonesAndCameras(): Promise<void> {
  for (const z of ZONES) {
    await pool.query(
      `INSERT INTO campus_zones (code, name, zone_type, room)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (code) DO NOTHING`,
      [z.code, z.name, z.zone_type, z.room],
    );
  }
  const zones = await pool.query(`SELECT id, code FROM campus_zones`);
  const zoneByCode = new Map<string, number>(zones.rows.map((r) => [r.code as string, Number(r.id)]));

  const cameras = [
    { id: "cam-form-3a", name: "Form 3A ceiling", zone: "form-3a" },
    { id: "cam-form-1a", name: "Form 1A ceiling", zone: "form-1a" },
    { id: "cam-physics", name: "Physics Lab", zone: "physics-lab" },
    { id: "cam-library", name: "Library door", zone: "library" },
    { id: "cam-dining", name: "Dining wall", zone: "dining" },
    { id: "cam-hall", name: "Hall stage", zone: "hall" },
    { id: "cam-gate", name: "Front gate", zone: "gate" },
    { id: "cam-corridor", name: "Main corridor", zone: "corridor-1" },
  ];
  for (const c of cameras) {
    const zoneId = zoneByCode.get(c.zone);
    if (!zoneId) continue;
    await pool.query(
      `INSERT INTO campus_cameras (camera_id, name, zone_id, enabled)
       VALUES ($1, $2, $3, TRUE)
       ON CONFLICT (camera_id) DO NOTHING`,
      [c.id, c.name, zoneId],
    );
  }
}

// ---------------------------------------------------------------------------
// Learning profiles + a birthday today
// ---------------------------------------------------------------------------
async function seedLearningProfilesAndBirthday(): Promise<void> {
  const today = new Date();
  const mm = String(today.getMonth() + 1).padStart(2, "0");
  const dd = String(today.getDate()).padStart(2, "0");
  const todayMMDD = `${mm}-${dd}`;
  for (const s of STUDENTS) {
    const isBday = s.code === "K9-BDAY";
    await pool.query(
      `INSERT INTO student_learning_profile (
         student_code, birthday,
         computed_topics_strong, computed_topics_weak,
         computed_questions_asked_count, computed_achievements,
         computed_attendance_rate
       ) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6::jsonb, $7)
       ON CONFLICT (student_code) DO UPDATE SET birthday = EXCLUDED.birthday`,
      [
        s.code,
        isBday ? todayMMDD : null,
        JSON.stringify(s.code === "K9-001" ? ["Biology", "Geography"] : []),
        JSON.stringify(s.code === "K9-002" ? ["Physics"] : []),
        s.code === "K9-001" ? 12 : 0,
        JSON.stringify(s.code === "K9-001" ? ["Chemistry quiz — 92%", "Debate team"] : []),
        96,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Quiz history — powers the learning-profile rollup and the magazine.
// ---------------------------------------------------------------------------
async function seedQuizAttempts(): Promise<void> {
  // Create the quiz table shape if it doesn't already exist (drizzle
  // migrations aren't automatic in this demo runner).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quizzes (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      subject TEXT NOT NULL,
      class_id INTEGER,
      teacher_id INTEGER,
      duration_minutes INTEGER NOT NULL DEFAULT 15,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS quiz_attempts (
      id SERIAL PRIMARY KEY,
      quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
      student_code TEXT NOT NULL,
      student_name TEXT NOT NULL,
      score INTEGER NOT NULL,
      points_earned INTEGER NOT NULL,
      correct_answers INTEGER NOT NULL,
      total_questions INTEGER NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // Idempotent by (title, subject) — cheap for demo purposes.
  const quizzes = [
    { title: "Cell biology basics", subject: "Biology" },
    { title: "Newton's laws", subject: "Physics" },
    { title: "Tanzania geography", subject: "Geography" },
    { title: "Linear equations", subject: "Mathematics" },
  ];
  for (const q of quizzes) {
    const existing = await pool.query(`SELECT id FROM quizzes WHERE title = $1`, [q.title]);
    if (existing.rows.length === 0) {
      await pool.query(
        `INSERT INTO quizzes (title, subject, duration_minutes) VALUES ($1, $2, 15)`,
        [q.title, q.subject],
      );
    }
  }
  const quizRows = await pool.query(`SELECT id, title, subject FROM quizzes`);
  const quizByTitle = new Map(quizRows.rows.map((r) => [r.title as string, r]));

  const attempts = [
    { studentCode: "K9-001", studentName: "Asha Mrema", title: "Cell biology basics", score: 92 },
    { studentCode: "K9-001", studentName: "Asha Mrema", title: "Tanzania geography", score: 88 },
    { studentCode: "K9-001", studentName: "Asha Mrema", title: "Newton's laws", score: 68 },
    { studentCode: "K9-002", studentName: "Juma Kimario", title: "Newton's laws", score: 45 },
    { studentCode: "K9-002", studentName: "Juma Kimario", title: "Cell biology basics", score: 55 },
    { studentCode: "K9-002", studentName: "Juma Kimario", title: "Linear equations", score: 42 },
    { studentCode: "K9-003", studentName: "Neema Kibwe", title: "Linear equations", score: 78 },
    { studentCode: "K9-004", studentName: "Fatuma Ali", title: "Cell biology basics", score: 90 },
  ];
  for (const a of attempts) {
    const q = quizByTitle.get(a.title);
    if (!q) continue;
    const existing = await pool.query(
      `SELECT id FROM quiz_attempts WHERE student_code = $1 AND quiz_id = $2`,
      [a.studentCode, q.id],
    );
    if (existing.rows.length > 0) continue;
    await pool.query(
      `INSERT INTO quiz_attempts
         (quiz_id, student_code, student_name, score, points_earned, correct_answers, total_questions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [q.id, a.studentCode, a.studentName, a.score, Math.round(a.score / 5), Math.round(a.score / 10), 10],
    );
  }
}

// ---------------------------------------------------------------------------
// Classroom insights — seeds the "questions this week" + weak-topics view.
// ---------------------------------------------------------------------------
async function seedClassroomInsights(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS classroom_discussion_insights (
      id SERIAL PRIMARY KEY,
      class_id INTEGER,
      student_code TEXT,
      subject TEXT,
      period_id INTEGER,
      insight_type TEXT NOT NULL,
      text TEXT NOT NULL,
      attribution_confidence INTEGER,
      source_kiosk TEXT,
      captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  const cls = await db.select().from(classesTable).where(eq(classesTable.name, "Form 3A"));
  const classId = cls[0]?.id ?? null;
  const rows = [
    { student: "K9-001", subject: "Biology", type: "question", text: "How does photosynthesis produce oxygen?" },
    { student: "K9-002", subject: "Physics", type: "misunderstanding", text: "Confusing acceleration with velocity again." },
    { student: "K9-002", subject: "Physics", type: "misunderstanding", text: "Thinks heavier objects fall faster." },
    { student: null, subject: "Physics", type: "theme", text: "Several Form 3A students struggled with free-body diagrams." },
    { student: "K9-001", subject: "Geography", type: "question", text: "Why is Dodoma the capital and not Dar es Salaam?" },
  ];
  for (const r of rows) {
    const existing = await pool.query(
      `SELECT id FROM classroom_discussion_insights WHERE text = $1`,
      [r.text],
    );
    if (existing.rows.length > 0) continue;
    await pool.query(
      `INSERT INTO classroom_discussion_insights
         (class_id, student_code, subject, insight_type, text, attribution_confidence, source_kiosk)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [classId, r.student, r.subject, r.type, r.text, r.student ? 92 : null, "demo-simulator"],
    );
  }
}

// ---------------------------------------------------------------------------
// Parent link — demo Grace Mwangi parent gets Asha as her child so the
// parent app has a school-day summary + magazine to look at.
// ---------------------------------------------------------------------------
async function seedParentLink(): Promise<void> {
  const phone = "+255700000001";
  let parent = (await db.select().from(usersTable).where(eq(usersTable.email, phone)))[0];
  if (!parent) {
    [parent] = await db
      .insert(usersTable)
      .values({ role: "parent", name: "Grace Mwangi", email: phone })
      .returning();
  }
  const asha = (await db.select().from(usersTable).where(eq(usersTable.student_code, "K9-001")))[0];
  const bday = (await db.select().from(usersTable).where(eq(usersTable.student_code, "K9-BDAY")))[0];
  if (!asha) return;
  for (const student of [asha, bday].filter(Boolean)) {
    await pool.query(
      `INSERT INTO parent_children (parent_user_id, student_user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [parent.id, student!.id],
    );
  }
}

// ---------------------------------------------------------------------------
// Some initial presence events so the live tile isn't empty at boot.
// ---------------------------------------------------------------------------
async function seedInitialPresence(): Promise<void> {
  const camByZone = await pool.query(
    `SELECT c.camera_id, z.code AS zone_code
     FROM campus_cameras c
     LEFT JOIN campus_zones z ON z.id = c.zone_id`,
  );
  const byZone = new Map<string, string>();
  for (const r of camByZone.rows) byZone.set(r.zone_code as string, r.camera_id as string);

  const at = new Date();
  const events = [
    { student: "K9-001", zone: "form-3a", conf: 0.95 },
    { student: "K9-003", zone: "form-3a", conf: 0.94 },
    { student: "K9-004", zone: "form-3a", conf: 0.92 },
    { student: "K9-002", zone: "library", conf: 0.88 },   // wrong location during class time
    { student: "K9-005", zone: "corridor-1", conf: 0.7 }, // low-confidence
  ];
  for (const e of events) {
    const cam = byZone.get(e.zone);
    if (!cam) continue;
    await pool.query(
      `INSERT INTO student_presence_events
         (student_code, camera_id, zone_id, confidence, captured_at)
       SELECT $1, $2, c.zone_id, $3, $4
       FROM campus_cameras c WHERE c.camera_id = $2`,
      [e.student, cam, e.conf, at.toISOString()],
    );
  }
}

// Allow `pnpm run seed` to invoke directly for testing.
if (import.meta.url === `file://${process.argv[1]}`) {
  seedK9DemoWorld()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
