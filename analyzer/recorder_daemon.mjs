/**
 * WarEra Battle Telemetry Recorder Daemon Engine
 * 
 * Production infrastructure for long-term unattended operation:
 * 1. Single Instance Guarantee via telemetry.lock (PID check & stale lock recovery)
 * 2. Error resilience with bounded exponential backoff (5s -> 15s -> 30s -> 60s -> 5m)
 * 3. Heartbeat / health state maintenance via recorder_status.json
 * 4. Atomic file writes (temp file + atomic rename)
 * 5. Watchdog health check (--health) with strict exit codes:
 *    0 = healthy and recent sample
 *    1 = recorder offline
 *    2 = recorder running but samples stale (>15m)
 *    3 = persistent API failures
 * 6. Windows Task Scheduler service installation and removal
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import chalk from "chalk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_DATA_DIR = path.resolve(ROOT_DIR, "data/battle_availability");

export function getDaemonDataDir() {
  if (process.env.WARERA_TELEMETRY_DIR) return path.resolve(process.env.WARERA_TELEMETRY_DIR);
  return DEFAULT_DATA_DIR;
}

export const BACKOFF_SCHEDULE = [5000, 15000, 30000, 60000, 120000, 300000]; // 5s, 15s, 30s, 1m, 2m, 5m

export function getLockFilePath() {
  return path.join(getDaemonDataDir(), "telemetry.lock");
}

export function getStatusFilePath() {
  return path.join(getDaemonDataDir(), "recorder_status.json");
}

/**
 * Check if a process with the given PID is currently alive
 * 
 * On Windows/POSIX:
 * - process.kill(pid, 0) throws ESRCH if process does not exist
 * - throws EPERM if process exists but belongs to another user
 * - succeeds if process exists and is active
 */
export function isPidAlive(pid) {
  if (!pid || typeof pid !== "number" || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (err.code === "EPERM") return true;
    return false;
  }
}

/**
 * Atomically write a JSON or text file by writing to a temporary file
 * and renaming it, preventing corruptions if a process crashes mid-write.
 */
export function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  const content = typeof data === "string" ? data : JSON.stringify(data, null, 2);

  fs.writeFileSync(tmpPath, content, "utf8");

  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Windows file locking fallback
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
      fs.renameSync(tmpPath, filePath);
    } catch {
      fs.writeFileSync(filePath, content, "utf8");
      try { fs.unlinkSync(tmpPath); } catch {}
    }
  }
}

/**
 * Acquire single-instance lock for the telemetry recorder
 * 
 * @param {string} customLockFile - Optional custom lock path for testing
 * @returns {Object} { acquired: boolean, staleRecovered: boolean, lock: Object, reason: string }
 */
export function acquireRecorderLock(customLockFile = null) {
  const lockFile = customLockFile || getLockFilePath();
  const dir = path.dirname(lockFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(lockFile)) {
    try {
      const raw = fs.readFileSync(lockFile, "utf8");
      const existing = JSON.parse(raw);

      // Cross-host stale lock detection:
      // If the lock was created on a different hostname, the PID is meaningless
      // (an unrelated process could hold that PID on this host).
      const lockHostname = existing.hostname ? existing.hostname.toUpperCase() : null;
      const currentHostname = os.hostname().toUpperCase();
      const isCrossHost = lockHostname && lockHostname !== currentHostname;

      if (!isCrossHost && existing.pid && isPidAlive(existing.pid)) {
        if (existing.pid === process.pid) {
          return { acquired: true, staleRecovered: false, lock: existing };
        }
        return {
          acquired: false,
          reason: "ALIVE",
          lock: existing,
        };
      }

      // Stale lock detected: either cross-host or process PID is no longer alive
      const staleLock = existing;
      const newLock = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: os.hostname(),
      };
      atomicWriteJson(lockFile, newLock);
      return {
        acquired: true,
        staleRecovered: true,
        stalePid: staleLock.pid,
        crossHostRecovered: isCrossHost,
        staleHostname: staleLock.hostname || null,
        lock: newLock,
      };
    } catch {
      // Corrupt or unparseable lock file -> recover safely
      const newLock = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: os.hostname(),
      };
      atomicWriteJson(lockFile, newLock);
      return { acquired: true, staleRecovered: true, stalePid: null, lock: newLock };
    }
  }

  const newLock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
  };
  atomicWriteJson(lockFile, newLock);
  return { acquired: true, staleRecovered: false, lock: newLock };
}

