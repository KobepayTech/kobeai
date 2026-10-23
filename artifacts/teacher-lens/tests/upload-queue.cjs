// The durable upload queue, driven through the built Lens in a mobile browser.
//
// Run like workspace.cjs: serve dist/public on 127.0.0.1:5178, then
//   NODE_PATH=<playwright>/node_modules node tests/upload-queue.cjs
//
// The school server is a route mock that can be switched off (requests fail at
// the network, as on a dropped Wi-Fi), made to lose its reply, or made to
// refuse. Everything else is the real app: real IndexedDB, a real reload for
// "the app was closed", and Chromium's fake camera for the phone-camera path.

const { chromium } = require("playwright");
const assert = require("node:assert/strict");

const BASE = process.env.LENS_URL ?? "http://127.0.0.1:5178";
const token = (userId) =>
  `e30.${Buffer.from(JSON.stringify({ sub: String(userId) })).toString("base64url")}.sig`;
const ASHA = token(7);
const BARAKA = token(8);

/** A school server. `frames` is what it accepted; `attempts` is everything it was sent. */
function school() {
  const server = {
    mode: "up", // up | down | lose-reply | refuse | expired | gone
    detail: [], // per attempt: the headers that carry a frame's context
    attempts: [],
    processed: new Map(), // capture id -> request id
    nextRequestId: 500,
    logins: { "asha@school.tz": ASHA, "baraka@school.tz": BARAKA },
  };
  server.route = async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    if (path.includes("/whisper/next")) return route.fulfill({ status: 204 });
    if (path.endsWith("/auth/teacher/login")) {
      const { email } = JSON.parse(req.postData());
      return route.fulfill({ json: { access_token: server.logins[email], teacher_name: email.split("@")[0] } });
    }
    if (path.endsWith("/teacher-lens/frame") && req.method() === "POST") {
      const headers = req.headers();
      const attempt = { captureId: headers["x-lens-capture-id"], auth: headers.authorization, mode: headers["x-lens-mode"] };
      server.attempts.push(attempt);
      server.detail.push({
        captureId: attempt.captureId,
        examId: headers["x-lens-exam-id"] ?? null,
        ageMs: Number(headers["x-lens-capture-age-ms"]),
        sessionId: headers["x-lens-session-id"],
      });
      if (server.mode === "gone") return route.fulfill({ status: 410, json: { error: "lookup_expired" } });
      if (server.mode === "down") return route.abort("connectionfailed");
      if (server.mode === "expired") return route.fulfill({ status: 401, json: { error: "expired" } });
      if (server.mode === "refuse") return route.fulfill({ status: 400, json: { error: "empty or too-small image body" } });
      // Idempotency, as api-server lib/lens-capture.ts implements it.
      const seen = server.processed.get(attempt.captureId);
      if (seen) return route.fulfill({ status: 200, json: { request: { id: seen }, image_key: `k/${seen}.jpg`, duplicate: true } });
      const id = ++server.nextRequestId;
      server.processed.set(attempt.captureId, id);
      if (server.mode === "lose-reply") {
        server.mode = "up";
        return route.abort("connectionreset");
      }
      return route.fulfill({ status: 202, json: { request: { id }, image_key: `k/${id}.jpg` } });
    }
    if (/\/teacher-lens\/frame\/\d+$/.test(path)) return route.fulfill({ json: { status: "completed" } });
    if (path.endsWith("/session")) {
      // An unreachable server is unreachable for everything, not only uploads.
      if (server.mode === "down") return route.abort("connectionfailed");
      return route.fulfill({ json: { session: { id: 10 } } });
    }
    if (path.endsWith("/teacher/students")) return route.fulfill({ json: { students: [{ student_id: "K9-001", name: "Neema" }] } });
    return route.fulfill({ json: { current_period: null, upcoming_periods: [] } });
  };
  return server;
}

