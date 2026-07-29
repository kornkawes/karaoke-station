import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("focus style contract", () => {
  it("gives lyric textarea the same visible focus ring as other controls", async () => {
    const css = await readFile(resolve(import.meta.dirname, "../../src/styles.css"), "utf8");
    expect(css).toContain("textarea:focus-visible");
    expect(css).toContain("outline:3px solid var(--focus)");
  });
});
