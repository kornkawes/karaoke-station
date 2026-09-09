import { normalizeQueue } from "../lib/hosted-api";

export const emptyPreviewRoom = {
  revision: 0,
  current: null,
  queue: [],
  stationName: "KaraokeStation",
  controllerCount: 0,
  settings: { fairQueue: false },
  playback: { playing: true, volume: 75, muted: false }
};

export function viewToPreviewRoom(view, previous = emptyPreviewRoom) {
  const normalized = normalizeQueue(view);

  return {
    revision: normalized.revision,
    current: normalized.current,
    queue: normalized.items,
    stationName: view?.stationName || previous.stationName || "KaraokeStation",
    controllerCount: Number.isFinite(Number(view?.controllerCount))
      ? Number(view.controllerCount)
      : Number(previous.controllerCount || 0),
    settings: view?.settings ?? previous.settings ?? { fairQueue: false },
    playback: view?.playback ?? previous.playback ?? { playing: true, volume: 75, muted: false }
  };
}

export function applyPreviewRoomView(view, previous = emptyPreviewRoom) {
  const next = viewToPreviewRoom(view, previous);
  return next.revision >= previous.revision ? next : previous;
}

export function isDirectYouTubeInput(value) {
  const input = String(value || "").trim();
  return /(?:youtube\.com|youtu\.be)/i.test(input) || /^[A-Za-z0-9_-]{11}$/.test(input);
}

export function thumbnailFor(track) {
  if (!track?.videoId) return "";
  return track.thumbnailUrl || `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`;
}
