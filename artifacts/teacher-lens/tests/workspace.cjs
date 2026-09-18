const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const requests = [];
  await page.addInitScript(() => {
    localStorage.setItem(
      "k9-lens.auth",
      JSON.stringify({
        api_base: location.origin,
        token: "teacher-test",
        teacher_name: "Asha",
      }),
    );
    window.cameraCalls = 0;
    navigator.mediaDevices.getUserMedia = async () => {
      window.cameraCalls++;
      throw new Error("Test camera unavailable");
    };
  });
  await page.route("**/api/**", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    requests.push({
      path: url.pathname,
      auth: req.headers().authorization,
      body: req.postData(),
    });
    let data = {};
    if (url.pathname.endsWith("/session")) data = { session: { id: 10 } };
    else if (url.pathname.endsWith("/classroom/context"))
      data = {
        current_period: null,
        upcoming_periods: [
          {
            period_id: 1,
            subject: "Biology",
            class_name: "Form 2",
            room: "B",
            start_minute: 600,
            end_minute: 640,
          },
        ],
      };
    else if (url.pathname.endsWith("/teacher/students"))
      data = {
        students: [{ student_id: "K9-001", name: "Neema", grade: "Form 2" }],
      };
    else if (url.pathname.endsWith("/summary"))
      data = {
        profile: {
          topics_strong: ["Reading"],
          topics_weak: ["Fractions"],
          attendance_rate: 95,
        },
        recent_papers: [],
      };
    else if (url.pathname.includes("/curated-notes/"))
      data = {
        notes: [
          {
            id: 1,
            topic: "Fractions practice",
            body_markdown: "Practise halves.",
          },
        ],
      };
    else if (url.pathname.endsWith("/behavior/event"))
      data = { observation: { id: 1 } };
    else if (url.pathname.endsWith("/classroom/ask"))
      data = {
        answer: "Use a leaf for the activity.",
        provider: "ollama",
        model: "qwen",
      };
    else if (url.pathname.includes("/whisper/next"))
      return route.fulfill({ status: 204 });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(data),
    });
  });
  await page.goto("http://127.0.0.1:5178");
  await page.getByText("Biology", { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => window.cameraCalls),
    0,
    "Workspace should not start phone camera",
  );
  await page
    .getByRole("button", {
      name: "Connections: school server and Rokid glasses",
    })
    .click();
  assert.equal(
    await page
      .getByLabel("Current server address", { exact: true })
      .inputValue(),
    "http://127.0.0.1:5178",
  );
  await page.getByRole("button", { name: "Check server connection" }).click();
  await page.getByText(/Connected. Your school API accepted/).waitFor();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await page.getByRole("button", { name: "Students", exact: true }).click();
  await page.getByLabel("Search students").fill("Neema");
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await page.getByRole("button", { name: /Neema/ }).click();
  await page.getByText("Needs support: Fractions", { exact: true }).waitFor();
  await page
    .getByLabel("What did you observe?")
    .fill("Explained fractions to a classmate.");
  await page.getByRole("button", { name: "Save to school record" }).click();
  await page.getByText(/Observation saved/).waitFor();
  const saved = requests.find((r) => r.path.endsWith("/behavior/event"));
  assert.equal(JSON.parse(saved.body).student_code, "K9-001");
  assert.equal(saved.auth, "Bearer teacher-test");
  await page.getByRole("button", { name: "Ask Kobe", exact: true }).click();
  await page
    .getByLabel("Question", { exact: true })
    .fill("Suggest an activity");
  await page
    .getByRole("button", { name: "Ask Kobe", exact: true })
    .last()
    .click();
  await page.getByText("Use a leaf for the activity.").waitFor();
  await page.getByText("Source: ollama · qwen").waitFor();
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByText(/No captures sent yet/).waitFor();
  await page
    .getByRole("button", {
      name: "Connections: school server and Rokid glasses",
    })
    .click();
  await page.getByRole("button", { name: "Change server / sign in" }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => localStorage.getItem("k9-lens.auth")),
    null,
  );
  assert.equal(
    await page.getByLabel("School server URL").inputValue(),
    "http://127.0.0.1:5178",
  );
  assert.deepEqual(errors, []);
  await browser.close();
  console.log(
    "PASS: mobile dashboard, camera gating, student summary, authenticated observation, AI source, empty activity, sign-out",
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
