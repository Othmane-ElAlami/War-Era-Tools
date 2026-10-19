/**
 * WarEra Tools - Windows Scheduled Tasks Manager
 * 
 * Manages Windows Scheduled Tasks strictly for:
 * 1. WarEraDailyAutomator
 * 2. WarEraBattleTelemetry
 * 
 * STRICT SAFETY INVARIANT: Never interacts with or modifies unrelated system tasks.
 */

import { execSync } from "child_process";
import {
  installDailyTask as installDaily,
  uninstallDailyTask as uninstallDaily,
  queryDailyTask,
  TASK_NAME as DAILY_TASK_NAME,
} from "../../daily_task.mjs";
import {
  installWindowsTask as installTelemetry,
  uninstallWindowsTask as uninstallTelemetry,
  queryWindowsTask,
  TASK_NAME as TELEMETRY_TASK_NAME,
} from "../../analyzer/recorder_daemon.mjs";

function parseSchtasksListOutput(output) {
  if (!output || typeof output !== "string") return {};
  const lines = output.split("\n");
  const result = {};
  for (const line of lines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx > 0) {
      const key = line.substring(0, colonIdx).trim();
      const val = line.substring(colonIdx + 1).trim();
      result[key] = val;
    }
  }
  return result;
}

export class SchedulerService {
  /**
   * Get live status of both WarEra scheduled tasks directly from Windows Task Scheduler
   */
  getTasksStatus() {
    if (process.platform !== "win32") {
      return {
        supported: false,
        tasks: {},
      };
    }

    const dailyRaw = queryDailyTask();
    const telemetryRaw = queryWindowsTask();

    const parseTaskState = (rawQuery, taskName) => {
      if (!rawQuery.exists) {
        return {
          name: taskName,
          installed: false,
          status: "Not Installed",
          lastRunTime: "Never",
          nextRunTime: "N/A",
          lastResult: "N/A",
          schedule: "None",
        };
      }

      const parsed = parseSchtasksListOutput(rawQuery.output);
      const isEnabled = parsed["Scheduled Task State"] !== "Disabled" && parsed["Status"] !== "Disabled";

      return {
        name: taskName,
        installed: true,
        enabled: isEnabled,
        status: parsed["Status"] || (isEnabled ? "Ready" : "Disabled"),
        lastRunTime: parsed["Last Run Time"] || "N/A",
        nextRunTime: parsed["Next Run Time"] || "N/A",
        lastResult: parsed["Last Result"] || "0",
        taskToRun: parsed["Task To Run"] || "",
        scheduleType: parsed["Schedule Type"] || "Repeating",
        repeatInterval: parsed["Repeat: Every:"] || "N/A",
      };
    };

    return {
      supported: true,
      tasks: {
        daily: parseTaskState(dailyRaw, DAILY_TASK_NAME),
        telemetry: parseTaskState(telemetryRaw, TELEMETRY_TASK_NAME),
      },
    };
  }

  // Daily Automator Task Controls
  installDaily(cadence = "10m") {
    // Convert cadence (e.g. "10m", "15m", "1h") to XML interval format (PT10M, PT15M, PT1H)
    let interval = "PT10M";
    if (cadence === "5m") interval = "PT5M";
    else if (cadence === "15m") interval = "PT15M";
    else if (cadence === "30m") interval = "PT30M";
    else if (cadence === "1h") interval = "PT1H";

    return installDaily({ interval });
  }

  uninstallDaily() {
    return uninstallDaily();
  }

  enableDaily() {
    execSync(`schtasks /Change /TN "${DAILY_TASK_NAME}" /ENABLE`, { stdio: "ignore" });
    return this.getTasksStatus();
  }

  disableDaily() {
    execSync(`schtasks /Change /TN "${DAILY_TASK_NAME}" /DISABLE`, { stdio: "ignore" });
    return this.getTasksStatus();
  }

  // Telemetry Task Controls
  installTelemetry(interval = "5m") {
    return installTelemetry({ interval });
  }

  uninstallTelemetry() {
    return uninstallTelemetry();
  }

  enableTelemetry() {
    execSync(`schtasks /Change /TN "${TELEMETRY_TASK_NAME}" /ENABLE`, { stdio: "ignore" });
    return this.getTasksStatus();
  }

  disableTelemetry() {
    execSync(`schtasks /Change /TN "${TELEMETRY_TASK_NAME}" /DISABLE`, { stdio: "ignore" });
    return this.getTasksStatus();
  }
}

export const schedulerService = new SchedulerService();
