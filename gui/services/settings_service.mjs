/**
 * WarEra Tools - Settings Service
 * 
 * Manages user configurations, persistent settings in AppData / data,
 * and security protections (masking secrets).
 */

import fs from "fs";
import path from "path";
import { getSettingsPath, getCookiesPath, getAppDir, getDataDir, isPackaged } from "./paths.mjs";
import { inspectJwt, getStoredSessionStatus } from "../../login.mjs";

const DEFAULT_SETTINGS = {
  dryRun: true,                    // Default: Dry Run active for maximum safety
  runInBackground: false,          // Keep background telemetry running on window close
  headless: true,                  // Headless mode for daily automator browser
  defaultBuyerStrategy: "best-value", // best-value, best-performance, cheapest
  defaultBuyerRarity: "green",
  defaultBuyerBudget: "",
  defaultBuyerSlippage: 0,
  defaultResellerPricing: "competitive",
  defaultResellerMaxListings: 1,
  defaultResellerMinConfidence: "LOW",
  battleHpFloor: 10,
  telemetryInterval: "5m",
  telemetryContext: "current",
  cdpUrl: "http://localhost:9222",
  browserPath: "",
};

/**
 * Mask sensitive token strings for display.
 * e.g. "eyJhbGciOi...1234abcd" -> "eyJhbGciOi...••••••••...abcd"
 */
export function maskSecret(secret) {
  if (!secret || typeof secret !== "string") return "None";
  if (secret.length <= 12) return "••••••••";
  const start = secret.substring(0, 8);
  const end = secret.substring(secret.length - 4);
  return `${start}••••••••${end}`;
}

/**
 * Load application settings from disk
 */
export function loadSettings() {
  const filePath = getSettingsPath();
  let current = { ...DEFAULT_SETTINGS };

  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw);
      current = { ...current, ...parsed };
    } catch (err) {
      console.error("Failed to parse settings.json, using defaults:", err);
    }
  }

  return current;
}

/**
 * Save application settings to disk
 */
export function saveSettings(newSettings) {
  const filePath = getSettingsPath();
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = loadSettings();
  const merged = { ...existing, ...newSettings };

  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), "utf8");
  return merged;
}

/**
 * Get sanitized session & authentication status for display in GUI
 */
export function getSanitizedAuthStatus() {
  const cookiesPath = getCookiesPath();
  const session = getStoredSessionStatus(cookiesPath);

  let maskedToken = "No Token Found";
  if (fs.existsSync(cookiesPath)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(cookiesPath, "utf8"));
      const jwtCookie = cookies.find((c) => c.name === "jwt");
      if (jwtCookie?.value) {
        maskedToken = maskSecret(jwtCookie.value);
      }
    } catch {}
  }

  return {
    cookiesPath,
    status: session.status,
    userId: session.userId || null,
    expiresAt: session.expiresAt ? session.expiresAt.toISOString() : null,
    expiresInMinutes: session.expiresInMinutes,
    expiredMinutesAgo: session.expiredMinutesAgo,
    totalCookies: session.totalCookies || 0,
    maskedToken,
    isValid: session.status === "VALID",
    message: session.message || (session.status === "VALID" ? "Active authenticated session" : "Authentication required"),
  };
}
