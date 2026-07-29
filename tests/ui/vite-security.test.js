import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("Vite development listener", () => {
  it("keeps the proxy development surface bound to loopback", async () => {
    const [packageJson, viteConfig] = await Promise.all([
      readFile(resolve(root, "package.json"), "utf8"),
      readFile(resolve(root, "vite.config.js"), "utf8")
    ]);
    expect(packageJson).toContain("vite --host 127.0.0.1");
    expect(packageJson).not.toContain("vite --host 0.0.0.0");
    expect(viteConfig).toContain('host: "127.0.0.1"');
  });
});
