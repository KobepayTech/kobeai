import express, { type Express, type Request, type Response, type NextFunction } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { seedK9DemoWorld } from "./seed-k9.js";
import { startSimulator } from "./simulate.js";

// ---------------------------------------------------------------------------
// The demo binary. Wraps the real api-server + all schedulers, adds the K9
// seed on top of seedDemoData, kicks the world simulator, and serves a
// landing page + every built dashboard from one Node process. Designed to
// run as either `pnpm --filter @workspace/demo run start` or as a Node SEA
// single-file exe (see scripts/build-exe.sh).
//
// api-server imports are dynamic so this package's own tsconfig doesn't
// need to reach into a foreign rootDir; esbuild resolves them at bundle
// time.
// ---------------------------------------------------------------------------

const START_AT = Date.now();
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const PORT = Number(process.env["PORT"] ?? 5555);
const HOST = process.env["HOST"] ?? "127.0.0.1";
const DEMO_PUBLIC = resolve(HERE, "..", "public");

type Mount = { path: string; artifact: string; description: string };
const MOUNTS: Mount[] = [
  { path: "/teacher", artifact: "teacher-dashboard", description: "Teacher / admin dashboard" },
  { path: "/parent", artifact: "parent-app", description: "Parent PWA" },
  { path: "/dev", artifact: "developer-portal", description: "Developer portal" },
  { path: "/tv", artifact: "classroom-tv", description: "Classroom TV kiosk" },
];

function artifactDist(artifact: string): string {
  return resolve(REPO_ROOT, "artifacts", artifact, "dist", "public");
}

function mountStatic(server: Express): void {
  for (const m of MOUNTS) {
    const dir = artifactDist(m.artifact);
    if (!existsSync(dir)) {
      console.warn(`[demo] ${m.path} → ${dir}  (not built — run pnpm build in ${m.artifact} first)`);
      server.get(m.path + "/*", (_req: Request, res: Response) => {
        res.status(503).send(
          `<h1>${m.description} not built</h1>` +
            `<p>Run <code>pnpm --filter @workspace/${m.artifact} run build</code> and refresh.</p>`,
        );
      });
      continue;
    }
    console.log(`[demo] ${m.path} → ${dir}`);
    server.use(m.path, express.static(dir, { fallthrough: true }));
    server.get(m.path + "/*", (_req: Request, res: Response, next: NextFunction) => {
      const index = join(dir, "index.html");
      if (existsSync(index)) res.sendFile(index);
      else next();
    });
  }
}

async function boot(): Promise<void> {
  console.log(`[demo] KobeAI school demo starting on http://${HOST}:${PORT}`);

  if (!process.env["DATABASE_URL"]) {
    console.error(
      "\n[demo] DATABASE_URL is not set. This demo needs Postgres.\n" +
        "        Fast path: run Postgres via docker,\n" +
        "          docker run --rm -e POSTGRES_PASSWORD=demo -p 5433:5432 postgres:16\n" +
        "        then set DATABASE_URL=postgres://postgres:demo@127.0.0.1:5433/postgres\n" +
        "        and re-run this demo.\n",
    );
    process.exit(2);
  }

  // Load the api-server bits dynamically so this package's own tsconfig
  // doesn't need to see into the api-server rootDir. esbuild will bundle
  // them into dist/kobeai-demo.mjs at build time.
  const [{ default: app }, seedMod, centralMod, presenceMod, profileMod, magazineMod, dbMod] = await Promise.all([
    import("../../api-server/src/app.js"),
    import("../../api-server/src/lib/seed.js"),
    import("../../api-server/src/lib/central-sync.js"),
    import("../../api-server/src/lib/presence-monitor.js"),
    import("../../api-server/src/lib/learning-profile.js"),
    import("../../api-server/src/lib/magazine.js"),
    import("@workspace/db"),
  ]);

  try {
    await seedMod.seedDemoData();
  } catch (err) {
    console.warn("[demo] seedDemoData failed:", err instanceof Error ? err.message : err);
  }
  try {
    await seedK9DemoWorld();
  } catch (err) {
    console.warn("[demo] seedK9DemoWorld failed:", err instanceof Error ? err.message : err);
  }

  centralMod.startCentralSync();
  presenceMod.startPresenceMonitor();
  profileMod.startLearningProfileScheduler();
  magazineMod.startMagazineScheduler();

  app.get("/demo/status", (_req: Request, res: Response) => {
    res.json({
      uptime_seconds: (Date.now() - START_AT) / 1000,
      pool_total_count: dbMod.pool.totalCount,
      pool_idle_count: dbMod.pool.idleCount,
      pool_waiting_count: dbMod.pool.waitingCount,
    });
  });

  app.get("/", (_req: Request, res: Response) => {
    const landing = join(DEMO_PUBLIC, "index.html");
    if (existsSync(landing)) res.sendFile(landing);
    else res.status(500).send("landing page missing");
  });

  mountStatic(app);
  startSimulator();

  app.listen(PORT, HOST, () => {
    console.log(`\n[demo] Ready.  Open http://${HOST}:${PORT}\n`);
    for (const m of MOUNTS) {
      console.log(`         · ${m.description.padEnd(28)} http://${HOST}:${PORT}${m.path}/`);
    }
    console.log("");
  });
}

boot().catch((err) => {
  console.error("[demo] fatal:", err);
  process.exit(1);
});
