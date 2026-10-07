import type { GlassesCapabilities } from "../core/GlassesCapabilities";
import type { KobeGlasses } from "../core/KobeGlasses";
import type { K9Api } from "./K9Api";

// What the teacher's glasses actually do in a K9 school. Glasses are staff kit:
// no student wears them, so every mode here belongs to a teacher, an admin or
// security. K9 never branches on hardware — it asks the capabilities.

export type GlassesMode = "lookup" | "mark" | "assistant" | "translate" | "safety";

export type ControllerOptions = {
  glasses: KobeGlasses;
  api: K9Api;
  /** Speaks in the teacher's ear when the glasses have no speaker (the usual case). */
  speakOnPhone?: (text: string) => void;
  /** Exam picked on the mark sheet, so read papers land on the right exam. */
  examId?: number | null;
  whisperPollMs?: number;
};

export class K9GlassesController {
  private glasses: KobeGlasses;
  private api: K9Api;
  private caps: GlassesCapabilities | null = null;
  private sessionId: number | null = null;
  private stopHandlers: Array<() => void> = [];
  private whisperTimer: ReturnType<typeof setInterval> | null = null;
  private markCaptureTimer: ReturnType<typeof setInterval> | null = null;
  private markCaptureInFlight = false;
  mode: GlassesMode = "lookup";
  examId: number | null;

  constructor(private options: ControllerOptions) {
    this.glasses = options.glasses;
    this.api = options.api;
    this.examId = options.examId ?? null;
  }

  /** Opens a lens session, wires the shutter, and starts reading whispers. */
  async start(mode: GlassesMode = "lookup"): Promise<void> {
    this.mode = mode;
    this.caps = await this.glasses.getCapabilities();
    this.sessionId = await this.api.startSession(mode === "mark" ? "marking" : "lookup");
    this.stopHandlers.push(this.glasses.on("shutter", () => void this.onShutter()));
    this.stopHandlers.push(
      this.glasses.on("transcript", ({ text, final }) => {
        if (final && this.mode === "assistant") void this.askBrain(text);
        if (final && this.mode === "translate") void this.translate(text);
      }),
    );
    this.startWhispers();
    if (mode === "mark") this.startContinuousMarkingCapture();
    await this.show(mode === "mark" ? "K9 marking vision active" : "Point at a student");
  }

  async stop(): Promise<void> {
    for (const off of this.stopHandlers) off();
    this.stopHandlers = [];
    if (this.whisperTimer) clearInterval(this.whisperTimer);
    this.whisperTimer = null;
    if (this.markCaptureTimer) clearInterval(this.markCaptureTimer);
    this.markCaptureTimer = null;
    if (this.sessionId) await this.api.endSession(this.sessionId);
    this.sessionId = null;
  }

  setMode(mode: GlassesMode): void {
    this.mode = mode;
    if (mode === "mark" && !this.markCaptureTimer) this.startContinuousMarkingCapture();
    if (mode !== "mark" && this.markCaptureTimer) {
      clearInterval(this.markCaptureTimer);
      this.markCaptureTimer = null;
    }
  }

  /**
   * Exam marking is camera-first. The teacher does not read the question,
   * answer, or question number aloud. K9 samples the teacher's view and the
   * vision worker determines the paper, student, question, answer and marks.
   */
  private startContinuousMarkingCapture(): void {
    if (this.markCaptureTimer || !this.caps?.camera) return;
    const intervalMs = 1800;
    void this.captureMarkFrame();
    this.markCaptureTimer = setInterval(() => void this.captureMarkFrame(), intervalMs);
  }

  private async captureMarkFrame(): Promise<void> {
    if (this.mode !== "mark" || !this.caps?.camera || this.markCaptureInFlight) return;
    this.markCaptureInFlight = true;
    try {
      const bytes = await this.glasses.camera.capture();
      await this.api.sendFrame(bytes, {
        sessionId: this.sessionId,
        mode: "mark",
        examId: this.examId,
      });
    } catch {
      // A dropped frame must never interrupt the teacher's normal marking.
    } finally {
      this.markCaptureInFlight = false;
    }
  }

  /** Shows text when there is a display; otherwise says it. */
  async show(text: string): Promise<void> {
    if (this.caps?.display) await this.glasses.display.text(text).catch(() => this.say(text));
    else this.say(text);
  }

  /** Speaks through the glasses when they can, else through the phone/earbud. */
  say(text: string): void {
    if (this.caps?.speechSynthesis && this.caps?.speaker) {
      void this.glasses.speaker.speak(text).catch(() => this.options.speakOnPhone?.(text));
      return;
    }
    this.options.speakOnPhone?.(text);
  }

  /**
   * Manual capture remains useful for lookup mode. In marking mode K9 is already
   * sampling the camera continuously; the teacher never reads the question aloud.
   */
  async onShutter(): Promise<void> {
    if (!this.caps?.camera) {
      await this.show("These glasses have no camera — use the phone");
      return;
    }
    const bytes = await this.glasses.camera.capture();
    const queued = await this.api.sendFrame(bytes, {
      sessionId: this.sessionId,
      mode: this.mode === "mark" ? "mark" : "lookup",
      examId: this.mode === "mark" ? this.examId : null,
    });
    await this.show(this.mode === "mark" ? "K9 is reading the marked paper…" : "Looking them up…");
    return queued.requestId === null ? undefined : this.waitForFrame(queued.requestId);
  }

  /** Follows one frame to its answer and shows the outcome. */
  private async waitForFrame(requestId: number, timeoutMs = 20 * 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const result = await this.api.frameResult(requestId).catch(() => null);
      if (!result || result.status === "pending" || result.status === "in_progress") continue;
      const response = result.response ?? {};
      if (result.kind === "lookup") {
        const name = typeof response["student_name"] === "string" ? response["student_name"] : null;
        await this.show(name ?? "Not recognised — pick from the list");
      } else {
        const items = Array.isArray(response["items"]) ? response["items"].length : 0;
        await this.show(items > 0 ? `${items} answers read — check the sheet` : "Couldn't read that paper");
      }
      return;
    }
    await this.show("K9 is taking too long");
  }

  /** Assistant mode: a spoken question goes to the school's own brain. */
  async askBrain(question: string, subject?: string): Promise<string> {
    const answer = await this.api.ask(question, subject);
    await this.show(answer.slice(0, 200));
    this.say(answer);
    return answer;
  }

  /** Translation mode: same brain, asked to translate between English and Kiswahili. */
  async translate(text: string): Promise<string> {
    return this.askBrain(
      `Translate this between English and Kiswahili, whichever direction fits, and reply with the translation only: ${text}`,
    );
  }

  /** Safety mode: an alert from K9 shown big and spoken at once. */
  async alert(message: string): Promise<void> {
    await this.show(`⚠ ${message}`);
    this.say(message);
  }

  /** Drains K9's whisper queue so results reach the teacher's ear. */
  private startWhispers(): void {
    const every = this.options.whisperPollMs ?? 2000;
    this.whisperTimer = setInterval(() => {
      void this.api
        .nextWhisper(this.sessionId)
        .then((text) => {
          if (text) this.say(text);
        })
        .catch(() => undefined);
    }, every);
  }
}
