/**
 * WarEra Daily Automator Task Scheduler & Lock Engine
 * 
 * Manages:
 * 1. Single-instance locking for daily_automator (data/daily_automator.lock)
 * 2. Windows Task Scheduler 10-minute service registration (WarEraDailyAutomator)
 */

import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import { fileURLToPath } from "url";
import chalk from "chalk";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname);
const DATA_DIR = path.resolve(ROOT_DIR, "data");
const LOCK_FILE = path.join(DATA_DIR, "daily_automator.lock");

export const TASK_NAME = "WarEraDailyAutomator";

/**
 * Check if a process with the given PID is currently alive
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
 * Acquire single-instance lock for daily_automator
 */
export function acquireDailyLock(customLockFile = LOCK_FILE) {
  const dir = path.dirname(customLockFile);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  if (fs.existsSync(customLockFile)) {
    try {
      const raw = fs.readFileSync(customLockFile, "utf8");
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
        const ageMs = existing.startedAt ? Date.now() - new Date(existing.startedAt).getTime() : 0;
        const MAX_LOCK_AGE_MS = 10 * 60 * 1000; // 10 minutes maximum duration
        if (ageMs > 0 && ageMs < MAX_LOCK_AGE_MS) {
          return {
            acquired: false,
            reason: "ALIVE",
            lock: existing,
            ageMs,
          };
        }

        // Process has been holding the lock for > 10m on the SAME host — it is hung.
        // Terminate the hung process and safely recover the lock.
        try {
          process.kill(existing.pid, "SIGKILL");
        } catch {}
        const staleLock = existing;
        const newLock = {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          hostname: os.hostname(),
        };
        fs.writeFileSync(customLockFile, JSON.stringify(newLock, null, 2), "utf8");
        return {
          acquired: true,
          staleRecovered: true,
          stalePid: staleLock.pid,
          reason: "HUNG_TERMINATED",
          lock: newLock,
        };
      }

      // Stale lock detected (process PID is no longer alive on this host, or cross-host lock)
      const staleLock = existing;
      const newLock = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: os.hostname(),
      };
      fs.writeFileSync(customLockFile, JSON.stringify(newLock, null, 2), "utf8");
      return {
        acquired: true,
        staleRecovered: true,
        crossHostRecovered: isCrossHost,
        staleHostname: staleLock.hostname || null,
        stalePid: staleLock.pid,
        lock: newLock,
      };
    } catch {
      // Corrupt lock file -> recover safely
      const newLock = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        hostname: os.hostname(),
      };
      fs.writeFileSync(customLockFile, JSON.stringify(newLock, null, 2), "utf8");
      return { acquired: true, staleRecovered: true, stalePid: null, lock: newLock };
    }
  }

  const newLock = {
    pid: process.pid,
    startedAt: new Date().toISOString(),
    hostname: os.hostname(),
  };
  fs.writeFileSync(customLockFile, JSON.stringify(newLock, null, 2), "utf8");
  return { acquired: true, staleRecovered: false, lock: newLock };
}

/**
 * Release single-instance lock for daily_automator
 */
export function releaseDailyLock(customLockFile = LOCK_FILE, force = false) {
  if (!fs.existsSync(customLockFile)) return true;
  try {
    const raw = fs.readFileSync(customLockFile, "utf8");
    const existing = JSON.parse(raw);
    if (force || existing.pid === process.pid) {
      fs.unlinkSync(customLockFile);
      return true;
    }
  } catch {
    try {
      fs.unlinkSync(customLockFile);
      return true;
    } catch {}
  }
  return false;
}

const DATA_VBS_RUNNER = path.join(DATA_DIR, "run_daily_silent.vbs");

export function getDailyVbsPath(projectDir = ROOT_DIR) {
  return path.join(projectDir, "data", "run_daily_silent.vbs");
}

/**
 * Generate the silent VBScript runner that launches node.exe completely hidden
 * (zero console window, SW_HIDE) and redirects logs to data/daily_automator.log.
 */
