import { describe, expect, it, vi } from "vitest";
import { normalizeSongQuery, SuggestionService } from "../../server/lib/suggestions.js";

describe("SuggestionService", () => {
  it("merges recent, queue, favorites and history locally without an upstream call", () => {
    const upstream = vi.fn();
    const service = new SuggestionService({
      getState: () => ({
        current: { title: "แสงสุดท้าย Karaoke" },
        queue: [{ title: "ฤดูที่ฉันเหงา [Instrumental]" }],
        favorites: [{ title: "โปรดส่งใครมารักฉันที - Karaoke" }],
        history: [{ title: "Yesterday | Backing Track" }]
      }),
      fetchImpl: upstream
    });
    service.remember("คิดถึงฉันไหมเวลาที่เธอ");

    expect(service.list({ query: "", limit: 8 }).suggestions).toEqual([
      { text: "คิดถึงฉันไหมเวลาที่เธอ", source: "recent" },
      { text: "ฤดูที่ฉันเหงา", source: "queue" },
      { text: "แสงสุดท้าย Karaoke", source: "queue" },
      { text: "โปรดส่งใครมารักฉันที", source: "favorite" },
      { text: "Yesterday", source: "history" }
    ]);
    expect(service.list({ query: "yes" }).suggestions).toEqual([
      { text: "Yesterday", source: "history" }
    ]);
    expect(upstream).not.toHaveBeenCalled();
  });

  it("deduplicates normalized recent queries and enforces caps", () => {
    const service = new SuggestionService({
      getState: () => ({ current: null, queue: [], favorites: [], history: [] }),
      maxRecent: 2
    });
    service.remember(" Song ");
    service.remember("song");
    service.remember("อีกเพลง");
    service.remember("เพลงสาม");

    expect(service.list({ limit: 20 }).suggestions).toEqual([
      { text: "เพลงสาม", source: "recent" },
      { text: "อีกเพลง", source: "recent" }
    ]);
  });
});

describe("normalizeSongQuery", () => {
  it.each([
    ["Song [Instrumental]", "Song"],
    ["Song - Karaoke", "Song"],
    ["เพลงไทย | คาราโอเกะ", "เพลงไทย"],
    [" Song   Name ", "Song Name"]
  ])("normalizes %s", (input, expected) => {
    expect(normalizeSongQuery(input)).toBe(expected);
  });
});
