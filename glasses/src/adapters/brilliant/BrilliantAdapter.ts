import { capabilities, requireCapability, type GlassesCapabilities } from "../../core/GlassesCapabilities";
import { GlassesEmitter, type GlassesEvent, type GlassesEventHandler, type IMUData } from "../../core/GlassesEvents";
import { AdapterUnavailableError, type GlassesAdapter, type GlassesDescriptor } from "../../core/GlassesAdapter";
import type { GlassesConnectionState, KobeGlasses } from "../../core/KobeGlasses";
import { BATTERY_LEVEL, CAPTURE_PHOTO, CLEAR_DISPLAY, IMU_DIRECTION, MICROPHONE_START, MICROPHONE_STOP, displayText } from "./frameLua";

// Brilliant Labs Frame / Halo over WebBluetooth.
//
// The real transport is the `brilliant-ble` package (BSD-3-Clause, browser
// only): `new BrilliantBle()`, `connect()`, `sendLua()`, `disconnect()`,
// `setPrintResponseHandler()`, plus `type` = FRAME | HALO. Photos come through
// `brilliant-msg` (`RxPhoto`, `TxCaptureSettings`).
//
// Those packages are not a dependency of this workspace: the client is injected
// so the Teacher Lens PWA can supply the real one, and tests a fake. Nothing
// here guesses an API that isn't in those packages.

/** The part of `brilliant-ble`'s BrilliantBle that K9 uses. */
export type BrilliantBleLike = {
  connect(): Promise<string>;
  disconnect(): Promise<void>;
  sendLua(lua: string): Promise<unknown>;
  setPrintResponseHandler?(handler: (line: string) => void): void;
  type?: string;
};

/** Optional hook for `brilliant-msg`'s RxPhoto flow, which K9 does not reimplement. */
export type BrilliantPhotoSource = () => Promise<Uint8Array>;

export type BrilliantOptions = {
  /** Builds the BLE client; called on connect so the browser prompt is a user gesture. */
  createClient: () => BrilliantBleLike | Promise<BrilliantBleLike>;
  capturePhoto?: BrilliantPhotoSource;
  id?: string;
};

export class BrilliantGlasses implements KobeGlasses {
  readonly vendor = "brilliant";
  readonly id: string;
  model = "Brilliant Frame";
  state: GlassesConnectionState = "disconnected";

  private emitter = new GlassesEmitter();
  private client: BrilliantBleLike | null = null;
  private caps: GlassesCapabilities;
  private printLines: string[] = [];

  constructor(private options: BrilliantOptions) {
    this.id = options.id ?? "brilliant-frame";
    this.caps = capabilities({
      display: true,
      camera: !!options.capturePhoto,
      microphone: true,
      imu: true,
      touch: true,
      battery: true,
    });
  }

  private ble(): BrilliantBleLike {
    if (!this.client) throw new Error("Brilliant glasses are not connected");
    return this.client;
  }

  async connect(): Promise<void> {
    this.state = "connecting";
    try {
      const client = await this.options.createClient();
      const name = await client.connect();
      client.setPrintResponseHandler?.((line) => {
        this.printLines.push(line);
        if (this.printLines.length > 50) this.printLines.shift();
      });
      this.client = client;
      if (typeof client.type === "string" && client.type.toUpperCase() === "HALO") this.model = "Brilliant Halo";
      else if (name) this.model = name;
      this.state = "connected";
      this.emitter.emit("connected", { id: this.id, model: this.model });
    } catch (err) {
      this.state = "disconnected";
      throw err;
    }
  }

  async disconnect(): Promise<void> {
    await this.client?.disconnect().catch(() => undefined);
    this.client = null;
    this.state = "disconnected";
    this.emitter.emit("disconnected", { id: this.id, reason: null });
  }

  async getCapabilities(): Promise<GlassesCapabilities> {
    return this.caps;
  }

  display = {
    text: async (text: string): Promise<void> => {
      requireCapability(this.caps, "display", this.model);
      await this.ble().sendLua(displayText(text));
    },
    image: async (_data: Uint8Array): Promise<void> => {
      // Frame draws sprites through brilliant-msg's TxSprite, which the host app
      // owns; K9 never pushes raw bitmaps over Lua.
      throw new Error("Brilliant Frame draws images through brilliant-msg TxSprite, not this adapter");
    },
    clear: async (): Promise<void> => {
      requireCapability(this.caps, "display", this.model);
      await this.ble().sendLua(CLEAR_DISPLAY);
    },
  };

  camera = {
    capture: async (): Promise<Uint8Array> => {
      requireCapability(this.caps, "camera", this.model);
      await this.ble().sendLua(CAPTURE_PHOTO);
      const bytes = await this.options.capturePhoto!();
      this.emitter.emit("photo", { bytes, mimeType: "image/jpeg" });
      return bytes;
    },
  };

  microphone = {
    start: async (): Promise<void> => {
      requireCapability(this.caps, "microphone", this.model);
      await this.ble().sendLua(MICROPHONE_START);
    },
    stop: async (): Promise<void> => {
      await this.ble().sendLua(MICROPHONE_STOP);
    },
  };

  speaker = {
    play: async (_data: Uint8Array): Promise<void> => {
      // Frame has no speaker; Halo's audio goes through brilliant-ble sendAudio.
      throw new Error(`${this.model} has no speaker — K9 speaks through the teacher's phone or earbud`);
    },
    speak: async (_text: string): Promise<void> => {
      throw new Error(`${this.model} has no speaker — K9 speaks through the teacher's phone or earbud`);
    },
  };

  sensors = {
    imu: async (): Promise<IMUData> => {
      requireCapability(this.caps, "imu", this.model);
      const line = await this.ask(IMU_DIRECTION);
      const [pitch, roll, yaw] = line.split(",").map((value) => Number(value.trim()));
      return { pitch: pitch ?? 0, roll: roll ?? 0, yaw: yaw ?? 0, at: Date.now() };
    },
  };

  async battery(): Promise<number> {
    requireCapability(this.caps, "battery", this.model);
    return Number((await this.ask(BATTERY_LEVEL)).replace(/[^\d.]/g, "")) || 0;
  }

  on<E extends GlassesEvent>(event: E, handler: GlassesEventHandler<E>): () => void {
    return this.emitter.on(event, handler);
  }

  /** Runs Lua that prints one line and waits for that line. */
  private async ask(lua: string, timeoutMs = 3000): Promise<string> {
    const before = this.printLines.length;
    await this.ble().sendLua(lua);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const line = this.printLines[before];
      if (line !== undefined) return line;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`${this.model} did not answer within ${timeoutMs}ms`);
  }
}

export class BrilliantAdapter implements GlassesAdapter {
  readonly vendor = "brilliant";

  constructor(private options: BrilliantOptions) {}

  /** WebBluetooth only — `brilliant-ble` has no Node transport. */
  async isAvailable(): Promise<boolean> {
    return typeof navigator !== "undefined" && "bluetooth" in navigator;
  }

  async discover(): Promise<GlassesDescriptor[]> {
    if (!(await this.isAvailable())) {
      throw new AdapterUnavailableError(this.vendor, "this browser has no WebBluetooth");
    }
    // The browser's own chooser picks the device, so there is one logical entry.
    return [{ id: this.options.id ?? "brilliant-frame", model: "Brilliant Frame", vendor: this.vendor }];
  }

  async open(descriptor: GlassesDescriptor): Promise<KobeGlasses> {
    return new BrilliantGlasses({ ...this.options, id: descriptor.id });
  }
}
