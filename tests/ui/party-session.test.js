import { describe, expect, it } from "vitest";
import { isInvalidPartySessionError } from "../../src/App.jsx";

describe("party session invalidation", () => {
  it("invalidates a guest token when Socket.IO says the server disconnected it", () => {
    expect(isInvalidPartySessionError("io server disconnect")).toBe(true);
    expect(isInvalidPartySessionError("party_session_expired")).toBe(true);
  });

  it("retains the guest session during ordinary network transport disconnects", () => {
    expect(isInvalidPartySessionError("transport close")).toBe(false);
    expect(isInvalidPartySessionError("ping timeout")).toBe(false);
  });
});
