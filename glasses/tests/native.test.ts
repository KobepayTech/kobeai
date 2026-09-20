import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NativeAdapter,
  NativeTransport,
} from "../src/adapters/native/NativeAdapter";
import { K9Api } from "../src/k9/K9Api";
import { CapabilityMissingError } from "../src/core/GlassesCapabilities";

function fixture(
  handler: (method: string, params: Record<string, unknown>) => unknown,
) {
  let transport: NativeTransport;
  transport = new NativeTransport(
    {
      postMessage(raw) {
        const request = JSON.parse(raw);
        queueMicrotask(() => {
          try {
            transport.receive({
              id: request.id,
              result: handler(request.method, request.params),
            });
          } catch (e) {
            transport.receive({ id: request.id, error: String(e) });
          }
        });
      },
    },
    100,
  );
  return transport;
}
const jpeg = Uint8Array.from([255, 216, 255, 224, 1, 2, 255, 217]);

test("native photo follows the authenticated K9 frame contract without a vendor cloud", async () => {
  const transport = fixture((method, params) => {
    if (method === "info") return { version: 1, providers: ["rokid"] };
    if (method === "connect") {
      assert.equal(params.provider, "rokid");
      return { capabilities: { camera: true } };
    }
    if (method === "capture")
      return { jpeg: Buffer.from(jpeg).toString("base64") };
    return null;
  });
  const adapter = new NativeAdapter(transport);
  const device = await adapter.open((await adapter.discover())[0]!);
  await device.connect();
  assert.equal(device.state, "connected");
  await assert.rejects(device.display.text("test"), CapabilityMissingError);
  await assert.rejects(device.microphone.start(), CapabilityMissingError);
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const api = new K9Api({
    baseUrl: "https://school.local",
    token: "teacher-token",
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ request: { id: 12 }, image_key: "lens/12.jpg" });
    },
  });
  const queued = await api.sendFrame(await device.camera.capture(), {
    sessionId: 7,
    mode: "mark",
    examId: 9,
  });
  assert.equal(queued.requestId, 12);
  assert.equal(calls[0]!.url, "https://school.local/api/v1/teacher-lens/frame");
  const headers = new Headers(calls[0]!.init!.headers);
  assert.equal(headers.get("authorization"), "Bearer teacher-token");
  assert.equal(headers.get("x-lens-session-id"), "7");
  assert.equal(headers.get("x-lens-exam-id"), "9");
  assert.deepEqual(calls[0]!.init!.body, jpeg);
  device.connectionLost("Bluetooth lost");
  await assert.rejects(device.camera.capture(), /disconnected/);
  transport.dispose();
});

test("capture rejects invalid media and vendor errors; failed pairing stays disconnected", async () => {
  for (const value of ["invalid", Buffer.from("not jpeg").toString("base64")]) {
    const transport = fixture((method) =>
      method === "connect"
        ? { capabilities: { camera: true } }
        : { jpeg: value },
    );
    const device = await new NativeAdapter(transport).open({
      id: "rokid",
      vendor: "native",
      model: "Rokid",
    });
    await device.connect();
    await assert.rejects(device.camera.capture());
    transport.dispose();
  }
  const transport = fixture(() => {
    throw new Error("Pairing denied");
  });
  const device = await new NativeAdapter(transport).open({
    id: "rokid",
    vendor: "native",
    model: "Rokid",
  });
  await assert.rejects(device.connect(), /Pairing denied/);
  assert.equal(device.state, "disconnected");
  transport.dispose();
});

test("bridge correlates out-of-order responses, ignores stale replies, and rejects on shutdown", async () => {
  const sent: Array<{ id: string }> = [];
  const transport = new NativeTransport({
    postMessage: (raw) => sent.push(JSON.parse(raw)),
  });
  const one = transport.request("one");
  const two = transport.request("two");
  transport.receive({ id: sent[1]!.id, result: 2 });
  transport.receive({ id: sent[0]!.id, result: 1 });
  transport.receive({ id: "999", result: 99 });
  assert.deepEqual(await Promise.all([one, two]), [1, 2]);
  const pending = transport.request("capture");
  transport.dispose();
  await assert.rejects(pending, /closed/);
});

test("bridge times out when native host does not reply", async () => {
  const transport = new NativeTransport({ postMessage() {} }, 5);
  await assert.rejects(transport.request("capture"), /timed out/);
});

test("an interactive pairing outlasts the default budget, an automatic reconnect does not", async () => {
  // The Android host puts a password dialog and Android's document picker in
  // front of the teacher during a first Rokid pairing, so a budget sized for a
  // machine-to-machine call expires while they are still reading. An automatic
  // reconnect has nobody in front of it and must still fail fast.
  const silent = new NativeTransport({ postMessage() {} }, 30);
  const adapter = new NativeAdapter(silent);
  const device = await adapter.open({
    id: "rokid",
    vendor: "native",
    model: "Rokid Glasses",
  });

  await assert.rejects(
    device.connect({ automatic: true }),
    /timed out/,
    "an unattended reconnect should give up on the default budget",
  );

  const interactive = device.connect().then(
    () => "settled",
    () => "settled",
  );
  const outcome = await Promise.race([
    interactive,
    new Promise((resolve) => setTimeout(() => resolve("still waiting"), 200)),
  ]);
  assert.equal(
    outcome,
    "still waiting",
    "an interactive pairing must not be cut short while the teacher is mid-dialog",
  );
  // Release the long timer, or the test run holds the event loop open for it.
  silent.dispose();
  await interactive;
});
