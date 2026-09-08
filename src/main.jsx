import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import HostedApp from "./HostedApp";
const DesignPreviewApp = lazy(() => import("./design-preview/DesignPreviewApp"));

// The approved AFTER HOURS preview is the live UI. Keep the prior hosted
// interface behind an explicit query parameter for a safe rollback path.
import ModernApp from "./modern/ModernApp";

const isLocalLane = import.meta.env.MODE === "locallane" || import.meta.env.VITE_APP_MODE === "local";
const savedUi = window.localStorage?.getItem?.("karaoke_ui");
const isModern = new URLSearchParams(window.location.search).get("ui") === "modern" ||
  window.location.hash.includes("ui=modern") ||
  savedUi === "modern";

const ui = new URLSearchParams(window.location.search).get("ui");
let Root = DesignPreviewApp;
if (isLocalLane) {
  Root = App;
} else if (isModern) {
  Root = ModernApp;
} else if (ui === "hosted") {
  Root = HostedApp;
}

createRoot(document.getElementById("root")).render(<StrictMode><Suspense fallback={<p>กำลังโหลด…</p>}><Root /></Suspense></StrictMode>);
