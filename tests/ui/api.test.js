import { describe, expect, it } from "vitest";
import { apiTrack, normalizeQueue, normalizeTrack } from "../../src/lib/api.js";

describe("frontend API adapters", () => {
  it("serializes a UI track to the backend contract without client-only fields", () => {
    expect(apiTrack({
      videoId: "dQw4w9WgXcQ",
      title: "เพลงไทย",
      channelTitle: "Channel",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
      duration: "PT4M"
    })).toEqual({
      videoId: "dQw4w9WgXcQ",
      title: "เพลงไทย",
      channelTitle: "Channel",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
      duration: "PT4M"
    });
  });

  it("normalizes queue items using the server id as queueId", () => {
    const track = normalizeTrack({ id: "8b9e0d7c-6b3c-42b9-a772-3e6b1dc8cb23", videoId: "dQw4w9WgXcQ", title: "เพลง", channelTitle: "ช่อง" });
    expect(track.queueId).toBe("8b9e0d7c-6b3c-42b9-a772-3e6b1dc8cb23");
    expect(track.thumbnailUrl).toBe("https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg");
    expect(normalizeQueue({ revision: 3, current: null, items: [track] }).items).toHaveLength(1);
  });

  it("accepts a host-state queue array as well as the queue endpoint shape", () => {
    const item = { id: "5c9f5b3f-4b1d-4333-b3c1-43b8d61f65f3", videoId: "dQw4w9WgXcQ", title: "เพลง" };
    const normalized = normalizeQueue({ revision: 4, current: item, queue: [item] });
    expect(normalized.revision).toBe(4);
    expect(normalized.current.queueId).toBe(item.id);
    expect(normalized.items).toHaveLength(1);
  });

  it("accepts the reduced party socket shape with next rather than queue", () => {
    const item = { id: "5c9f5b3f-4b1d-4333-b3c1-43b8d61f65f3", videoId: "dQw4w9WgXcQ", title: "เพลงต่อไป" };
    const normalized = normalizeQueue({ revision: 5, current: null, next: [item] });
    expect(normalized.revision).toBe(5);
    expect(normalized.items[0].queueId).toBe(item.id);
  });
});
