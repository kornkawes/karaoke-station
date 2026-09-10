import { describe, expect, it } from "vitest";
import {
  applyPreviewRoomView,
  emptyPreviewRoom,
  isDirectYouTubeInput,
  viewToPreviewRoom
} from "../../src/design-preview/model.js";

describe("design preview hosted adapter", () => {
  it("maps a hosted room snapshot into the preview room state", () => {
    const next = viewToPreviewRoom({
      revision: 7,
      stationName: "After Hours",
      settings: { fairQueue: true },
      current: {
        id: "current-id",
        videoId: "dQw4w9WgXcQ",
        title: "Current song",
        channelTitle: "Channel",
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"
      },
      queue: [{
        id: "queue-id",
        videoId: "abcdefghijk",
        title: "Next song",
        channelTitle: "Channel",
        requestedBy: "Nut"
      }]
    });

    expect(next).toMatchObject({
      revision: 7,
      stationName: "After Hours",
      settings: { fairQueue: true },
      current: { queueId: "current-id", videoId: "dQw4w9WgXcQ" },
      queue: [{ queueId: "queue-id", videoId: "abcdefghijk", requestedBy: "Nut" }]
    });
  });

  it("also maps the nested queue object used by hosted room snapshots", () => {
    const next = viewToPreviewRoom({
      revision: 9,
      settings: { fairQueue: false },
      queue: {
        revision: 9,
        current: { id: "nested-current", videoId: "dQw4w9WgXcQ", title: "Nested current" },
        items: [{ id: "nested-next", videoId: "abcdefghijk", title: "Nested next" }]
      }
    });

    expect(next).toMatchObject({
      revision: 9,
      current: { queueId: "nested-current" },
      queue: [{ queueId: "nested-next" }]
    });
  });

  it("does not lose the previous settings when a partial snapshot omits them", () => {
    const next = viewToPreviewRoom(
      { revision: 8, queue: [], current: null },
      { ...emptyPreviewRoom, settings: { fairQueue: true } }
    );

    expect(next.settings).toEqual({ fairQueue: true });
  });

  it("keeps the authoritative controller count for the host invite transition", () => {
    const joined = viewToPreviewRoom({ revision: 4, controllerCount: 2, queue: [], current: null });
    expect(joined.controllerCount).toBe(2);

    const partial = viewToPreviewRoom({ revision: 5, queue: [], current: null }, joined);
    expect(partial.controllerCount).toBe(2);
  });

  it("prefers live controller sockets over registered session count", () => {
    const joined = viewToPreviewRoom({
      revision: 4,
      controllerCount: 7,
      connectedControllerCount: 1,
      idle: { phase: "idle", warning: false, closesAt: "2026-07-29T12:10:00.000Z" },
      queue: [],
      current: null
    });
    expect(joined.controllerCount).toBe(1);
    expect(joined.connectedControllerCount).toBe(1);
    expect(joined.idle.phase).toBe("idle");
  });

  it("ignores stale room snapshots after a newer realtime revision", () => {
    const current = viewToPreviewRoom({
      revision: 2,
      current: { id: "current-id", videoId: "dQw4w9WgXcQ", title: "Current song" },
      queue: [{ id: "next-id", videoId: "abcdefghijk", title: "Next song" }]
    });

    const stale = applyPreviewRoomView({ revision: 0, current: null, queue: [] }, current);
    expect(stale).toBe(current);
    expect(stale.current).toMatchObject({ queueId: "current-id" });

    const fresh = applyPreviewRoomView({
      revision: 3,
      current: { id: "next-id", videoId: "abcdefghijk", title: "Next song" },
      queue: []
    }, current);
    expect(fresh).toMatchObject({ revision: 3, current: { queueId: "next-id" }, queue: [] });
  });

  it("recognizes YouTube URLs and video IDs but not ordinary search text", () => {
    expect(isDirectYouTubeInput("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(isDirectYouTubeInput("dQw4w9WgXcQ")).toBe(true);
    expect(isDirectYouTubeInput("เพลงไทย คาราโอเกะ")).toBe(false);
  });
});
