import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { registerSW, pushSupported } from "./lib/push";

createRoot(document.getElementById("root")!).render(<App />);

// Best-effort SW registration on boot. If push isn't supported (Safari iOS
// without PWA install, or http) this no-ops. Failures are logged but never
// block the app from rendering.
if (pushSupported()) {
  registerSW().catch((err) => console.warn("Service worker registration failed", err));
}
