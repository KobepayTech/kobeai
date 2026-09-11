import { Router } from "express";
import { randomUUID } from "node:crypto";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";

/**
 * K9 device registry.
 *
 * Every non-camera K9 client on the school LAN registers here and sends a
 * heartbeat, so the server console can show which classroom displays,
 * Teacher Lens phones/glasses and attendance kiosks are online. Cameras are
 * discovered and health-checked separately (services/k9-network).
 *
 * There is intentionally no per-student device type: K9 identifies students
 * through cameras and serves them through the shared classroom display.
 */
const router = Router();
const staffAuth = requireAuth(["teacher", "admin", "super_admin"]);

const DEVICE_TYPES = ["classroom_display", "teacher_lens", "attendance_kiosk"] as const;
// A device with no heartbeat inside this window is reported offline.
const ONLINE_WINDOW_MS = 2 * 60_000;

let tablesReady: Promise<void> | null = null;

function ensureDeviceTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = pool
      .query(`
        CREATE TABLE IF NOT EXISTS k9_devices (
          id BIGSERIAL PRIMARY KEY,
          device_id TEXT NOT NULL UNIQUE,
          device_type TEXT NOT NULL,
          display_name TEXT,
          room TEXT,
          assigned_class_id TEXT,
          registered_by INTEGER,
          registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ,
          app_version TEXT,
          status TEXT NOT NULL DEFAULT 'active',
          settings JSONB NOT NULL DEFAULT '{}'::jsonb
        )
      `)
      .then(() => undefined)
      .catch((err) => {
        // Let the next request retry instead of caching the failure forever.
        tablesReady = null;
        throw err;
      });
  }
  return tablesReady;
}

function optionalText(value: unknown, max = 200): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= max ? trimmed : null;
}

router.use("/v1/devices", staffAuth);

/**
 * POST /v1/devices/register
 * Body: { device_type, device_id?, display_name?, room?, assigned_class_id?,
 *         app_version?, settings? }
 * Idempotent on device_id — re-registering refreshes the row.
 */
router.post("/v1/devices/register", async (req, res) => {
  const deviceType = String(req.body?.device_type ?? "");
  if (!(DEVICE_TYPES as readonly string[]).includes(deviceType)) {
    res.status(400).json({ error: "invalid device_type", allowed: DEVICE_TYPES });
    return;
  }
  await ensureDeviceTables();

  const deviceId = optionalText(req.body?.device_id, 100) ?? randomUUID();
  const result = await pool.query(
    `INSERT INTO k9_devices (
       device_id, device_type, display_name, room, assigned_class_id,
       registered_by, last_seen_at, app_version, settings
     )
     VALUES ($1, $2, $3, $4, $5, $6, NOW(), $7, $8::jsonb)
     ON CONFLICT (device_id)
     DO UPDATE SET
       device_type = EXCLUDED.device_type,
       display_name = COALESCE(EXCLUDED.display_name, k9_devices.display_name),
       room = COALESCE(EXCLUDED.room, k9_devices.room),
       assigned_class_id = COALESCE(EXCLUDED.assigned_class_id, k9_devices.assigned_class_id),
       registered_by = EXCLUDED.registered_by,
       last_seen_at = NOW(),
       app_version = COALESCE(EXCLUDED.app_version, k9_devices.app_version),
       status = 'active',
       settings = k9_devices.settings || EXCLUDED.settings
     RETURNING *`,
    [
      deviceId,
      deviceType,
      optionalText(req.body?.display_name),
      optionalText(req.body?.room),
      optionalText(req.body?.assigned_class_id != null ? String(req.body.assigned_class_id) : null, 50),
      req.auth?.user_id ?? null,
      optionalText(req.body?.app_version, 50),
      JSON.stringify(req.body?.settings && typeof req.body.settings === "object" ? req.body.settings : {}),
    ],
  );

  res.status(201).json({ device: result.rows[0] });
});

/** POST /v1/devices/heartbeat — Body: { device_id, app_version? } */
router.post("/v1/devices/heartbeat", async (req, res) => {
  const deviceId = optionalText(req.body?.device_id, 100);
  if (!deviceId) {
    res.status(400).json({ error: "device_id is required" });
    return;
  }
  await ensureDeviceTables();

  const result = await pool.query(
    `UPDATE k9_devices
     SET last_seen_at = NOW(), app_version = COALESCE($2, app_version)
     WHERE device_id = $1 AND status = 'active'
     RETURNING *`,
    [deviceId, optionalText(req.body?.app_version, 50)],
  );
  if (!result.rows[0]) {
    res.status(404).json({ error: "device is not registered" });
    return;
  }

  res.json({ ok: true, server_time: new Date().toISOString(), device: result.rows[0] });
});

/** GET /v1/devices?type=classroom_display — registry view for the server console. */
router.get("/v1/devices", async (req, res) => {
  await ensureDeviceTables();
  const type = optionalText(req.query["type"], 50);

  const result = await pool.query(
    `SELECT * FROM k9_devices
     WHERE status = 'active' AND ($1::text IS NULL OR device_type = $1)
     ORDER BY device_type, display_name NULLS LAST, device_id`,
    [type],
  );
  const now = Date.now();
  res.json({
    online_window_seconds: ONLINE_WINDOW_MS / 1000,
    devices: result.rows.map((d) => ({
      ...d,
      online: d.last_seen_at != null && now - new Date(d.last_seen_at).getTime() < ONLINE_WINDOW_MS,
    })),
  });
});

export default router;
