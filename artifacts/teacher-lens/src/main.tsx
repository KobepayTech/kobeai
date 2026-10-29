import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Onboarding } from "./Onboarding";
import "./styles.css";
import "./k9-refresh.css";

// The QR a teacher scans lands on `#/onboard/<token>`. That is a different
// screen from the Lens itself — it has no session, no wake word and no
// briefing — so it is branched here rather than inside App, which would
// otherwise open the camera and start a lens session behind the form.
const onboarding = window.location.hash.startsWith("#/onboard/");

createRoot(document.getElementById("root")!).render(onboarding ? <Onboarding /> : <App />);

/* Install only in the production browser PWA. The Android shell bundles its own
 * assets and does not need a browser service worker. API data is never cached. */
if (import.meta.env.PROD && "serviceWorker" in navigator && !window.KobeNative) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`, {
      scope: import.meta.env.BASE_URL,
    }).catch((error) => console.warn("K9 offline shell unavailable:", error));
  });
}
