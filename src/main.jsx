import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import HostedApp from "./HostedApp";
const DesignPreviewApp = lazy(() => import("./design-preview/DesignPreviewApp"));

// AFTER HOURS uses the hosted room and playback APIs. Keep the earlier
// preview runtime available explicitly for comparison.
import ModernApp from "./modern/ModernApp";

const isLocalLane = import.meta.env.MODE === "locallane" || import.meta.env.VITE_APP_MODE === "local";
const isModern = new URLSearchParams(window.location.search).get("ui") === "modern" ||
  window.location.hash.includes("ui=modern") ||
  window.localStorage?.getItem?.("karaoke_ui") === "modern";

let Root = HostedApp;
if (isLocalLane) {
  Root = App;
} else if (isModern) {
  Root = ModernApp;
} else if (new URLSearchParams(window.location.search).get("ui") === "preview") {
  Root = DesignPreviewApp;
}

createRoot(document.getElementById("root")).render(<StrictMode><Suspense fallback={<p>กำลังโหลด…</p>}><Root /></Suspense></StrictMode>);
