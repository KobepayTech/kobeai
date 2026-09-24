import {
  AdapterUnavailableError,
  type GlassesAdapter,
  type GlassesDescriptor,
} from "../../core/GlassesAdapter";
import {
  capabilities,
  requireCapability,
  type GlassesCapabilities,
} from "../../core/GlassesCapabilities";
import {
  GlassesEmitter,
  type GlassesEvent,
  type GlassesEventHandler,
} from "../../core/GlassesEvents";
import type {
  KobeGlasses,
  GlassesConnectionState,
} from "../../core/KobeGlasses";

export type NativeProvider = "rokid" | "heycyan" | "rayneo";
export type NativeHost = { postMessage(message: string): void };
export type NativeReply = { id: string; result?: unknown; error?: string };

/** Origin-restricted WebMessage bridge supplied by the Android Lens app. No network listener. */
export class NativeTransport {
  private sequence = 0;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private host: NativeHost,
    private timeoutMs = 90_000,
  ) {}
  request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = String(++this.sequence);
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(`Glasses ${method} timed out. Reconnect and try again.`),
        );
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      try {
        this.host.postMessage(JSON.stringify({ id, method, params }));
      } catch (error) {
        this.receive({ id, error: String(error) });
      }
    });
  }
  receive(reply: NativeReply): void {
    const call = this.pending.get(reply.id);
    if (!call) return;
    this.pending.delete(reply.id);
    clearTimeout(call.timer);
    if (reply.error) call.reject(new Error(reply.error));
    else call.resolve(reply.result);
  }
  dispose(): void {
    for (const [id] of this.pending)
      this.receive({ id, error: "Glasses connection closed" });
  }
}

export class NativeAdapter implements GlassesAdapter {
  readonly vendor = "native";
  constructor(private transport: NativeTransport) {}
  async isAvailable(): Promise<boolean> {
    try {
      return (
        (await this.transport.request<{ version: number }>("info")).version ===
        1
      );
    } catch {
      return false;
    }
  }
  async discover(): Promise<GlassesDescriptor[]> {
    const info = await this.transport.request<{
      version: number;
      providers: NativeProvider[];
    }>("info");
    if (info.version !== 1)
      throw new AdapterUnavailableError(
        this.vendor,
        "Update the Android companion",
      );
    return info.providers.map((provider) => ({
      id: provider,
      vendor: this.vendor,
      model: {
        rokid: "Rokid Glasses",
        heycyan: "HeyCyan-compatible glasses",
        rayneo: "RayNeo on-glasses",
      }[provider],
    }));
  }
  async open(device: GlassesDescriptor): Promise<NativeGlasses> {
    if (!["rokid", "heycyan", "rayneo"].includes(device.id))
      throw new Error("Unknown native glasses provider");
    return new NativeGlasses(device, this.transport);
  }
}

export class NativeGlasses implements KobeGlasses {
  readonly id: string;
  readonly model: string;
  readonly vendor = "native";
  state: GlassesConnectionState = "disconnected";
  private caps = capabilities({});
  private emitter = new GlassesEmitter();
  constructor(
    device: GlassesDescriptor,
    private transport: NativeTransport,
  ) {
    this.id = device.id;
    this.model = device.model;
  }
  async connect(options: { automatic?: boolean } = {}): Promise<void> {
    this.state = "connecting";
    try {
      const result = await this.transport.request<{
        capabilities: Partial<GlassesCapabilities>;
      }>("connect", {
        provider: this.id,
        ...(options.automatic ? { automatic: true } : {}),
      });
      this.caps = capabilities({
        camera: result.capabilities.camera === true,
        display: result.capabilities.display === true,
        speaker: result.capabilities.speaker === true,
        speechSynthesis: result.capabilities.speechSynthesis === true,
      });
      this.state = "connected";
      this.emitter.emit("connected", { id: this.id, model: this.model });
    } catch (error) {
      this.state = "disconnected";
      throw error;
    }
  }
  async disconnect(): Promise<void> {
    try {
      await this.transport.request("disconnect");
    } finally {
      this.connectionLost(null);
    }
  }
  connectionLost(reason: string | null): void {
    this.state = "disconnected";
    this.emitter.emit("disconnected", { id: this.id, reason });
  }
  async getCapabilities(): Promise<GlassesCapabilities> {
    return { ...this.caps };
  }
  private require(feature: keyof GlassesCapabilities): void {
    if (this.state !== "connected")
      throw new Error("Glasses disconnected — reconnect before capturing");
    requireCapability(this.caps, feature, this.model);
  }
  display = {
    text: async (text: string): Promise<void> => {
      this.require("display");
      await this.transport.request("display", { text });
    },
    clear: async (): Promise<void> => {
      this.require("display");
      await this.transport.request("display", { text: "" });
    },
    image: async (_data: Uint8Array): Promise<void> => {
      this.require("displayImage");
    },
  };
  camera = {
    capture: async (): Promise<Uint8Array> => {
      this.require("camera");
      const result = await this.transport.request<{ jpeg: string }>("capture");
      if (typeof result.jpeg !== "string" || result.jpeg.length > 12_000_000)
        throw new Error("Invalid glasses image");
      const bytes = Uint8Array.from(atob(result.jpeg), (c) => c.charCodeAt(0));
      if (
        bytes.length < 3 ||
        bytes[0] !== 255 ||
        bytes[1] !== 216 ||
        bytes[2] !== 255
      )
        throw new Error("Glasses did not return a JPEG");
      return bytes;
    },
  };
  // These capabilities stay false until streaming is implemented end to end.
  microphone = {
    start: async (): Promise<void> => {
      this.require("microphone");
    },
    stop: async (): Promise<void> => {
      this.require("microphone");
    },
  };
  speaker = {
    speak: async (text: string): Promise<void> => {
      this.require("speechSynthesis");
      await this.transport.request("speak", { text });
    },
    play: async (_data: Uint8Array): Promise<void> => {
      throw new Error("Audio byte playback is not exposed by the Lens bridge");
    },
  };
  sensors = {};
  async battery(): Promise<number> {
    this.require("battery");
    return this.transport.request<number>("battery");
  }
  on<E extends GlassesEvent>(
    event: E,
    handler: GlassesEventHandler<E>,
  ): () => void {
    return this.emitter.on(event, handler);
  }
}
