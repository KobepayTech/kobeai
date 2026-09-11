// Bundles the demo orchestrator + its api-server dependency graph into a
// single dist/kobeai-demo.mjs file with esbuild. The scripts/build-exe.sh
// step then wraps that bundle into a Node Single Executable Application
// (SEA) so it can be shipped as one file.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: [resolve(HERE, "src/index.ts")],
  outfile: resolve(HERE, "dist/kobeai-demo.mjs"),
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  banner: {
    // Node ESM doesn't inject __dirname / require for CJS interop by default;
    // some deps in the workspace expect them.
    js: `import { createRequire } from 'node:module'; import { fileURLToPath } from 'node:url'; import { dirname as __esm_dirname } from 'node:path'; const require = createRequire(import.meta.url); const __filename = fileURLToPath(import.meta.url); const __dirname = __esm_dirname(__filename);`,
  },
  external: [
    // pg brings a native binding; leave it as an external require rather
    // than bundling so Node loads the platform-appropriate one.
    "pg-native",
  ],
  logLevel: "info",
});

console.log("[demo] esbuild bundle written to dist/kobeai-demo.mjs");
