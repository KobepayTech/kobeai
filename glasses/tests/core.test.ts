import { test } from "node:test";
import { strict as assert } from "node:assert";

import { CapabilityMissingError, GlassesManager, capabilities } from "../src/core/index";
import { SimulatorAdapter, SimulatorGlasses } from "../src/adapters/simulator/SimulatorAdapter";
import { K9Api } from "../src/k9/K9Api";
import { K9GlassesController } from "../src/k9/K9GlassesController";

test("the manager opens the first adapter that can run here", async () => {
  const manager = new GlassesManager().register(new SimulatorAdapter({ model: "Test Frame" }));
  const found = await manager.discover();
  assert.deepEqual(
    found.map((device) => device.vendor),
    ["simulator"],
  );
  const glasses = await manager.open(found[0]!);
  assert.equal(glasses.state, "connected");
  assert.equal(glasses.model, "Test Frame");
});

test("an adapter that can't run here is skipped, and reports why", async () => {
  const manager = new GlassesManager().register({
    vendor: "mentra",
    isAvailable: async () => false,
    discover: async () => [{ id: "x", model: "Even G1", vendor: "mentra" }],
    open: async () => {
      throw new Error("should not open");
    },
  });
  assert.deepEqual(await manager.discover(), []);
  await assert.rejects(() => manager.connectFirst(), /No glasses adapter can run here/);
});

test("display-only glasses refuse the camera instead of pretending", async () => {
  const glasses = new SimulatorGlasses({ model: "Even G1", capabilities: capabilities({ display: true, microphone: true }) });
  await glasses.connect();
  await glasses.display.text("Physics starts in Room 4");
  assert.deepEqual(glasses.shown, ["Physics starts in Room 4"]);
  await assert.rejects(() => glasses.camera.capture(), CapabilityMissingError);
});

/** A K9 server that answers the handful of endpoints the glasses use. */
function fakeK9(overrides: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const whispers = ["Asha Juma. Last Biology: 92 percent."];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, body: init?.body });
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (url.endsWith("/v1/teacher-lens/session")) return json({ session: { id: 7 } });
    if (url.includes("/v1/teacher-lens/frame/")) return json({ id: 11, status: "completed", kind: "lookup", response: { student_name: "Asha Juma" }, ...overrides });
    if (url.endsWith("/v1/teacher-lens/frame")) return json({ request: { id: 11 }, image_key: "2026-09-12/abc.lookup.jpg" });
    if (url.includes("/v1/teacher-lens/whisper/next")) {
      const next = whispers.shift();
      return next ? json({ whisper: { text: next } }) : new Response(null, { status: 204 });
    }
    if (url.endsWith("/v1/classroom/ask")) return json({ answer: "Photosynthesis is how plants make food from sunlight." });
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("the shutter sends a frame and shows who K9 recognised", async () => {
  const { calls, fetchImpl } = fakeK9();
  const glasses = new SimulatorGlasses();
  const spoken: string[] = [];
  const controller = new K9GlassesController({
    glasses,
    api: new K9Api({ baseUrl: "http://school.local:8088", token: "teacher-token", fetchImpl }),
    speakOnPhone: (text) => spoken.push(text),
    whisperPollMs: 10_000,
  });
  await glasses.connect();
  await controller.start("lookup");
  await controller.onShutter();

  const frame = calls.find((call) => call.url.endsWith("/v1/teacher-lens/frame"));
  assert.ok(frame, "the photo was posted to the lens frame endpoint");
  assert.equal(frame!.method, "POST");
  assert.deepEqual(glasses.shown, ["Point at a student", "Looking them up…", "Asha Juma"]);
  await controller.stop();
});

test("mark mode sends the picked exam with the paper", async () => {
  const { calls, fetchImpl } = fakeK9({ kind: "mark_paper", response: { items: [{}, {}, {}] } });
  const glasses = new SimulatorGlasses();
  const controller = new K9GlassesController({
    glasses,
    api: new K9Api({ baseUrl: "http://school.local:8088", token: "teacher-token", fetchImpl }),
    examId: 42,
    whisperPollMs: 10_000,
  });
  await glasses.connect();
  await controller.start("mark");
  await controller.onShutter();
  assert.ok(glasses.shown.includes("3 answers read — check the sheet"));
  await controller.stop();
});

test("glasses without a speaker fall back to the teacher's earbud", async () => {
  const { fetchImpl } = fakeK9();
  const glasses = new SimulatorGlasses({ capabilities: capabilities({ display: true, camera: true }) });
  const spoken: string[] = [];
  const controller = new K9GlassesController({
    glasses,
    api: new K9Api({ baseUrl: "http://school.local:8088", token: "t", fetchImpl }),
    speakOnPhone: (text) => spoken.push(text),
    whisperPollMs: 10_000,
  });
  await glasses.connect();
  await controller.start("assistant");
  await controller.askBrain("What is photosynthesis?");
  assert.deepEqual(spoken, ["Photosynthesis is how plants make food from sunlight."]);
  await controller.stop();
});
