import { Router } from "express";

const router = Router();

const STUDENTS = [
  { id: "1", student_id: "DSS001", name: "Amina Hassan", grade: "Form 1", points: 1450, status: "active", last_active: new Date().toISOString() },
  { id: "2", student_id: "DSS002", name: "Brian Mwenda", grade: "Form 2", points: 1280, status: "active", last_active: new Date().toISOString() },
  { id: "3", student_id: "DSS003", name: "Fatuma Ali", grade: "Form 1", points: 1920, status: "active", last_active: new Date().toISOString() },
  { id: "4", student_id: "DSS004", name: "James Oloo", grade: "Form 3", points: 980, status: "active", last_active: new Date().toISOString() },
  { id: "5", student_id: "DSS005", name: "Neema Kibwe", grade: "Form 2", points: 2100, status: "active", last_active: new Date().toISOString() },
  { id: "6", student_id: "DSS006", name: "Omar Suleiman", grade: "Form 4", points: 760, status: "inactive", last_active: new Date(Date.now() - 86400000 * 2).toISOString() },
  { id: "7", student_id: "DSS007", name: "Pendo Makame", grade: "Form 1", points: 1650, status: "active", last_active: new Date().toISOString() },
  { id: "8", student_id: "DSS008", name: "Rashidi Juma", grade: "Form 3", points: 890, status: "active", last_active: new Date().toISOString() },
  { id: "9", student_id: "DSS009", name: "Sofia Mwambao", grade: "Form 2", points: 1340, status: "active", last_active: new Date().toISOString() },
  { id: "10", student_id: "DSS010", name: "Tumaini Shija", grade: "Form 4", points: 2450, status: "active", last_active: new Date().toISOString() },
  { id: "11", student_id: "DSS011", name: "Upendo Chirwa", grade: "Form 1", points: 540, status: "inactive", last_active: new Date(Date.now() - 86400000 * 3).toISOString() },
  { id: "12", student_id: "DSS012", name: "Victor Nyerere", grade: "Form 3", points: 1780, status: "active", last_active: new Date().toISOString() },
];

const ACTIVITY = [
  { id: "1", student_name: "Fatuma Ali", action: "Completed Science Quiz", points: 25, timestamp: new Date(Date.now() - 3600000 * 1).toISOString() },
  { id: "2", student_name: "Tumaini Shija", action: "Asked AI about photosynthesis", points: 10, timestamp: new Date(Date.now() - 3600000 * 2).toISOString() },
  { id: "3", student_name: "Neema Kibwe", action: "Daily attendance check-in", points: 20, timestamp: new Date(Date.now() - 3600000 * 3).toISOString() },
  { id: "4", student_name: "Amina Hassan", action: "Completed Math Quiz", points: 30, timestamp: new Date(Date.now() - 3600000 * 4).toISOString() },
  { id: "5", student_name: "Brian Mwenda", action: "Asked AI about Tanzania history", points: 10, timestamp: new Date(Date.now() - 3600000 * 5).toISOString() },
];

router.get("/v1/teacher/dashboard/stats", (_req, res) => {
  res.json({
    total_students: 1247,
    active_today: 1103,
    total_points: 458920,
    avg_performance: 78.5,
    questions_today: 3421,
    online_watches: 1103,
    recent_activity: ACTIVITY,
  });
});

router.get("/v1/teacher/students", (req, res) => {
  const { grade, search } = req.query;
  let students = [...STUDENTS];
  if (grade && typeof grade === "string") {
    students = students.filter((s) => s.grade === grade);
  }
  if (search && typeof search === "string") {
    const q = search.toLowerCase();
    students = students.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.student_id.toLowerCase().includes(q)
    );
  }
  res.json({ students, total: students.length });
});

router.get("/v1/teacher/attendance", (req, res) => {
  const today = new Date().toISOString().split("T")[0];
  const records = STUDENTS.slice(0, 10).map((s, i) => ({
    id: String(i + 1),
    student_id: s.student_id,
    student_name: s.name,
    grade: s.grade,
    check_in_time: new Date(Date.now() - 3600000 * (i + 1)).toISOString(),
    status: s.status === "active" ? "present" : "absent",
    points_earned: s.status === "active" ? 20 : 0,
  }));
  res.json({
    records,
    date: today,
    total_present: 9,
    total_absent: 1,
    total_students: STUDENTS.length,
  });
});

router.get("/v1/teacher/leaderboard", (_req, res) => {
  const sorted = [...STUDENTS]
    .sort((a, b) => b.points - a.points)
    .slice(0, 10)
    .map((s, i) => ({
      rank: i + 1,
      student_id: s.student_id,
      name: s.name,
      grade: s.grade,
      points: s.points,
      badge: i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : undefined,
    }));
  res.json({ entries: sorted, period: "This Week" });
});

export default router;
