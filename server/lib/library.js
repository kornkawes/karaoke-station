import { AppError } from "./errors.js";
import { randomUuid } from "./compat.js";

function timestamp() {
  return new Date().toISOString();
}

function queueItem(track, requestedBy = "Host") {
  return {
    id: randomUuid(),
    ...track,
    requestedBy: requestedBy || "Host",
    addedAt: timestamp(),
    status: "queued",
    failureReason: null
  };
}

function historyItem(track, outcome, failureReason = null) {
  return {
    ...track,
    status: outcome,
    failureReason,
    playedAt: timestamp()
  };
}

export function addToQueue(draft, track, options = {}) {
  if (draft.queue.length >= 100) {
    throw new AppError(409, "queue_full", "คิวเต็มแล้ว (สูงสุด 100 เพลง)");
  }
  const duplicate = draft.current?.videoId === track.videoId ||
    draft.queue.some((item) => item.videoId === track.videoId);
  const allowDuplicate = options.allowDuplicate ?? draft.settings.allowDuplicate;
  if (duplicate && !allowDuplicate) {
    throw new AppError(409, "duplicate_track", "เพลงนี้อยู่ในคิวแล้ว");
  }
  const item = queueItem(track, options.requestedBy);
  if (options.playNow) {
    if (draft.current) {
      draft.history.unshift(historyItem(draft.current, "interrupted"));
      draft.history = draft.history.slice(0, 1_000);
    }
    draft.current = { ...item, status: "playing" };
  } else if (!draft.current) {
    draft.current = { ...item, status: "ready" };
  } else {
    draft.queue.push(item);
  }
  return item;
}

export function advanceQueue(draft, { outcome = "completed", failureReason = null } = {}) {
  const previous = draft.current;
  if (previous) {
    draft.history.unshift(historyItem(previous, outcome, failureReason));
    draft.history = draft.history.slice(0, 1_000);
  }
  const next = draft.queue.shift() ?? null;
  draft.current = next ? { ...next, status: "ready", failureReason: null } : null;
  return { previous, current: draft.current };
}

export function removeQueueItem(draft, itemId) {
  if (draft.current?.id === itemId) {
    return advanceQueue(draft, { outcome: "removed" });
  }
  const index = draft.queue.findIndex((item) => item.id === itemId);
  if (index === -1) throw new AppError(404, "queue_item_not_found", "ไม่พบเพลงในคิว");
  const [removed] = draft.queue.splice(index, 1);
  return { removed, current: draft.current };
}

export function reorderQueue(draft, itemId, toIndex) {
  if (draft.current?.id === itemId) {
    throw new AppError(409, "current_track_not_reorderable", "ไม่สามารถย้ายเพลงที่กำลังเล่นได้");
  }
  const index = draft.queue.findIndex((item) => item.id === itemId);
  if (index === -1) throw new AppError(404, "queue_item_not_found", "ไม่พบเพลงในคิว");
  if (toIndex >= draft.queue.length) {
    throw new AppError(400, "invalid_queue_position", "ตำแหน่งคิวเกินจำนวนเพลง");
  }
  const [item] = draft.queue.splice(index, 1);
  draft.queue.splice(toIndex, 0, item);
  return item;
}

export function playQueueItemNow(draft, itemId) {
  if (draft.current?.id === itemId) {
    throw new AppError(409, "track_already_current", "เพลงนี้กำลังเล่นอยู่แล้ว");
  }
  const index = draft.queue.findIndex((item) => item.id === itemId);
  if (index === -1) throw new AppError(404, "queue_item_not_found", "ไม่พบเพลงในคิว");
  const [selected] = draft.queue.splice(index, 1);
  const previous = draft.current;
  if (previous) {
    draft.history.unshift(historyItem(previous, "interrupted"));
    draft.history = draft.history.slice(0, 1_000);
  }
  draft.current = { ...selected, status: "ready", failureReason: null };
  return { previous, current: draft.current };
}

export function queueView(state) {
  return {
    revision: state.revision,
    current: state.current,
    items: state.queue
  };
}
