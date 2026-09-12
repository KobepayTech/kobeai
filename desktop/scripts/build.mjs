// Builds the K9 School Server Windows installer.
//
//   node desktop/scripts/build.mjs              full build → desktop/release/K9-Setup-<version>.exe
//   node desktop/scripts/build.mjs --dir        unpacked app only → desktop/release/win-unpacked
//   node desktop/scripts/build.mjs --pack-only  reuse desktop/build (web + server), just package
//   node desktop/scripts/build.mjs --no-package build web + server into desktop/build and stop
//   --skip-web                                  keep the dashboards already in desktop/build/web
//   --ollama <folder>                           bundle an Ollama runtime folder containing ollama.exe
//
// Prerequisites: `pnpm install` at the repo root and `npm ci` in desktop/.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire, isBuiltin } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureNativeBinaries } from "./ensure-native-binaries.mjs";
import { writeIcons } from "./make-icon.mjs";

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(DESKTOP, "..");
const BUILD = path.join(DESKTOP, "build");
const BUILD_RESOURCES = path.join(DESKTOP, "build-resources");

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);
const optionValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const WEB_SURFACES = [
  { artifact: "teacher-dashboard", dir: "teacher" },
  { artifact: "parent-app", dir: "parent" },
  { artifact: "classroom-tv", dir: "tv" },
  { artifact: "teacher-lens", dir: "lens" },
];

function step(message) {
  console.log(`\n[k9-build] ${message}`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    ...options,
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    throw new Error(`${path.basename(command)} ${commandArgs.join(" ")} failed (${result.error ?? `exit ${result.status}`})`);
  }
}

function buildWeb() {
  for (const { artifact, dir } of WEB_SURFACES) {
    step(`building ${artifact} for /${dir}/`);
    const cwd = path.join(ROOT, "artifacts", artifact);
    const vite = path.join(cwd, "node_modules", "vite", "bin", "vite.js");
    run(process.execPath, [vite, "build", "--config", "vite.config.ts"], { cwd, env: { BASE_PATH: `/${dir}/` } });
    const out = path.join(BUILD, "web", dir);
    rmSync(out, { recursive: true, force: true });
    cpSync(path.join(cwd, "dist", "public"), out, { recursive: true });
  }
}

