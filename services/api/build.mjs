// One self-contained file for the server: no node_modules to install on the box.
import { build } from "esbuild";

await build({
  entryPoints: ["src/main.ts"],
  outfile: "dist/server.mjs",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  // socket.io's ws can use these native speed-ups when present; it works without them.
  external: ["bufferutil", "utf-8-validate"],
  // Some bundled CommonJS code calls require(); give ESM output one.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: "warning",
});
console.log("built dist/server.mjs");
await build({
  entryPoints: ["src/sandbox/supervisor.ts"], outfile: "dist/supervisor.mjs",
  bundle: true, platform: "node", target: "node22", format: "esm", sourcemap: true,
  logLevel: "warning",
});
console.log("built dist/supervisor.mjs (separate privileged service; not deployed)");
