import { timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { Router } from "express";
import { pool } from "@workspace/db";
import { verifyToken } from "../lib/auth";

const router = Router();
let tablesReady: Promise<void> | null = null;

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function bearer(req: Request): string | null {
  const header = req.header("authorization") ?? req.header("Authorization");
  if (!header || !header.toLowerCase().startsWith("bearer ")) return null;
  return header.slice(7).trim() || null;
}

function requireK9OrStaff(req: Request, res: Response, next: NextFunction): void {
  const configured = process.env["K9_SHARED_SECRET"]?.trim() ?? "";
  const supplied = req.header("x-k9-secret")?.trim() ?? "";
  if (configured && supplied && safeEqual(configured, supplied)) {
    next();
    return;
  }

  const token = bearer(req);
  const principal = token ? verifyToken(token) : null;
  if (principal && ["teacher", "admin", "super_admin"].includes(principal.role)) {
    req.auth = principal;
    next();
    return;
  }

  res.status(401).json({ error: "network_discovery_auth_required" });
}

function requireStaff(req: Request, res: Response, next: NextFunction): void {
  const token = bearer(req);
  const principal = token ? verifyToken(token) : null;
  if (!principal) {
    res.status(401).json({ error: "staff_auth_required" });
    return;
  }
  if (!["teacher", "admin", "super_admin"].includes(principal.role)) {
    res.status(403).json({ error: "staff_role_required" });
    return;
  }
  req.auth = principal;
  next();
}

function text(value: unknown, max = 240): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v && v.length <= max ? v : null;
}

function jsonObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function jsonArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function deviceKey(device: Record<string, unknown>): string | null {
  const mac = text(device.mac, 64)?.toLowerCase();
  if (mac && mac !== "00:00:00:00:00:00") return `mac:${mac}`;
  const ip = text(device.ip, 64);
  return ip ? `ip:${ip}` : null;
}