/**
 * Release the single-instance recorder lock
 * 
 * @param {string|null} customLockFile
 * @param {boolean} force
 */
export function releaseRecorderLock(customLockFile = null, force = false) {
  const lockFile = customLockFile || getLockFilePath();
  if (!fs.existsSync(lockFile)) return true;
  try {
    const raw = fs.readFileSync(lockFile, "utf8");
    const existing = JSON.parse(raw);
    if (force || existing.pid === process.pid) {
      fs.unlinkSync(lockFile);
      return true;
    }
  } catch {
    try {
      fs.unlinkSync(lockFile);
      return true;
    } catch {}
  }
  return false;
}

/**
 * Read the current recorder heartbeat and status state
 * 
 * @param {string|null} customStatusFile
 */
export function getRecorderStatus(customStatusFile = null) {
  const statusFile = customStatusFile || getStatusFilePath();
  if (!fs.existsSync(statusFile)) {
    return {
      running: false,
      pid: null,
      startedAt: null,
      lastAttemptAt: null,
      lastSuccessfulSampleAt: null,
      nextSampleAt: null,
      consecutiveFailures: 0,
      lastError: null,
      samplingIntervalMs: 300000,
    };
  }

  try {
    const raw = fs.readFileSync(statusFile, "utf8");
    const status = JSON.parse(raw);

    // Verify actual process liveness
    if (status.running && status.pid && !isPidAlive(status.pid)) {
      status.running = false;
      status.crashed = true;
    }

    return status;
  } catch {
    return {
      running: false,
      pid: null,
      startedAt: null,
      lastAttemptAt: null,
      lastSuccessfulSampleAt: null,
      nextSampleAt: null,
      consecutiveFailures: 0,
      lastError: null,
      samplingIntervalMs: 300000,
    };
  }
}

/**
 * Atomically update the recorder heartbeat status
 * 
 * @param {Object} updates
 * @param {string|null} customStatusFile
 */
export function updateRecorderStatus(updates = {}, customStatusFile = null) {
  const statusFile = customStatusFile || getStatusFilePath();
  const current = getRecorderStatus(statusFile);
  const merged = { ...current, ...updates };
  atomicWriteJson(statusFile, merged);
  return merged;
}

/**
 * Calculate bounded exponential backoff delay based on consecutive failures
 * 
 * @param {number} consecutiveFailures
 * @returns {number} Backoff delay in milliseconds
 */
export function calculateBackoff(consecutiveFailures) {
  if (!consecutiveFailures || consecutiveFailures <= 0) return BACKOFF_SCHEDULE[0];
  const idx = Math.min(consecutiveFailures - 1, BACKOFF_SCHEDULE.length - 1);
  return BACKOFF_SCHEDULE[idx];
}

/**
 * Format relative elapsed time (e.g. "2m ago", "1h 15m ago", "3d 14h ago")
 */
