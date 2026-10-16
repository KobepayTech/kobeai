import { useEffect, useRef, useState, type ReactNode } from "react";
import { benchmarkGlasses } from "./glasses";
import type { TeacherAuth } from "./TeacherWorkspace";

/** Keep the one glasses control mounted when opening/closing settings. */
export function Connections({
  auth,
  open,
  onClose,
  onChangeServer,
  children,
}: {
  auth: TeacherAuth;
  open: boolean;
  onClose: () => void;
  onChangeServer: () => void;
  children: ReactNode;
}) {
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [bench, setBench] = useState("");
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  async function checkServer() {
    if (busy) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true);
    setStatus("");
    try {
      const response = await fetch(
        `${auth.api_base}/api/v1/classroom/context`,
        {
          headers: { authorization: `Bearer ${auth.token}` },
          signal: AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(10_000),
          ]),
        },
      );
      if (response.status === 401)
        throw new Error("Sign-in expired. Sign in again to this server.");
      if (!response.ok)
        throw new Error(
          `Server responded with HTTP ${response.status}. Check your account access.`,
        );
      await response.json();
      setStatus(
        "Connected. Your school API accepted this teacher account. AI model readiness is checked when you ask a question.",
      );
    } catch (e) {
      if (!controller.signal.aborted)
        setStatus(
          (e instanceof Error && e.message.startsWith("Server")) ||
            (e instanceof Error && e.message.startsWith("Sign-in"))
            ? e.message
            : "Cannot reach the school API. Check Wi-Fi, the server address, its HTTPS certificate and server CORS settings.",
        );
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  return (
    <section
      className={open ? "teacher-workspace teacher-connections" : "k9-controls-mounted"}
      aria-label={open ? "Connections" : "Device controls"}
    >
      {open && (
        <>
          <header className="teacher-heading">
            <div>
              <span className="teacher-eyebrow">K9 / SETTINGS</span>
              <h1>Connections</h1>
              <p>Keep your camera and school server ready.</p>
            </div>
            <button onClick={onClose}>Done</button>
          </header>
          <article className="teacher-card">
            <h2>School server</h2>
            <p>
              Your class work and photos sync with this school server.
            </p>
            <label>
              Current server address
              <input
                aria-label="Current server address"
                readOnly
                value={auth.api_base}
              />
            </label>
            <p>
              Signed in as <strong>{auth.teacher_name}</strong>
            </p>
            <div className="connection-actions">
              <button onClick={() => void checkServer()} disabled={busy}>
                {busy ? "Checking…" : "Test connection"}
              </button>
              <button onClick={onChangeServer}>Change school</button>
            </div>
            {status && <p role="status">{status}</p>}
          </article>
          <article className="teacher-card">
            <h2>MoYoung / DA ECHO glasses</h2>
            <p>Choose your glasses below. K9 will show whether the device is actually connected before capturing.</p>
            <p className="teacher-muted">If your glasses are not listed, ask your school administrator to enable them.</p>
            <details className="teacher-advanced">
              <summary>Advanced diagnostics</summary>
              <p>Turn on your MoYoung / DA ECHO glasses, tap Connect, allow Nearby devices and select your glasses. K9 remembers successful pairing. Use Pause or Forget pairing to stop automatic reconnection.</p>
            <h3>Check capture speed</h3>
            <p>
              Takes ten photographs through the glasses and reports what actually
              arrived. A vendor command that says “photo taken” does not mean the
              image reached the phone — capture and transfer are separate, so the
              only honest cadence is a measured one.
            </p>
            <button
              onClick={async () => {
                setBench("Taking ten photographs…");
                const report = await benchmarkGlasses(10);
                if (!report) {
                  setBench("Connect the glasses first.");
                  return;
                }
                setBench(
                  `${report.delivered}/${report.attempted} arrived in ${report.seconds}s · ` +
                    `typical ${(report.medianLatencyMs / 1000).toFixed(1)}s, ` +
                    `slowest ${(report.p95LatencyMs / 1000).toFixed(1)}s · ` +
                    `sustainable interval ${(report.sustainableIntervalMs / 1000).toFixed(1)}s ` +
                    `(${report.perMinute}/min) · ${report.stoppedBecause}`,
                );
              }}
            >
              Test capture speed
            </button>
            {bench && (
              <p role="status" className="teacher-prewrap">{bench}</p>
            )}
            </details>
          </article>
        </>
      )}
      <div className={open ? "teacher-card connection-controls" : undefined}>
        {children}
      </div>
      {open && <p className="teacher-muted">Only connected devices can capture glasses photos. Choose Phone camera explicitly if you want to use it instead.</p>}
    </section>
  );
}
