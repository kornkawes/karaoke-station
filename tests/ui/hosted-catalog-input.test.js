import { describe, expect, it } from "vitest";
import { isDirectYouTubeInput } from "../../src/design-preview/model.js";
import { normalizeCatalogSuggestions } from "../../src/design-preview/DesignPreviewApp.jsx";

describe("design-preview catalog autocomplete input", () => {
  it("keeps direct YouTube URLs and video IDs out of the catalog suggestion flow", () => {
    expect(isDirectYouTubeInput("https://youtu.be/dQw4w9WgXcQ")).toBe(true);
    expect(isDirectYouTubeInput("dQw4w9WgXcQ")).toBe(true);
    expect(isDirectYouTubeInput("สายลมที่หวังดี")).toBe(false);
  });

  it("keeps the catalog artist, title, and video ID for a selectable row", () => {
    expect(normalizeCatalogSuggestions({
      suggestions: [{
        artist: "Palmy",
        title: "คิดมาก",
        videoId: "dQw4w9WgXcQ",
        youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
      }]
    })).toMatchObject([{
      artist: "Palmy",
      title: "คิดมาก",
      videoId: "dQw4w9WgXcQ"
    }]);
  });
});
