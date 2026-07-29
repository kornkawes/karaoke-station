import { describe, expect, it } from "vitest";
import { isInstrumental, isKaraokeResult, karaokeBadge, partySearchMode } from "../../src/App.jsx";

describe("party redesign result policy", () => {
  it("requests the combined official search mode so users choose among all supported types", () => {
    expect(partySearchMode).toBe("both");
  });
  it("keeps only positively classified karaoke-style results and preserves their badge", () => {
    expect(isKaraokeResult({ classification: "karaoke", title: "เพลงทดสอบ" })).toBe(true);
    expect(isKaraokeResult({ classification: "instrumental", title: "เพลงทดสอบ" })).toBe(true);
    expect(isKaraokeResult({ classification: "backing_track", title: "เพลงทดสอบ" })).toBe(true);
    expect(isKaraokeResult({ classification: "music", title: "Official Music Video" })).toBe(false);
    expect(karaokeBadge({ classification: "backing_track" })).toBe("backing");
    expect(isInstrumental({ classification: "instrumental" })).toBe(true);
  });
});
