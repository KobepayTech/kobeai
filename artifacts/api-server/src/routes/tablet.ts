import { Router } from "express";
import { randomUUID } from "crypto";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router = Router();
const staffAuth = requireAuth(["teacher", "admin", "super_admin"]);

let tablesReady: Promise<void> | null = null;

function ensureTabletTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS tablet_devices (
          id BIGSERIAL PRIMARY KEY,
          device_id TEXT NOT NULL UNIQUE,
          display_name TEXT,
          school_id TEXT,
          assigned_class_id TEXT,
          paired_by INTEGER,
          paired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ,
          app_version TEXT,
          platform TEXT NOT NULL DEFAULT 'android-tablet',
          status TEXT NOT NULL DEFAULT 'active',
          settings JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `);
    })();
  }
  return tablesReady;
}

router.use("/v1/tablet", staffAuth);

router.post("/v1/tablet/pair", async (req, res) => {
  await ensureTabletTables();

  const deviceId = String(req.body?.device_id ?? req.body?.deviceId ?? randomUUID()).trim();
  const result = await pool.query(
    `INSERT INTO tablet_devices (
       device_id, display_name, school_id, assigned_class_id,
       paired_by, last_seen_at, app_version, settings
     )
     VALUES ($1, $2, $3, $4, $5, NOW(), $6, $7::jsonb)
     ON CONFLICT (device_id)
     DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, tablet_devices.display_name),
       school_id = COALESCE(EXCLUDED.school_id, tablet_devices.school_id),
       assigned_class_id = COALESCE(EXCLUDED.assigned_class_id, tablet_devices.assigned_class_id),
       paired_by = EXCLUDED.paired_by,
       last_seen_at = NOW(),
       app_version = COALESCE(EXCLUDED.app_version, tablet_devices.app_version),
       status = 'active',
       settings = tablet_devices.settings || EXCLUDED.settings
     RETURNING *`,
    [
      deviceId,
      req.body?.display_name ?? req.body?.displayName ?? "KobeAI Attendance Tablet",
      req.body?.school_id ?? req.body?.schoolId ?? null,
      req.body?.assigned_class_id ?? req.body?.assignedClassId ?? null,
      req.auth?.user_id ?? null,
      req.body?.app_version ?? req.body?.appVersion ?? null,
      JSON.stringify(req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : {}),
    ],
  );

  res.status(201).json({
    device: result.rows[0],
    api: {
      attendance_session_start: "/api/v1/attendance/session/start",
      attendance_ruview_scan: "/api/v1/attendance/scan",
      attendance_manual_mark: "/api/v1/attendance/mark",
      attendance_today: "/api/v1/attendance/class/{classId}/today",
      sync: "/api/v1/tablet/sync",
    },
  });
});

router.post("/v1/tablet/heartbeat", async (req, res) => {
  await ensureTabletTables();
  const deviceId = String(req.body?.device_id ?? req.body?.deviceId ?? "").trim();
  if (!deviceId) {
    res.status(400).json({ error: "device_id is required" });
    return;
  }

  const result = await pool.query(
    `UPDATE tablet_devices
     SET last_seen_at = NOW(), app_version = COALESCE($2, app_version)
     WHERE device_id = $1
     RETURNING *`,
    [deviceId, req.body?.app_version ?? req.body?.appVersion ?? null],
  );

  if (!result.rows[0]) {
    res.status(404).json({ error: "tablet device is not paired" });
    return;
  }

  res.json({ ok: true, device: result.rows[0] });
});

router.post("/v1/tablet/sync", async (req, res) => {
  await ensureTabletTables();
  const deviceId = String(req.body?.device_id ?? req.body?.deviceId ?? "").trim();
  if (!deviceId) {
    res.status(400).json({ error: "device_id is required" });
    return;
  }

  const deviceResult = await pool.query(
    `UPDATE tablet_devices
     SET last_seen_at = NOW(), app_version = COALESCE($2, app_version)
     WHERE device_id = $1
     RETURNING *`,
    [deviceId, req.body?.app_version ?? req.body?.appVersion ?? null],
  );

  if (!deviceResult.rows[0]) {
    res.status(404).json({ error: "tablet device is not paired" });
    return;
  }

  const classId = req.body?.class_id ?? req.body?.classId ?? deviceResult.rows[0].assigned_class_id;
  res.json({
    ok: true,
    server_time: new Date().toISOString(),
    device: deviceResult.rows[0],
    tablet_mode: "attendance",
    ruview: {
      enabled: true,
      review_threshold: Number(process.env["RUVIEW_REVIEW_THRESHOLD"] ?? 0.8),
      engine_path: "external/RuView",
    },
    class_id: classId ?? null,
  });
});

export default router;
