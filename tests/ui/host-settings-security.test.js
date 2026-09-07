import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("host settings secret UI", () => {
  it("uses a password-only input and clears the in-memory key after save", async () => {
    const source = await readFile(resolve("src/App.jsx"), "utf8");
    expect(source).toContain('type="password"');
    expect(source).toContain("await karaokeApi.saveYouTubeKey(key); setKey(\"\")");
    expect(source).toContain("await karaokeApi.saveYouTubeKey(\"\"); setKey(\"\")");
    expect(source).toContain("ลบ YouTube API key");
    expect(source).toContain("API key ไม่ถูกแสดงหรือเก็บในเบราว์เซอร์");
  });
});
