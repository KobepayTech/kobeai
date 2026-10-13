import { test } from "node:test";
import { strict as assert } from "node:assert";

import { BrilliantAdapter, BrilliantGlasses, type BrilliantBleLike } from "../src/adapters/brilliant/BrilliantAdapter";
import { MentraAdapter, MentraGlasses, toK9State, type MentraClient } from "../src/adapters/mentra/MentraAdapter";
import { CLEAR_DISPLAY, displayText } from "../src/adapters/brilliant/frameLua";

/** Stands in for brilliant-ble's BrilliantBle, which needs a browser. */
class FakeBle implements BrilliantBleLike {
  lua: string[] = [];
  type = "FRAME";
  private print: ((line: string) => void) | null = null;
  connected = false;

  async connect(): Promise<string> {
    this.connected = true;
    return "Frame 4B";
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async sendLua(lua: string): Promise<void> {
    this.lua.push(lua);
    if (lua.includes("battery_level")) this.print?.("82");
    if (lua.includes("imu.direction")) this.print?.("1.5,-2,180");
  }
  setPrintResponseHandler(handler: (line: string) => void): void {
    this.print = handler;
  }
}

test("Frame display text becomes wrapped Lua, and clearing is one call", () => {
  const lua = displayText("Physics starts in Room 4 right after the break");
  assert.match(lua, /^frame\.display\.clear\(\);/);
  assert.match(lua, /frame\.display\.text\('Physics starts in Room 4 right after'/);
  assert.match(lua, /frame\.display\.show\(\)$/);
  assert.equal(CLEAR_DISPLAY, "frame.display.clear(); frame.display.show()");
});

test("a quote in the text can't break out of the Lua string", () => {
  assert.match(displayText("Asha's paper"), /'Asha\\'s paper'/);
});

test("the Brilliant adapter talks Lua and reads printed answers", async () => {
  const ble = new FakeBle();
  const glasses = new BrilliantGlasses({ createClient: () => ble, capturePhoto: async () => new Uint8Array([1, 2, 3]) });
  await glasses.connect();
  assert.equal(glasses.model, "Frame 4B");
  await glasses.display.text("Hello");
  assert.equal(await glasses.battery(), 82);
  const imu = await glasses.sensors.imu!();
  assert.deepEqual([imu.pitch, imu.roll, imu.yaw], [1.5, -2, 180]);
  const photo = await glasses.camera.capture();
  assert.deepEqual([...photo], [1, 2, 3]);
  assert.ok(ble.lua.some((lua) => lua.includes("frame.camera.capture()")));
  await glasses.disconnect();
  assert.equal(ble.connected, false);
});

test("Frame has no speaker, so K9 is told to speak elsewhere", async () => {
  const glasses = new BrilliantGlasses({ createClient: () => new FakeBle() });
  await glasses.connect();
  await assert.rejects(() => glasses.speaker.speak("hello"), /no speaker/);
});

test("the Brilliant adapter is unavailable without WebBluetooth", async () => {
  const adapter = new BrilliantAdapter({ createClient: () => new FakeBle() });
  assert.equal(await adapter.isAvailable(), typeof navigator !== "undefined" && "bluetooth" in navigator);
  await assert.rejects(() => adapter.discover(), /WebBluetooth/);
});

test("the Mentra adapter stays unavailable until the mobile app injects its client", async () => {
  const withoutClient = new MentraAdapter({ client: null });
  assert.equal(await withoutClient.isAvailable(), false);
  await assert.rejects(() => withoutClient.discover(), /React Native or native app only/);
});

/** The documented Mentra Live surface: camera by webhook, mic, battery, no display. */
function fakeMentra(overrides: Partial<MentraClient> = {}): MentraClient {
  return {
    scan: async () => [{ id: "g1", name: "Mentra Live", model: "Mentra Live" }],
    connect: async () => undefined,
    disconnect: async () => undefined,
    requestPhoto: async (options) => ({ uploadUrl: options.webhookUrl, contentType: "image/jpeg" }),
    setMicState: async () => undefined,
    batteryPercent: async () => 64,
    ...overrides,
  };
}

test("Mentra Live reports camera and microphone but never a display", async () => {
  // The Bluetooth SDK's documented feature set has no screen — display output
  // belongs to the Miniapp SDK. Claiming one here would turn a missing feature
  // into a silent no-op.
  const adapter = new MentraAdapter({ client: fakeMentra() });
  assert.equal(await adapter.isAvailable(), true);
  const [device] = await adapter.discover();
  assert.equal(device!.model, "Mentra Live");

  const glasses = await adapter.open(device!);
  await glasses.connect();
  const caps = await glasses.getCapabilities();
  assert.equal(caps.display, false);
  assert.equal(caps.camera, true);
  assert.equal(caps.microphone, true);
  assert.equal(await glasses.battery(), 64);
  await assert.rejects(() => glasses.display.text("hello"), /no display|display/i);
});

test("capture() refuses rather than pretending it can return bytes", async () => {
  // requestPhoto() uploads to a webhook and never hands the app the JPEG, so
  // the Uint8Array contract cannot be honoured. Failing loudly beats returning
  // an empty buffer to keep the types quiet.
  const adapter = new MentraAdapter({ client: fakeMentra() });
  const glasses = await adapter.open((await adapter.discover())[0]!);
  await glasses.connect();
  await assert.rejects(() => glasses.camera.capture(), /webhook/);
});

test("a photo is uploaded to the school server, not a vendor cloud", async () => {
  let asked: { webhookUrl: string; authToken?: string } | null = null;
  const adapter = new MentraAdapter({
    client: fakeMentra({
      requestPhoto: async (options) => {
        asked = options;
        return { uploadUrl: options.webhookUrl };
      },
    }),
    photoTarget: { baseUrl: "http://192.168.1.10:8088/", token: "teacher-jwt" },
  });
  const glasses = (await adapter.open((await adapter.discover())[0]!)) as MentraGlasses;
  await glasses.connect();
  await glasses.requestPhotoToK9({ mode: "mark", sessionId: 7, examId: 3 });

  const sent = asked as unknown as { webhookUrl: string; authToken?: string };
  assert.ok(sent, "requestPhoto was never called");
  assert.match(sent.webhookUrl, /^http:\/\/192\.168\.1\.10:8088\/api\/v1\/teacher-lens\/mentra\/photo\?/);
  assert.match(sent.webhookUrl, /mode=mark/);
  assert.match(sent.webhookUrl, /sessionId=7/);
  assert.match(sent.webhookUrl, /examId=3/);
  assert.equal(sent.authToken, "teacher-jwt", "the teacher's own JWT authenticates the upload");
});

test("without a school server to upload to, the photo request is refused", async () => {
  const adapter = new MentraAdapter({ client: fakeMentra() });
  const glasses = (await adapter.open((await adapter.discover())[0]!)) as MentraGlasses;
  await glasses.connect();
  await assert.rejects(() => glasses.requestPhotoToK9(), /no K9 photo target/);
});

test("the SDK's own event names reach K9's", async () => {
  let emit: ((event: { type: string; payload?: Record<string, unknown> }) => void) | null = null;
  const adapter = new MentraAdapter({
    client: fakeMentra({
      subscribe: (handler) => {
        emit = handler;
        return () => undefined;
      },
    }),
  });
  const glasses = await adapter.open((await adapter.discover())[0]!);
  await glasses.connect();

  const shutters: string[] = [];
  let battery = 0;
  glasses.on("shutter", (e) => shutters.push(e.source));
  glasses.on("battery", (e) => (battery = e.percent));

  const fire = emit as unknown as (event: { type: string; payload?: Record<string, unknown> }) => void;
  fire({ type: "button_press" });
  fire({ type: "touch_event" });
  fire({ type: "battery_status", payload: { percent: 41 } });
  // Not K9's business — belongs to the shell, and must not be mapped onto
  // something that means something else.
  fire({ type: "mic_pcm", payload: {} });

  assert.deepEqual(shutters, ["button", "touch"]);
  assert.equal(battery, 41);
});

test("bonding and a half-booted connection are not 'connected'", async () => {
  // A session that is connected but not fullyBooted cannot be handed a
  // shutter press yet, so K9 must not report it as ready.
  assert.equal(toK9State("bonding"), "connecting");
  assert.equal(toK9State("scanning"), "connecting");
  assert.equal(toK9State("connected", false), "connecting");
  assert.equal(toK9State("connected", true), "connected");
  assert.equal(toK9State("disconnected"), "disconnected");
});
