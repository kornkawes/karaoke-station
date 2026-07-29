import { describe, expect, it } from "vitest";
import { needsPlayNowAfterAdd, playbackIntentForMutation, playbackStateAfterAdd, playbackStateAfterCurrentUpdate } from "../../src/App.jsx";

describe("playback mutation state", () => {
  it("does not issue Play Now twice when the first added track already became current", () => {
    const item = { id: "queue-first" };
    expect(needsPlayNowAfterAdd({ item, position: 0, queue: { current: item } })).toBe(false);
    expect(needsPlayNowAfterAdd({ item, position: 1, queue: { current: { id: "other" } } })).toBe(true);
  });
  const current = { videoId: "dQw4w9WgXcQ", title: "เพลงถัดไป" };

  it("starts the current track for Play Now but not a normal queue add", () => {
    expect(playbackIntentForMutation(current, { playNow: true })).toBe(true);
    expect(playbackIntentForMutation(current, { playNow: false })).toBe(false);
  });

  it("starts a next track after advance and never plays when the queue is empty", () => {
    expect(playbackIntentForMutation(current, { advance: true })).toBe(true);
    expect(playbackIntentForMutation(null, { advance: true })).toBe(false);
  });

  it("preserves an actively playing iframe while a normal queue add completes", () => {
    expect(playbackStateAfterAdd(true, current, false)).toBe(true);
    expect(playbackStateAfterAdd(false, current, false)).toBe(false);
    expect(playbackStateAfterAdd(true, current, true)).toBe(true);
  });

  it("stops when current is removed but continues automatically on a failure with a next track", () => {
    expect(playbackStateAfterCurrentUpdate(true, null)).toBe(false);
    expect(playbackStateAfterCurrentUpdate(true, current)).toBe(true);
    expect(playbackStateAfterCurrentUpdate(false, current, { continuePlayback: true })).toBe(true);
  });
});
