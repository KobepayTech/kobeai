import { test } from "node:test";
import { strict as assert } from "node:assert";

import { BrilliantAdapter, BrilliantGlasses, type BrilliantBleLike } from "../src/adapters/brilliant/BrilliantAdapter";
import { MentraAdapter, type MentraClient } from "../src/adapters/mentra/MentraAdapter";
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
  await assert.rejects(() => withoutClient.discover(), /React Native app only/);

  const client: MentraClient = {
    scan: async () => [{ id: "g1", model: "Even Realities G1" }],
    connect: async () => undefined,
    disconnect: async () => undefined,
    features: async () => ({ display: true, microphone: true }),
    displayText: async () => undefined,
    clearDisplay: async () => undefined,
    batteryPercent: async () => 64,
  };
  const adapter = new MentraAdapter({ client });
  assert.equal(await adapter.isAvailable(), true);
  const [device] = await adapter.discover();
  const glasses = await adapter.open(device!);
  await glasses.connect();
  const caps = await glasses.getCapabilities();
  assert.equal(caps.display, true);
  assert.equal(caps.camera, false, "no takePhoto means no camera capability");
  assert.equal(await glasses.battery(), 64);
  await assert.rejects(() => glasses.camera.capture(), /no camera/);
});
