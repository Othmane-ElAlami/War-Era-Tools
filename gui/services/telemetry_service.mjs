/**
 * WarEra Tools - Battle Telemetry Service
 * 
 * Manages the background telemetry daemon, parses historical telemetry,
 * calculates availability metrics and time-of-day heatmaps,
 * and cleanly distinguishes Schema v1 from Schema v2 data.
 */

import os from "os";
import fs from "fs";
import { spawn } from "child_process";
import path from "path";
import { EventEmitter } from "events";
import {
  loadTelemetrySamplesSync,
  calculateObservedAvailability,
  getTelemetryFilePath,
  getExecutionsFilePath,
  getLockFilePath,
  getStatusFilePath,
} from "../../analyzer/battle_telemetry.mjs";
import {
  acquireRecorderLock,
  releaseRecorderLock,
  getRecorderStatus,
  updateRecorderStatus,
  installWindowsTask,
  uninstallWindowsTask,
  queryWindowsTask,
} from "../../analyzer/recorder_daemon.mjs";
import { REPO_ROOT, getCookiesPath, getTelemetryDir } from "./paths.mjs";
import { isPidAlive } from "../../daily_task.mjs";

class TelemetryService extends EventEmitter {
  constructor() {
    super();
    this.daemonChild = null;
  }

  /**
   * Get live recorder daemon status and health info
   */
  getDaemonStatus() {
    const status = getRecorderStatus();
    const taskInfo = queryWindowsTask();
    const lockFile = getLockFilePath();
    let lockHeld = false;
    let lockPid = null;

    if (fs.existsSync(lockFile)) {
      try {
        const raw = JSON.parse(fs.readFileSync(lockFile, "utf8"));
        lockPid = raw.pid;
        lockHeld = isPidAlive(lockPid);
      } catch {}
    }

    return {
      running: lockHeld || Boolean(status?.running),
      pid: lockPid || status?.pid || null,
      hostname: status?.hostname || os.hostname(),
      lastSample: status?.lastObservationTimestamp || null,
      sampleInterval: status?.samplingInterval || "5m",
      samplesCount: status?.samplesCount || 0,
      consecutiveFailures: status?.consecutiveFailures || 0,
      taskInstalled: Boolean(taskInfo.exists),
      taskName: "WarEraBattleTelemetry",
    };
  }

  /**
   * Start the background telemetry recorder daemon
   */
  startDaemon(interval = "5m") {
    const current = this.getDaemonStatus();
    if (current.running) {
      return { started: false, message: `Daemon already running (PID: ${current.pid})` };
    }

    const scriptPath = path.join(REPO_ROOT, "battle_telemetry.mjs");
    const args = [`--interval=${interval}`];

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      WARERA_COOKIE_FILE: getCookiesPath(),
      WARERA_TELEMETRY_DIR: getTelemetryDir(),
    };

    const nodeExec = process.execPath;

    this.daemonChild = spawn(nodeExec, [scriptPath, ...args], {
      cwd: REPO_ROOT,
      env,
      detached: true,
      stdio: "ignore",
    });

    this.daemonChild.unref();

    return {
      started: true,
      pid: this.daemonChild.pid,
      interval,
    };
  }

  /**
   * Stop the background telemetry recorder daemon
   */
  stopDaemon() {
    const status = this.getDaemonStatus();
    if (!status.running || !status.pid) {
      return { stopped: false, message: "Telemetry daemon is not running." };
    }

    try {
      process.kill(status.pid, "SIGTERM");
      setTimeout(() => {
        if (isPidAlive(status.pid)) {
          try { process.kill(status.pid, "SIGKILL"); } catch {}
        }
      }, 3000);

      releaseRecorderLock();
      updateRecorderStatus({ running: false, pid: null });
      return { stopped: true, pid: status.pid };
    } catch (err) {
      return { stopped: false, error: err.message };
    }
  }

  /**
   * Load and calculate comprehensive telemetry analytics.
   * STRICT SAFETY: Never fabricates fields for Schema v1 historical samples.
   */
  getAnalytics() {
    const allSamples = loadTelemetrySamplesSync({ onlyLive: true });
    const availability = calculateObservedAvailability(allSamples);

    let v1Count = 0;
    let v2Count = 0;

    const damageBonusDistribution = {}; // Schema v2 only
    const bountyDistribution = {};      // Schema v2 only
    const hourOfDayCounts = Array(24).fill(0);
    const hourOfDayQualifying = Array(24).fill(0);

    for (const sample of allSamples) {
      const dt = new Date(sample.timestamp);
      const hour = dt.getUTCHours();
      hourOfDayCounts[hour]++;

      if (sample.hasQualifyingBattle) {
        hourOfDayQualifying[hour]++;
      }

      if (sample.schemaVersion === 2 && Array.isArray(sample.activeBattles)) {
        v2Count++;
        for (const b of sample.activeBattles) {
          if (typeof b.damageBonusPercent === "number") {
            const bucket = `${Math.floor(b.damageBonusPercent / 10) * 10}%`;
            damageBonusDistribution[bucket] = (damageBonusDistribution[bucket] || 0) + 1;
          }
          if (typeof b.bountyRate === "number") {
            const bBucket = `${(Math.floor(b.bountyRate * 100) / 100).toFixed(2)} G`;
            bountyDistribution[bBucket] = (bountyDistribution[bBucket] || 0) + 1;
          }
        }
      } else {
        v1Count++;
      }
    }

    // 24h Time-of-day percentage array
    const timeOfDayAvailability = hourOfDayCounts.map((total, h) => {
      const qualifying = hourOfDayQualifying[h];
      const pct = total > 0 ? Math.round((qualifying / total) * 100) : 0;
      return {
        hour: h,
        hourLabel: `${String(h).padStart(2, "0")}:00`,
        totalScans: total,
        qualifyingScans: qualifying,
        percentage: pct,
      };
    });

    // Recent executions from executions.jsonl
    let executions = [];
    const execFile = getExecutionsFilePath();
    if (fs.existsSync(execFile)) {
      try {
        const lines = fs.readFileSync(execFile, "utf8").trim().split("\n").filter(Boolean);
        executions = lines.slice(-20).map((l) => JSON.parse(l)).reverse();
      } catch {}
    }

    return {
      totalSamples: allSamples.length,
      v1SamplesCount: v1Count,
      v2SamplesCount: v2Count,
      observedCoveragePercent: availability.observedCoveragePct ?? 0,
      confidence: availability.confidence || "LOW",
      knownBattleHours: availability.qualifyingDurationHours ?? 0,
      knownNonBattleHours: availability.lullDurationHours ?? 0,
      totalObservedHours: availability.actualObservedHours ?? 0,
      totalUnknownHours: availability.unknownDurationHours ?? 0,
      longestKnownLullFormatted: availability.longestLull || "None",
      timeOfDayAvailability,
      damageBonusDistribution, // Only v2 populated
      bountyDistribution,      // Only v2 populated
      recentExecutions: executions,
    };
  }

  /**
   * Install Windows Scheduled Task for Telemetry
   */
  installTask(interval = "5m") {
    return installWindowsTask({ interval });
  }

  /**
   * Uninstall Windows Scheduled Task for Telemetry
   */
  uninstallTask() {
    return uninstallWindowsTask();
  }
}

export const telemetryService = new TelemetryService();
