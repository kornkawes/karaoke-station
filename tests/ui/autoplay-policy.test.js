import { describe, expect, it, vi } from "vitest";
import { handleAutoplayBlocked, youtubePlayerVars } from "../../src/App.jsx";

describe("YouTube autoplay policy handling", () => {
  it("adds autoplay intent and origin to the IFrame player configuration", () => {
    expect(youtubePlayerVars(true, "http://station.local")).toMatchObject({
      autoplay: 1,
      controls: 0,
      disablekb: 1,
      fs: 0,
      iv_load_policy: 3,
      origin: "http://station.local",
      rel: 0,
      playsinline: 1
    });
    expect(youtubePlayerVars(false, "http://station.local").autoplay).toBe(0);
  });

  it("reports a browser autoplay block to the UI callback", () => {
    const blocked = vi.fn();
    handleAutoplayBlocked(blocked);
    expect(blocked).toHaveBeenCalledOnce();
  });
});
