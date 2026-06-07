import { Router } from "express";
import { pool } from "@workspace/db";
import { requireAuth } from "../lib/auth";

const router = Router();
const teacherAuth = requireAuth(["teacher", "admin", "super_admin"]);

type AttendanceStatus = "present" | "absent" | "late" | "excused";
type AttendanceSource = "ruview" | "manual" | "nfc" | "tablet";

let tablesReady: Promise<void> | null = null;
