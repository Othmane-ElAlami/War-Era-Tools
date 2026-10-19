/**
 * Central Path Abstraction & Runtime Storage for WarEra Tools
 * 
 * Provides consistent paths for:
 * - Development/CLI mode: uses repository root and repo/data
 * - Packaged Electron mode: uses %APPDATA%\WarEraTools
 * - Supports safe one-click migration from existing repository data
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const REPO_ROOT = path.resolve(__dirname, "..", "..");

let activeAppDir = null;

/**
 * Determine if running as a packaged Electron application.
 */
export function isPackaged() {
  if (process.env.WARERA_FORCE_PACKAGED === "1") return true;
  if (process.env.WARERA_FORCE_DEV === "1") return false;
  // Electron sets process.resourcesPath in packaged app
  if (process.versions && process.versions.electron) {
    if (process.defaultApp || /node_modules[\\/]electron[\\/]/.test(process.execPath)) {
      return false;
    }
    return true;
  }
  return false;
}

/**
 * Get the base directory for mutable data.
 */
export function getAppDir() {
  if (activeAppDir) return activeAppDir;
  if (process.env.WARERA_APP_DIR) return path.resolve(process.env.WARERA_APP_DIR);

  if (isPackaged()) {
    const baseAppData = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
    return path.join(baseAppData, "WarEraTools");
  }
  return REPO_ROOT;
}

/**
 * Override the active App directory (for testing and isolation)
 */
export function setAppDir(customDir) {
  activeAppDir = customDir ? path.resolve(customDir) : null;
}

/**
 * Reset App directory to default
 */
export function resetAppDir() {
  activeAppDir = null;
}

/**
 * Get the path to mutable data directory
 */
export function getDataDir() {
  if (process.env.WARERA_DATA_DIR) return path.resolve(process.env.WARERA_DATA_DIR);
  return path.join(getAppDir(), "data");
}

/**
 * Get the path to the battle availability telemetry directory
 */
export function getTelemetryDir() {
  if (process.env.WARERA_TELEMETRY_DIR) return path.resolve(process.env.WARERA_TELEMETRY_DIR);
  return path.join(getDataDir(), "battle_availability");
}

/**
 * Get the path to the cookies.json file
 */
export function getCookiesPath() {
  if (process.env.WARERA_COOKIE_FILE) return path.resolve(process.env.WARERA_COOKIE_FILE);
  if (isPackaged()) {
    return path.join(getAppDir(), "cookies.json");
  }
  return path.join(REPO_ROOT, "cookies.json");
}

/**
 * Get the path to application logs directory
 */
export function getLogsDir() {
  if (isPackaged()) {
    return path.join(getAppDir(), "logs");
  }
  return getDataDir();
}

/**
 * Get path to persistent settings.json
 */
export function getSettingsPath() {
  return path.join(getAppDir(), "settings.json");
}

/**
 * Ensure all necessary mutable directories exist.
 */
export function initRuntimePaths() {
  const dirs = [getAppDir(), getDataDir(), getTelemetryDir(), getLogsDir()];
  for (const d of dirs) {
    if (!fs.existsSync(d)) {
      try {
        fs.mkdirSync(d, { recursive: true });
      } catch (err) {
        console.error(`Failed to create directory ${d}:`, err);
      }
    }
  }

  // Set environment variables so underlying modules resolve to these directories
  process.env.WARERA_TELEMETRY_DIR = getTelemetryDir();
  process.env.WARERA_COOKIE_FILE = getCookiesPath();
  process.env.WARERA_DATA_DIR = getDataDir();
}

/**
 * Detect existing WarEra data in a given folder (or repo root)
 */
