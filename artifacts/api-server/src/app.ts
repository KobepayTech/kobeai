import express, { type Express } from "express";
import cors, { type CorsOptions } from "cors";
import pinoHttp from "pino-http";
import router from "./routes";
import { logger } from "./lib/logger";

const NODE_ENV = process.env["NODE_ENV"] ?? "development";

// Comma-separated origin allowlist. The watch app, tap-box, and any
// non-browser client never send an Origin header so they're unaffected.
// In development we allow any origin so local Vite dashboards work without
// extra config; in any other env an unset list means "no browser clients."
const rawAllowed = process.env["CORS_ALLOWED_ORIGINS"] ?? "";
const allowedOrigins = rawAllowed
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const corsOptions: CorsOptions = {
  origin(origin, cb) {
    // Same-origin / non-browser callers (no Origin header) are always allowed.
    if (!origin) return cb(null, true);
    if (NODE_ENV === "development" && allowedOrigins.length === 0) {
      return cb(null, true);
    }
    if (allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error(`origin not allowed: ${origin}`));
  },
  credentials: true,
  maxAge: 600,
};

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
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

export default app;