async function buildServer() {
  step("bundling the api-server");
  const apiServer = path.join(ROOT, "artifacts", "api-server");
  run(process.execPath, ["build.mjs"], { cwd: apiServer });
  const apiOut = path.join(BUILD, "server", "api");
  rmSync(apiOut, { recursive: true, force: true });
  cpSync(path.join(apiServer, "dist"), apiOut, { recursive: true, filter: (src) => !src.endsWith(".map") });

  step("bundling the schema migrator");
  const esbuild = createRequire(path.join(apiServer, "package.json"))("esbuild");
  // Bundling drizzle-kit's ESM api.mjs breaks its module init order at runtime
  // ("SingleStoreDialect is not a constructor"), so use its prebuilt CommonJS api.js.
  const drizzleKitApiCjs = createRequire(path.join(ROOT, "lib", "db", "package.json")).resolve("drizzle-kit/api");
  await esbuild.build({
    plugins: [
      {
        name: "drizzle-kit-cjs",
        setup(build) {
          build.onResolve({ filter: /^drizzle-kit\/api$/ }, () => ({ path: drizzleKitApiCjs }));
        },
      },
    ],
    entryPoints: [path.join(DESKTOP, "server", "migrate.mjs")],
    outfile: path.join(BUILD, "server", "migrate.cjs"),
    bundle: true,
    platform: "node",
    // CommonJS keeps drizzle-kit's optional driver imports as lazy require()
    // calls that never run for node-postgres; ESM would hoist them to load time.
    format: "cjs",
    target: "node22",
    // drizzle-kit calls createRequire(import.meta.url), which is undefined in CommonJS.
    define: { "import.meta.url": "__k9ImportMetaUrl" },
    banner: { js: 'const __k9ImportMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
    nodePaths: [path.join(ROOT, "lib", "db", "node_modules"), path.join(apiServer, "node_modules")],
    external: [
      "pg-native",
      "@electric-sql/pglite",
      "postgres",
      "@vercel/postgres",
      "@neondatabase/serverless",
      "mysql2",
      "mysql2/*",
      "@planetscale/database",
      "@libsql/client",
      "better-sqlite3",
      "@aws-sdk/*",
      "bun:sqlite",
      "gel",
      "ws",
    ],
    logLevel: "warning",
  });
}

// Packages the server bundles may leave unresolved. Each is loaded lazily, and
// only for a feature or database driver the K9 desktop app never uses.
const LAZY_OPTIONAL_PACKAGES = new Set([
  "@google-cloud/storage", // GCS object storage; the desktop app uses OBJECT_STORAGE_DIR
  "pg-native",
  "supports-color",
  "pnpapi",
  "@aws-sdk/client-rds-data",
  "@electric-sql/pglite",
  "@libsql/client",
  "@neondatabase/serverless",
  "@planetscale/database",
  "@vercel/postgres",
  "better-sqlite3",
  "mysql2",
  "mysql2/promise",
  "postgres",
]);

// The installed app has no node_modules next to the server, so anything the
// bundles still require at runtime would crash K9 on launch. Fail the build instead.
function verifyServerBundle() {
  step("checking the server bundles are self-contained");
  const serverDir = path.join(BUILD, "server");
  const files = [
    ...readdirSync(path.join(serverDir, "api"))
      .filter((file) => file.endsWith(".mjs"))
      .map((file) => path.join(serverDir, "api", file)),
    path.join(serverDir, "migrate.cjs"),
  ];
  const patterns = [
    /(?:^|[^\w$.])(?:__require|require)\(\s*"([^"./\s][^"\s]*)"\s*\)/g,
    /(?:^|[^\w$.])import\(\s*"([^"./\s][^"\s]*)"\s*\)/g,
    /^import\s[^;]*?\sfrom\s*"([^"./\s][^"\s]*)";?/gm,
    /^import\s*"([^"./\s][^"\s]*)";/gm,
  ];
  const unresolved = new Set();
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        const specifier = match[1];
        if (isBuiltin(specifier) || LAZY_OPTIONAL_PACKAGES.has(specifier)) continue;
        unresolved.add(`${specifier}  (${path.basename(file)})`);
      }
    }
  }
  if (unresolved.size > 0) {
    throw new Error(
      `The packaged server would need node_modules for:\n  ${[...unresolved].join("\n  ")}\n` +
      "Bundle these packages, or add them to LAZY_OPTIONAL_PACKAGES if they are only loaded optionally.",
    );
  }
}

// The server resolves every model location from the K9 registry, so ship it,
// plus the registry CLI (Node built-ins only) the app runs to connect Ollama.
function prepareModelRegistry() {
  const out = path.join(BUILD, "config");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(path.join(ROOT, "config", "k9-models.json"), path.join(out, "k9-models.json"));
  cpSync(path.join(ROOT, "scripts", "k9-models.mjs"), path.join(BUILD, "server", "k9-models.mjs"));
  cpSync(path.join(ROOT, "scripts", "k9-worker.mjs"), path.join(BUILD, "server", "k9-worker.mjs"));
}

// The Python model runtime ships as source; the Python named in the registry runs it.
function prepareRuntime() {
  const out = path.join(BUILD, "runtime");
  rmSync(out, { recursive: true, force: true });
  cpSync(path.join(ROOT, "services", "k9-runtime"), out, {
    recursive: true,
    filter: (src) => !/[\\/](tests|__pycache__)([\\/]|$)/.test(path.relative(ROOT, src)),
  });
}

