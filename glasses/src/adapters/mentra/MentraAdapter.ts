import { capabilities, requireCapability, type GlassesCapabilities } from "../../core/GlassesCapabilities";
import { GlassesEmitter, type GlassesEvent, type GlassesEventHandler } from "../../core/GlassesEvents";
import { AdapterUnavailableError, type GlassesAdapter, type GlassesDescriptor } from "../../core/GlassesAdapter";
import type { GlassesConnectionState, KobeGlasses } from "../../core/KobeGlasses";

// ===========================================================================
// MentraOS glasses through the Mentra Bluetooth SDK.
//
// Written against the published API reference, not against guesses:
// https://docs.mentraglass.com/bluetooth-sdk/api-reference
//
// Three facts from those docs shape this file, and two of them contradict what
// a reasonable person would assume:
//
//  1. **The Bluetooth SDK has no display.** It covers scanning, pairing,
//     device status, microphone audio, camera capture, speaker playback,
//     streaming, Wi-Fi and hardware events — for Mentra Live. Screen output
//     belongs to the *Miniapp* SDK, which is a different product with a
//     different distribution story (see the README). So `display` is false
//     here unless a caller proves otherwise, and `display.text()` throws
//     rather than silently doing nothing.
//
//  2. **`requestPhoto()` does not return bytes.** It takes a `webhookUrl` and
//     an optional bearer `authToken`, and the JPEG is POSTed there as
//     multipart form-data (`photo` file + `requestId`). The promise resolves
//     only once that upload has succeeded.
//
//     That suits K9 exactly: point the webhook at the school's own server
//     (`POST /v1/teacher-lens/mentra/photo`) and the picture travels
//     glasses → teacher's phone → school LAN, never touching a vendor cloud.
//     Same promise as the rest of K9. It also means `camera.capture()` cannot
//     honour the `Uint8Array` contract, so it throws and directs the caller to
//     `requestPhotoToK9()` below.
//
//  3. **The capture light is automatic.** Mentra turns the privacy indicator
//     on for photo, video and stream operations. For a school that matters:
//     a teacher wearing camera glasses around children is visibly recording,
//     and K9 does not get to switch that off.
//
// The SDK itself runs in React Native / Expo (`@mentra/bluetooth-sdk`,
// `useMentraBluetooth()`), Android (`com.mentraglass:bluetooth-sdk`) or iOS
// (`MentraBluetoothSDK`) — never in the Node server and never in a browser. So
// this adapter still takes an injected client: the mobile shell owns the
// binding, and everything above the adapter stays on one interface.
// ===========================================================================

/** A device as `scan()` reports it. */
export type MentraDevice = { id: string; name?: string; model?: string };

/** MentraOS's own lifecycle, which has one more state than K9's. */
export type MentraConnectionState = "disconnected" | "scanning" | "connecting" | "bonding" | "connected";

export type MentraPhotoResult = {
  /** Where the SDK uploaded the JPEG. */
  uploadUrl?: string;
  /** Whatever the webhook returned — K9's own endpoint echoes its queue ids. */
  photoUrl?: string;
  statusUrl?: string;
  contentType?: string;
  fileSizeBytes?: number;
  [key: string]: unknown;
};

export type MentraPhotoRequest = {
  /** JPEG tier. */
  size?: "low" | "medium" | "high" | "max";
  /** Where the glasses POST the photo. For K9 this is the school server. */
  webhookUrl: string;
  /** Bearer token the upload carries — the teacher's own K9 JWT. */
  authToken?: string;
  compress?: "none" | "medium" | "heavy";
  sound?: boolean;
};

/**
 * The slice of the Mentra SDK K9 uses, named exactly as the SDK names it so a
 * shell can pass `useMentraBluetooth()` through with a thin wrapper and no
 * renaming. Everything optional is genuinely optional: an OEM model may not
 * carry the hardware.
 */
export type MentraClient = {
  scan(model?: string, options?: Record<string, unknown>): Promise<MentraDevice[]>;
  connect(device: MentraDevice, options?: Record<string, unknown>): Promise<void>;
  /** Reconnect to the saved device — the normal path after the first pairing. */
  connectDefault?(): Promise<void>;
  disconnect(): Promise<void>;
  /** Unpair. K9 calls this only when a teacher hands the glasses back. */
  forget?(): Promise<void>;
  cancelConnectionAttempt?(): Promise<void>;

  /** Current lifecycle, and whether the glasses have finished booting. */
  getState?(): { state: MentraConnectionState; fullyBooted?: boolean };

  requestPhoto?(options: MentraPhotoRequest): Promise<MentraPhotoResult>;
  warmUpCamera?(options?: Record<string, unknown>): Promise<unknown>;
  startVideoRecording?(options: Record<string, unknown>): Promise<unknown>;
  stopVideoRecording?(options?: Record<string, unknown>): Promise<unknown>;

  setMicState?(enabled: boolean): Promise<void>;
  setVoiceActivityDetectionEnabled?(enabled: boolean): Promise<void>;
  setPreferredMic?(micId: string): Promise<void>;

  /** RTMP/SRT/WHIP out. K9 points it at the school's own ingest, or not at all. */
  startStream?(config: { streamUrl: string; streamId?: string; video?: { fps?: number } }): Promise<unknown>;
  stopStream?(): Promise<unknown>;

  requestWifiScan?(): Promise<Array<{ ssid: string; [key: string]: unknown }>>;
  sendWifiCredentials?(ssid: string, password: string): Promise<void>;
  setHotspotState?(enabled: boolean): Promise<void>;

  /** The privacy/recording indicator. Read the note in `led` before using it. */
  rgbLedControl?(options: Record<string, unknown>): Promise<unknown>;
  requestVersionInfo?(): Promise<Record<string, unknown>>;
  batteryPercent?(): Promise<number>;

  /** Bridges the SDK's typed events onto K9's. Returns an unsubscribe. */
  subscribe?(handler: (event: { type: string; payload?: Record<string, unknown> }) => void): () => void;
};

