// Standalone ad-exchange Express service. Mounted by the platform proxy at
// `/ads-api/*` (see `.replit-artifact/artifact.toml`).
//
// Why a separate service?
//   1. Hot path isolation — high-volume ad serves and event posts don't
//      compete for an event-loop slot with the rest of the school API.
//   2. Independent deploy/scale — we can horizontally scale just this
//      service when ad volume grows.
//   3. Smaller blast radius — a buggy targeting tweak can't take down
//      attendance, wallet, or watch login.
//
// All routes are prefixed `/ads-api` (the platform path strip means we mount
// router at "/" inside the app and the proxy handles the prefix).
import express, { type Express } from "express";
import cors from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const app: Express = express();

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return { statusCode: res.statusCode };
      },
    },
  }),
);
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// The platform proxy forwards `/ads-api/*` to this service preserving the
// prefix, so we mount the router at /ads-api here.
app.use("/ads-api", router);

export default app;
