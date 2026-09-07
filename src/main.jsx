import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import HostedApp from "./HostedApp";

// Hosted is the current direction; the local-first App is kept for the legacy
// installer lane, built with `vite build --mode local`.
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
}

createRoot(document.getElementById("root")).render(<StrictMode><Root /></StrictMode>);
