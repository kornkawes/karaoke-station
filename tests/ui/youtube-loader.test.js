// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { loadYouTubeIframeApi } from "../../src/lib/youtube.js";

describe("YouTube IFrame API loader", () => {
  it("adds a script without assigning the read-only dataset object and preserves a previous callback", async () => {
    const original = vi.fn();
    window.onYouTubeIframeAPIReady = original;
    const loading = loadYouTubeIframeApi(document, window);
    const script = document.querySelector("script[data-youtube-iframe]");
    expect(script?.src).toContain("youtube.com/iframe_api");
    expect(script?.dataset.youtubeIframe).toBe("true");
    window.YT = { Player: vi.fn() };
    window.onYouTubeIframeAPIReady();
    await expect(loading).resolves.toBe(window.YT);
    expect(original).toHaveBeenCalledOnce();
  });
});