/** How K9 reaches its own server, so photos can be uploaded straight to it. */
export type K9PhotoTarget = {
  /** e.g. "http://192.168.1.10:8088" — the school server on the LAN. */
  baseUrl: string;
  /** The teacher's JWT. Mentra sends it as the upload's bearer token. */
  token: string;
};

/**
 * Map MentraOS's lifecycle onto K9's. `bonding` is the OS pairing dialog; from
 * K9's point of view that is still "connecting", and a session that is
 * connected but not `fullyBooted` is not ready to be handed a shutter press.
 */
export function toK9State(state: MentraConnectionState, fullyBooted = true): GlassesConnectionState {
  if (state === "connected") return fullyBooted ? "connected" : "connecting";
  if (state === "connecting" || state === "bonding" || state === "scanning") return "connecting";
  return "disconnected";
}

export class MentraGlasses implements KobeGlasses {
  readonly vendor = "mentra";
  state: GlassesConnectionState = "disconnected";

  private emitter = new GlassesEmitter();
  // Deliberately conservative: the Bluetooth SDK's documented feature set for
  // Mentra Live has no display, so nothing here claims one until the SDK says
  // so. Over-claiming turns a missing feature into a silent no-op.
  private caps: GlassesCapabilities = capabilities({ battery: true });
  private unsubscribe: (() => void) | null = null;

  constructor(
    readonly id: string,
    readonly model: string,
    private client: MentraClient,
    private photoTarget: K9PhotoTarget | null = null,
  ) {}

  async connect(): Promise<void> {
    this.state = "connecting";
    try {
      await this.client.connect({ id: this.id, model: this.model });
      this.caps = capabilities({
        battery: true,
        camera: !!this.client.requestPhoto,
        microphone: !!this.client.setMicState,
        // The SDK documents speaker playback for Mentra Live, but exposes it
        // through audio APIs the shell owns rather than a play(bytes) call —
        // so K9 does not claim it here. `controller.say()` already falls back
        // to the teacher's phone or earbud, which is how Lens whispers work.
        speaker: false,
        display: false,
      });
      this.unsubscribe = this.client.subscribe?.((event) => this.onSdkEvent(event)) ?? null;

      const reported = this.client.getState?.();
      this.state = reported ? toK9State(reported.state, reported.fullyBooted ?? true) : "connected";
      if (this.state === "connected") this.emitter.emit("connected", { id: this.id, model: this.model });
    } catch (err) {
      this.state = "disconnected";
      throw err;
    }
  }