function ensureTables(): Promise<void> {
  if (!tablesReady) {
    tablesReady = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS network_discovery_scans (
          id BIGSERIAL PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'k9',
          cidr TEXT,
          gateway TEXT,
          interface_name TEXT,
          devices_seen INTEGER NOT NULL DEFAULT 0,
          scanned_addresses INTEGER,
          elapsed_seconds NUMERIC(10,3),
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      await pool.query(`
        CREATE TABLE IF NOT EXISTS network_devices (
          device_key TEXT PRIMARY KEY,
          source TEXT NOT NULL DEFAULT 'k9',
          ip TEXT,
          mac TEXT,
          hostname TEXT,
          display_name TEXT,
          vendor TEXT,
          device_type TEXT,
          category TEXT,
          flags JSONB NOT NULL DEFAULT '[]'::jsonb,
          flag_reasons JSONB NOT NULL DEFAULT '[]'::jsonb,
          open_ports JSONB NOT NULL DEFAULT '{}'::jsonb,
          services JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_source TEXT,
          last_seen_source TEXT,
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          online BOOLEAN NOT NULL DEFAULT TRUE,
          is_new BOOLEAN NOT NULL DEFAULT FALSE,
          is_alert BOOLEAN NOT NULL DEFAULT FALSE,
          trusted BOOLEAN NOT NULL DEFAULT FALSE,
          ignored BOOLEAN NOT NULL DEFAULT FALSE,
          claimed_camera_id TEXT,
          claimed_at TIMESTAMPTZ,
          metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
          raw JSONB NOT NULL DEFAULT '{}'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await pool.query(`CREATE INDEX IF NOT EXISTS network_devices_category_idx ON network_devices(category)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS network_devices_online_idx ON network_devices(online)`);
    })();
  }
  return tablesReady;
}

router.use("/v1/network-discovery", requireK9OrStaff);

/**
 * Ingests one machine-readable K-9 scan. K-9 remains the LAN discovery/fingerprint
 * engine; KobeAI stores a normalized inventory so camera onboarding and health
 * can be shown in the school admin UI.
 */
router.post("/v1/network-discovery/k9/sync", async (req, res) => {
  await ensureTables();
  const meta = jsonObject(req.body?.meta);
  const devices = jsonArray(req.body?.devices).filter(
    (d): d is Record<string, unknown> => !!d && typeof d === "object" && !Array.isArray(d),
  );

  await pool.query(`UPDATE network_devices SET online = FALSE WHERE source = 'k9'`);

  let accepted = 0;
  for (const device of devices) {
    const key = deviceKey(device);
    if (!key) continue;
    const flags = jsonArray(device.flags).map(String);
    const isAlert = Boolean(device.is_alert) || flags.length > 0;
    await pool.query(
      `INSERT INTO network_devices (
         device_key, source, ip, mac, hostname, display_name, vendor, device_type,
         category, flags, flag_reasons, open_ports, services, first_seen_source,
         last_seen_source, online, is_new, is_alert, metadata, raw
       ) VALUES (
         $1, 'k9', $2, $3, $4, $5, $6, $7, $8,
         $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14,
         TRUE, $15, $16, $17::jsonb, $18::jsonb
       )
       ON CONFLICT (device_key)
       DO UPDATE SET
         ip = EXCLUDED.ip,
         mac = COALESCE(EXCLUDED.mac, network_devices.mac),
         hostname = COALESCE(EXCLUDED.hostname, network_devices.hostname),
         display_name = COALESCE(EXCLUDED.display_name, network_devices.display_name),
         vendor = COALESCE(EXCLUDED.vendor, network_devices.vendor),
         device_type = COALESCE(EXCLUDED.device_type, network_devices.device_type),
         category = COALESCE(EXCLUDED.category, network_devices.category),
         flags = EXCLUDED.flags,
         flag_reasons = EXCLUDED.flag_reasons,
         open_ports = EXCLUDED.open_ports,
         services = EXCLUDED.services,
         last_seen_source = EXCLUDED.last_seen_source,
         last_seen_at = NOW(),
         online = TRUE,
         is_new = EXCLUDED.is_new,
         is_alert = EXCLUDED.is_alert,
         metadata = network_devices.metadata || EXCLUDED.metadata,
         raw = EXCLUDED.raw,
         updated_at = NOW()`,
      [
        key,
        text(device.ip, 64),
        text(device.mac, 64),
        text(device.hostname, 240),
        text(device.display_name, 240),
        text(device.vendor, 240),
        text(device.device_type, 120),
        text(device.category, 80),
        JSON.stringify(flags),
        JSON.stringify(jsonArray(device.flag_reasons)),
        JSON.stringify(jsonObject(device.open_ports)),
        JSON.stringify(jsonObject(device.services)),
        text(device.first_seen, 100),
        text(device.last_seen, 100),
        Boolean(device.is_new),
        isAlert,
        JSON.stringify({ via: device.via ?? null, rtt_ms: device.rtt_ms ?? null }),
        JSON.stringify(device),
      ],
    );
    accepted += 1;
  }

  const scan = await pool.query(
    `INSERT INTO network_discovery_scans (
       source, cidr, gateway, interface_name, devices_seen, scanned_addresses,
       elapsed_seconds, metadata
     ) VALUES ('k9', $1, $2, $3, $4, $5, $6, $7::jsonb)
     RETURNING *`,
    [
      text(meta.cidr, 100),
      text(meta.gateway, 100),
      text(meta.iface, 120),
      accepted,
      Number.isFinite(Number(meta.scanned)) ? Number(meta.scanned) : null,
      Number.isFinite(Number(meta.elapsed)) ? Number(meta.elapsed) : null,
      JSON.stringify(meta),
    ],
  );

  res.status(201).json({ scan: scan.rows[0], accepted });
});

router.get("/v1/network-discovery/devices", requireStaff, async (req, res) => {
  await ensureTables();
  const cameraOnly = String(req.query["camera_only"] ?? "").toLowerCase() === "true";
  const onlineOnly = String(req.query["online_only"] ?? "").toLowerCase() === "true";
  const clauses: string[] = ["ignored = FALSE"];
  if (cameraOnly) clauses.push(`(category = 'camera' OR flags ?| ARRAY['CAMERA','CAMERA?','SURVEILLANCE'])`);
  if (onlineOnly) clauses.push("online = TRUE");
  const rows = await pool.query(
    `SELECT * FROM network_devices
     WHERE ${clauses.join(" AND ")}
     ORDER BY online DESC, is_alert DESC, category, display_name NULLS LAST, ip`,
  );
  res.json({ devices: rows.rows });
});

router.get("/v1/network-discovery/summary", requireStaff, async (_req, res) => {
  await ensureTables();
  const summary = await pool.query(`
    SELECT
      COUNT(*)::int AS known_devices,
      COUNT(*) FILTER (WHERE online)::int AS online,
      COUNT(*) FILTER (WHERE category = 'camera' OR flags ?| ARRAY['CAMERA','CAMERA?'])::int AS cameras,
      COUNT(*) FILTER (WHERE flags ? 'SURVEILLANCE')::int AS recorders,
      COUNT(*) FILTER (WHERE flags ? 'NEW')::int AS new_devices,
      COUNT(*) FILTER (WHERE is_alert)::int AS flagged,
      COUNT(*) FILTER (WHERE claimed_camera_id IS NOT NULL)::int AS claimed_cameras
    FROM network_devices
    WHERE ignored = FALSE
  `);
  const scan = await pool.query(`SELECT * FROM network_discovery_scans ORDER BY scanned_at DESC LIMIT 1`);
  res.json({ summary: summary.rows[0], last_scan: scan.rows[0] ?? null });
});

/**
 * Claims a K-9-discovered camera into the existing campus camera map. Stream
 * credentials remain outside the database; this binds logical identity/location.
 */
router.post("/v1/network-discovery/devices/:deviceKey/claim-camera", requireStaff, async (req, res) => {
  await ensureTables();
  const key = decodeURIComponent(req.params.deviceKey);
  const cameraId = text(req.body?.camera_id ?? req.body?.cameraId, 160);
  const zoneCode = text(req.body?.zone_code ?? req.body?.zoneCode, 100);
  const requestedName = text(req.body?.name, 160);
  if (!cameraId || !zoneCode) {
    res.status(400).json({ error: "camera_id and zone_code are required" });
    return;
  }

  const device = await pool.query(`SELECT * FROM network_devices WHERE device_key = $1 LIMIT 1`, [key]);
  const row = device.rows[0];
  if (!row) {
    res.status(404).json({ error: "network_device_not_found" });
    return;
  }
  const flags = Array.isArray(row.flags) ? row.flags : [];
  if (row.category !== "camera" && !flags.some((f: string) => ["CAMERA", "CAMERA?", "SURVEILLANCE"].includes(f))) {
    res.status(400).json({ error: "device_is_not_camera_or_recorder_candidate" });
    return;
  }

  const zone = await pool.query(`SELECT id FROM campus_zones WHERE code = $1 AND active = TRUE LIMIT 1`, [zoneCode]);
  if (!zone.rows[0]) {
    res.status(404).json({ error: "zone_not_found" });
    return;
  }
  const name = requestedName ?? row.display_name ?? row.hostname ?? `${row.vendor ?? "Camera"} ${row.ip ?? cameraId}`;

  const camera = await pool.query(
    `INSERT INTO campus_cameras (camera_id, name, zone_id, enabled, metadata)
     VALUES ($1, $2, $3, TRUE, $4::jsonb)
     ON CONFLICT (camera_id)
     DO UPDATE SET name = EXCLUDED.name, zone_id = EXCLUDED.zone_id,
                   enabled = TRUE, metadata = campus_cameras.metadata || EXCLUDED.metadata,
                   updated_at = NOW()
     RETURNING *`,
    [
      cameraId,
      name,
      zone.rows[0].id,
      JSON.stringify({
        discovered_by: "k9",
        network_device_key: key,
        ip: row.ip,
        mac: row.mac,
        vendor: row.vendor,
        open_ports: row.open_ports,
      }),
    ],
  );

  await pool.query(
    `UPDATE network_devices SET claimed_camera_id = $2, claimed_at = NOW(), updated_at = NOW() WHERE device_key = $1`,
    [key, cameraId],
  );

  res.status(201).json({
    camera: camera.rows[0],
    network_device: row,
    next_step: "Configure this device's RTSP/ONVIF stream credentials in the local KobeVision deployment secrets.",
  });
});

router.post("/v1/network-discovery/devices/:deviceKey/trust", requireStaff, async (req, res) => {
  await ensureTables();
  const key = decodeURIComponent(req.params.deviceKey);
  const trusted = req.body?.trusted !== false;
  const result = await pool.query(
    `UPDATE network_devices SET trusted = $2, updated_at = NOW() WHERE device_key = $1 RETURNING *`,
    [key, trusted],
  );
  if (!result.rows[0]) {
    res.status(404).json({ error: "network_device_not_found" });
    return;
  }
  res.json({ device: result.rows[0] });
});

export default router;
