// Typed events every adapter emits. Deliberately small: K9 reacts to a shutter
// press, a photo, speech and connection changes — everything else is polled.

export type IMUData = { pitch: number; roll: number; yaw: number; at: number };

export type GlassesEventMap = {
  connected: { id: string; model: string };
  disconnected: { id: string; reason: string | null };
  /** The wearer pressed the capture button / tapped the frame. */
  shutter: { source: "button" | "touch" | "voice" };
  photo: { bytes: Uint8Array; mimeType: string };
  /** A chunk of microphone audio, 16-bit PCM mono unless the adapter says otherwise. */
  audio: { bytes: Uint8Array; sampleRate: number };
  /** Speech the device (or the phone) already turned into text. */
  transcript: { text: string; final: boolean };
  battery: { percent: number };
  imu: IMUData;
  error: { message: string };
};

export type GlassesEvent = keyof GlassesEventMap;
export type GlassesEventHandler<E extends GlassesEvent> = (payload: GlassesEventMap[E]) => void;

/** Minimal typed emitter — no Node or DOM dependency, so it runs anywhere. */
export class GlassesEmitter {
  private handlers = new Map<GlassesEvent, Set<(payload: never) => void>>();

  on<E extends GlassesEvent>(event: E, handler: GlassesEventHandler<E>): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler as (payload: never) => void);
    this.handlers.set(event, set);
    return () => this.off(event, handler);
  }

  off<E extends GlassesEvent>(event: E, handler: GlassesEventHandler<E>): void {
    this.handlers.get(event)?.delete(handler as (payload: never) => void);
  }

  emit<E extends GlassesEvent>(event: E, payload: GlassesEventMap[E]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      try {
        (handler as GlassesEventHandler<E>)(payload);
      } catch {
        // A listener must never break the device loop.
      }
    }
  }

  listenerCount(event: GlassesEvent): number {
    return this.handlers.get(event)?.size ?? 0;
  }

  removeAll(): void {
    this.handlers.clear();
  }
}
