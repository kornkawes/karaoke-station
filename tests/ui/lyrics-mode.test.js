import { describe, expect, it } from "vitest";
import { resolveLyricsMode } from "../../src/App.jsx";

describe("lyrics mode realtime state handling", () => {
  it("keeps a mode chosen locally on non-settings realtime events", () => {
    expect(resolveLyricsMode("side", { defaultLyricsMode: "video" }, false)).toBe("side");
  });

  it("uses the configured default for initial and settings snapshots", () => {
    expect(resolveLyricsMode("side", { defaultLyricsMode: "fullscreen" }, true)).toBe("full");
  });
});
