import type { KobeGlasses } from "../core/KobeGlasses";

// ===========================================================================
// Exam Mode: photograph papers hands-free, at whatever rate the glasses can
// actually sustain.
//
// The premise is a teacher marking a stack of papers with the glasses on,
// rather than pressing a shutter for every script. The hard part is not issuing
// the command — it is that **capture and transfer are separate operations** on
// every pair of glasses worth using, and the second one is slow and variable.
// A vendor command that returns "photo taken" has told you nothing about
// whether the image is on the phone.
//
// So this does not promise a cadence. It aims at one, measures what it gets,
// and slows down on its own if the device cannot keep up — then reports the
// interval the hardware actually sustained, which is the number a deployment
// decision needs.
//
// It is device-agnostic by construction: it drives `KobeGlasses.camera.capture`
// and knows nothing about Rokid, Wi-Fi P2P modes or BLE. Any adapter that can
// return JPEG bytes can be measured by it.
// ===========================================================================

/** A conservative opening target. Raised only by evidence, never by hope. */
export const DEFAULT_TARGET_MS = 5_000;

/** Below this a classroom device is not keeping up and the aim is lowered. */
export const MIN_TARGET_MS = 1_500;

/** No slower than this; past it the teacher is waiting on the glasses. */
export const MAX_TARGET_MS = 30_000;

/** A capture that has not produced bytes by now is treated as lost. */
export const CAPTURE_TIMEOUT_MS = 25_000;

/** Consecutive failures before Exam Mode stops and says so. */
export const GIVE_UP_AFTER = 4;

export type Shot = {
  index: number;
  /** When the capture was requested, ms since session start. */
  at: number;
  /** Request to bytes-in-hand. The number that actually matters. */
  latencyMs: number;
  bytes: number;
  ok: boolean;
  error?: string;
};

export type SessionReport = {
  attempted: number;
  delivered: number;
  failed: number;
  /** Wall-clock seconds the session ran. */
  seconds: number;
  /** Delivered photographs per minute, measured not promised. */
  perMinute: number;
  medianLatencyMs: number;
  p95LatencyMs: number;
  /** The interval the hardware sustained, rounded up to a round number. */
  sustainableIntervalMs: number;
  targetEndedAtMs: number;
  stoppedBecause: string;
  shots: Shot[];
};

export type SchedulerOptions = {
  targetMs?: number;
  /** Stop after this many delivered photographs. Omit to run until stopped. */
  limit?: number;
  captureTimeoutMs?: number;
  onShot?: (shot: Shot) => void;
  /** Injected for tests; defaults to real time. */
  now?: () => number;
  /**
   * Waiting between captures to hold the cadence. A test may make this
   * instant to run a virtual clock.
   */
  sleep?: (ms: number) => Promise<void>;
  /**
   * The watchdog on a single capture — deliberately NOT `sleep`.
   *
   * Pacing and timing out are different jobs, and sharing one function
   * conflates them: a test that makes pacing instant would fire every
   * watchdog immediately and no capture could ever succeed. This defaults to
   * a real timer so a virtual clock cannot disarm it.
   */
  timer?: (ms: number) => Promise<void>;
};

const percentile = (sorted: number[], p: number): number =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!;

/** Round an interval up to something a human would write down. */
export function roundInterval(ms: number): number {
  if (ms <= 0) return MIN_TARGET_MS;
  const step = ms < 10_000 ? 500 : 1_000;
  return Math.ceil(ms / step) * step;
}

export class CaptureScheduler {
  private running = false;
  private stopReason = "";
  private target: number;
  private readonly shots: Shot[] = [];

  constructor(
    private glasses: Pick<KobeGlasses, "camera" | "state">,
    private options: SchedulerOptions = {},
  ) {
    this.target = Math.min(
      MAX_TARGET_MS,
      Math.max(MIN_TARGET_MS, options.targetMs ?? DEFAULT_TARGET_MS),
    );
  }

  get targetMs(): number {
    return this.target;
  }

  stop(reason = "stopped_by_teacher"): void {
    if (this.running && !this.stopReason) this.stopReason = reason;
    this.running = false;
  }

