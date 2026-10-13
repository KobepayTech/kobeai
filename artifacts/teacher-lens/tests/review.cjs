// Teacher review of a paper K9 read from a photograph, in the built Lens.
//
// Run like workspace.cjs: serve dist/public on 127.0.0.1:5178, then
//   NODE_PATH=<playwright>/node_modules node tests/review.cjs
//
// The rule under test: what K9 read is shown, never applied. The student is
// whoever the teacher picks, nothing is saved until they say so, and saving
// happens once. The server half (one result per reading, K9's reading kept
// beside the teacher's decision) is api-server routes/teacher-lens.frame.test.ts.

const { chromium } = require("playwright");
const assert = require("node:assert/strict");

const BASE = process.env.LENS_URL ?? "http://127.0.0.1:5178";
const TOKEN = `e30.${Buffer.from(JSON.stringify({ sub: "7" })).toString("base64url")}.sig`;
const JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=",
  "base64",
);

function school() {
  const server = { saves: [], dismissals: 0, imageRequests: 0, decided: false };
  server.route = async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.includes("/whisper/next")) return route.fulfill({ status: 204 });
    if (path.endsWith("/teacher-lens/reviews"))
      return route.fulfill({
        json: {
          reviews: server.decided
            ? []
            : [
                {
                  request_id: 77,
                  captured_at: "2026-10-13T08:42:41.000Z",
                  read_at: "2026-10-13T08:48:04.000Z",
                  exam_id: 1,
                  has_image: true,
                  questions: 2,
                  ai: { student_code: "TEST001", student_name: "John Doe", student_confidence: null },
                },
              ],
        },
      });
    if (path.endsWith("/frame/77/image")) {
      server.imageRequests++;
      return route.fulfill({ status: 200, contentType: "image/jpeg", body: JPEG });
    }
    if (path.endsWith("/frame/77/dismiss")) {
      server.dismissals++;
      server.decided = true;
      return route.fulfill({ json: { request_id: 77, decision: "dismissed" } });
    }
    if (path.endsWith("/frame/77"))
      return route.fulfill({
        json: {
          id: 77,
          status: "completed",
          kind: "mark_paper",
          response: {
            student_name: "John Doe",
            student_code: "TEST001",
            total_marks_awarded: 2,
            items: [
              { question_number: 1, is_correct: true, marks_awarded: 2, marks_possible: 2, student_answer: "x = 6" },
              { question_number: 2, is_correct: false, marks_awarded: 0, marks_possible: 2, student_answer: "4/12" },
            ],
          },
        },
      });
    if (path.endsWith("/results/exams"))
      return route.fulfill({ json: { exams: [{ id: 1, class_name: "Form 1A", subject: "Mathematics", title: "Quiz", kind: "ca", total_marks: 10 }] } });
    if (path.endsWith("/results/exams/1/results"))
      return route.fulfill({
        json: {
          students: [
            { student_id: 3, name: "John Doe", student_code: "TEST001", marks: null },
            { student_id: 9, name: "Joan Doe", student_code: "TEST002", marks: null },
          ],
        },
      });
    if (path.endsWith("/paper-graded")) {
      const body = JSON.parse(req.postData());
      server.saves.push(body);
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (server.decided)
        return route.fulfill({ status: 200, json: { duplicate: true, decision: "confirmed", confirmed_student_code: "TEST002", summary: null, result: null } });
      server.decided = true;
      return route.fulfill({
        status: 201,
        json: {
          summary: { total: 2, correct: 1, score_percent: 50 },
          result: { marks: 5, percent: 50, exam: { id: 1, subject: "Mathematics", title: "Quiz", kind: "ca", total_marks: 10 }, standing: null },
          curated_notes_generated: 0,
          retest: null,
        },
      });
    }
    if (path.endsWith("/session")) return route.fulfill({ json: { session: { id: 10 } } });
    return route.fulfill({ json: { current_period: null, upcoming_periods: [], students: [] } });
  };
  return server;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const passed = [];
  async function scenario(name, run) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("dialog", (dialog) => dialog.accept());
    await page.addInitScript((token) => {
      localStorage.setItem("k9-lens.auth", JSON.stringify({ api_base: location.origin, token, teacher_name: "Asha" }));
      // The exam new photographs are being captured for; a review must not change it.
      localStorage.setItem("k9-lens.exam", "5");
      navigator.mediaDevices.getUserMedia = async () => {
        throw new Error("no camera in this test");
      };
    }, TOKEN);
    const server = school();
    await page.route("**/api/**", server.route);
    try {
      await page.goto(BASE);
      await page.getByRole("tab", { name: "Papers", exact: true }).click();
      await run(page, server);
      assert.deepEqual(errors, [], "no uncaught page errors");
      passed.push(name);
    } catch (error) {
      error.message = `[${name}] ${error.message}`;
      throw error;
    } finally {
      await context.close();
    }
  }
  const openReview = async (page) => {
    await page.getByText("1 paper to review").waitFor();
    await page.getByText(/K9 read “John Doe” on the paper · not confirmed/).waitFor();
    await page.getByRole("button", { name: "Review", exact: true }).click();
    await page.getByRole("heading", { name: "Review paper" }).waitFor();
    // Wait for K9's reading to be on the sheet before judging what it did with it.
    await page.getByText(/Kobe read 2 answers/).waitFor({ timeout: 15_000 });
  };
  const save = (page) => page.getByRole("button", { name: "Confirm student and save result" });
  const studentPicker = (page) => page.locator("select.mark-input").nth(1);

  await scenario("the reading is shown, the student is the teacher's choice, and saving is explicit", async (page, server) => {
    await openReview(page);
    await page.getByAltText("The photographed paper").waitFor();
    assert.equal(server.imageRequests, 1, "the photograph was fetched for the teacher to check");
    await page.getByText(/K9 read on the paper: name “John Doe”, code “TEST001”\.\s+This is not confirmed/).waitFor();

    // K9 read a code that matches a real student. It still must not be chosen for the teacher.
    assert.equal(await studentPicker(page).inputValue(), "", "no student is preselected from the reading");
    assert.equal(await page.getByPlaceholder("Or type a student code").inputValue(), "");
    assert.equal(await save(page).isDisabled(), true, "nothing can be saved without a student");
    assert.equal(server.saves.length, 0);

    // The teacher looks at the paper and picks a different student than the one K9 read.
    await studentPicker(page).selectOption("TEST002");
    assert.equal(await save(page).isDisabled(), true, "choosing is not yet approving");
    const approval = page.getByRole("checkbox", { name: /I have checked the paper: it belongs to\s+Joan Doe/ });
    await approval.check();
    // Changing the student withdraws the approval given for the previous one.
    await studentPicker(page).selectOption("TEST001");
    assert.equal(await save(page).isDisabled(), true, "approval does not carry over to a different student");
    await studentPicker(page).selectOption("TEST002");
    await page.getByRole("checkbox", { name: /it belongs to\s+Joan Doe/ }).check();
    assert.equal(server.saves.length, 0, "still nothing sent");

    // The teacher corrects question 2, then saves — tapping twice.
    await page.locator(".mark-item").nth(1).getByPlaceholder("Marks given").fill("1");
    await save(page).dblclick();
    await page.getByText(/Saved for Joan Doe: 5\/10 \(50%\)\./).waitFor();
    assert.equal(server.saves.length, 1, "a double tap sends one save");
    const sent = server.saves[0];
    assert.equal(sent.lens_request_id, 77, "tied to the reading, so the server can refuse a second save");
    assert.equal(sent.student_code, "TEST002", "the teacher's student, not the one K9 read");
    assert.equal(sent.exam_id, 1, "the exam the paper was captured for");
    assert.equal(sent.items[1].marks_awarded, 1, "the teacher's mark");
    assert.equal(sent.items[1].metadata.ai_marks_awarded, 0, "with K9's proposal recorded beside it");
    assert.equal(sent.items[1].metadata.ai_is_correct, false);
    assert.equal(await page.evaluate(() => localStorage.getItem("k9-lens.exam")), "5", "the exam for new captures is untouched");

    await page.getByRole("tab", { name: "Papers", exact: true }).click();
    await page.getByText(/No papers yet/).waitFor();
    assert.equal(await page.getByText(/to review/).count(), 0, "the paper has left the review list");
  });

  await scenario("a paper that was already saved is not recorded again", async (page, server) => {
    await openReview(page);
    server.decided = true; // saved from another device in the meantime
    await studentPicker(page).selectOption("TEST001");
    await page.getByRole("checkbox", { name: /it belongs to\s+John Doe/ }).check();
    await save(page).click();
    await page.getByText(/This paper was already saved for TEST002\. Nothing was recorded twice\./).waitFor();
  });

  await scenario("a photograph can be set aside without recording anything", async (page, server) => {
    await openReview(page);
    await page.getByRole("button", { name: "Not a paper to save" }).click();
    await page.getByText(/Photograph set aside\. Nothing was recorded\./).waitFor();
    assert.equal(server.dismissals, 1);
    assert.equal(server.saves.length, 0);
  });

  await browser.close();
  console.log(`PASS: ${passed.join("; ")}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