const signedIn = (page, bearer) =>
  page.addInitScript((value) => {
    if (!sessionStorage.getItem("seeded")) {
      localStorage.setItem("k9-lens.auth", JSON.stringify({ api_base: location.origin, token: value, teacher_name: "Asha" }));
      sessionStorage.setItem("seeded", "1");
    }
  }, bearer);

/** Open the lens; on the phone-camera path, wait until the camera has a picture. */
const openLens = async (page, phoneCamera = true) => {
  if (await page.getByRole("tab", { name: "Home", exact: true }).isVisible())
    await page.getByRole("tab", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: /Student insights/ }).click();
  if (phoneCamera) await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0);
};
const shutter = (page) => page.getByRole("button", { name: "Capture / check frame" }).click();
const closeSheet = (page) => page.getByRole("button", { name: "Cancel", exact: true }).click();
const openActivity = async (page) => {
  if (!(await page.getByRole("tab", { name: "Papers", exact: true }).isVisible()))
    await page.getByRole("button", { name: "← Back to K9 home" }).click();
  await page.getByRole("tab", { name: "Papers", exact: true }).click();
};
const stored = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open("k9-lens-uploads");
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result.transaction("frames").objectStore("frames").getAll();
          all.onsuccess = () => resolve(all.result);
        };
      }),
  );
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Take one lookup photo while the server is unreachable, leaving it queued. */
async function captureWhileDown(page, server) {
  server.mode = "down";
  await shutter(page);
  await page.getByText(/saved on this phone but has not reached the school server/).waitFor({ timeout: 15_000 });
  await closeSheet(page);
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const passed = [];
  async function scenario(name, run) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ["camera"] });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const server = school();
    await page.route("**/api/**", server.route);
    try {
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

  await scenario("outage recovery", async (page, server) => {
    await signedIn(page, ASHA);
    await page.goto(BASE);
    await openLens(page);
    await captureWhileDown(page, server);
    await page.getByText(/1 photo saved on this phone, waiting to upload/).waitFor();
    const [frame] = await stored(page);
    assert.equal(frame.state, "pending", "an unsent frame stays stored");
    await openActivity(page);
    await page.getByText("1 waiting to upload").waitFor();
    await page.getByText(/Student lookup · pending/).waitFor();

    server.mode = "up";
    await page.getByRole("button", { name: "Try now" }).click();
    await page.getByText(/Student lookup · completed/).waitFor();
    await page.getByText(/#501/).waitFor();
    assert.equal(server.processed.size, 1, "the frame reached the server once");
    assert.ok(server.attempts.length >= 2, "it was attempted during the outage and again after");
    assert.equal(new Set(server.attempts.map((a) => a.captureId)).size, 1, "every attempt carried the same capture id");
    assert.match(server.attempts[0].captureId, /^[A-Za-z0-9_-]{16,64}$/);
    assert.equal((await stored(page))[0].state, "done");
  });

  await scenario("restart recovery", async (page, server) => {
    await signedIn(page, ASHA);
    await page.goto(BASE);
    await openLens(page);
    await captureWhileDown(page, server);
    const before = (await stored(page))[0];

    // The app is closed and reopened while the server is still unreachable…
    await page.reload();
    await openActivity(page);
    await page.getByText("1 waiting to upload").waitFor();
    assert.equal(server.processed.size, 0);

    // …and again once it is back: the upload resumes with nobody pressing anything.
    server.mode = "up";
    await page.reload();
    await openActivity(page);
    await page.getByText(/Student lookup · completed/).waitFor();
    assert.deepEqual([...server.processed.keys()], [before.id], "the stored frame, under its original capture id");
  });

  await scenario("opened offline, uploads once the network returns without being reopened", async (page, server) => {
    await signedIn(page, ASHA);
    await page.goto(BASE);
    await openLens(page);
    await captureWhileDown(page, server);
    // The app is closed and reopened with the server still unreachable, so it
    // cannot even start its session…
    await page.reload();
    await openActivity(page);
    await page.getByText("1 waiting to upload").waitFor();
    await sleep(4000);
    assert.equal(server.processed.size, 0);
    // …and then the Wi-Fi comes back while the app is simply left open.
    server.mode = "up";
    await page.getByText(/Student lookup · completed/).waitFor({ timeout: 45_000 });
    assert.equal(server.processed.size, 1);
    assert.equal(server.detail.at(-1).sessionId, "10", "sent under the session it finally obtained");
  });

  await scenario("duplicate retries", async (page, server) => {
    await signedIn(page, ASHA);
    await page.goto(BASE);
    await openLens(page);
    // The server takes the photo but the reply is lost, so the phone cannot
    // know it arrived and has to send it again.
    server.mode = "lose-reply";
    await shutter(page);
    await page.getByText(/K9 is checking the photo|Pick the student/).waitFor({ timeout: 15_000 });
    await closeSheet(page);
    await openActivity(page);
    await page.getByText(/#501/).waitFor();
    assert.ok(server.attempts.length >= 2, "the phone retried");
    assert.equal(new Set(server.attempts.map((a) => a.captureId)).size, 1, "with the same capture id");
    assert.equal(server.processed.size, 1, "and the server processed the capture once");
    assert.equal(server.nextRequestId, 501, "no second vision request was created");
    assert.equal((await stored(page))[0].requestId, 501, "the phone records the first attempt's result");
  });

  await scenario("refused upload and retry control", async (page, server) => {
    await signedIn(page, ASHA);
    await page.goto(BASE);
    await openLens(page);
    server.mode = "refuse";
    await shutter(page);
    await page.getByText(/No photo was taken|has not reached the school server/).waitFor({ timeout: 15_000 });
    await closeSheet(page);
    await page.getByText(/1 could not be uploaded/).waitFor();
    await openActivity(page);
    await page.getByText(/Student lookup · failed/).waitFor();
    await page.getByText(/refused this photo \(HTTP 400\)/).waitFor();
    assert.equal((await stored(page))[0].state, "failed", "a refused frame is kept, not dropped");
    const attemptsWhileFailed = server.attempts.length;
    await sleep(3000);
    assert.equal(server.attempts.length, attemptsWhileFailed, "a refused frame is not retried on its own");

    server.mode = "up";
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByText(/Student lookup · completed/).waitFor();
  });

  await scenario("replayed exam frames keep their exam and capture time", async (page, server) => {
    await signedIn(page, ASHA);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("exam-seeded")) {
        localStorage.setItem("k9-lens.exam", "41");
        sessionStorage.setItem("exam-seeded", "1");
      }
    });
    server.mode = "down";
    await page.goto(BASE);
    await page.getByRole("button", { name: /Mark a paper/ }).click();
    // Continuous marking photographs the paper on its own while the server is away.
    await page.waitForFunction(() => document.querySelector("video")?.videoWidth > 0);
    await page.getByText(/[2-9] photos saved on this phone, waiting to upload/).waitFor({ timeout: 20_000 });
    const queued = (await stored(page)).filter((f) => f.mode === "mark");
    assert.ok(queued.length >= 2);
    assert.ok(queued.every((f) => f.examId === 41), "each frame remembers the exam it was captured for");

    // The teacher moves on to another exam and closes the app before the server returns.
    await page.evaluate(() => localStorage.setItem("k9-lens.exam", "99"));
    const captureTimes = new Map(queued.map((f) => [f.id, f.createdAt]));
    await sleep(3000);
    server.detail.length = 0;
    server.mode = "up";
    await page.reload();
    await openActivity(page);
    await page.getByText(/Paper reading · completed/).first().waitFor();
    await page.waitForFunction(async () => {
      const open = indexedDB.open("k9-lens-uploads");
      const db = await new Promise((resolve) => (open.onsuccess = () => resolve(open.result)));
      const all = db.transaction("frames").objectStore("frames").getAll();
      const frames = await new Promise((resolve) => (all.onsuccess = () => resolve(all.result)));
      return frames.every((f) => f.state === "done");
    });
    const replayed = server.detail.filter((d) => captureTimes.has(d.captureId));
    assert.equal(replayed.length, queued.length, "every stored frame was replayed");
    for (const attempt of replayed) {
      assert.equal(attempt.examId, "41", "under the exam it was captured for, not the one selected now");
      assert.ok(attempt.ageMs >= 3000, `with its real age (${attempt.ageMs}ms), so the server can date it`);
      assert.equal(attempt.sessionId, "10", "and only once the new session exists");
    }
    assert.deepEqual(
      replayed.map((d) => d.captureId),
      [...captureTimes.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id),
      "in the order the pages were photographed",
    );
    const after = await stored(page);
    for (const frame of after.filter((f) => captureTimes.has(f.id)))
      assert.equal(frame.createdAt, captureTimes.get(frame.id), "capture time is never rewritten");
  });

  await scenario("a stale lookup is held back, not replayed", async (page, server) => {
    await signedIn(page, ASHA);
    await page.goto(BASE);
    await openLens(page);
    // The server says the lookup is too old to act on (it would whisper late).
    server.mode = "gone";
    await shutter(page);
    await page.getByText(/saved on this phone but has not reached the school server/).waitFor({ timeout: 15_000 });
    await closeSheet(page);
    await openActivity(page);
    await page.getByText(/Student lookup · failed/).waitFor();
    await page.getByText(/was not sent in time, so it was held back and will not be sent/).waitFor();
    assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0, "an expired lookup offers no retry");
    assert.equal(await page.getByRole("button", { name: "Remove", exact: true }).count(), 1);
    server.mode = "up";
    const attempts = server.attempts.length;
    await page.reload();
    await openActivity(page);
    await page.getByText(/Student lookup · failed/).waitFor();
    await sleep(3000);
    assert.equal(server.attempts.length, attempts, "and it is never sent again, even after a restart with the server back");
    assert.equal(server.processed.size, 0);
  });

  await scenario("with automatic capture off, marking photographs only on the shutter", async (page, server) => {
    await signedIn(page, ASHA);
    await page.goto(BASE);
    await openLens(page);
    await page.getByRole("button", { name: "Mark paper", exact: true }).click();
    await page.getByRole("button", { name: "Auto-capture: On ✓" }).click();
    await page.getByRole("button", { name: "Auto-capture: Off" }).waitFor();
    await page.getByText(/Automatic capture is off\. Tap the shutter/).waitFor();
    // A frame already committed before the toggle may still finish uploading.
    // Let that in-flight upload settle before checking the disabled state.
    await sleep(2500);
    const attemptsWhenDisabled = server.attempts.length;
    await sleep(6000);
    assert.equal(server.attempts.length, attemptsWhenDisabled, "no additional photographs after automatic capture is turned off");
    const processedBeforeShutter = server.processed.size;
    const attemptsBeforeShutter = server.attempts.length;
    await shutter(page);
    await page.getByText(/K9 is reading the marked paper/).waitFor({ timeout: 15_000 });
    await sleep(4000);
    assert.equal(server.processed.size - processedBeforeShutter, 1, "one tap, one additional photograph");
    assert.equal(server.attempts.length - attemptsBeforeShutter, 1, "shutter produces one new upload");
    assert.equal(server.attempts.at(-1).mode, "mark");
    // The choice survives the app being closed.
    await page.reload();
    await openLens(page);
    await page.getByRole("button", { name: "Mark paper", exact: true }).click();
    await page.getByRole("button", { name: "Auto-capture: Off" }).waitFor();
  });

  await scenario("account switching", async (page, server) => {
    await signedIn(page, ASHA);
    await page.goto(BASE);
    await openLens(page);
    await captureWhileDown(page, server);
    const ashasFrame = (await stored(page))[0];
    const signIn = async (email) => {
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill("irrelevant");
      await page.getByRole("button", { name: "Continue to K9 →", exact: true }).click();
      await page.getByRole("tab", { name: "Papers", exact: true }).waitFor();
    };

    // Another teacher signs in on the same phone, on a working server.
    await page.getByRole("button", { name: "Sign out" }).click();
    server.mode = "up";
    server.attempts.length = 0;
    await signIn("baraka@school.tz");
    await openActivity(page);
    await page.getByText(/1 photo from a different sign-in is stored on this phone/).waitFor();
    await page.getByText(/No captures sent yet/).waitFor();
    assert.equal(await page.getByText(/waiting to upload/).count(), 0, "another teacher's queue is not shown");
    await sleep(4000);
    assert.deepEqual(server.attempts, [], "nothing of Asha's was uploaded under Baraka's sign-in");
    assert.equal((await stored(page))[0].state, "pending", "and it is still stored");

    // Baraka's own capture goes up as Baraka.
    await page.getByRole("tab", { name: "Home", exact: true }).click();
    await openLens(page);
    await shutter(page);
    await page.getByText(/K9 is checking the photo|Pick the student/).waitFor({ timeout: 15_000 });
    await closeSheet(page);
    assert.deepEqual(server.attempts.map((a) => a.auth), [`Bearer ${BARAKA}`]);
    assert.notEqual(server.attempts[0].captureId, ashasFrame.id);

    // Asha returns: her frame uploads, under her sign-in.
    await page.getByRole("button", { name: "Sign out" }).click();
    server.attempts.length = 0;
    await signIn("asha@school.tz");
    await openActivity(page);
    await page.getByText(/Student lookup · completed/).waitFor();
    assert.deepEqual(server.attempts, [{ captureId: ashasFrame.id, auth: `Bearer ${ASHA}`, mode: "lookup" }]);
  });

  await scenario("expired sign-in pauses uploads without losing frames", async (page, server) => {
    await signedIn(page, ASHA);
    await page.goto(BASE);
    await openLens(page);
    server.mode = "expired";
    await shutter(page);
    await page.getByText(/saved on this phone but has not reached the school server/).waitFor({ timeout: 15_000 });
    await closeSheet(page);
    await page.getByText(/sign in again to send them/).waitFor();
    await openActivity(page);
    await page.getByText(/no longer accepts this sign-in, so uploads\s+are paused/).waitFor();
    const attempts = server.attempts.length;
    await sleep(3000);
    assert.equal(server.attempts.length, attempts, "no retry storm against a server that said no");
    assert.equal((await stored(page))[0].state, "pending");
  });

  await scenario("storage full", async (page, server) => {
    await signedIn(page, ASHA);
    await page.goto(BASE);
    await openLens(page);
    await captureWhileDown(page, server);
    // Fill the rest of this account's allowance with stored frames.
    await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open("k9-lens-uploads");
          open.onsuccess = () => {
            const tx = open.result.transaction(["frames", "images"], "readwrite");
            const frames = tx.objectStore("frames");
            const first = frames.getAll();
            first.onsuccess = () => {
              const template = first.result[0];
              for (let i = 1; i < 240; i++) {
                const id = `filler${String(i).padStart(26, "0")}`;
                frames.put({ ...template, id, createdAt: template.createdAt + i });
                tx.objectStore("images").put(new ArrayBuffer(600), id);
              }
            };
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
          };
        }),
    );
    await shutter(page);
    await page.getByRole("alert").filter({ hasText: /Capture storage on this phone is full: 240 photos are waiting/ }).waitFor();
    await sleep(500);
    const frames = await stored(page);
    assert.equal(frames.length, 240, "the new photo was refused out loud, and nothing stored was dropped to make room");
    assert.ok(frames.every((f) => f.state !== "done"));
  });

  // --- glasses -------------------------------------------------------------
  /** A native host whose glasses connect (or not) and whose camera can fail. */
  const nativeHost = (page, options) =>
    page.addInitScript((opts) => {
      window.cameraCalls = 0;
      const realCamera = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = (constraints) => {
        window.cameraCalls++;
        return realCamera(constraints);
      };
      window.nativeCalls = [];
      let connected = false;
      let provider = null;
      // Like the real host, "paused" outlives the page.
      let enabled = sessionStorage.getItem("native-paused") !== "1";
      window.KobeNative = {
        postMessage(raw) {
          const call = JSON.parse(raw);
          window.nativeCalls.push(call.method);
          const reply = { id: call.id, result: null };
          if (call.method === "info") reply.result = { version: 1, providers: ["moyoung"], automaticMoYoung: enabled, connected, provider };
          if (call.method === "connect") {
            if (opts.connects) {
              connected = true;
              provider = "moyoung";
              reply.result = { capabilities: { camera: true, display: true, speaker: true, speechSynthesis: true } };
            } else {
              delete reply.result;
              reply.error = "Connection failed or cancelled. Check permissions, Bluetooth and the vendor licence.";
            }
          }
          if (call.method === "capture") {
            delete reply.result;
            reply.error = "Photo capture failed. Reconnect glasses and try again.";
          }
          if (call.method === "pause" || call.method === "forget") {
            enabled = false;
            sessionStorage.setItem("native-paused", "1");
            connected = false;
            provider = null;
          }
          if (call.method === "disconnect") {
            connected = false;
            provider = null;
          }
          setTimeout(() => window.KobeNative.onmessage?.({ data: JSON.stringify(reply) }), 0);
        },
      };
    }, options);

  await scenario("glasses capture failure", async (page, server) => {
    await signedIn(page, ASHA);
    await nativeHost(page, { connects: true });
    await page.goto(BASE);
    await page.getByText("MoYoung Glasses connected", { exact: true }).waitFor();
    await openLens(page, false);
    await shutter(page);
    await page
      .getByRole("alert")
      .filter({ hasText: /MoYoung Glasses did not return a photo, and the phone camera was not used in their place\..*Reconnect glasses and try again/ })
      .waitFor();
    assert.equal(await page.evaluate(() => window.cameraCalls), 0, "the phone camera was never opened");
    assert.deepEqual(server.attempts, [], "nothing was uploaded in the glasses' place");
    assert.deepEqual(await stored(page).catch(() => []), [], "and nothing was queued");
  });

  await scenario("glasses selected but not connected", async (page, server) => {
    await signedIn(page, ASHA);
    await nativeHost(page, { connects: false });
    await page.goto(BASE);
    await openLens(page, false);
    await page.getByText(/MoYoung Glasses are selected but not connected\. Open Connections/).first().waitFor();
    await shutter(page);
    await page.getByRole("alert").filter({ hasText: /selected but not connected, so no photo was taken/ }).waitFor();
    assert.equal(await page.evaluate(() => window.cameraCalls), 0, "no silent fall back to the phone camera");
    assert.deepEqual(server.attempts, []);

    // Choosing the phone camera explicitly is still honoured.
    await page.getByRole("button", { name: "← Back to K9 home" }).click();
    await page.getByRole("button", { name: "Open glasses settings" }).click();
    await page.getByLabel("Camera source").selectOption("");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText(/automatic glasses connection paused/).waitFor();
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await openLens(page);
    assert.ok((await page.evaluate(() => window.cameraCalls)) > 0);
    await shutter(page);
    await page.getByText(/K9 is checking the photo|Pick the student/).waitFor({ timeout: 15_000 });
    assert.equal(server.processed.size, 1, "the explicitly chosen phone camera captures and uploads");

    // The choice is remembered when the app is reopened.
    await page.reload();
    await page.getByRole("button", { name: "Open glasses settings" }).click();
    await page.getByText("Phone camera", { exact: true }).last().waitFor();
    assert.equal(await page.getByLabel("Camera source").inputValue(), "", "still on the phone camera");
    await sleep(4000);
    assert.equal(await page.evaluate(() => window.nativeCalls.filter((m) => m === "connect").length), 0, "and no glasses connection is attempted");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await openLens(page);
    assert.equal(await page.getByText(/selected but not connected/).count(), 0);
  });

  await browser.close();
  console.log(`PASS: ${passed.join(", ")}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
