import express, { type Express } from "express";
import { existsSync } from "node:fs";
import path from "node:path";
import { logger } from "./logger";

// Built dashboards served by a self-hosted K9 server (see desktop/). Each
// directory under K9_WEB_ROOT is a vite build made with BASE_PATH=/<mount>/.
const SURFACES = [
  { mount: "/teacher", dir: "teacher" },
  { mount: "/parent", dir: "parent" },
  { mount: "/tv", dir: "tv" },
  { mount: "/lens", dir: "lens" },
] as const;

export function mountWebSurfaces(app: Express, webRoot: string): void {
  for (const surface of SURFACES) {
    const dir = path.join(webRoot, surface.dir);
    const index = path.join(dir, "index.html");
    if (!existsSync(index)) {
      logger.warn({ dir }, `web surface ${surface.mount} is not built — skipping`);
      continue;
    }
    app.use(surface.mount, express.static(dir));
    // Client-side routes (paths without a file extension) get the SPA shell.
    app.get(`${surface.mount}/{*splat}`, (req, res, next) => {
      if (path.extname(req.path) !== "") return next();
      res.sendFile(index);
    });
    logger.info({ dir }, `serving ${surface.mount}/`);
  }
  app.get("/", (_req, res) => res.redirect("/teacher/"));
}
