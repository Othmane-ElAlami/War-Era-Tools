/**
 * WarEra Tools - Log Viewer Service
 * 
 * Provides log stream access, filtering, search, and directory location.
 * STRICT SAFETY INVARIANT: Clearing view never deletes files on disk.
 */

import fs from "fs";
import path from "path";
import { exec } from "child_process";
import { getLogsDir, getDataDir, getTelemetryDir, isPackaged } from "./paths.mjs";
import { getExecutionsFilePath, getTelemetryFilePath, getStatusFilePath } from "../../analyzer/battle_telemetry.mjs";

class LogsService {
  constructor() {
    this.memoryLogs = {
      buyer: [],
      reseller: [],
      system: [],
    };
  }

  logOperation(category, text, level = "INFO") {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      text,
    };
    if (!this.memoryLogs[category]) this.memoryLogs[category] = [];
    this.memoryLogs[category].push(entry);
    if (this.memoryLogs[category].length > 500) {
      this.memoryLogs[category].shift();
    }
  }

  getLogFolderPath() {
    return getLogsDir();
  }

  openLogFolder() {
    const dir = this.getLogFolderPath();
    if (process.platform === "win32") {
      exec(`explorer.exe "${dir}"`);
      return { opened: true, path: dir };
    }
    return { opened: false, path: dir };
  }

  /**
   * Read log entries for specified category with filtering and search
   */
  readLogs(category = "daily", options = {}) {
    const { limit = 300, levelFilter = "", searchQuery = "" } = options;

    let rawLines = [];

    if (category === "daily") {
      const filePath = path.join(getLogsDir(), "daily_automator.log");
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, "utf8");
          rawLines = content.split("\n").filter((l) => l.trim().length > 0);
        } catch {}
      }
    } else if (category === "battle") {
      const filePath = getExecutionsFilePath();
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const jsonl = content.split("\n").filter((l) => l.trim().length > 0);
          rawLines = jsonl.map((line) => {
            try {
              const obj = JSON.parse(line);
              return `[${obj.timestamp || "TIME"}] [${obj.verificationState || "HIT"}] Battle: ${obj.battleId} - Dmg: ${obj.damageDealt ?? "N/A"} - HP: ${obj.healthBefore} -> ${obj.healthAfter}`;
            } catch {
              return line;
            }
          });
        } catch {}
      }
    } else if (category === "telemetry") {
      const filePath = getTelemetryFilePath();
      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const jsonl = content.split("\n").filter((l) => l.trim().length > 0);
          rawLines = jsonl.slice(-100).map((line) => {
            try {
              const obj = JSON.parse(line);
              return `[${obj.timestamp}] [SAMPLES] Source: ${obj.source || "live"} - Battles: ${obj.qualifyingBattles?.length || 0} qualifying - Active: ${obj.hasQualifyingBattle ? "YES" : "NO"}`;
            } catch {
              return line;
            }
          });
        } catch {}
      }
    } else if (category === "buyer" || category === "reseller" || category === "system") {
      const entries = this.memoryLogs[category] || [];
      rawLines = entries.map((e) => `[${e.timestamp}] [${e.level}] ${e.text}`);
    }

    // Strip ANSI codes
    const cleanLines = rawLines.map((l) =>
      l.replace(/[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g, "")
    );

    // Apply level filter & search query
    let filtered = cleanLines;
    if (levelFilter) {
      const lvl = levelFilter.toUpperCase();
      filtered = filtered.filter((l) => l.toUpperCase().includes(lvl));
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter((l) => l.toLowerCase().includes(q));
    }

    // Return the latest entries up to limit
    const sliced = filtered.slice(-limit);

    return {
      category,
      totalAvailable: cleanLines.length,
      returnedCount: sliced.length,
      lines: sliced,
      logFolder: this.getLogFolderPath(),
    };
  }
}

export const logsService = new LogsService();
