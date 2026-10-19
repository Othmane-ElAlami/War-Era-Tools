import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ─── Base URLs & Endpoints ─── */
export const BASE = process.env.WARERA_BASE_URL || "https://app.warera.io";
export const API2_BASE = process.env.WARERA_API2_URL || "https://api2.warera.io/trpc";
export const API4_BASE = process.env.WARERA_API4_URL || "https://api4.warera.io/trpc";
export const API6_BASE = process.env.WARERA_API6_URL || "https://api6.warera.io/trpc";

/* ─── Browser & Connection ─── */
export const CDP_URL = process.env.WARERA_CDP_URL || "http://localhost:9222";
export const COOKIE_FILE = process.env.WARERA_COOKIE_FILE || path.join(__dirname, "cookies.json");

/* ─── Account & Military Unit Identity ─── */
// Optional explicit overrides via environment variables. If omitted, derived from active session.
export const USER_ID = process.env.WARERA_USER_ID || getStoredUserId() || "";
export const MU_ID = process.env.WARERA_MU_ID || "";

/* ─── Combat & Resource Limits ─── */
export const HP_MIN = Number(process.env.WARERA_HP_MIN) || 10; // Stop fighting below this HP
export const MAX_CYCLES = Number(process.env.WARERA_MAX_CYCLES) || 300; // Hard cap on fight iterations
export const EAT_RETRIES = Number(process.env.WARERA_EAT_RETRIES) || 3; // Attempts before giving up eating

/**
 * Inspect stored cookies to extract user ID from JWT payload if available
 */
export function getStoredUserId(cookieFilePath = null) {
  const filePath = cookieFilePath || process.env.WARERA_COOKIE_FILE || COOKIE_FILE;
  if (!fs.existsSync(filePath)) return "";
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies)) return "";
    const jwtCookie = cookies.find((c) => c.name === "jwt");
    if (!jwtCookie || !jwtCookie.value) return "";
    const parts = jwtCookie.value.split(".");
    if (parts.length < 2) return "";
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8"));
    return payload?.data?._id || payload?.userId || "";
  } catch {
    return "";
  }
}

/**
 * Resolve effective user ID across explicit parameter, environment, and stored session
 */
export function resolveUserId(explicitId = null) {
  if (explicitId && typeof explicitId === "string" && explicitId.trim()) {
    return explicitId.trim();
  }
  if (process.env.WARERA_USER_ID && process.env.WARERA_USER_ID.trim()) {
    return process.env.WARERA_USER_ID.trim();
  }
  return getStoredUserId();
}
