// kobeai's pnpm overrides strip every platform-specific native binary except
// Linux x64 (the Replit / CI target), so vite, esbuild and Tailwind can't run
// on a Windows build machine. This drops the matching win32-x64 packages into
// the pnpm virtual store next to each host package. It only touches
// node_modules — the lockfile and the overrides are left alone.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const NATIVES = [
  { host: "rollup", native: "@rollup/rollup-win32-x64-msvc" },
  { host: "esbuild", native: "@esbuild/win32-x64" },
  { host: "lightningcss", native: "lightningcss-win32-x64-msvc" },
  { host: "@tailwindcss/oxide", native: "@tailwindcss/oxide-win32-x64-msvc" },
];

// Use Windows' own bsdtar: Git for Windows' GNU tar reads "C:\..." as a remote host.
const TAR = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");

export function ensureNativeBinaries(root) {
  if (process.platform !== "win32" || process.arch !== "x64") return;

  const store = path.join(root, "node_modules", ".pnpm");
  if (!existsSync(store)) {
    throw new Error(`${store} not found — run "pnpm install" at the repo root first`);
  }
  const storeDirs = readdirSync(store);
  const tmp = mkdtempSync(path.join(os.tmpdir(), "k9-natives-"));
  try {
    for (const { host, native } of NATIVES) {
      const prefix = `${host.replace("/", "+")}@`;
      for (const dir of storeDirs.filter((d) => d.startsWith(prefix))) {
        const modules = path.join(store, dir, "node_modules");
        const hostManifest = path.join(modules, ...host.split("/"), "package.json");
        if (!existsSync(hostManifest)) continue;
        const target = path.join(modules, ...native.split("/"));
        if (existsSync(path.join(target, "package.json"))) continue;

        const { version } = JSON.parse(readFileSync(hostManifest, "utf8"));
        console.log(`[k9-build] adding ${native}@${version} next to ${dir}`);
        const packed = execFileSync("npm", ["pack", `${native}@${version}`, "--silent", "--pack-destination", tmp], {
          encoding: "utf8",
          shell: true,
        });
        const tarball = packed.trim().split(/\r?\n/).pop();
        mkdirSync(target, { recursive: true });
        execFileSync(TAR, ["-xzf", path.join(tmp, tarball), "-C", target, "--strip-components=1"]);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
