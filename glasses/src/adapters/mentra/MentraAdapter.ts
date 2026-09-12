import { capabilities, requireCapability, type GlassesCapabilities } from "../../core/GlassesCapabilities";
import { GlassesEmitter, type GlassesEvent, type GlassesEventHandler } from "../../core/GlassesEvents";
import { AdapterUnavailableError, type GlassesAdapter, type GlassesDescriptor } from "../../core/GlassesAdapter";
import type { GlassesConnectionState, KobeGlasses } from "../../core/KobeGlasses";

// MentraOS glasses (Mentra Live, Even Realities, Vuzix Z100, NIMO …) through
// `@mentra/bluetooth-sdk` (MIT).
//
// That SDK runs in React Native / Expo only — peer deps Expo >= 49, React
// Native >= 0.72 — with native packages `com.mentraglass:bluetooth-sdk` and
// `MentraBluetoothSDK`. Its published metadata documents the feature set
// (scan, connect, reconnect, display text / clear / dashboard, photo and video,
// microphone in LC3 or PCM, typed lifecycle state, and button, touch, swipe,
// battery, Wi-Fi and OTA events) but not exact method signatures.
//
// So this adapter does not import the SDK. The React Native shell passes in a
// small client that it wires to the SDK, and K9 stays on one interface. When the
// signatures are confirmed against the starter kit, the binding lives in the
// mobile app — not here — and this file needs no change.

export type MentraClient = {
  scan(): Promise<Array<{ id: string; model: string }>>;
  connect(deviceId: string): Promise<void>;
  disconnect(): Promise<void>;
  /** Features the connected model actually has, as the SDK reports them. */
  features(): Promise<Partial<GlassesCapabilities>>;
  displayText(text: string): Promise<void>;
  clearDisplay(): Promise<void>;
  takePhoto?(): Promise<Uint8Array>;
  startMicrophone?(): Promise<void>;
  stopMicrophone?(): Promise<void>;
  playAudio?(bytes: Uint8Array): Promise<void>;
  batteryPercent(): Promise<number>;
  /** Bridges the SDK's typed events onto K9's. Returns an unsubscribe. */
  subscribe?(handler: (event: { type: string; payload?: Record<string, unknown> }) => void): () => void;
};

export class MentraGlasses implements KobeGlasses {
  readonly vendor = "mentra";
  state: GlassesConnectionState = "disconnected";

  private emitter = new GlassesEmitter();
  private caps: GlassesCapabilities = capabilities({ display: true, battery: true });
  private unsubscribe: (() => void) | null = null;

  constructor(
    readonly id: string,
    readonly model: string,
    private client: MentraClient,
  ) {}

  async connect(): Promise<void> {
    this.state = "connecting";
    try {
      await this.client.connect(this.id);
      this.caps = capabilities({
        display: true,
        battery: true,
        camera: !!this.client.takePhoto,
        microphone: !!this.client.startMicrophone,
        speaker: !!this.client.playAudio,
        ...(await this.client.features().catch(() => ({}))),
      });
      this.unsubscribe =
        this.client.subscribe?.((event) => {
          if (event.type === "button" || event.type === "touch") this.emitter.emit("shutter", { source: event.type });
          else if (event.type === "battery") this.emitter.emit("battery", { percent: Number(event.payload?.["percent"] ?? 0) });
          else if (event.type === "photo" && event.payload?.["bytes"] instanceof Uint8Array) {
            this.emitter.emit("photo", { bytes: event.payload["bytes"], mimeType: "image/jpeg" });
          }
        }) ?? null;
      this.state = "connected";
      this.emitter.emit("connected", { id: this.id, model: this.model });
    } catch (err) {
      this.state = "disconnected";
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.client.disconnect().catch(() => undefined);
    this.state = "disconnected";
    this.emitter.emit("disconnected", { id: this.id, reason: null });
  }

  async getCapabilities(): Promise<GlassesCapabilities> {
    return this.caps;
  }

  display = {
    text: async (text: string): Promise<void> => {
      requireCapability(this.caps, "display", this.model);
      await this.client.displayText(text);
    },
    image: async (_data: Uint8Array): Promise<void> => {
      throw new Error(`${this.model}: images go through the MentraOS app, not this adapter`);
    },
    clear: async (): Promise<void> => {
      requireCapability(this.caps, "display", this.model);
      await this.client.clearDisplay();
    },
  };

  camera = {
    capture: async (): Promise<Uint8Array> => {
      requireCapability(this.caps, "camera", this.model);
      const bytes = await this.client.takePhoto!();
      this.emitter.emit("photo", { bytes, mimeType: "image/jpeg" });
      return bytes;
    },
  };

  microphone = {
    start: async (): Promise<void> => {
      requireCapability(this.caps, "microphone", this.model);
      await this.client.startMicrophone!();
    },
    stop: async (): Promise<void> => {
      await this.client.stopMicrophone?.();
    },
  };

  speaker = {
    play: async (data: Uint8Array): Promise<void> => {
      requireCapability(this.caps, "speaker", this.model);
      await this.client.playAudio!(data);
    },
    speak: async (_text: string): Promise<void> => {
      // No MentraOS model exposes text-to-speech on the glasses themselves.
      throw new Error(`${this.model} cannot speak text — K9 speaks through the teacher's phone or earbud`);
    },
  };

  sensors = {};

  async battery(): Promise<number> {
    return this.client.batteryPercent();
  }

  on<E extends GlassesEvent>(event: E, handler: GlassesEventHandler<E>): () => void {
    return this.emitter.on(event, handler);
  }
}

export type MentraAdapterOptions = {
  /** Supplied by the React Native shell that owns @mentra/bluetooth-sdk. */
  client: MentraClient | null;
};

export class MentraAdapter implements GlassesAdapter {
  readonly vendor = "mentra";

  constructor(private options: MentraAdapterOptions) {}

  async isAvailable(): Promise<boolean> {
    return this.options.client !== null;
  }

  async discover(): Promise<GlassesDescriptor[]> {
    if (!this.options.client) {
      throw new AdapterUnavailableError(this.vendor, "@mentra/bluetooth-sdk runs in the React Native app only");
    }
    const devices = await this.options.client.scan();
    return devices.map((device) => ({ ...device, vendor: this.vendor }));
  }

  async open(descriptor: GlassesDescriptor): Promise<KobeGlasses> {
    if (!this.options.client) throw new AdapterUnavailableError(this.vendor, "no Mentra client was provided");
    return new MentraGlasses(descriptor.id, descriptor.model, this.options.client);
  }
}
