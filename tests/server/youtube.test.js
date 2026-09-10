import { describe, expect, it, vi } from "vitest";
import {
  classifyKaraokeTrack,
  parseYouTubeInput,
  YouTubeService
} from "../../server/lib/youtube.js";

describe("parseYouTubeInput", () => {
  it.each([
    ["dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1", "dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube.com/shorts/dQw4w9WgXcQ", "dQw4w9WgXcQ"],
    ["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ", "dQw4w9WgXcQ"]
  ])("parses %s", (input, expected) => {
    expect(parseYouTubeInput(input).videoId).toBe(expected);
  });

  it.each([
    "https://example.com/watch?v=dQw4w9WgXcQ",
    "http://youtube.com/watch?v=dQw4w9WgXcQ",
    "not-a-video!"
  ])("rejects unsafe or malformed input: %s", (input) => {
    expect(() => parseYouTubeInput(input)).toThrow();
  });
});

describe("YouTubeService", () => {
  it("uses official embeddable filters, normalizes results, and caches", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{ id: { videoId: "dQw4w9WgXcQ" } }]
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          id: "dQw4w9WgXcQ",
          status: { embeddable: true, privacyStatus: "public" },
          snippet: {
            title: "เพลงไทย Karaoke",
            channelTitle: "Test Channel",
            thumbnails: { medium: { url: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg" } }
          },
          contentDetails: { duration: "PT4M12S" }
        }]
      }), { status: 200 }));
    const service = new YouTubeService({
      fetchImpl,
      getApiKey: () => "test-key"
    });

    const first = await service.search({ query: "เพลงไทย", mode: "karaoke" });
    const second = await service.search({ query: "เพลงไทย", mode: "karaoke" });

    expect(first.results[0]).toMatchObject({
      videoId: "dQw4w9WgXcQ",
      title: "เพลงไทย Karaoke",
      classification: "karaoke",
      badge: "Karaoke",
      embeddable: true
    });
    const searchUrl = new URL(fetchImpl.mock.calls[0][0]);
    expect(searchUrl.searchParams.get("videoEmbeddable")).toBe("true");
    expect(searchUrl.searchParams.get("videoSyndicated")).toBe("true");
    expect(searchUrl.searchParams.get("key")).toBe("test-key");
    expect(second.cached).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("strictly returns every positively-classified type in both mode", async () => {
    const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: ids.map((videoId) => ({ id: { videoId } }))
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [
          {
            id: ids[0],
            status: { embeddable: true, privacyStatus: "public" },
            snippet: { title: "เพลงไทย คาราโอเกะ", channelTitle: "A" },
            contentDetails: { duration: "PT3M" }
          },
          {
            id: ids[1],
            status: { embeddable: true, privacyStatus: "public" },
            snippet: { title: "English Song Instrumental", channelTitle: "B" },
            contentDetails: { duration: "PT3M" }
          },
          {
            id: ids[2],
            status: { embeddable: true, privacyStatus: "public" },
            snippet: { title: "Artist - Song", description: "Official backing track" },
            contentDetails: { duration: "PT3M" }
          },
          {
            id: ids[3],
            status: { embeddable: true, privacyStatus: "public" },
            snippet: { title: "Official Music Video", description: "No vocals metadata" },
            contentDetails: { duration: "PT3M" }
          }
        ]
      }), { status: 200 }));
    const service = new YouTubeService({ fetchImpl, getApiKey: () => "test-key" });

    const result = await service.search({ query: "Song", mode: "both", maxResults: 12 });

    expect(result.results.map((item) => item.classification)).toEqual([
      "karaoke",
      "instrumental",
      "backing_track"
    ]);
    expect(result.results.map((item) => item.badge)).toEqual([
      "Karaoke",
      "Instrumental",
      "Backing Track"
    ]);
    const searchUrl = new URL(fetchImpl.mock.calls[0][0]);
    expect(searchUrl.searchParams.get("q")).toContain("คาราโอเกะ");
    expect(searchUrl.searchParams.get("maxResults")).toBe("25");
  });

  it("deduplicates song variants and prefers official or major channels before views", async () => {
    const ids = ["aaaaaaaaaaa", "bbbbbbbbbbb", "ccccccccccc", "ddddddddddd"];
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: ids.map((videoId) => ({ id: { videoId } }))
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [
          {
            id: ids[0],
            status: { embeddable: true, privacyStatus: "public" },
            snippet: { title: "[KARAOKE] กำแพงหัวใจ - Mirrr", channelTitle: "Small Channel" },
            statistics: { viewCount: "9000000" },
            contentDetails: { duration: "PT4M13S" }
          },
          {
            id: ids[1],
            status: { embeddable: true, privacyStatus: "public" },
            snippet: { title: "กำแพงหัวใจ - Mirrr (Official Karaoke)", channelTitle: "GMM Grammy Official" },
            statistics: { viewCount: "1200" },
            contentDetails: { duration: "PT4M13S" }
          },
          {
            id: ids[2],
            status: { embeddable: true, privacyStatus: "public" },
            snippet: { title: "คืนที่ดาวเต็มฟ้า Karaoke", channelTitle: "Random Karaoke" },
            statistics: { viewCount: "12000" },
            contentDetails: { duration: "PT3M42S" }
          },
          {
            id: ids[3],
            status: { embeddable: true, privacyStatus: "public" },
            snippet: { title: "คืนที่ดาวเต็มฟ้า Karaoke", channelTitle: "Another Karaoke" },
            statistics: { viewCount: "88000" },
            contentDetails: { duration: "PT3M42S" }
          }
        ]
      }), { status: 200 }));
    const service = new YouTubeService({ fetchImpl, getApiKey: () => "test-key" });

    const result = await service.search({ query: "Mirrr", mode: "both", maxResults: 15 });

    expect(result.results).toHaveLength(2);
    expect(result.results.map((item) => item.videoId)).toEqual([ids[1], ids[3]]);
    expect(result.results[0].channelTitle).toBe("GMM Grammy Official");
    expect(result.results[1].viewCount).toBe(88000);
    expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("maxResults")).toBe("30");
    expect(new URL(fetchImpl.mock.calls[1][0]).searchParams.get("part")).toContain("statistics");
  });

  it("maps quota failures without exposing upstream payloads", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { errors: [{ reason: "quotaExceeded" }] }
    }), { status: 403 }));
    const service = new YouTubeService({ fetchImpl, getApiKey: () => "secret-key" });

    await expect(service.search({ query: "test" })).rejects.toMatchObject({
      status: 429,
      code: "youtube_quota_exceeded"
    });
  });
});

describe("classifyKaraokeTrack", () => {
  it.each([
    [{ title: "รักเธอ คาราโอเกะ" }, "karaoke"],
    [{ title: "My Song KARAOKE" }, "karaoke"],
    [{ title: "My Song instrumental version" }, "instrumental"],
    [{ title: "My Song", description: "clean BACKING-TRACK" }, "backing_track"]
  ])("classifies Thai and English positive keywords", (track, expected) => {
    expect(classifyKaraokeTrack(track)?.classification).toBe(expected);
  });

  it("does not infer a karaoke type without a positive keyword", () => {
    expect(classifyKaraokeTrack({ title: "Official music video" })).toBeNull();
  });

  it("rejects an official MV whose description merely mentions a karaoke version", () => {
    expect(classifyKaraokeTrack({
      title: "Artist - Song (Official Music Video)",
      description: "Listen to the karaoke version in our playlist."
    })).toBeNull();
  });

  it("accepts an explicit positive title even when it also says official", () => {
    expect(classifyKaraokeTrack({
      title: "Artist - Song (Official Karaoke Version)"
    })).toMatchObject({ classification: "karaoke", badge: "Karaoke" });
  });
});
