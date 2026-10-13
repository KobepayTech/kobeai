import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { installMocks } from "./mock";
import "./styles.css";

// `?mock=1` serves demo data through the same code path a school uses, so the
// app can be seen without a server. Without the flag this does nothing.
installMocks();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
