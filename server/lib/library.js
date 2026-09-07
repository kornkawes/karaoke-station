import { AppError } from "./errors.js";
import { randomUuid } from "./compat.js";

function timestamp() {
  return new Date().toISOString();
}

function queueItem(track, requestedBy = "Host", requesterKey = requestedBy) {
  return {
    id: randomUuid(),
    ...track,
    requestedBy: requestedBy || "Host",
    _requesterKey: requesterKey || requestedBy || "Host",
    addedAt: timestamp(),
    status: "queued",
    failureReason: null
  };
}

function historyItem(track, outcome, failureReason = null) {
  const { _requesterKey: _hiddenRequesterKey, ...visibleTrack } = track;
  return {
    ...visibleTrack,
    status: outcome,
    failureReason,
    playedAt: timestamp()
  };
}

/** Remove server-only queue bookkeeping before data leaves the process. */
export function publicTrack(track) {
  if (!track) return track;
  const { _requesterKey: _hiddenRequesterKey, ...visibleTrack } = track;
  return visibleTrack;
}

export function publicMutationResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) return result;
  return Object.fromEntries(Object.entries(result).map(([key, value]) => {
    if (["current", "previous", "removed"].includes(key)) return [key, publicTrack(value)];
    return [key, value];
  }));
}

export function rebalanceFairQueue(items, { currentRequester, currentRequesterKey } = {}) {
  if (!Array.isArray(items) || items.length <= 1) return items;
  const singerQueues = new Map();
  const orderOfArrival = [];
  for (const item of items) {
    const key = item._requesterKey || item.requestedBy || "Host";
    if (!singerQueues.has(key)) {
      singerQueues.set(key, []);
      orderOfArrival.push(key);
    }
    singerQueues.get(key).push(item);
  }

  const currentKey = currentRequesterKey || currentRequester;
  const currentIndex = currentKey ? orderOfArrival.indexOf(currentKey) : -1;
  if (currentIndex >= 0 && orderOfArrival.length > 1) {
    const nextIndex = (currentIndex + 1) % orderOfArrival.length;
    orderOfArrival.splice(0, orderOfArrival.length, ...[
      ...orderOfArrival.slice(nextIndex),
      ...orderOfArrival.slice(0, nextIndex)
    ]);
  }

  const result = [];
  let round = 0;
  let hasMore = true;
  while (hasMore) {
    hasMore = false;
    for (const singer of orderOfArrival) {
      const q = singerQueues.get(singer);
      if (round < q.length) {
        result.push(q[round]);
        hasMore = true;
      }
    }
    round++;
  }
  return result;
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
  const item = queueItem(track, options.requestedBy, options.requesterKey);
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
    if (draft.settings?.fairQueue) {
      draft.queue = rebalanceFairQueue(draft.queue, {
        currentRequester: draft.current?.requestedBy,
        currentRequesterKey: draft.current?._requesterKey
      });
    }
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
    current: publicTrack(state.current),
    items: state.queue.map(publicTrack)
  };
}
