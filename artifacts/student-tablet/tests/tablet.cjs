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
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 820, height: 1180 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.addInitScript(() => {
    localStorage.setItem("k9-student.auth", JSON.stringify({
      api_base: location.origin, token: "t", name: "Amani", student_code: "K9-001",
    }));
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

  // Navigation is never disabled by a request in flight.
  assert.deepEqual(
    await page.getByRole("tab").evaluateAll((els) => els.map((e) => e.disabled)),
    [false, false, false, false, false],
  );
  assert.deepEqual(errors, []);
  await browser.close();
  console.log("PASS: home, timetable, banded learning map with no percentages, ask, honest follow-up");
})().catch((e) => { console.error(e); process.exit(1); });
