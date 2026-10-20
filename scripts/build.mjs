import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  external: ["effect", "effect/*", "@opencode/plugin", "@opencode/plugin/*"],
});
await mkdir("dist", { recursive: true });
await copyFile("src/inert-mcp.mjs", "dist/inert-mcp.mjs");
// Local-directory plugins resolve index.js, not package.json's exports target.
const manifest = JSON.parse(await readFile("package.json", "utf8"));
await writeFile("dist/package.json", JSON.stringify({
  name: manifest.name, version: manifest.version, type: "module",
  main: "./index.js", exports: "./index.js", peerDependencies: manifest.peerDependencies,
}, null, 2) + "\n");
