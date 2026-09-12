import express, { Router, type IRouter } from "express";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isLocalObjectStorage, localUploadPath, verifyLocalUpload } from "../lib/objectStorage";

const router: IRouter = Router();

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * PUT /v1/local-objects/uploads/:id?exp=&sig=
 * Local-disk stand-in for a presigned object-storage upload URL, active when
 * OBJECT_STORAGE_DIR is set (K9 desktop / self-hosted). The URL is minted and
 * HMAC-signed by ObjectStorageService.getObjectEntityUploadURL(), so holding
 * the URL is the authorization — exactly like a presigned GCS URL.
 */
router.put(
  "/v1/local-objects/uploads/:id",
  express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }),
  async (req, res) => {
    if (!isLocalObjectStorage()) {
      res.status(404).json({ error: "local object storage is not enabled" });
      return;
    }
    const id = String(req.params.id);
    const exp = String(req.query["exp"] ?? "");
    const sig = String(req.query["sig"] ?? "");
    if (!verifyLocalUpload(id, exp, sig)) {
      res.status(403).json({ error: "invalid or expired upload url" });
      return;
    }
    if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
      res.status(400).json({ error: "empty upload" });
      return;
    }
    const file = localUploadPath(id);
    await mkdir(path.dirname(file), { recursive: true });
    try {
      // "wx" refuses to overwrite, so a leaked URL can't replace a stored file.
      await writeFile(file, req.body, { flag: "wx" });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        res.status(409).json({ error: "object already uploaded" });
        return;
      }
      throw err;
    }
    res.status(200).end();
  },
);

export default router;
