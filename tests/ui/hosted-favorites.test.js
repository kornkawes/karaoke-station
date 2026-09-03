/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from "vitest";
import { normalizeFavorite, sanitizeFavorites } from "../../src/HostedApp.jsx";

describe("hosted favorite storage", () => {
  it("repairs legacy badge-only favorites and strips unsafe fields", () => {
    expect(normalizeFavorite({
      videoId: "dQw4w9WgXcQ",
      title: "  เพลงโปรด  ",
      badge: "Karaoke",
      thumbnailUrl: "https://evil.example/track.jpg",
      queueId: "should-not-persist",
      requestedBy: "someone"
    })).toEqual({
      videoId: "dQw4w9WgXcQ",
      title: "เพลงโปรด",
      channelTitle: "",
      thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
      classification: "karaoke",
      badge: "Karaoke"
    });
  });

  it("drops malformed entries and limits the stored collection", () => {
    const input = [
      { videoId: "bad", title: "invalid" },
      ...Array.from({ length: 105 }, (_, index) => ({
        videoId: `${String(index).padStart(10, "0")}a`,
        title: `Song ${index}`
      }))
    ];

    const result = sanitizeFavorites(input);
    expect(result).toHaveLength(100);
    expect(result[0].title).toBe("Song 0");
    expect(result.at(-1).title).toBe("Song 99");
  });
});