export function writeDailyVbsRunner(options = {}) {
  const nodePath = options.nodePath || process.execPath;
  const projectDir = options.projectDir || ROOT_DIR;
  const vbsPath = options.vbsPath || getDailyVbsPath(projectDir);
  const logPath = options.logPath || path.join(projectDir, "data", "daily_automator.log");
  const mode = options.mode || "nothing";

  const vbsDir = path.dirname(vbsPath);
  if (!fs.existsSync(vbsDir)) {
    fs.mkdirSync(vbsDir, { recursive: true });
  }

  const logDir = path.dirname(logPath);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const vbsContent = [
    "' WarEra Daily Automator Silent Background Runner",
    "' Executes daily_automator.mjs headlessly with 0 console window (SW_HIDE)",
    "Set WshShell = CreateObject(\"WScript.Shell\")",
    `WshShell.CurrentDirectory = "${projectDir}"`,
    `cmd = "cmd.exe /c " & Chr(34) & Chr(34) & "${nodePath}" & Chr(34) & " daily_automator.mjs --headless --mode=${mode} >> " & Chr(34) & "${logPath}" & Chr(34) & " 2>&1" & Chr(34)`,
    "WshShell.Run cmd, 0, False",
    "",
  ].join("\r\n");

  fs.writeFileSync(vbsPath, vbsContent, "utf8");
  return vbsPath;
}

/**
 * Generate Windows Task Scheduler XML definition for 10-Minute Daily Automator
 */
export function generateDailyTaskXml(options = {}) {
  const projectDir = options.projectDir || ROOT_DIR;
  const vbsPath = options.vbsPath || getDailyVbsPath(projectDir);
  const interval = options.interval || "PT10M";

  // Start boundary: top of the current day
  const now = new Date();
  const startBoundary = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}T00:00:00`;

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>WarEra Daily Tasks 10-Minute Automator (Silent Background)</Description>
  </RegistrationInfo>
  <Triggers>
    <TimeTrigger>
      <StartBoundary>${startBoundary}</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>${interval}</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
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
    <Hidden>true</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT15M</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${vbsPath}"</Arguments>
      <WorkingDirectory>${projectDir}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}

/**
 * Check if the Windows scheduled task exists
 */
export function queryDailyTask() {
  if (process.platform !== "win32") {
    return { supported: false, exists: false, error: "Platform is not Windows" };
  }
  try {
    const out = execSync(`schtasks /Query /TN "${TASK_NAME}" /V /FO LIST`, { stdio: ["pipe", "pipe", "ignore"] }).toString();
    return { supported: true, exists: true, output: out };
  } catch {
    return { supported: true, exists: false };
  }
}

/**
 * Install the daily automator as a 10-minute Windows Task Scheduler task
 */
export function installDailyTask(options = {}) {
  if (process.platform !== "win32") {
    throw new Error("Task Scheduler auto-start is only supported on Windows.");
  }

  const xmlContent = generateDailyTaskXml(options);
  const tmpXml = path.join(os.tmpdir(), `warera_daily_task_${Date.now()}.xml`);
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

  writeDailyVbsRunner(options);

  try {
    const out = execSync(`schtasks /Create /TN "${TASK_NAME}" /XML "${tmpXml}" /F`, {
      encoding: "utf8",
    });
    try {
      if (process.env.USERNAME) {
        const sysRoot = process.env.SystemRoot || "C:\\Windows";
        execSync(`icacls "${path.join(sysRoot, "System32", "Tasks", TASK_NAME)}" /grant "${process.env.USERNAME}:F"`, {
          stdio: "ignore",
        });
      }
    } catch {}
    return { success: true, taskName: TASK_NAME, output: out.trim() };
  } catch (err) {
    if (err.message.includes("Access is denied") || err.status === 1) {
      throw new Error(
        `Access is denied while creating scheduled task "${TASK_NAME}".\n` +
        `Please run the command from an elevated PowerShell/Command Prompt (Run as Administrator):\n` +
        `  npm run daily:install`
      );
    }
    throw err;
  } finally {
    try { fs.unlinkSync(tmpXml); } catch {}
  }
}

/**
 * Uninstall the daily automator from Windows Task Scheduler
 */
export function uninstallDailyTask(options = {}) {
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
    try {
      const vbs = getDailyVbsPath();
      if (fs.existsSync(vbs)) fs.unlinkSync(vbs);
    } catch {}
    return { success: true, taskName: TASK_NAME, output: out.trim() };
  } catch (err) {
    if (err.message.includes("cannot find the file") || err.message.includes("does not exist")) {
      return { success: true, taskName: TASK_NAME, output: "Task was not registered." };
    }
    if (err.message.includes("Access is denied")) {
      throw new Error(
        `Access is denied while deleting scheduled task "${TASK_NAME}".\n` +
        `Please run the command from an elevated PowerShell/Command Prompt (Run as Administrator):\n` +
        `  npm run daily:uninstall`
      );
    }
    throw err;
  }
}