export function detectRepoData(sourceDir = REPO_ROOT) {
  const result = {
    hasCookies: false,
    hasTelemetry: false,
    hasExecutions: false,
    hasLogs: false,
    hasGameConfig: false,
    hasRankings: false,
    samplesCount: 0,
    sourceDir,
  };

  const cookies = path.join(sourceDir, "cookies.json");
  if (fs.existsSync(cookies)) result.hasCookies = true;

  const telemetry = path.join(sourceDir, "data", "battle_availability", "telemetry.jsonl");
  if (fs.existsSync(telemetry)) {
    result.hasTelemetry = true;
    try {
      const content = fs.readFileSync(telemetry, "utf8");
      result.samplesCount = content.split("\n").filter((l) => l.trim().length > 0).length;
    } catch {}
  }

  const executions = path.join(sourceDir, "data", "battle_availability", "executions.jsonl");
  if (fs.existsSync(executions)) result.hasExecutions = true;

  const dailyLog = path.join(sourceDir, "data", "daily_automator.log");
  if (fs.existsSync(dailyLog)) result.hasLogs = true;

  const gameConfig = path.join(sourceDir, "data", "game_config.json");
  if (fs.existsSync(gameConfig)) result.hasGameConfig = true;

  const rankings = path.join(sourceDir, "data", "rankings.json");
  if (fs.existsSync(rankings)) result.hasRankings = true;

  return result;
}

/**
 * Safely copy existing repo data into target AppData directory.
 * Never moves, deletes, or truncates original files.
 * Does not overwrite existing historical telemetry unless force is true.
 */
export function importRepoData(sourceDir = REPO_ROOT, targetAppDir = getAppDir(), options = {}) {
  const { overwriteTelemetry = false, overwriteCookies = false } = options;
  const targetDataDir = path.join(targetAppDir, "data");
  const targetTelemetryDir = path.join(targetDataDir, "battle_availability");
  const targetLogsDir = isPackaged() ? path.join(targetAppDir, "logs") : targetDataDir;

  if (!fs.existsSync(targetTelemetryDir)) fs.mkdirSync(targetTelemetryDir, { recursive: true });
  if (!fs.existsSync(targetLogsDir)) fs.mkdirSync(targetLogsDir, { recursive: true });

  const imported = {
    cookies: false,
    telemetry: false,
    executions: false,
    dailyLog: false,
    gameConfig: false,
    rankings: false,
  };

  // 1. Cookies
  const srcCookies = path.join(sourceDir, "cookies.json");
  const destCookies = path.join(targetAppDir, "cookies.json");
  if (fs.existsSync(srcCookies)) {
    if (!fs.existsSync(destCookies) || overwriteCookies) {
      fs.copyFileSync(srcCookies, destCookies);
      imported.cookies = true;
    }
  }

  // 2. Game Config & Rankings
  const srcGameConfig = path.join(sourceDir, "data", "game_config.json");
  const destGameConfig = path.join(targetDataDir, "game_config.json");
  if (fs.existsSync(srcGameConfig) && !fs.existsSync(destGameConfig)) {
    fs.copyFileSync(srcGameConfig, destGameConfig);
    imported.gameConfig = true;
  }

  const srcRankings = path.join(sourceDir, "data", "rankings.json");
  const destRankings = path.join(targetDataDir, "rankings.json");
  if (fs.existsSync(srcRankings) && !fs.existsSync(destRankings)) {
    fs.copyFileSync(srcRankings, destRankings);
    imported.rankings = true;
  }

  // 3. Telemetry
  const srcTelemetry = path.join(sourceDir, "data", "battle_availability", "telemetry.jsonl");
  const destTelemetry = path.join(targetTelemetryDir, "telemetry.jsonl");
  if (fs.existsSync(srcTelemetry)) {
    if (!fs.existsSync(destTelemetry) || overwriteTelemetry) {
      fs.copyFileSync(srcTelemetry, destTelemetry);
      imported.telemetry = true;
    }
  }

  // 4. Executions
  const srcExecutions = path.join(sourceDir, "data", "battle_availability", "executions.jsonl");
  const destExecutions = path.join(targetTelemetryDir, "executions.jsonl");
  if (fs.existsSync(srcExecutions) && !fs.existsSync(destExecutions)) {
    fs.copyFileSync(srcExecutions, destExecutions);
    imported.executions = true;
  }

  // 5. Daily Automator Log
  const srcLog = path.join(sourceDir, "data", "daily_automator.log");
  const destLog = path.join(targetLogsDir, "daily_automator.log");
  if (fs.existsSync(srcLog) && !fs.existsSync(destLog)) {
    fs.copyFileSync(srcLog, destLog);
    imported.dailyLog = true;
  }

  return imported;
}