  /** Translate the SDK's documented event names onto K9's. */
  private onSdkEvent(event: { type: string; payload?: Record<string, unknown> }): void {
    switch (event.type) {
      case "button_press":
      case "touch_event":
        this.emitter.emit("shutter", { source: event.type === "button_press" ? "button" : "touch" });
        break;
      case "battery_status":
        this.emitter.emit("battery", { percent: Number(event.payload?.["percent"] ?? event.payload?.["level"] ?? 0) });
        break;
      case "photo_response": {
        // The bytes went to the webhook, not to us — but a shell that fetched
        // them back can still hand them over, so honour that when it does.
        const bytes = event.payload?.["bytes"];
        if (bytes instanceof Uint8Array) this.emitter.emit("photo", { bytes, mimeType: "image/jpeg" });
        break;
      }
      default:
        // mic_pcm, stream_status, wifi_status_change, ota_status and the rest
        // belong to the shell, not to K9's feature layer. Ignored on purpose
        // rather than mapped onto something that does not mean the same thing.
        break;
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
    text: async (_text: string): Promise<void> => {
      requireCapability(this.caps, "display", this.model);
    },
    image: async (_data: Uint8Array): Promise<void> => {
      requireCapability(this.caps, "display", this.model);
    },
    clear: async (): Promise<void> => {
      requireCapability(this.caps, "display", this.model);
    },
  };

  camera = {
    capture: async (): Promise<Uint8Array> => {
      requireCapability(this.caps, "camera", this.model);
      // Honest failure. The SDK uploads to a webhook and never hands the app
      // the bytes, so there is no way to satisfy this signature — and
      // returning an empty buffer to keep the types happy would be worse.
      throw new Error(
        `${this.model}: Mentra uploads photos to a webhook instead of returning bytes — ` +
          `use requestPhotoToK9() so the JPEG goes straight to the school server`,
      );
    },
  };

  /**
   * Take a photo and have the glasses upload it to the school's own server.
   *
   * This is the Mentra path K9 actually uses: the teacher looks at a student,
   * presses the shutter, and the JPEG lands on
   * `POST /v1/teacher-lens/mentra/photo` — the same ingest the Teacher Lens
   * PWA uses, so the frame is face-matched or marked by exactly the same
   * pipeline. Nothing leaves the school LAN.
   */
  async requestPhotoToK9(opts: {
    mode?: "lookup" | "mark";
    sessionId?: number | null;
    examId?: number | null;
    size?: MentraPhotoRequest["size"];
  } = {}): Promise<MentraPhotoResult> {
    requireCapability(this.caps, "camera", this.model);
    if (!this.photoTarget) {
      throw new Error(
        `${this.model}: no K9 photo target configured — pass { baseUrl, token } to the adapter ` +
          `so the glasses know which school server to upload to`,
      );
    }
    const query = new URLSearchParams({
      mode: opts.mode ?? "lookup",
      ...(opts.sessionId != null ? { sessionId: String(opts.sessionId) } : {}),
      ...(opts.examId != null ? { examId: String(opts.examId) } : {}),
    });
    return this.client.requestPhoto!({
      size: opts.size ?? "medium",
      webhookUrl: `${this.photoTarget.baseUrl.replace(/\/$/, "")}/api/v1/teacher-lens/mentra/photo?${query}`,
      authToken: this.photoTarget.token,
      // The shutter sound is the other half of the consent story the capture
      // light starts. In a classroom, audible beats silent.
      sound: true,
    });
  }

  microphone = {
    start: async (): Promise<void> => {
      requireCapability(this.caps, "microphone", this.model);
      await this.client.setMicState!(true);
    },
    stop: async (): Promise<void> => {
      await this.client.setMicState?.(false);
    },
  };

  speaker = {
    play: async (_data: Uint8Array): Promise<void> => {
      requireCapability(this.caps, "speaker", this.model);
    },
    speak: async (_text: string): Promise<void> => {
      // No MentraOS model exposes text-to-speech on the glasses over the
      // Bluetooth SDK. K9 speaks through the teacher's phone or earbud, which
      // is how Teacher Lens whispers already work.
      throw new Error(`${this.model} cannot speak text — K9 speaks through the teacher's phone or earbud`);
    },
  };

  sensors = {};

  async battery(): Promise<number> {
    return (await this.client.batteryPercent?.()) ?? 0;
  }

  /**
   * Put the glasses on the school's Wi-Fi. Mentra Live uploads photos and
   * streams over Wi-Fi rather than Bluetooth, so without this the webhook
   * above has no route to the school server.
   */
  async joinSchoolWifi(ssid: string, password: string): Promise<void> {
    if (!this.client.sendWifiCredentials) {
      throw new Error(`${this.model} cannot be given Wi-Fi credentials over this SDK`);
    }
    await this.client.sendWifiCredentials(ssid, password);
  }

  on<E extends GlassesEvent>(event: E, handler: GlassesEventHandler<E>): () => void {
    return this.emitter.on(event, handler);
  }
}

export type MentraAdapterOptions = {
  /** Supplied by the React Native shell that owns @mentra/bluetooth-sdk. */
  client: MentraClient | null;
  /** Where photos should be uploaded — the school server, not a vendor cloud. */
  photoTarget?: K9PhotoTarget | null;
  /** Narrows `scan()` to one model, as the SDK's first argument allows. */
  model?: string;
};

export class MentraAdapter implements GlassesAdapter {
  readonly vendor = "mentra";

  constructor(private options: MentraAdapterOptions) {}

  async isAvailable(): Promise<boolean> {
    return this.options.client !== null;
  }

  async discover(): Promise<GlassesDescriptor[]> {
    if (!this.options.client) {
      throw new AdapterUnavailableError(this.vendor, "@mentra/bluetooth-sdk runs in the React Native or native app only");
    }
    const devices = await this.options.client.scan(this.options.model);
    return devices.map((device) => ({
      id: device.id,
      model: device.model ?? device.name ?? "Mentra Live",
      vendor: this.vendor,
    }));
  }

  async open(descriptor: GlassesDescriptor): Promise<KobeGlasses> {
    if (!this.options.client) throw new AdapterUnavailableError(this.vendor, "no Mentra client was provided");
    return new MentraGlasses(
      descriptor.id,
      descriptor.model,
      this.options.client,
      this.options.photoTarget ?? null,
    );
  }
}