export function formatRelativeTime(diffMs) {
  if (diffMs == null || isNaN(diffMs) || diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  if (hours < 24) {
    return remMinutes > 0 ? `${hours}h ${remMinutes}m ago` : `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0 ? `${days}d ${remHours}h ago` : `${days}d ago`;
}

/**
 * Format relative future time (e.g. "in 3m", "in 45s", "in 1h 10m")
 */
export function formatRelativeFuture(diffMs) {
  if (diffMs == null || isNaN(diffMs)) return "soon";
  if (diffMs <= 0) return "now";
  const seconds = Math.ceil(diffMs / 1000);
  if (seconds < 60) return `in ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  if (minutes < 60) {
    return remSeconds > 10 ? `in ${minutes}m ${remSeconds}s` : `in ${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `in ${hours}h ${remMinutes}m` : `in ${hours}h`;
}

/**
 * Evaluate recorder watchdog health status
 * 
 * Exit codes:
 *   0 = healthy and recent live sample
 *   1 = recorder offline (daemon not running or PID dead)
 *   2 = recorder running but samples stale (> 3x sampling interval)
 *   3 = persistent API failures (>= 3 consecutive failures or active error)
 * 
 * @param {Object} status - Result from getRecorderStatus()
 * @param {Array} liveSamples - Optional recent live samples
 * @param {Object} options - { staleThresholdMs }
 */
export function evaluateRecorderHealth(status, liveSamples = [], options = {}) {
  const intervalMs = status?.samplingIntervalMs || 300000;
  // Default stale threshold: 3x interval or at least 15m
  const staleThresholdMs = options.staleThresholdMs || Math.max(intervalMs * 3, 900000);

  // Check 1: Recorder offline (exit code 1)
  if (!status || !status.running || !status.pid || !isPidAlive(status.pid)) {
    return {
      code: 1,
      status: "OFFLINE",
      message: "Recorder daemon is offline.",
      details: status?.pid ? `PID ${status.pid} is not active.` : "No active recorder status found.",
    };
  }

  // Check 2: Persistent API failures (exit code 3)
  if (status.consecutiveFailures >= 3) {
    return {
      code: 3,
      status: "PERSISTENT_FAILURES",
      message: `Recorder experiencing persistent API failures (${status.consecutiveFailures} consecutive failures).`,
      details: `Last error: ${status.lastError || "Unknown API failure"}`,
    };
  }

  // Check 3: Samples stale (exit code 2)
  let lastSuccessMs = status.lastSuccessfulSampleAt
    ? new Date(status.lastSuccessfulSampleAt).getTime()
    : 0;

  if (!lastSuccessMs && liveSamples.length > 0) {
    lastSuccessMs = liveSamples[liveSamples.length - 1].timestampMs;
  }

  const elapsedMs = lastSuccessMs ? Date.now() - lastSuccessMs : Infinity;
  if (!lastSuccessMs || elapsedMs > staleThresholdMs) {
    const mins = Math.round(elapsedMs / 60000);
    return {
      code: 2,
      status: "STALE",
      message: `Recorder is running (PID ${status.pid}) but samples are stale (${mins}m since last sample).`,
      details: `Threshold is ${Math.round(staleThresholdMs / 60000)}m. Last sample: ${status.lastSuccessfulSampleAt || "None"}.`,
    };
  }

  // Check 4: Healthy (exit code 0)
  return {
    code: 0,
    status: "HEALTHY",
    message: "Recorder is running healthy with recent live samples.",
    details: `PID: ${status.pid}, last sample: ${formatRelativeTime(elapsedMs)}.`,
  };
}

/**
 * Render the recorder health header block for --status
 */
export function renderRecorderHeader(status) {
  console.log();
  console.log(chalk.hex("#00b4d8").bold(`📡 Recorder Daemon Health`));
  console.log(chalk.hex("#264653")(`  ${"─".repeat(66)}`));

  const isRunning = status && status.running && isPidAlive(status.pid);
  const statusLabel = isRunning ? chalk.greenBright.bold("RUNNING") : chalk.yellow.bold("OFFLINE");

  console.log(`  Status:                 ${statusLabel}`);
  if (isRunning) {
    const uptimeMs = status.startedAt ? Date.now() - new Date(status.startedAt).getTime() : 0;
    const lastSampleMs = status.lastSuccessfulSampleAt ? Date.now() - new Date(status.lastSuccessfulSampleAt).getTime() : null;
    const nextSampleMs = status.nextSampleAt ? new Date(status.nextSampleAt).getTime() - Date.now() : null;

    // Format uptime into human-readable duration
    const totalMinutes = Math.round(uptimeMs / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const days = Math.floor(hours / 24);
    const remHours = hours % 24;
    let uptimeStr = `${mins}m`;
    if (days >= 1) uptimeStr = `${days}d ${remHours}h`;
    else if (hours >= 1) uptimeStr = `${hours}h ${mins}m`;

    console.log(`  PID:                    ${chalk.white.bold(status.pid)}`);
    console.log(`  Uptime:                 ${chalk.white(uptimeStr)}`);
    console.log(`  Sampling interval:      ${chalk.cyan(`${Math.round(status.samplingIntervalMs / 60000)}m`)}`);
    console.log(`  Last successful sample: ${chalk.greenBright(formatRelativeTime(lastSampleMs))}`);
    console.log(`  Next sample:            ${chalk.dim(formatRelativeFuture(nextSampleMs))}`);
    console.log(`  Consecutive failures:   ${status.consecutiveFailures > 0 ? chalk.red(status.consecutiveFailures) : chalk.dim("0")}`);
    if (status.lastError) {
      console.log(`  Last error:             ${chalk.yellow(status.lastError)}`);
    }
  } else {
    console.log(`  PID:                    ${chalk.dim("None")}`);
    if (status?.startedAt) {
      console.log(`  Last active:            ${chalk.dim(formatRelativeTime(Date.now() - new Date(status.lastAttemptAt || status.startedAt).getTime()))}`);
    }
    if (status?.crashed) {
      console.log(`  Notice:                 ${chalk.red("Previous process appears to have terminated unexpectedly.")}`);
    }
    console.log(`  Sampling interval:      ${chalk.dim(`${Math.round((status?.samplingIntervalMs || 300000) / 60000)}m (configured)`)}`);
    console.log(`  To start recorder:      ${chalk.cyan("npm run battle-telemetry")}`);
  }
  console.log(chalk.hex("#264653")(`  ${"─".repeat(66)}`));
}

// -------------------------------------------------------------
// Windows Task Scheduler Integration
// -------------------------------------------------------------

export const TASK_NAME = "WarEraBattleTelemetry";

/**
 * Generate Windows Task Scheduler XML definition
 */
export function generateTaskXml(options = {}) {
  const nodePath = options.nodePath || process.execPath;
  const projectDir = options.projectDir || ROOT_DIR;
  const scriptPath = "battle_telemetry.mjs";

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>WarEra Battle Availability Telemetry Recorder Daemon</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>true</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>5</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${nodePath}</Command>
      <Arguments>${scriptPath}</Arguments>
      <WorkingDirectory>${projectDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * Check if the Windows scheduled task exists
 */
export function queryWindowsTask() {
  if (process.platform !== "win32") {
    return { supported: false, exists: false, error: "Platform is not Windows" };
  }
  try {
    const out = execSync(`schtasks /Query /TN "${TASK_NAME}" /FO LIST`, { stdio: ["pipe", "pipe", "ignore"] }).toString();
    return { supported: true, exists: true, output: out };
  } catch {
    return { supported: true, exists: false };
  }
}

/**
 * Install the recorder daemon as a Windows Task Scheduler task
 */
export function installWindowsTask(options = {}) {
  if (process.platform !== "win32") {
    throw new Error("Task Scheduler auto-start is only supported on Windows.");
  }

  const xmlContent = generateTaskXml(options);
  const tmpXml = path.join(os.tmpdir(), `warera_task_${Date.now()}.xml`);
  // Task Scheduler requires UTF-16LE with Byte Order Mark (\uFEFF)
  fs.writeFileSync(tmpXml, "\uFEFF" + xmlContent, "utf16le");

  if (options.dryRun) {
    try { fs.unlinkSync(tmpXml); } catch {}
    return {
      success: true,
      dryRun: true,
      taskName: TASK_NAME,
      xmlContent,
    };
  }

  try {
    const out = execSync(`schtasks /Create /TN "${TASK_NAME}" /XML "${tmpXml}" /F`, {
      encoding: "utf8",
    });
    return { success: true, taskName: TASK_NAME, output: out.trim() };
  } catch (err) {
    if (err.message.includes("Access is denied") || err.status === 1) {
      throw new Error(
        `Access is denied while creating scheduled task "${TASK_NAME}".\n` +
        `Please run the command from an elevated PowerShell/Command Prompt (Run as Administrator):\n` +
        `  npm run battle-telemetry:install`
      );
    }
    throw err;
  } finally {
    try { fs.unlinkSync(tmpXml); } catch {}
  }
}

/**
 * Uninstall the recorder daemon from Windows Task Scheduler
 */
export function uninstallWindowsTask(options = {}) {
  if (process.platform !== "win32") {
    throw new Error("Task Scheduler auto-start is only supported on Windows.");
  }

  if (options.dryRun) {
    return { success: true, dryRun: true, taskName: TASK_NAME };
  }

  try {
    const out = execSync(`schtasks /Delete /TN "${TASK_NAME}" /F`, {
      encoding: "utf8",
    });
    return { success: true, taskName: TASK_NAME, output: out.trim() };
  } catch (err) {
    if (err.message.includes("cannot find the file") || err.message.includes("does not exist")) {
      return { success: true, taskName: TASK_NAME, output: "Task was not registered." };
    }
    if (err.message.includes("Access is denied")) {
      throw new Error(
        `Access is denied while deleting scheduled task "${TASK_NAME}".\n` +
        `Please run the command from an elevated PowerShell/Command Prompt (Run as Administrator):\n` +
        `  npm run battle-telemetry:uninstall`
      );
    }
    throw err;
  }
}
