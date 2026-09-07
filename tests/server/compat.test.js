import { describe, expect, it } from "vitest";
import {
  cloneJson,
  createAbortController,
  legacyFetch,
  randomUuid,
  toBase64Url
} from "../../server/lib/compat.js";

describe("Node 12 compatibility helpers", () => {
  it("clones persisted JSON without sharing nested references", () => {
    const source = { settings: { stationName: "คาราโอเกะ" }, queue: [{ id: "one" }] };
    const clone = cloneJson(source);

    clone.settings.stationName = "changed";
    clone.queue[0].id = "two";

    expect(source).toEqual({
      settings: { stationName: "คาราโอเกะ" },
      queue: [{ id: "one" }]
    });
  });

  it("generates RFC 4122 version 4 identifiers", () => {
    expect(randomUuid()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
  });

  it("encodes tokens without base64 padding or URL-unsafe characters", () => {
    expect(toBase64Url(Buffer.from([251, 255, 254]))).toBe("-__-");
  });

  it("provides an abort signal when the runtime has no native controller", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "AbortController");
    Object.defineProperty(globalThis, "AbortController", {
      configurable: true,
      value: undefined
    });
    try {
      const controller = createAbortController();
      let calls = 0;
      controller.signal.addEventListener("abort", () => { calls += 1; });
      controller.abort();
      controller.abort();
      expect(controller.signal.aborted).toBe(true);
      expect(calls).toBe(1);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "AbortController", descriptor);
      else delete globalThis.AbortController;
    }
  });

  it("rejects non-HTTPS URLs in the legacy external-call fallback", async () => {
    await expect(legacyFetch("http://example.com")).rejects.toThrow(
      "Legacy fetch only allows HTTPS"
    );
  });
});
