import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const projectDir = path.resolve(import.meta.dirname, "..");
const entryPath = path.join(projectDir, "server", "index.js");
const outputPath = path.resolve(process.argv[2] ?? path.join(projectDir, "packaging", ".stage-windows7", "app", "server", "index.cjs"));
const source = await readFile(entryPath, "utf8");
const runtimeMarker = "const runtime = await createApplication({";
const runtimeIndex = source.indexOf(runtimeMarker);

if (runtimeIndex < 0) {
  throw new Error(`Legacy bundle marker not found in ${entryPath}`);
}

const prelude = source
  .slice(0, runtimeIndex)
  .replace(
    "const serverDir = path.dirname(fileURLToPath(import.meta.url));",
    "const serverDir = __dirname;"
  );
const runtime = source.slice(runtimeIndex);
const wrappedSource = `${prelude}

(async () => {
${runtime}
})().catch((error) => {
  console.error("KaraokeStation startup failed:", error);
  process.exitCode = 1;
});
`;

await build({
  stdin: {
    contents: wrappedSource,
    loader: "js",
    resolveDir: path.dirname(entryPath),
    sourcefile: entryPath
  },
  outfile: outputPath,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node12.22",
  sourcemap: false,
  legalComments: "none",
  plugins: [{
    name: "node12-builtins",
    setup(buildContext) {
      buildContext.onResolve({ filter: /^node:fs\/promises$/ }, () => ({
        path: path.join(projectDir, "server", "lib", "fs-promises-compat.js")
      }));
      buildContext.onResolve({ filter: /^node:/ }, (args) => ({
        path: args.path.slice("node:".length),
        external: true
      }));
    }
  }]
});

console.log(`Built Node 12 server bundle: ${outputPath}`);
