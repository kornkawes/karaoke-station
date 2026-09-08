import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import HostedApp from "./HostedApp";
import DesignPreviewApp from "./design-preview/DesignPreviewApp";

// The design-preview runtime is the default hosted surface. The existing
// functional shells remain available for the legacy/local lanes and rollback.
import ModernApp from "./modern/ModernApp";

const isLocalLane = import.meta.env.MODE === "locallane" || import.meta.env.VITE_APP_MODE === "local";
const isModern = new URLSearchParams(window.location.search).get("ui") === "modern" ||
  window.location.hash.includes("ui=modern") ||
  window.localStorage?.getItem?.("karaoke_ui") === "modern";

let Root = DesignPreviewApp;
if (isLocalLane) {
  Root = App;
} else if (isModern) {
  Root = ModernApp;
} else if (new URLSearchParams(window.location.search).get("ui") === "hosted") {
  Root = HostedApp;
}

createRoot(document.getElementById("root")).render(<StrictMode><Root /></StrictMode>);
