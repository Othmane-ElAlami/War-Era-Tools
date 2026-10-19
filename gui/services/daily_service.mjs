/**
 * WarEra Tools - Daily Automation Service
 * 
 * Orchestrates daily automation runs, captures stdout/stderr in real-time,
 * tracks execution stages, enforces duplicate run prevention, and supports cancellation.
 * Calls the existing daily_automator.mjs CLI module directly.
 */

import { spawn } from "child_process";
import path from "path";
import { EventEmitter } from "events";
import { REPO_ROOT, getCookiesPath, getTelemetryDir, getLogsDir } from "./paths.mjs";
import { acquireDailyLock, releaseDailyLock, isPidAlive } from "../../daily_task.mjs";

class DailyAutomationService extends EventEmitter {
  constructor() {
    super();
    this.activeChild = null;
    this.isRunning = false;
    this.currentStage = "Idle"; // Idle, Companies, Military Unit, Resistance, Battles, Summary
    this.runStartTime = null;
    this.logHistory = [];
    this.maxLogHistory = 1000;
  }

  getStatus() {
    return {
      isRunning: this.isRunning,
      pid: this.activeChild?.pid || null,
      currentStage: this.currentStage,
      runStartTime: this.runStartTime,
      logCount: this.logHistory.length,
    };
  }

  appendLog(line) {
    // Strip ANSI escape codes for clean UI rendering
    const clean = line.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "");
    const entry = {
      timestamp: new Date().toISOString(),
      text: clean,
    };
    this.logHistory.push(entry);
    if (this.logHistory.length > this.maxLogHistory) {
      this.logHistory.shift();
    }
    this.emit("log", entry);
  }

  setStage(stage) {
    if (this.currentStage !== stage) {
      this.currentStage = stage;
      this.emit("stage", stage);
    }
  }

  detectStageFromOutput(line) {
    const upper = line.toUpperCase();
    if (upper.includes("COMPANIES") || upper.includes("JOB WORK") || upper.includes("COMPANY PRODUCTION")) {
      this.setStage("Companies");
    } else if (upper.includes("MILITARY UNIT") || upper.includes("MU HELP") || upper.includes("ASKED FOR HELP")) {
      this.setStage("Military Unit");
    } else if (upper.includes("RESISTANCE") || upper.includes("CIVIL WAR")) {
      this.setStage("Resistance");
    } else if (upper.includes("BATTLE") || upper.includes("COMBAT")) {
      this.setStage("Battles");
    } else if (upper.includes("COMPLETE") || upper.includes("SUMMARY") || upper.includes("ROUTINE COMPLETE")) {
      this.setStage("Summary");
    }
  }

  /**
   * Run Daily Automation with specified mode and options
   */
  async startDaily(options = {}) {
    if (this.isRunning) {
      throw new Error(`Daily Automation is already running (PID: ${this.activeChild?.pid})`);
    }

    const mode = options.mode || "nothing"; // 'nothing', 'resistance', 'battles', 'both'
    const dryRun = options.dryRun !== false;
    const headless = options.headless !== false;

    // Check lock file first
    const lock = acquireDailyLock();
    if (!lock.acquired) {
      throw new Error(`Another process is already running Daily Automator (PID ${lock.lock?.pid} on ${lock.lock?.hostname})`);
    }

    this.isRunning = true;
    this.currentStage = "Starting";
    this.runStartTime = new Date().toISOString();
    this.emit("stage", this.currentStage);

    const scriptPath = path.join(REPO_ROOT, "daily_automator.mjs");
    const args = [`--mode=${mode}`];
    if (dryRun) args.push("--dry-run");
    if (headless) args.push("--headless");
    else args.push("--headful");

    const env = {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      WARERA_COOKIE_FILE: getCookiesPath(),
      WARERA_TELEMETRY_DIR: getTelemetryDir(),
    };

    const nodeExec = process.execPath;

    this.appendLog(`[SYSTEM] Starting Daily Automation: node daily_automator.mjs ${args.join(" ")}`);

    try {
      this.activeChild = spawn(nodeExec, [scriptPath, ...args], {
        cwd: REPO_ROOT,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.activeChild.stdout.on("data", (chunk) => {
        const text = chunk.toString();
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.detectStageFromOutput(line);
            this.appendLog(line);
          }
        }
      });

      this.activeChild.stderr.on("data", (chunk) => {
        const text = chunk.toString();
        const lines = text.split("\n");
        for (const line of lines) {
          if (line.trim().length > 0) {
            this.appendLog(`[ERR] ${line}`);
          }
        }
      });

      this.activeChild.on("close", (code) => {
        this.isRunning = false;
        const exitStage = code === 0 ? "Completed" : "Failed";
        this.setStage(exitStage);
        this.appendLog(`[SYSTEM] Daily Automation finished with exit code ${code} (${exitStage})`);
        this.activeChild = null;
        releaseDailyLock();
        this.emit("done", { code, stage: exitStage });
      });

      this.activeChild.on("error", (err) => {
        this.isRunning = false;
        this.setStage("Failed");
        this.appendLog(`[ERROR] Process error: ${err.message}`);
        this.activeChild = null;
        releaseDailyLock();
        this.emit("error", err);
      });

      return {
        pid: this.activeChild.pid,
        mode,
        dryRun,
        headless,
      };
    } catch (err) {
      this.isRunning = false;
      this.setStage("Failed");
      releaseDailyLock();
      throw err;
    }
  }

  /**
   * Cancel currently running Daily Automation
   */
  async cancelDaily() {
    if (!this.isRunning || !this.activeChild) {
      return { cancelled: false, message: "No active Daily Automation process to cancel." };
    }

    try {
      this.appendLog("[SYSTEM] Sending abort signal to Daily Automation process...");
      this.activeChild.kill("SIGTERM");
      
      // Force kill after 4 seconds if still alive
      setTimeout(() => {
        if (this.activeChild && isPidAlive(this.activeChild.pid)) {
          this.activeChild.kill("SIGKILL");
        }
      }, 4000);

      return { cancelled: true, message: "Cancellation request sent." };
    } catch (err) {
      return { cancelled: false, error: err.message };
    }
  }
}

export const dailyService = new DailyAutomationService();