function preparePostgres() {
  step("preparing embedded PostgreSQL");
  const native = path.join(DESKTOP, "node_modules", "@embedded-postgres", "windows-x64", "native");
  if (!existsSync(path.join(native, "bin", "postgres.exe"))) {
    throw new Error('@embedded-postgres/windows-x64 is not installed — run "npm ci" in desktop/ first');
  }
  const out = path.join(BUILD, "postgres");
  rmSync(out, { recursive: true, force: true });
  cpSync(native, out, { recursive: true });
}

function prepareOllama() {
  const out = path.join(BUILD, "ollama");
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const source = optionValue("--ollama");
  if (!source) {
    writeFileSync(
      path.join(out, "README.txt"),
      "No Ollama runtime is bundled in this build. K9 uses the Ollama server at http://127.0.0.1:11434 when one is running.\n",
    );
    return;
  }
  step(`bundling the Ollama runtime from ${source}`);
  if (!existsSync(path.join(source, "ollama.exe"))) throw new Error(`${source} does not contain ollama.exe`);
  cpSync(source, out, { recursive: true });
}

async function ensureVcRedist() {
  const target = path.join(BUILD_RESOURCES, "vc_redist.x64.exe");
  if (existsSync(target)) return;
  step("downloading the Visual C++ 2015-2022 x64 Redistributable from Microsoft");
  const res = await fetch("https://aka.ms/vs/17/release/vc_redist.x64.exe");
  if (!res.ok) throw new Error(`vc_redist download failed: HTTP ${res.status}`);
  writeFileSync(target, Buffer.from(await res.arrayBuffer()));
}

// electron-builder's winCodeSign archive (rcedit stamps the K9 icon and version
// into K9.exe) contains macOS symlinks, and extracting those fails on Windows
// without Developer Mode. Pre-extract it into electron-builder's cache without
// the darwin folder so packaging never needs symlink privileges.
async function ensureWinCodeSign() {
  const version = "winCodeSign-2.6.0";
  const cacheDir = path.join(process.env.LOCALAPPDATA ?? "", "electron-builder", "Cache", "winCodeSign");
  const target = path.join(cacheDir, version);
  if (existsSync(path.join(target, "rcedit-x64.exe"))) return;
  step(`preparing electron-builder ${version} (without macOS symlinks)`);
  const res = await fetch(`https://github.com/electron-userland/electron-builder-binaries/releases/download/${version}/${version}.7z`);
  if (!res.ok) throw new Error(`${version} download failed: HTTP ${res.status}`);
  mkdirSync(cacheDir, { recursive: true });
  const archive = path.join(cacheDir, `${version}.7z`);
  writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
  rmSync(target, { recursive: true, force: true });
  const sevenZip = path.join(DESKTOP, "node_modules", "7zip-bin", "win", "x64", "7za.exe");
  run(sevenZip, ["x", "-bd", "-y", `-o${target}`, "-xr!darwin", archive]);
  rmSync(archive, { force: true });
}

function packageApp() {
  step("packaging with electron-builder");
  const cli = path.join(DESKTOP, "node_modules", "electron-builder", "cli.js");
  run(process.execPath, [cli, "--win", "--x64", "--publish", "never", ...(hasFlag("--dir") ? ["--dir"] : [])], { cwd: DESKTOP });
}

async function main() {
  if (process.platform !== "win32") {
    throw new Error("The K9 installer targets Windows (NSIS) — run this build on Windows.");
  }
  if (!hasFlag("--pack-only")) {
    ensureNativeBinaries(ROOT);
    if (!hasFlag("--skip-web")) buildWeb();
    await buildServer();
  }
  verifyServerBundle();
  if (hasFlag("--no-package")) {
    step("web + server built in desktop/build (--no-package)");
    return;
  }
  prepareModelRegistry();
  prepareRuntime();
  preparePostgres();
  prepareOllama();
  await ensureVcRedist();
  if (!existsSync(path.join(BUILD_RESOURCES, "icon.ico"))) writeIcons();
  await ensureWinCodeSign();
  packageApp();
  step(hasFlag("--dir") ? "done — desktop/release/win-unpacked" : "done — installer in desktop/release");
}

main().catch((err) => {
  console.error(`\n[k9-build] ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
