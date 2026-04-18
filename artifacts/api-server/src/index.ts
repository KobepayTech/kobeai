import app from "./app";
import { logger } from "./lib/logger";
import { seedDemoData } from "./lib/seed";
import { seedCentralDemo } from "./lib/seed-central";
import { seedStationeryDemo } from "./lib/seed-stationery";
import { startCentralSync } from "./lib/central-sync";
import { startDailyDigest } from "./routes/parent-push";

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

app.listen(port, async (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Best-effort demo seed. Failures here shouldn't crash the server — they
  // just mean the print picker will show an empty file list until a teacher
  // uploads a real document.
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

  startCentralSync();
  startDailyDigest();
});
