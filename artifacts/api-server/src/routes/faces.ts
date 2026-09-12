import express, { Router, type Response } from "express";
import { requireAuth } from "../lib/auth";
import { FaceGalleryError, enrollStudentFace, faceCounts, removeStudentFaces } from "../lib/face-gallery";

// Student face enrollment for Teacher Lens lookup. Staff upload a clear photo
// per student (the lens can also enroll from a saved frame, see
// /v1/teacher-lens/enroll-face); the K9 worker matches lens frames against them.

const router = Router();
const staff = requireAuth(["teacher", "admin", "super_admin"]);

function sendGalleryError(res: Response, err: unknown): void {
  if (err instanceof FaceGalleryError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  throw err;
}

/** GET /v1/faces/enrolled — { faces: { [student_code]: photo count } } */
router.get("/v1/faces/enrolled", staff, async (_req, res) => {
  res.json({ faces: await faceCounts() });
});

/** POST /v1/faces/students/:studentCode — the body is a JPEG or PNG photo of the student. */
router.post(
  "/v1/faces/students/:studentCode",
  express.raw({ type: ["image/jpeg", "image/png", "application/octet-stream"], limit: "6mb" }),
  staff,
  async (req, res) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 512) {
      res.status(400).json({ error: "send a JPEG or PNG photo as the request body" });
      return;
    }
    try {
      const result = await enrollStudentFace(String(req.params.studentCode), req.body, {
        source: "dashboard",
        createdBy: req.auth?.user_id ?? null,
      });
      res.status(201).json(result);
    } catch (err) {
      sendGalleryError(res, err);
    }
  },
);

/** DELETE /v1/faces/students/:studentCode — forget every enrolled photo of the student. */
router.delete("/v1/faces/students/:studentCode", staff, async (req, res) => {
  res.json({ removed: await removeStudentFaces(String(req.params.studentCode)) });
});

export default router;
