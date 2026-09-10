import { describe, expect, it } from "vitest";
import { formatIdleCountdown } from "../../src/lib/idle-session.js";

describe("host idle countdown", () => {
  it("formats the remaining warning window from the server close time", () => {
    const now = Date.UTC(2026, 6, 29, 12, 0, 0);
    expect(formatIdleCountdown(new Date(now + 5 * 60_000 + 1_000).toISOString(), now)).toBe("05:01");
    expect(formatIdleCountdown(new Date(now - 1).toISOString(), now)).toBe("00:00");
  });

  it("fails closed for a malformed close time", () => {
    expect(formatIdleCountdown("not-a-date", Date.now())).toBe("--:--");
  });
});
