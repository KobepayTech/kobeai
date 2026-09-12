import { capabilities, requireCapability, type GlassesCapabilities } from "../../core/GlassesCapabilities";
import { GlassesEmitter, type GlassesEvent, type GlassesEventHandler, type IMUData } from "../../core/GlassesEvents";
import type { GlassesAdapter, GlassesDescriptor } from "../../core/GlassesAdapter";
import type { GlassesConnectionState, KobeGlasses } from "../../core/KobeGlasses";

// Glasses that exist only in software. This is the adapter K9 development and
// the test suite run against: it records everything shown and spoken, and lets
// a test fire a shutter press or hand back a canned photo.

export type SimulatorOptions = {
  id?: string;
  model?: string;
  capabilities?: Partial<GlassesCapabilities>;
  /** Bytes handed back by camera.capture(). */
  photo?: Uint8Array;
  batteryPercent?: number;
};

export class SimulatorGlasses implements KobeGlasses {
  readonly vendor = "simulator";
  readonly id: string;
  readonly model: string;
  state: GlassesConnectionState = "disconnected";

  /** Everything the glasses were told to show or say, in order. */
  readonly shown: string[] = [];
  readonly spoken: string[] = [];
  readonly images: Uint8Array[] = [];
  readonly played: Uint8Array[] = [];
  micOn = false;
  streaming = false;

  private emitter = new GlassesEmitter();
  private caps: GlassesCapabilities;
  private photo: Uint8Array;
  private batteryPercent: number;

  constructor(options: SimulatorOptions = {}) {
    this.id = options.id ?? "simulator-1";
    this.model = options.model ?? "K9 Simulator";
    this.caps = capabilities({
      display: true,
      displayImage: true,
      camera: true,
      cameraStream: true,
      microphone: true,
      speaker: true,
      speechSynthesis: true,
      imu: true,
      touch: true,
      buttons: true,
      battery: true,
      ...options.capabilities,
    });
    this.photo = options.photo ?? new Uint8Array([0xff, 0xd8, 0xff, 0xd9]); // shortest valid JPEG markers
    this.batteryPercent = options.batteryPercent ?? 87;
  }

  async connect(): Promise<void> {
    this.state = "connected";
    this.emitter.emit("connected", { id: this.id, model: this.model });
  }

  async disconnect(): Promise<void> {
    this.state = "disconnected";
    this.micOn = false;
    this.streaming = false;
    this.emitter.emit("disconnected", { id: this.id, reason: null });
  }

  async getCapabilities(): Promise<GlassesCapabilities> {
    return this.caps;
  }

  display = {
    text: async (text: string): Promise<void> => {
      requireCapability(this.caps, "display", this.model);
      this.shown.push(text);
    },
    image: async (data: Uint8Array): Promise<void> => {
      requireCapability(this.caps, "displayImage", this.model);
      this.images.push(data);
    },
    clear: async (): Promise<void> => {
      requireCapability(this.caps, "display", this.model);
      this.shown.push("");
    },
  };

  camera = {
    capture: async (): Promise<Uint8Array> => {
      requireCapability(this.caps, "camera", this.model);
      this.emitter.emit("photo", { bytes: this.photo, mimeType: "image/jpeg" });
      return this.photo;
    },
    startStream: async (): Promise<void> => {
      requireCapability(this.caps, "cameraStream", this.model);
      this.streaming = true;
    },
    stopStream: async (): Promise<void> => {
      this.streaming = false;
    },
  };

  microphone = {
    start: async (): Promise<void> => {
      requireCapability(this.caps, "microphone", this.model);
      this.micOn = true;
    },
    stop: async (): Promise<void> => {
      this.micOn = false;
    },
  };

  speaker = {
    play: async (data: Uint8Array): Promise<void> => {
      requireCapability(this.caps, "speaker", this.model);
      this.played.push(data);
    },
    speak: async (text: string): Promise<void> => {
      requireCapability(this.caps, "speaker", this.model);
      this.spoken.push(text);
    },
  };

  sensors = {
    imu: async (): Promise<IMUData> => {
      requireCapability(this.caps, "imu", this.model);
      return { pitch: 0, roll: 0, yaw: 0, at: Date.now() };
    },
  };

  async battery(): Promise<number> {
    return this.batteryPercent;
  }

  on<E extends GlassesEvent>(event: E, handler: GlassesEventHandler<E>): () => void {
    return this.emitter.on(event, handler);
  }

  // -- test helpers ---------------------------------------------------------

  /** Pretend the wearer pressed the capture button. */
  pressShutter(source: "button" | "touch" | "voice" = "button"): void {
    this.emitter.emit("shutter", { source });
  }

  /** Pretend the phone's speech recognition produced a line of text. */
  hearSpeech(text: string, final = true): void {
    this.emitter.emit("transcript", { text, final });
  }

  setBattery(percent: number): void {
    this.batteryPercent = percent;
    this.emitter.emit("battery", { percent });
  }
}

export class SimulatorAdapter implements GlassesAdapter {
  readonly vendor = "simulator";

  constructor(private options: SimulatorOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async discover(): Promise<GlassesDescriptor[]> {
    return [{ id: this.options.id ?? "simulator-1", model: this.options.model ?? "K9 Simulator", vendor: this.vendor }];
  }

  async open(descriptor: GlassesDescriptor): Promise<KobeGlasses> {
    return new SimulatorGlasses({ ...this.options, id: descriptor.id });
  }
}
