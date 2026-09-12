import { describe, expect, it, vi } from "vitest";
import {
  CatalogService,
  createCatalogSourceFromEnv,
  mapCatalogRows
} from "../../server/lib/catalog.js";

const header = [
  "Artist",
  "Title",
  "Video ID",
  "Channel Title",
  "Thumbnail URL",
  "Classification",
  "Badge"
];

describe("catalog row mapping", () => {
  it("maps named columns, removes duplicate video IDs and omits unsafe metadata", () => {
    const items = mapCatalogRows([
      header,
      ["ศิลปิน ก", "เพลง ก", "dQw4w9WgXcQ", "ช่อง ก", "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg", "karaoke", "Karaoke"],
      ["duplicate", "duplicate", "dQw4w9WgXcQ"],
      ["ศิลปิน ข", "เพลง ข", "abcdefghijk", "ช่อง ข", "https://evil.example/image.jpg"],
      ["broken", "missing id", "too-short"]
    ]);

    expect(items).toEqual([
      {
        artist: "ศิลปิน ก",
        title: "เพลง ก",
        videoId: "dQw4w9WgXcQ",
        youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        aliases: [],
        channelTitle: "ช่อง ก",
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/mqdefault.jpg",
        classification: "karaoke",
        badge: "Karaoke"
      },
      {
        artist: "ศิลปิน ข",
        title: "เพลง ข",
        videoId: "abcdefghijk",
        youtubeUrl: "https://www.youtube.com/watch?v=abcdefghijk",
        aliases: [],
        channelTitle: "ช่อง ข"
      }
    ]);
  });

  it("supports a headerless artist/title/videoId sheet", () => {
    expect(mapCatalogRows([
      ["Artist", "Song", "zyxwvutsrqp", "Channel"]
    ])).toEqual([{
      artist: "Artist",
      title: "Song",
      videoId: "zyxwvutsrqp",
      youtubeUrl: "https://www.youtube.com/watch?v=zyxwvutsrqp",
      aliases: [],
      channelTitle: "Channel"
    }]);
  });

  it("derives videoId from youtubeUrl and normalizes string or array aliases", () => {
    expect(mapCatalogRows([
      ["artist", "title", "youtubeUrl", "aliases"],
      ["Artist", "URL song", "https://youtu.be/dQw4w9WgXcQ", "old name | ชื่อเก่า, old name"],
      ["Artist B", "Array aliases", "https://www.youtube.com/watch?v=abcdefghijk", ["one", "two", "one"]]
    ])).toEqual([
      expect.objectContaining({
        videoId: "dQw4w9WgXcQ",
        youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
        aliases: ["old name", "ชื่อเก่า"]
      }),
      expect.objectContaining({
        videoId: "abcdefghijk",
        aliases: ["one", "two"]
      })
    ]);
  });

  it("falls back from an empty videoId column to youtubeUrl and keeps a channel as artist", () => {
    expect(mapCatalogRows([
      ["artist", "title", "videoId", "youtubeUrl", "channelTitle"],
      ["", "URL only", "", "https://www.youtube.com/watch?v=abcdefghijk", "Official Channel"]
    ])).toEqual([expect.objectContaining({
      title: "URL only",
      videoId: "abcdefghijk",
      artist: "Official Channel",
      channelTitle: "Official Channel"
    })]);
  });
});

describe("CatalogService", () => {
  it("coalesces concurrent reads and caches mapped suggestions", async () => {
    const clock = { value: 1_000 };
    const source = {
      load: vi.fn(async () => [
        header,
        ["Artist A", "Hello Karaoke", "dQw4w9WgXcQ"],
        ["Artist B", "Another Song", "abcdefghijk"]
      ]),
      append: vi.fn()
    };
    const service = new CatalogService({
      source,
      cacheTtlMs: 5_000,
      now: () => clock.value
    });

    const [first, second] = await Promise.all([
      service.listSuggestions({ query: "hello", limit: 8 }),
      service.listSuggestions({ query: "artist", limit: 8 })
    ]);
    expect(source.load).toHaveBeenCalledTimes(1);
    expect(first.suggestions.map((item) => item.videoId)).toEqual(["dQw4w9WgXcQ"]);
    expect(second.suggestions).toHaveLength(2);

    clock.value += 4_000;
    await service.listSuggestions({ query: "", limit: 1 });
    expect(source.load).toHaveBeenCalledTimes(1);
  });

  it("deduplicates existing and concurrent auto-learn writes by videoId", async () => {
    let finishAppend;
    const appendPending = new Promise((resolve) => { finishAppend = resolve; });
    const source = {
      load: vi.fn(async () => [header, ["Artist A", "Song A", "dQw4w9WgXcQ"]]),
      append: vi.fn(() => appendPending)
    };
    const service = new CatalogService({ source });

    await expect(service.remember({
      videoId: "dQw4w9WgXcQ",
      title: "Already known"
    })).resolves.toBe(false);
    const track = { videoId: "abcdefghijk", title: "New Song", artist: "Artist B" };
    const first = service.remember(track);
    const second = service.remember(track);
    await vi.waitFor(() => expect(source.append).toHaveBeenCalledTimes(1));
    finishAppend();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    await expect(service.remember(track)).resolves.toBe(false);
    expect(source.append).toHaveBeenCalledTimes(1);
  });

  it("uses stale cache when a refresh fails", async () => {
    const clock = { value: 1_000 };
    const source = {
      load: vi.fn()
        .mockResolvedValueOnce([header, ["Artist", "Song", "dQw4w9WgXcQ"]])
        .mockRejectedValueOnce(new Error("temporary outage")),
      append: vi.fn()
    };
    const service = new CatalogService({ source, cacheTtlMs: 1_000, now: () => clock.value });
    await service.listSuggestions({ query: "", limit: 8 });
    clock.value += 1_001;

    await expect(service.listSuggestions({ query: "song", limit: 8 })).resolves.toMatchObject({
      suggestions: [{ videoId: "dQw4w9WgXcQ" }]
    });
  });

  it("stays available with no Google credentials", async () => {
    expect(createCatalogSourceFromEnv({ GOOGLE_SHEETS_ID: "sheet-only" })).toBeNull();
    const service = new CatalogService();
    await expect(service.listSuggestions({ query: "anything", limit: 8 })).resolves.toEqual({
      suggestions: []
    });
    await expect(service.remember({ videoId: "dQw4w9WgXcQ", title: "Song" })).resolves.toBe(false);
  });

  it("validates suggestion query and limit at the boundary", async () => {
    const service = new CatalogService();
    await expect(service.listSuggestions({ query: "x".repeat(121), limit: 8 }))
      .rejects.toMatchObject({ code: "invalid_catalog_query" });
    await expect(service.listSuggestions({ query: "song", limit: "all" }))
      .rejects.toMatchObject({ code: "invalid_catalog_limit" });
  });
});
