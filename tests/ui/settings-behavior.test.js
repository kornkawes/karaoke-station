import { describe, expect, it } from "vitest";
import { isEnabledSingleKeyShortcut, shouldConfirmPlayNow } from "../../src/App.jsx";

describe("settings-backed host interactions", () => {
  it("only requests Play Now confirmation when a track is active and setting is enabled", () => {
    expect(shouldConfirmPlayNow({ title: "เพลงเดิม" }, true)).toBe(true);
    expect(shouldConfirmPlayNow({ title: "เพลงเดิม" }, false)).toBe(false);
    expect(shouldConfirmPlayNow(null, true)).toBe(false);
  });

  it("disables slash, Q and L single-key actions while preserving explicit shortcut eligibility", () => {
    expect(isEnabledSingleKeyShortcut("/", false)).toBe(false);
    expect(isEnabledSingleKeyShortcut("Q", false)).toBe(false);
    expect(isEnabledSingleKeyShortcut("l", true)).toBe(true);
  });
});
