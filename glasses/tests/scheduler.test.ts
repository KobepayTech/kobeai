import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CaptureScheduler,
  GIVE_UP_AFTER,
  MAX_TARGET_MS,
  MIN_TARGET_MS,
  benchmarkCapture,
  roundInterval,
} from "../src/k9/CaptureScheduler";

/**
 * A fake pair of glasses with a controllable capture latency, on a virtual
 * clock. Exam Mode is about timing, and timing tests on a real clock are both
 * slow and flaky.
 */
function fakeGlasses(plan: {
  latency: number | number[];
  failAt?: number[];
  state?: "connected" | "disconnected";
  disconnectAfter?: number;
}) {
  let clock = 0;
  let calls = 0;
  const latency = (n: number) =>
    Array.isArray(plan.latency) ? (plan.latency[n] ?? plan.latency.at(-1)!) : plan.latency;
  const glasses = {
    state: (plan.state ?? "connected") as "connected" | "disconnected",
    camera: {
      capture: async (): Promise<Uint8Array> => {
        const n = calls++;
        clock += latency(n);
        if (plan.disconnectAfter !== undefined && calls >= plan.disconnectAfter)
          glasses.state = "disconnected";
        if (plan.failAt?.includes(n)) throw new Error("transfer busy");
        return new Uint8Array(1024);
      },
    },
  };
  return {
    glasses,
    options: {
      now: () => clock,
      sleep: async (ms: number) => {
        clock += ms;
      },
    },
  };
}

test("a device that keeps up holds the target cadence", async () => {
  const { glasses, options } = fakeGlasses({ latency: 1_200 });
  const report = await new CaptureScheduler(glasses, {
    ...options,
    targetMs: 5_000,
    limit: 5,
  }).run();
  assert.equal(report.delivered, 5);
  assert.equal(report.failed, 0);
  assert.equal(report.targetEndedAtMs, 5_000, "no need to slow down");
  assert.equal(report.stoppedBecause, "reached_limit");
});

test("a device that cannot keep up sets its own pace instead of being promised one", async () => {
  // The finding this exists for: a vendor command returning success says
  // nothing about the image being on the phone. If transfer takes 9s, the real
  // cadence is 9s, and claiming 5s just means zero slack.
  const { glasses, options } = fakeGlasses({ latency: 9_000 });
  const report = await new CaptureScheduler(glasses, {
    ...options,
    targetMs: 5_000,
    limit: 3,
  }).run();
  assert.equal(report.delivered, 3);
  assert.ok(report.targetEndedAtMs > 9_000, `target should have risen, got ${report.targetEndedAtMs}`);
  assert.ok(report.sustainableIntervalMs >= 10_000);
});

test("captures never overlap, however slow the transfer", async () => {
  // On a device that switches between capture and transfer modes, issuing a
  // second command on top of a slow first one is how a session wedges.
  let inFlight = 0;
  let maxInFlight = 0;
  let clock = 0;
  const glasses = {
    state: "connected" as const,
    camera: {
      capture: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        clock += 7_000;
        inFlight -= 1;
        return new Uint8Array(10);
      },
    },
  };
  await new CaptureScheduler(glasses, {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    targetMs: 2_000,
    limit: 4,
  }).run();
  assert.equal(maxInFlight, 1);
});

test("the reported interval is the 95th percentile, not the best case", async () => {
  // A cadence that works nine times in ten drops a paper every tenth script.
  const { glasses, options } = fakeGlasses({
    latency: [1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 1_000, 8_000],
  });
  const report = await new CaptureScheduler(glasses, { ...options, limit: 10, targetMs: 2_000 }).run();
  assert.equal(report.delivered, 10);
  assert.ok(report.medianLatencyMs <= 1_100, "most were fast");
  assert.ok(
    report.sustainableIntervalMs >= 8_000,
    `the slow tail must set the interval, got ${report.sustainableIntervalMs}`,
  );
});

test("a failure backs off rather than retrying into the same wall", async () => {
  const { glasses, options } = fakeGlasses({ latency: 1_000, failAt: [0] });
  const report = await new CaptureScheduler(glasses, { ...options, targetMs: 4_000, limit: 2 }).run();
  assert.equal(report.failed, 1);
  assert.equal(report.delivered, 2);
  assert.ok(report.targetEndedAtMs > 4_000, "the target should have loosened after the failure");
});

