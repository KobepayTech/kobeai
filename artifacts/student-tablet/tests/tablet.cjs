// Browser test for the student tablet.
//
//   pnpm --filter @workspace/student-tablet build
//   python3 -m http.server 5179 --directory artifacts/student-tablet/dist/public &
//   node artifacts/student-tablet/tests/tablet.cjs
//
// The assertion that matters is the negative one: no percentage may reach a
// child's screen. lib/mastery-bands.test.ts enforces the same rule server-side
// and does run in CI; this proves it survives all the way to the pixels.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
  // A real fake camera, so the component's actual getUserMedia path runs.
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"],
  });
  const context = await browser.newContext({
    viewport: { width: 820, height: 1180 },
    permissions: ["camera"],
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("k9-student.auth", JSON.stringify({
      api_base: location.origin, token: "t", name: "Amani", student_code: "K9-001",
    }));
    // Watch the real track being released. A tablet left with its camera light
    // on in a classroom is both a battery problem and an unsettling one.
    window.__stopped = false;
    const stop = MediaStreamTrack.prototype.stop;
    MediaStreamTrack.prototype.stop = function () {
      window.__stopped = true;
      return stop.apply(this, arguments);
    };
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/v1/student/today"))
      return route.fulfill({ json: { now_minute: 560, periods: [
        { period_id: 1, subject: "Mathematics", room: "A", start_minute: 480, end_minute: 520, state: "done" },
        { period_id: 2, subject: "Physics", room: "B", start_minute: 560, end_minute: 600, state: "now" },
      ] } });
    if (path.endsWith("/v1/student/me"))
      return route.fulfill({ json: {
        subjects: [{ subject: "Physics", skills: [
          { skill_id: 1, name: "Speed", subject: "Physics", band: "strong", label: "Strong", pips: 4, moving: null, needs_practice_to_tell: false },
          { skill_id: 2, name: "Negative acceleration", subject: "Physics", band: "learning", label: "Learning", pips: 2, moving: "down", needs_practice_to_tell: false },
          { skill_id: 3, name: "Motion graphs", subject: "Physics", band: null, label: "Not enough practice yet", pips: 0, moving: null, needs_practice_to_tell: true },
        ]}],
        focus: { skill_id: 2, name: "Negative acceleration", subject: "Physics", band: "learning", label: "Learning", pips: 2, moving: "down", needs_practice_to_tell: false },
        week: { questions_asked: 18, skills_practised: 12 },
      } });
    if (path.endsWith("/v1/classroom/ask"))
      return route.fulfill({ json: { answer: "Negative acceleration points the opposite way to motion." } });
    if (path.endsWith("/v1/student/notes"))
      return route.fulfill({ json: { entitled: true, notes: [
        { id: 1, subject: "Physics", topic: "Negative acceleration", body_markdown: "Acceleration opposes motion when it is negative." },
      ] } });
    if (path.endsWith("/v1/student/practice"))
      return route.fulfill({ json: { entitled: true, practice: [
        { id: 5, subject: "Physics", difficulty_level: "standard", questions: 2 },
      ] } });
    if (path.endsWith("/v1/student/practice/5"))
      return route.fulfill({ json: { id: 5, subject: "Physics", items: [
        { id: 51, topic: "Negative acceleration", question_text: "A car slows from 10 m/s at -2 m/s^2. What is v after 3 s?" },
        { id: 52, topic: "Negative acceleration", question_text: "Is the car still moving forward?" },
      ] } });
    if (path.endsWith("/v1/student/practice/5/answer")) {
      const body = JSON.parse(route.request().postData() || "{}");
      // The server's rule, mirrored: a hinted right answer is not a measurement.
      return route.fulfill({ json: {
        correct: true, moves_mastery: !body.used_hint,
        suggest_assessment: !!body.used_hint,
        reason: body.used_hint ? "assisted_attempt_measures_the_hint" : "independent_demonstration",
      } });
    }
    if (path.endsWith("/v1/student/school"))
      return route.fulfill({ json: {
        week: [
          { day_of_week: 1, subject: "Mathematics", room: "A", start_minute: 480, end_minute: 520 },
          { day_of_week: 4, subject: "Physics", room: "B", start_minute: 560, end_minute: 600 },
        ],
        results: [{ subject: "Physics", marks_awarded: 34, marks_possible: 50, created_at: "2026-09-01T00:00:00Z" }],
        attendance_rate: 95, kp_balance: 120,
        subscription: { status: "active", expires_at: "2027-01-01T00:00:00Z" },
      } });
    if (path.endsWith("/v1/student/scan"))
      return route.fulfill({ json: {
        read: "v = u + at, a = -2", answer: "Check the sign on the -2 when you substitute.",
        moves_mastery: false,
      } });
    if (path.endsWith("/v1/student/interaction"))
      return route.fulfill({ json: { record: true, moves_mastery: false, suggest_assessment: false, reason: "x" } });
    return route.fulfill({ json: {} });
  });
  await page.goto("http://127.0.0.1:5179");
  await page.getByText("Good", { exact: false }).first().waitFor();
  await page.getByText("Physics", { exact: true }).first().waitFor();

  // THE rule: no percentage may ever appear on a child's screen.
  await page.getByRole("tab", { name: "Me", exact: true }).click();
  await page.getByText("Negative acceleration").first().waitFor();
  const body = await page.locator("body").innerText();
  assert.ok(!/\d+\s?%/.test(body), `a percentage leaked onto the student screen: ${body.match(/\d+\s?%/)}`);
  assert.ok(body.includes("Not enough practice yet"), "thin evidence is stated honestly");
  assert.ok(body.includes("Strong") && body.includes("Learning"), "bands render");

  // Ask K9, and check the follow-up tells the truth about marks.
  await page.getByRole("tab", { name: "K9", exact: true }).click();
  await page.getByLabel("Ask a question").fill("Why is acceleration negative?");
  await page.getByRole("button", { name: "Ask", exact: true }).click();
  await page.getByText(/points the opposite way/).waitFor();
  await page.getByRole("button", { name: "I understand ✓" }).click();
  await page.getByText(/doesn’t change your marks/).waitFor();

  // Draw your working: the pad, a stroke, and the scan round trip.
  await page.getByRole("button", { name: /Show your working/ }).click();
  await page.getByLabel("Draw your working").waitFor();
  const pad = page.getByLabel("Draw your working");
  const box = await pad.boundingBox();
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 160, box.y + 110);
  await page.mouse.up();
  await page.getByRole("button", { name: "Ask K9", exact: true }).click();
  await page.getByText(/I read:/).waitFor();
  await page.getByText(/Check the sign on the -2/).waitFor();

  // Scan: the camera must be released when the view closes, or a tablet is
  // left with its light on in a classroom.
  await page.getByRole("button", { name: /Scan a question/ }).click();
  await page.getByLabel("Camera").waitFor();
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.getByLabel("Ask a question").waitFor();
  await page.waitForFunction(() => window.__stopped === true, null, { timeout: 5000 })
    .catch(() => { throw new Error("the camera track must be stopped when Scan is closed"); });

  // Learn: a practice answered ALONE counts; the same answer after a hint does
  // not, and the child is told so rather than quietly downgraded.
  await page.getByRole("tab", { name: "Learn", exact: true }).click();
  await page.getByText("Revision notes").waitFor();
  await page.getByRole("button", { name: /Physics/ }).first().click();
  await page.getByLabel("Your answer").fill("4 m/s");
  await page.getByRole("button", { name: "Check" }).click();
  await page.getByText(/worked that out on your own/).waitFor();
  await page.getByRole("button", { name: "Next question" }).click();
  await page.getByRole("button", { name: "Give me a hint" }).click();
  await page.getByLabel("Your answer").fill("yes");
  await page.getByRole("button", { name: "Check" }).click();
  await page.getByText(/used a hint, so this one doesn’t change your learning map/).waitFor();
  await page.getByText(/asking is how you learn/).waitFor();

  // School: the child's own record. Marks ARE numbers here — the
  // no-percentages rule is about inferred mastery, not a teacher's mark.
  await page.getByRole("tab", { name: "School", exact: true }).click();
  await page.getByText("Your timetable").waitFor();
  const school = await page.locator("body").innerText();
  assert.ok(school.includes("34/50"), "a teacher's mark is the child's to see");
  assert.ok(school.includes("95%") && school.includes("120"), "attendance and KP render");
  assert.ok(school.includes("Thursday"), "the whole week renders");

  // Navigation is never disabled by a request in flight.
  assert.deepEqual(
    await page.getByRole("tab").evaluateAll((els) => els.map((e) => e.disabled)),
    [false, false, false, false, false],
  );
  assert.deepEqual(errors, []);
  await browser.close();
  console.log("PASS: home, banded map, ask, draw, scan, camera released, practice hint downgrade, school record");
})().catch((e) => { console.error(e); process.exit(1); });
