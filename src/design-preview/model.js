import { normalizeQueue } from "../lib/hosted-api";

export const emptyPreviewRoom = {
  revision: 0,
  current: null,
  queue: [],
  stationName: "KaraokeStation",
  settings: { fairQueue: false }
};

export function viewToPreviewRoom(view, previous = emptyPreviewRoom) {
  const normalized = normalizeQueue(view);

  return {
    revision: normalized.revision,
    current: normalized.current,
    queue: normalized.items,
    stationName: view?.stationName || previous.stationName || "KaraokeStation",
    settings: view?.settings ?? previous.settings ?? { fairQueue: false }
  };
}

export function isDirectYouTubeInput(value) {
  const input = String(value || "").trim();
  return /(?:youtube\.com|youtu\.be)/i.test(input) || /^[A-Za-z0-9_-]{11}$/.test(input);
}

export function thumbnailFor(track) {
  if (!track?.videoId) return "";
  return track.thumbnailUrl || `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`;
}