test("it gives up and says why rather than hammering a dead device", async () => {
  const failAt = Array.from({ length: GIVE_UP_AFTER }, (_, i) => i);
  const { glasses, options } = fakeGlasses({ latency: 500, failAt });
  const report = await new CaptureScheduler(glasses, { ...options, targetMs: 2_000 }).run();
  assert.equal(report.stoppedBecause, "too_many_failures");
  assert.equal(report.delivered, 0);
  assert.equal(report.attempted, GIVE_UP_AFTER);
});

test("losing the glasses mid-session stops cleanly and keeps what arrived", async () => {
  const { glasses, options } = fakeGlasses({ latency: 1_000, disconnectAfter: 2 });
  const report = await new CaptureScheduler(glasses, { ...options, targetMs: 2_000, limit: 10 }).run();
  assert.equal(report.stoppedBecause, "glasses_disconnected");
  assert.equal(report.delivered, 2, "the papers already photographed are not lost");
});

test("disconnected glasses produce a report, not an exception", async () => {
  const { glasses, options } = fakeGlasses({ latency: 500, state: "disconnected" });
  const report = await new CaptureScheduler(glasses, { ...options, limit: 3 }).run();
  assert.equal(report.attempted, 0);
  assert.equal(report.stoppedBecause, "glasses_disconnected");
});

test("an empty image counts as a failure, not a photograph", async () => {
  // A vendor that answers "mode set, success" with no bytes has delivered
  // nothing, and the whole point is to count what arrived.
  let clock = 0;
  const report = await new CaptureScheduler(
    {
      state: "connected",
      camera: { capture: async () => new Uint8Array(0) },
    },
    { now: () => clock, sleep: async (ms) => { clock += ms; }, targetMs: 1_500, limit: 2 },
  ).run();
  assert.equal(report.delivered, 0);
  assert.ok(report.failed > 0);
});

test("a wedged capture times out instead of hanging Exam Mode", async () => {
  let clock = 0;
  const report = await new CaptureScheduler(
    { state: "connected", camera: { capture: () => new Promise<Uint8Array>(() => {}) } },
    {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      captureTimeoutMs: 3_000,
      // The watchdog gets its own instant timer here; pacing stays virtual.
      timer: async () => undefined,
      targetMs: 1_500,
    },
  ).run();
  assert.equal(report.stoppedBecause, "too_many_failures");
  assert.ok(report.shots[0]!.error?.includes("timed out"));
});

test("the target is clamped to something a classroom can live with", async () => {
  const { glasses, options } = fakeGlasses({ latency: 100 });
  assert.equal(new CaptureScheduler(glasses, { ...options, targetMs: 10 }).targetMs, MIN_TARGET_MS);
  assert.equal(
    new CaptureScheduler(glasses, { ...options, targetMs: 10 * 60_000 }).targetMs,
    MAX_TARGET_MS,
  );
});

test("stopping is honoured and reported", async () => {
  const { glasses, options } = fakeGlasses({ latency: 500 });
  const scheduler = new CaptureScheduler(glasses, {
    ...options,
    targetMs: 1_500,
    onShot: (shot) => {
      if (shot.index === 2) scheduler.stop("teacher_pressed_stop");
    },
  });
  const report = await scheduler.run();
  assert.equal(report.delivered, 3);
  assert.equal(report.stoppedBecause, "teacher_pressed_stop");
});

test("the benchmark aims fast and reports what the device actually did", async () => {
  // The proof of concept: ten consecutive captures, every image counted.
  const { glasses, options } = fakeGlasses({ latency: 2_600 });
  const report = await benchmarkCapture(glasses, 10, options);
  assert.equal(report.attempted, 10);
  assert.equal(report.delivered, 10);
  assert.ok(report.sustainableIntervalMs >= 3_000, "measured, not assumed");
  assert.ok(report.perMinute > 0);
});

test("intervals round to numbers a person would write down", () => {
  assert.equal(roundInterval(2_600), 3_000);
  assert.equal(roundInterval(9_100), 9_500);
  assert.equal(roundInterval(12_200), 13_000);
  assert.equal(roundInterval(0), MIN_TARGET_MS);
});
