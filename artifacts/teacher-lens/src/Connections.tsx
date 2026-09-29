import { useEffect, useRef, useState, type ReactNode } from "react";
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
      className={open ? "teacher-workspace teacher-connections" : undefined}
      aria-label={open ? "Connections" : "Device controls"}
    >
      {open && (
        <>
          <header className="teacher-heading">
            <div>
              <span className="teacher-eyebrow">KobeAI · CONNECTIONS</span>
              <h1>Ready to connect</h1>
              <p>One-time setup. Automatic reconnection.</p>
            </div>
            <button onClick={onClose}>Done</button>
          </header>
          <article className="teacher-card">
            <h2>1 · School server</h2>
            <p>
              The Android app sends your questions and captured photos to this
              server using your teacher account.
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
                {busy ? "Checking…" : "Check server connection"}
              </button>
              <button onClick={onChangeServer}>Change server / sign in</button>
            </div>
            {status && <p role="status">{status}</p>}
            <details>
              <summary>Using the school’s local Wi-Fi?</summary>
              <p>
                Join the same school network as the KobeAI server. Enter the
                HTTPS address provided by your administrator. The server must be
                running and have a certificate trusted by Android.
              </p>
              <p>
                Administrator: allow{" "}
                <code>https://appassets.androidplatform.net</code> in the
                server’s CORS origins.
              </p>
            </details>
          </article>
          <article className="teacher-card">
            <h2>2 · MoYoung glasses</h2>
            <p>Glasses → Bluetooth → this Android phone → school server.</p>
            <details>
              <summary>Pair MoYoung / DA ECHO glasses</summary>
              <ol>
                <li>Turn on the glasses and Bluetooth on this phone.</li>
                <li>Choose MoYoung below and tap Connect MoYoung.</li>
                <li>Allow Android’s nearby-device permissions.</li>
                <li>Select your glasses from the Bluetooth scan list.</li>
                <li>
                  The MoYoung SDK starts its connection flow. Wait for the
                  connected status before taking a photo.
                </li>
              </ol>
              <p>
                The selected device is remembered after a successful connection.
                MoYoung reconnects automatically when you return or the connection
                drops. Use Pause or Forget pairing to stop automatic connection.
                No developer secret or licence file is needed for this pairing flow.
                W620 support is experimental; test capture on your device first.
              </p>
            </details>
          </article>
        </>
      )}
      <div className={open ? "teacher-card connection-controls" : undefined}>
        {children}
      </div>
      {open && (
        <p className="teacher-muted">
          The web preview cannot pair Bluetooth glasses. Use the installed
          Android app for the native MoYoung dialogs. Physical pairing has not yet
          been verified on our hardware.
        </p>
      )}
    </section>
  );
}
