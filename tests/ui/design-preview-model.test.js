import { describe, expect, it } from "vitest";
import {
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

  it("recognizes YouTube URLs and video IDs but not ordinary search text", () => {
    expect(isDirectYouTubeInput("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(isDirectYouTubeInput("dQw4w9WgXcQ")).toBe(true);
    expect(isDirectYouTubeInput("เพลงไทย คาราโอเกะ")).toBe(false);
  });
});
