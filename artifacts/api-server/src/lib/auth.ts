import jwt from "jsonwebtoken";
import type { Request, Response, NextFunction } from "express";

const NODE_ENV = process.env["NODE_ENV"] ?? "development";
const RAW_SECRET = process.env["JWT_SECRET"] ?? process.env["SESSION_SECRET"];
if (!RAW_SECRET && NODE_ENV !== "development" && NODE_ENV !== "test") {
  throw new Error("JWT_SECRET (or SESSION_SECRET) must be set in non-development environments");
}
const JWT_SECRET = RAW_SECRET ?? "dev-jwt-secret-do-not-use-in-prod";
const JWT_TTL = "12h";

export type Principal = {
  sub: string; // string user id
  role: "student" | "teacher" | "admin" | "parent";
  user_id: number;
  student_id?: string; // student_code, when role === student
  email?: string;
  name?: string;
};

export function signToken(p: Omit<Principal, "sub">): string {
  return jwt.sign({ ...p, sub: String(p.user_id) }, JWT_SECRET, { expiresIn: JWT_TTL });
}

export function verifyToken(token: string): Principal | null {
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as Principal;
    return decoded;
  } catch {
    return null;
  }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: Principal;
    }
  }
}

/**
 * Express middleware. If `roles` is non-empty, the principal's role must be in
 * the allow-list or the request is rejected with 403.
 */
export function requireAuth(roles?: Principal["role"][]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("authorization") ?? req.header("Authorization");
    if (!header || !header.toLowerCase().startsWith("bearer ")) {
      res.status(401).json({ error: "missing bearer token" });
      return;
    }
    const token = header.slice(7).trim();
    const principal = verifyToken(token);
    if (!principal) {
      res.status(401).json({ error: "invalid or expired token" });
      return;
    }
    if (roles && roles.length > 0 && !roles.includes(principal.role)) {
      res.status(403).json({ error: "forbidden for role" });
      return;
    }
    req.auth = principal;
    next();
  };
}
