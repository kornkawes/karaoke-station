import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import App from "./App";
import HostedApp from "./HostedApp";

// Hosted is the current direction; the local-first App is kept for the legacy
// installer lane, built with `vite build --mode local`.
const isLocalLane = import.meta.env.MODE === "locallane" || import.meta.env.VITE_APP_MODE === "local";
const Root = isLocalLane ? App : HostedApp;

createRoot(document.getElementById("root")).render(<StrictMode><Root /></StrictMode>);
