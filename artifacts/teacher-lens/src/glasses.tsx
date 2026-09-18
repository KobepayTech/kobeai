import { useEffect, useRef, useState } from "react";
import {
  NativeAdapter,
  NativeTransport,
  type NativeGlasses,
  type NativeHost,
  type NativeReply,
} from "../../../glasses/src/adapters/native/NativeAdapter";

declare global {
  interface Window {
    KobeNative?: NativeHost & {
      onmessage?: (event: MessageEvent<string>) => void;
    };
  }
}
let transport: NativeTransport | null = null;
let active: NativeGlasses | null = null;
function native(): NativeTransport | null {
  if (!window.KobeNative) return null;
  if (!transport) {
    transport = new NativeTransport(window.KobeNative);
    window.KobeNative.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data) as NativeReply & {
          event?: string;
          reason?: string;
        };
        if (message.event === "disconnected")
          active?.connectionLost(message.reason ?? "Connection lost");
        else transport?.receive(message);
      } catch {
        /* malformed native message is ignored */
      }
    };
  }
  return transport;
}

/** Returns null only when the wearer explicitly chose the phone camera. */
export async function captureGlasses(): Promise<Blob | null> {
  if (!active) return null;
  const bytes = await active.camera.capture();
  return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
}
export function speakThroughGlasses(text: string): boolean {
  const bridge = native();
  if (!bridge) return false;
  // Native TTS follows the phone's selected Bluetooth audio output for HeyCyan;
  // Rokid uses its SDK TTS. Errors are visible rather than silently discarded.
  const speech =
    active?.state === "connected"
      ? active.speaker.speak(text)
      : bridge.request("phone.speak", { text });
  void speech
    .catch(() => bridge.request("phone.speak", { text }))
    .catch((error) => {
      window.dispatchEvent(
        new CustomEvent("kobe-glasses-error", { detail: String(error) }),
      );
    });
  if (active?.state === "connected")
    void active
      .getCapabilities()
      .then((caps) => {
        if (caps.display) return active?.display.text(text.slice(0, 250));
        return undefined;
      })
      .catch(() => undefined);
  return true;
}

export function GlassesControl({
  onSource,
}: {
  onSource: (source: string | null, connected?: boolean) => void;
}) {
  const mounted = useRef(true);
  const [devices, setDevices] = useState<
    Array<{ id: string; model: string; vendor: string }>
  >([]);
  const [selected, setSelected] = useState("");
  const [status, setStatus] = useState("Phone camera");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    mounted.current = true;
    const bridge = native();
    if (bridge)
      void new NativeAdapter(bridge)
        .discover()
        .then(setDevices)
        .catch((e) => setError(String(e)));
    return () => {
      mounted.current = false;
      active = null;
      // Queue cleanup even when the native pairing dialog has not completed.
      // The host serializes this before a newly mounted session can connect.
      void bridge?.request("disconnect").catch(() => undefined);
    };
  }, []);
  if (!window.KobeNative)
    return (
      <div style={{ padding: "6px 16px", fontSize: 12 }}>
        For Rokid, HeyCyan or RayNeo, use the KobeAI Lens Android app.
      </div>
    );
  const connect = async () => {
    const bridge = native();
    if (!bridge) return;
    setBusy(true);
    setError("");
    try {
      await active?.disconnect();
      active = null;
      onSource(null);
      if (!selected) {
        setStatus("Phone camera");
        return;
      }
      const device = devices.find((d) => d.id === selected);
      if (!device) throw new Error("Choose a glasses model");
      const glasses = await new NativeAdapter(bridge).open(device);
      await glasses.connect();
      if (!mounted.current) return;
      active = glasses;
      glasses.on("disconnected", () => {
        setStatus(`${device.model}: disconnected — reconnect or choose phone`);
        onSource(device.model, false);
      });
      onSource(device.model, true);
      setStatus(
        `${device.model} connected${selected === "heycyan" ? " · preview photos; check paper text is legible" : ""}`,
      );
    } catch (e) {
      setError(String(e));
      setStatus("Phone camera");
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label="Glasses connection" style={{ padding: "8px 16px" }}>
      <div style={{ display: "flex", gap: 8 }}>
        <select
          aria-label="Camera source"
          className="mark-input"
          value={selected}
          disabled={busy}
          onChange={(e) => setSelected(e.target.value)}
        >
          <option value="">Phone camera</option>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.model}
            </option>
          ))}
        </select>
        <button
          className="lens-secondary"
          onClick={() => void connect()}
          disabled={busy}
        >
          {busy ? "Connecting…" : "Connect"}
        </button>
      </div>
      <div role="status" style={{ fontSize: 12, paddingTop: 6 }}>
        {status}
      </div>
      {error && (
        <div role="alert" className="mark-error">
          {error}
        </div>
      )}
    </section>
  );
}
