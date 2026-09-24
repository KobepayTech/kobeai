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

  // Navigation is never disabled by a request in flight.
  assert.deepEqual(
    await page.getByRole("tab").evaluateAll((els) => els.map((e) => e.disabled)),
    [false, false, false, false, false],
  );
  assert.deepEqual(errors, []);
  await browser.close();
  console.log("PASS: home, timetable, banded map with no percentages, ask, honest follow-up, draw, scan, camera released");
})().catch((e) => { console.error(e); process.exit(1); });
