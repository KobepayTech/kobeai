import { createRoot } from "react-dom/client";
import { App } from "./App";
import { Onboarding } from "./Onboarding";
import "./styles.css";

// The QR a teacher scans lands on `#/onboard/<token>`. That is a different
// screen from the Lens itself — it has no session, no wake word and no
// briefing — so it is branched here rather than inside App, which would
// otherwise open the camera and start a lens session behind the form.
const onboarding = window.location.hash.startsWith("#/onboard/");

createRoot(document.getElementById("root")!).render(onboarding ? <Onboarding /> : <App />);
