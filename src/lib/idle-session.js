/** Format a server-provided ISO close time for the Host warning banner. */
export function formatIdleCountdown(closesAt, now = Date.now()) {
  const closeTime = Date.parse(String(closesAt || ""));
  if (!Number.isFinite(closeTime)) return "--:--";
  const totalSeconds = Math.max(0, Math.ceil((closeTime - now) / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
