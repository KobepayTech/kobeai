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
        else if (message.event === "reconnected")
          window.dispatchEvent(new Event("kobe-native-reconnected"));
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
  // Rokid speaks through its own SDK TTS; the phone's engine is the fallback
  // when no glasses are connected. Errors are visible rather than discarded.
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
  const connecting = useRef(false);
  const nextAttempt = useRef(0);
  const backoff = useRef(3000);
  const knownDevices = useRef(devices);
  async function runConnect(provider: string, automatic = false) {
    const bridge = native();
    if (!bridge || connecting.current) return;
    connecting.current = true;
    setBusy(true);
    setError("");
    try {
      if (!provider) {
        await bridge.request("pause");
        active = null;
        onSource(null);
        setStatus("Phone camera · automatic glasses connection paused");
        return;
      }
      const device = knownDevices.current.find((d) => d.id === provider);
      if (!device) throw new Error("Choose a glasses model");
      if (!automatic) await bridge.request("disconnect");
      const glasses = await new NativeAdapter(bridge).open(device);
      active = glasses;
      onSource(device.model, false);
      setStatus("Connecting in the background…");
      await glasses.connect({ automatic });
      if (!mounted.current) return;
      active = glasses;
      glasses.on("disconnected", () => {
        if (!mounted.current || active !== glasses) return;
        setStatus(
          provider === "rokid"
            ? "Rokid reconnecting automatically…"
            : "Glasses disconnected",
        );
        onSource(device.model, false);
      });
      setSelected(provider);
      onSource(device.model, true);
      setStatus(
        `${device.model} connected${provider === "rokid" ? " · reconnects automatically" : ""}`,
      );
      backoff.current = 3000;
      nextAttempt.current = 0;
    } catch (e) {
      if (!mounted.current) return;
      setStatus(
        automatic
          ? "Waiting for Rokid · retrying automatically"
          : "Connection needs attention",
      );
      if (!automatic) setError(String(e));
      nextAttempt.current = Date.now() + backoff.current;
      backoff.current = Math.min(backoff.current * 2, 60_000);
    } finally {
      connecting.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    const bridge = native();
    if (!bridge) return;
    let checking = false;
    async function sync() {
      if (
        !mounted.current ||
        document.visibilityState === "hidden" ||
        connecting.current ||
        checking
      )
        return;
      checking = true;
      try {
        const info = await bridge!.request<{
          automaticRokid?: boolean;
          connected?: boolean;
          provider?: string;
        }>("info");
        if (!mounted.current) return;
        if (!info.connected && active?.state === "connected")
          active.connectionLost("Connection interrupted");
        if (
          info.connected &&
          info.provider === "rokid" &&
          active?.state !== "connected"
        ) {
          await runConnect("rokid", true);
        } else if (
          info.automaticRokid &&
          !info.provider &&
          Date.now() >= nextAttempt.current
        ) {
          await runConnect("rokid", true);
        }
      } catch {
        /* bounded request; next status check retries */
      } finally {
        checking = false;
      }
    }
    void new NativeAdapter(bridge)
      .discover()
      .then((found) => {
        if (!mounted.current) return;
        knownDevices.current = found;
        setDevices(found);
        setSelected(found.find((d) => d.id === "rokid")?.id ?? "");
        void sync();
      })
      .catch((e) => {
        if (mounted.current) setError(String(e));
      });
    const timer = window.setInterval(() => void sync(), 3000);
    const resume = () => {
      nextAttempt.current = 0;
      void sync();
    };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("kobe-native-reconnected", resume);
    return () => {
      mounted.current = false;
      active = null;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", resume);
      window.removeEventListener("kobe-native-reconnected", resume);
      void bridge.request("disconnect").catch(() => undefined);
    };
  }, []);
  if (!window.KobeNative)
    return (
      <div className="glasses-hint">
        Rokid reconnects automatically in the Android app after its first setup.
        Phone camera works here.
      </div>
    );
  const connect = () => runConnect(selected);
  const forget = async () => {
    if (connecting.current) return;
    connecting.current = true;
    setBusy(true);
    try {
      await native()?.request("forget");
      active = null;
      onSource(null);
      setStatus("Pairing removed. Connect Rokid to set up again.");
      setError("");
    } catch {
      setError("Could not remove pairing. Try again.");
    } finally {
      connecting.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section aria-label="Glasses connection" className="glasses-control">
      <div className="glasses-row">
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
          {busy
            ? "Connecting…"
            : selected === "rokid"
              ? "Connect Rokid"
              : "Connect"}
        </button>
      </div>
      <div role="status" className="glasses-status">
        {status}
      </div>
      <button
        className="mark-ghost"
        disabled={busy}
        onClick={() => void forget()}
      >
        Forget pairing
      </button>
      {error && (
        <div role="alert" className="mark-error">
          {error}
        </div>
      )}
    </section>
  );
}
