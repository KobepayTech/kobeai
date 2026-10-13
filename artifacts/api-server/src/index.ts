import app from "./app";
import { logger } from "./lib/logger";
import { seedDemoData } from "./lib/seed";
import { seedCentralDemo } from "./lib/seed-central";
import { seedStationeryDemo } from "./lib/seed-stationery";
import { seedMiniApps } from "./lib/seed-miniapps";
import { startCentralSync } from "./lib/central-sync";
import { startPresenceMonitor } from "./lib/presence-monitor";
import { startLearningProfileScheduler } from "./lib/learning-profile";
import { startMagazineScheduler } from "./lib/magazine";
import { startLessonPlanScheduler } from "./lib/student-development";
import { startMarketAgent } from "./lib/market-agent";
import { ensureSkillsSeeded } from "./lib/skill-engine";
import { startDailyDigest } from "./routes/parent-push";
import { bootstrapK9School } from "./lib/k9-bootstrap";
import { mountWebSurfaces } from "./lib/web-host";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

// The K9 desktop server (desktop/) must never ship the demo accounts, so it
// bootstraps a real school instead. K9_SEED_DEMO=1 opts back in for demos.
const desktopMode = process.env["K9_DESKTOP"] === "1";
const seedDemo = !desktopMode || process.env["K9_SEED_DEMO"] === "1";

const webRoot = process.env["K9_WEB_ROOT"];
if (webRoot) {
  mountWebSurfaces(app, webRoot);
}

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  if (desktopMode) {
    await bootstrapK9School(port).catch((err) =>
      logger.error({ err }, "K9 school bootstrap failed"),
    );
  }

  if (seedDemo) {
    // Best-effort demo seed. Failures here shouldn't crash the server — they
    // just mean the documents page will be empty until a teacher uploads a
    // real document.
    await seedDemoData().catch((err) => logger.error({ err }, "demo seed failed"));

    // Seed the multi-tenant control plane and grab a license key for the
    // "this school" demo tenant. In production each school would have its own
    // CENTRAL_BASE_URL + TENANT_LICENSE_KEY in its env file; for the demo we
    // auto-wire them so the local sync agent has something to talk to.
    try {
      const { thisTenantLicenseKey } = await seedCentralDemo();
      if (!process.env["CENTRAL_BASE_URL"]) {
        process.env["CENTRAL_BASE_URL"] = `http://127.0.0.1:${port}`;
      }
      if (!process.env["TENANT_LICENSE_KEY"] && thisTenantLicenseKey) {
        process.env["TENANT_LICENSE_KEY"] = thisTenantLicenseKey;
      }
    } catch (err) {
      logger.error({ err }, "central seed failed");
    }

    await seedStationeryDemo().catch((err) =>
      logger.error({ err }, "stationery seed failed"),
    );

    await seedMiniApps().catch((err) =>
      logger.error({ err }, "mini-apps seed failed"),
    );
  }

  startCentralSync();
  startDailyDigest();
  startPresenceMonitor();
  startLearningProfileScheduler();
  startMagazineScheduler();
  startLessonPlanScheduler();
  startMarketAgent();

  // Seed the skill taxonomy so the first paper a teacher marks already has
  // skills to map onto. Additive and idempotent; a failure here only means
  // the first ingest seeds it instead.
  await ensureSkillsSeeded().catch((err) =>
    logger.error({ err }, "skill taxonomy seed failed"),
  );
});
