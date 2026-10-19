/**
 * WarEra Tools - Dashboard Service
 * 
 * Aggregates live account state, resources, telemetry health,
 * scheduled task status, and recent activity into a single read-only snapshot.
 * STRICT SAFETY INVARIANT: Never performs any mutations during refresh.
 */

import fs from "fs";
import path from "path";
import { fetchMe, fetchWithRetry, getCookieHeader } from "../../analyzer/api.mjs";
import { fetchLiveWalletGold } from "../../equipment_buyer.mjs";
import { fetchUserRecentTransactions } from "../../analyzer/buyer_evaluator.mjs";
import { getRecorderStatus, queryWindowsTask } from "../../analyzer/recorder_daemon.mjs";
import { queryDailyTask } from "../../daily_task.mjs";
import {
  getTelemetryFilePath,
  getExecutionsFilePath,
  getStatusFilePath,
  loadTelemetrySamplesSync,
} from "../../analyzer/battle_telemetry.mjs";
import { getSanitizedAuthStatus } from "./settings_service.mjs";
import { getLogsDir, getDataDir } from "./paths.mjs";
import { CDP_URL, USER_ID, resolveUserId } from "../../config.mjs";

/**
 * Check if the browser CDP endpoint is currently reachable
 */
export async function checkCdpReachable(url = CDP_URL) {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 1500);
    const res = await fetch(`${url}/json/version`, { signal: controller.signal });
    clearTimeout(timeout);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Read the last execution from executions.jsonl
 */
export function getLastBattleExecution() {
  const file = getExecutionsFilePath();
  if (!fs.existsSync(file)) return null;

  try {
    const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return last;
  } catch {
    return null;
  }
}

/**
 * Parse the last execution summary from daily_automator.log
 */
export function getLastDailyRunInfo() {
  const logDir = getLogsDir();
  const logFile = path.join(logDir, "daily_automator.log");
  if (!fs.existsSync(logFile)) return null;

  try {
    const stat = fs.statSync(logFile);
    const content = fs.readFileSync(logFile, "utf8");
    const lines = content.trim().split("\n");
    const lastLines = lines.slice(-40).join("\n");

    const finishedMatch = lastLines.match(/(?:Daily routine complete|COMPLETED|All requested tasks finished)/i);
    const errorMatch = lastLines.match(/(?:ERROR|CRITICAL|Failed to)/i);

    return {
      lastModified: stat.mtime.toISOString(),
      status: finishedMatch ? "COMPLETED" : (errorMatch ? "WARNING" : "RECORDED"),
      snippet: lines.slice(-3).map((l) => l.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "")).join(" | "),
    };
  } catch {
    return null;
  }
}

/**
 * Fetch country name safely
 */
export async function fetchCountryName() {
  const cookieHeader = getCookieHeader();
  if (!cookieHeader) return null;

  try {
    const res = await fetchWithRetry("https://api4.warera.io/trpc/country.getMyCountry?batch=1", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie: cookieHeader,
      },
      body: JSON.stringify({ "0": {} }),
    });

    if (res.ok) {
      const json = await res.json();
      return json[0]?.result?.data?.name || json[0]?.result?.data?.title || null;
    }
  } catch {}
  return null;
}

/**
 * Load complete read-only dashboard state.
 */
export async function getDashboardState() {
  const auth = getSanitizedAuthStatus();
  const cdpReachable = await checkCdpReachable();

  let liveUser = null;
  let liveGold = null;
  let countryName = null;
  let recentTransactions = [];
  let userError = null;

  if (auth.isValid) {
    try {
      const meResult = await fetchMe();
      liveUser = meResult.user || null;
    } catch (err) {
      userError = err.message;
    }

    try {
      liveGold = await fetchLiveWalletGold(liveUser?._id || resolveUserId());
    } catch {}

    try {
      countryName = await fetchCountryName();
    } catch {}

    try {
      if (liveUser?._id) {
        recentTransactions = await fetchUserRecentTransactions(liveUser._id, { limit: 10 });
      }
    } catch {}
  }

  // Parse resources from skills
  const skills = liveUser?.skills || {};
  const healthCurrent = skills.health?.currentBarValue ?? 0;
  const healthMax = skills.health?.total ?? skills.health?.value ?? 100;
  const hungerCurrent = skills.hunger?.currentBarValue ?? 0;
  const hungerMax = skills.hunger?.total ?? skills.hunger?.value ?? 4;
  const energyCurrent = skills.energy?.currentBarValue ?? 0;
  const energyMax = skills.energy?.total ?? skills.energy?.value ?? 120;
  const entCurrent = skills.entrepreneurship?.currentBarValue ?? 0;
  const entMax = skills.entrepreneurship?.total ?? skills.entrepreneurship?.value ?? 60;

  // Telemetry status
  const recorderStatus = getRecorderStatus();
  const lastSample = recorderStatus?.lastObservationTimestamp || null;
  let telemetrySamplesCount = 0;
  try {
    const samples = loadTelemetrySamplesSync({ onlyLive: true });
    telemetrySamplesCount = samples.length;
  } catch {}

  // Scheduled task status
  const dailyTask = queryDailyTask();
  const telemetryTask = queryWindowsTask();

  // Recent executions
  const lastBattle = getLastBattleExecution();
  const lastDaily = getLastDailyRunInfo();

  return {
    timestamp: new Date().toISOString(),
    account: {
      username: liveUser?.username || "Not connected",
      userId: liveUser?._id || auth.userId || null,
      level: liveUser?.leveling?.level || 0,
      country: countryName || liveUser?.country || "Unknown",
      countryId: liveUser?.country || null,
      militaryUnitId: liveUser?.mu || null,
      militaryUnitName: liveUser?.mu ? `MU #${liveUser.mu.substring(0, 6)}` : "None",
      gold: liveGold,
    },
    resources: {
      health: { current: Number(healthCurrent.toFixed(1)), max: healthMax },
      hunger: { current: Number(hungerCurrent.toFixed(1)), max: hungerMax },
      energy: { current: Number(energyCurrent.toFixed(1)), max: energyMax },
      entrepreneurship: { current: Number(entCurrent.toFixed(1)), max: entMax },
    },
    session: {
      ...auth,
      cdpReachable,
      browserConnected: cdpReachable,
    },
    telemetry: {
      running: Boolean(recorderStatus?.running),
      pid: recorderStatus?.pid || null,
      lastSample,
      samplesCollected: telemetrySamplesCount,
      interval: recorderStatus?.samplingInterval || "5m",
      schemaVersion: 2,
    },
    scheduler: {
      dailyTask: {
        supported: dailyTask.supported,
        exists: dailyTask.exists,
        name: "WarEraDailyAutomator",
      },
      telemetryTask: {
        supported: telemetryTask.supported,
        exists: telemetryTask.exists,
        name: "WarEraBattleTelemetry",
      },
    },
    activity: {
      lastDailyRun: lastDaily,
      lastBattleHit: lastBattle,
      recentTransactions: Array.isArray(recentTransactions) ? recentTransactions : [],
    },
    error: userError,
  };
}
