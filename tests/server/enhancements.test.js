import { describe, expect, it, vi } from "vitest";
import { orderQueueByArrival, rebalanceFairQueue } from "../../server/lib/library.js";
import { YouTubeService } from "../../server/lib/youtube.js";

describe("KaraokeStation Enhancements", () => {
  describe("Fair Queue (Round-Robin)", () => {
    it("rebalances queue fairly across multiple singers", () => {
      const items = [
        { id: "1", title: "Song 1", requestedBy: "Alice" },
        { id: "2", title: "Song 2", requestedBy: "Alice" },
        { id: "3", title: "Song 3", requestedBy: "Alice" },
        { id: "4", title: "Song 4", requestedBy: "Bob" },
        { id: "5", title: "Song 5", requestedBy: "Charlie" },
        { id: "6", title: "Song 6", requestedBy: "Bob" }
      ];

      const fair = rebalanceFairQueue(items);

      // Round 1: Alice (1), Bob (4), Charlie (5)
      // Round 2: Alice (2), Bob (6)
      // Round 3: Alice (3)
      expect(fair.map((i) => i.id)).toEqual(["1", "4", "5", "2", "6", "3"]);
    });

    it("handles single singer or empty queue without error", () => {
      expect(rebalanceFairQueue([])).toEqual([]);
      expect(rebalanceFairQueue([{ id: "1", requestedBy: "Alice" }])).toEqual([{ id: "1", requestedBy: "Alice" }]);
    });

    it("starts the next round after the singer who is currently playing", () => {
      const items = [
        { id: "alice-2", requestedBy: "Alice", _requesterKey: "controller-a" },
        { id: "bob-1", requestedBy: "Bob", _requesterKey: "controller-b" },
        { id: "alice-3", requestedBy: "Alice", _requesterKey: "controller-a" }
      ];

      expect(rebalanceFairQueue(items, { currentRequesterKey: "controller-a" }).map((item) => item.id))
        .toEqual(["bob-1", "alice-2", "alice-3"]);
    });

    it("restores arrival order when fair queue mode is turned off", () => {
      const items = [
        { id: "late", requestedBy: "Bob", addedAt: "2026-09-11T10:00:02.000Z" },
        { id: "first", requestedBy: "Alice", addedAt: "2026-09-11T10:00:00.000Z" },
        { id: "middle", requestedBy: "Charlie", addedAt: "2026-09-11T10:00:01.000Z" }
      ];

      expect(orderQueueByArrival(items).map((item) => item.id)).toEqual(["first", "middle", "late"]);
    });
  });

  describe("YouTube Direct Link Resolution & Quota Cache", () => {
    it("resolves direct YouTube URL via oEmbed when no API key", async () => {
      const fakeFetch = async (url) => {
        if (url.includes("oembed")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              title: "วัดใจ - Silly Fools (Karaoke)",
              author_name: "GMM GRAMMY",
              thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"
            })
          };
        }
        return { ok: false, status: 404 };
      };

      const youtube = new YouTubeService({ fetchImpl: fakeFetch, getApiKey: () => null });
      const result = await youtube.resolveVideo({ input: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });

      expect(result.videoId).toBe("dQw4w9WgXcQ");
      expect(result.title).toBe("วัดใจ - Silly Fools (Karaoke)");
      expect(result.channelTitle).toBe("GMM GRAMMY");
      expect(result.cached).toBe(false);

      // Second call must hit memory cache (cached: true)
      const cachedResult = await youtube.resolveVideo({ input: "https://youtu.be/dQw4w9WgXcQ" });
      expect(cachedResult.cached).toBe(true);
      expect(cachedResult.title).toBe("วัดใจ - Silly Fools (Karaoke)");
    });

    it("fails closed when metadata lookup fails instead of inventing a playable track", async () => {
      const fakeFetch = async () => ({ ok: false, status: 404 });
      const youtube = new YouTubeService({ fetchImpl: fakeFetch, getApiKey: () => null });

      await expect(youtube.resolveVideo({ input: "dQw4w9WgXcQ" })).rejects.toMatchObject({
        code: "youtube_upstream_error"
      });
    });

    it("does not use oEmbed to bypass an API response that marks a video unavailable", async () => {
      const fakeFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
        items: [{ id: "dQw4w9WgXcQ", status: { embeddable: false, privacyStatus: "public" } }]
      }), { status: 200 }));
      const youtube = new YouTubeService({ fetchImpl: fakeFetch, getApiKey: () => "test-key" });

      await expect(youtube.resolveVideo({ input: "dQw4w9WgXcQ" })).rejects.toMatchObject({
        status: 404,
        code: "youtube_video_unavailable"
      });
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    });

    it("coalesces concurrent resolution requests for the same video", async () => {
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      const fakeFetch = vi.fn().mockImplementation(async (url) => {
        await gate;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            title: "Concurrent Karaoke",
            author_name: "Channel",
            thumbnail_url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg"
          })
        };
      });
      const youtube = new YouTubeService({ fetchImpl: fakeFetch, getApiKey: () => null });
      const first = youtube.resolveVideo({ input: "dQw4w9WgXcQ" });
      const second = youtube.resolveVideo({ input: "https://youtu.be/dQw4w9WgXcQ" });
      release();

      await expect(first).resolves.toMatchObject({ cached: false, title: "Concurrent Karaoke" });
      await expect(second).resolves.toMatchObject({ cached: true, title: "Concurrent Karaoke" });
      expect(fakeFetch).toHaveBeenCalledTimes(1);
    });
  });
});
