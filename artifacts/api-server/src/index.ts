import app from "./app";
import { logger } from "./lib/logger";
import { seedDemoData } from "./lib/seed";

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

app.listen(port, (err) => {
  if (err) {
    logger.error({ err }, "Error listening on port");
    process.exit(1);
  }

  logger.info({ port }, "Server listening");

  // Best-effort demo seed. Failures here shouldn't crash the server — they
  // just mean the print picker will show an empty file list until a teacher
  // uploads a real document.
  seedDemoData().catch((err) => logger.error({ err }, "demo seed failed"));
});
