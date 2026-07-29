import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { googleLyricsUrl } from "../../src/App.jsx";

describe("lyrics Bento fallbacks", () => {
  it("builds an encoded Google lyrics fallback while retaining the LRCLIB lookup", async () => {
    expect(googleLyricsUrl({ title: "แสงสุดท้าย", channelTitle: "Bodyslam" })).toContain("q=%E0%B9%81%E0%B8%AA%E0%B8%87");
    expect(googleLyricsUrl({ title: "แสงสุดท้าย", channelTitle: "Bodyslam" })).toContain("lyrics");
    const source = await readFile(resolve("src/App.jsx"), "utf8");
    expect(source).toContain("karaokeApi.searchLyrics(track.title, track.channelTitle)");
    expect(source).toContain("target=\"_blank\"");
  });
});
