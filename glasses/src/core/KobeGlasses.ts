import type { GlassesCapabilities } from "./GlassesCapabilities";
import type { GlassesEvent, GlassesEventHandler, IMUData } from "./GlassesEvents";

// The one interface everything above the adapter talks to. K9 never branches on
// Even G1 / Brilliant Frame / Vuzix — it calls these methods and the selected
// adapter deals with the hardware.

export type GlassesConnectionState = "disconnected" | "connecting" | "connected";

export interface KobeGlasses {
  readonly id: string;
  readonly model: string;
  readonly vendor: string;
  readonly state: GlassesConnectionState;

  connect(): Promise<void>;
  disconnect(): Promise<void>;
  getCapabilities(): Promise<GlassesCapabilities>;

  display: {
    text(text: string): Promise<void>;
    image(data: Uint8Array): Promise<void>;
    clear(): Promise<void>;
  };

  camera: {
    capture(): Promise<Uint8Array>;
    startStream?(): Promise<void>;
    stopStream?(): Promise<void>;
  };

  microphone: {
    start(): Promise<void>;
    stop(): Promise<void>;
  };

  speaker: {
    play(data: Uint8Array): Promise<void>;
    speak(text: string): Promise<void>;
  };

  sensors: {
    imu?(): Promise<IMUData>;
  };

  battery(): Promise<number>;

  on<E extends GlassesEvent>(event: E, handler: GlassesEventHandler<E>): () => void;
}

export type { GlassesCapabilities, IMUData };