  /**
   * Run Exam Mode until stopped, the limit is reached, or the glasses give up.
   *
   * Captures never overlap. One slow transfer must not have a second command
   * issued on top of it — on a device that switches between capture and
   * transfer modes, that is how a session wedges.
   */
  async run(): Promise<SessionReport> {
    const now = this.options.now ?? (() => Date.now());
    const sleep =
      this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const timer =
      this.options.timer ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const timeout = this.options.captureTimeoutMs ?? CAPTURE_TIMEOUT_MS;
    const started = now();
    this.running = true;
    this.stopReason = "";
    let consecutiveFailures = 0;

    while (this.running) {
      if (this.options.limit !== undefined && this.delivered >= this.options.limit) {
        this.stopReason = "reached_limit";
        break;
      }
      if (this.glasses.state !== "connected") {
        this.stopReason = "glasses_disconnected";
        break;
      }

      const at = now() - started;
      const begun = now();
      let shot: Shot;
      try {
        const bytes = await withTimeout(this.glasses.camera.capture(), timeout, timer);
        shot = {
          index: this.shots.length,
          at,
          latencyMs: now() - begun,
          bytes: bytes.length,
          ok: bytes.length > 0,
          ...(bytes.length === 0 ? { error: "empty_image" } : {}),
        };
      } catch (error) {
        shot = {
          index: this.shots.length,
          at,
          latencyMs: now() - begun,
          bytes: 0,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
      this.shots.push(shot);
      this.options.onShot?.(shot);

      if (shot.ok) {
        consecutiveFailures = 0;
      } else {
        consecutiveFailures += 1;
        if (consecutiveFailures >= GIVE_UP_AFTER) {
          this.stopReason = "too_many_failures";
          break;
        }
        // A failure is usually the device still busy with the last transfer, so
        // back off rather than retrying straight into the same wall.
        this.target = Math.min(MAX_TARGET_MS, Math.round(this.target * 1.5));
      }

      // Adapt. If a capture consistently takes longer than the target, the
      // target is a fiction: the real cadence is the latency, and pretending
      // otherwise just means zero idle time and no slack for anything else.
      if (shot.latencyMs > this.target) {
        this.target = Math.min(MAX_TARGET_MS, roundInterval(shot.latencyMs * 1.15));
      }

      const remaining = this.target - shot.latencyMs;
      if (remaining > 0 && this.running) await sleep(remaining);
    }

    const latencies = this.shots.filter((s) => s.ok).map((s) => s.latencyMs).sort((a, b) => a - b);
    const seconds = Math.max(0.001, (now() - started) / 1000);
    return {
      attempted: this.shots.length,
      delivered: this.delivered,
      failed: this.shots.length - this.delivered,
      seconds: Math.round(seconds * 10) / 10,
      perMinute: Math.round((this.delivered / seconds) * 60 * 10) / 10,
      medianLatencyMs: Math.round(percentile(latencies, 0.5)),
      p95LatencyMs: Math.round(percentile(latencies, 0.95)),
      // What the hardware sustained: the 95th percentile, not the best case. A
      // cadence that works nine times in ten drops a paper every tenth script.
      sustainableIntervalMs: roundInterval(percentile(latencies, 0.95) * 1.15),
      targetEndedAtMs: this.target,
      stoppedBecause: this.stopReason || "stopped",
      shots: this.shots,
    };
  }

  private get delivered(): number {
    return this.shots.filter((s) => s.ok).length;
  }
}

async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  timer: (ms: number) => Promise<void>,
): Promise<T> {
  let settled = false;
  const expiry = timer(ms).then((): never => {
    throw new Error(`capture timed out after ${ms}ms`);
  });
  // The work is given the race rather than the watchdog: a capture that
  // resolves in the same tick as the watchdog is a delivered photograph, not
  // a timeout.
  return await Promise.race([
    work.then((value) => {
      settled = true;
      return value;
    }),
    expiry.catch((error) => {
      if (settled) return undefined as never;
      throw error;
    }),
  ]);
}

/**
 * The proof of concept, as a function: connect, take N, report.
 *
 * This is the thing to run on a new pair of glasses before promising anyone a
 * cadence. It answers the questions a spec sheet does not: do ten consecutive
 * commands succeed, does every image actually arrive, and what is the shortest
 * interval this hardware can hold.
 */
export async function benchmarkCapture(
  glasses: Pick<KobeGlasses, "camera" | "state">,
  shots = 10,
  options: SchedulerOptions = {},
): Promise<SessionReport> {
  return new CaptureScheduler(glasses, {
    ...options,
    limit: shots,
    // Aim fast on purpose: the point is to find the ceiling, and the scheduler
    // backs off to whatever the device can actually do.
    targetMs: options.targetMs ?? MIN_TARGET_MS,
  }).run();
}
