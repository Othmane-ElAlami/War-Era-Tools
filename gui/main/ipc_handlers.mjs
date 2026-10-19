/**
 * WarEra Tools - IPC Handlers
 * 
 * Secure typed bridge connecting Electron Main process services to Renderer.
 * Strictly avoids exposing arbitrary shell execution or unsafe primitives.
 */

import { ipcMain } from "electron";
import { getDashboardState } from "../services/dashboard_service.mjs";
import { dailyService } from "../services/daily_service.mjs";
import { battlesService } from "../services/battles_service.mjs";
import { buyerService } from "../services/buyer_service.mjs";
import { resellerService } from "../services/reseller_service.mjs";
import { analyzerService } from "../services/analyzer_service.mjs";
import { telemetryService } from "../services/telemetry_service.mjs";
import { schedulerService } from "../services/scheduler_service.mjs";
import { logsService } from "../services/logs_service.mjs";
import {
  loadSettings,
  saveSettings,
  getSanitizedAuthStatus,
} from "../services/settings_service.mjs";
import {
  detectRepoData,
  importRepoData,
  getAppDir,
  REPO_ROOT,
} from "../services/paths.mjs";
import { updateStoredJwt } from "../../login.mjs";
import { connect, disconnectBrowser } from "../../browser.mjs";

export function registerIpcHandlers(mainWindow) {
  // Event forwarding from services to UI
  dailyService.on("log", (entry) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("daily:log", entry);
    }
  });

  dailyService.on("stage", (stage) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("daily:stage", stage);
    }
  });

  battlesService.on("hit", (record) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("battles:hit", record);
    }
  });

  buyerService.on("progress", (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("buyer:progress", info);
    }
  });

  buyerService.on("item-purchased", (record) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("buyer:item-purchased", record);
    }
  });

  resellerService.on("item-listed", (record) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("reseller:item-listed", record);
    }
  });

  resellerService.on("audit-status", (info) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send("reseller:audit-status", info);
    }
  });

  // --- Dashboard ---
  ipcMain.handle("dashboard:getState", async () => {
    return await getDashboardState();
  });

  // --- Daily Automator ---
  ipcMain.handle("daily:getStatus", () => {
    return dailyService.getStatus();
  });

  ipcMain.handle("daily:start", async (_, options) => {
    const settings = loadSettings();
    const effectiveDryRun = options.dryRun !== undefined ? options.dryRun : settings.dryRun;
    return await dailyService.startDaily({ ...options, dryRun: effectiveDryRun });
  });

  ipcMain.handle("daily:cancel", async () => {
    return await dailyService.cancelDaily();
  });

  // --- Battles ---
  ipcMain.handle("battles:scan", async (_, context) => {
    return await battlesService.scanBattles(context);
  });

  ipcMain.handle("battles:execute", async (_, options) => {
    const settings = loadSettings();
    const effectiveDryRun = options.dryRun !== undefined ? options.dryRun : settings.dryRun;
    return await battlesService.executeBattleMode({ ...options, dryRun: effectiveDryRun });
  });

  // --- Equipment Buyer ---
  ipcMain.handle("buyer:analyze", async (_, options) => {
    return await buyerService.analyzeMarket(options);
  });

  ipcMain.handle("buyer:cancel", () => {
    buyerService.cancelAnalysis();
    return { cancelled: true };
  });

  ipcMain.handle("buyer:execute", async (_, options) => {
    const settings = loadSettings();
    const effectiveDryRun = options.dryRun !== undefined ? options.dryRun : settings.dryRun;
    return await buyerService.executePurchases({ ...options, dryRun: effectiveDryRun });
  });

  // --- Equipment Reseller ---
  ipcMain.handle("reseller:audit", async (_, options) => {
    return await resellerService.auditInventory(options);
  });

  ipcMain.handle("reseller:execute", async (_, options) => {
    const settings = loadSettings();
    const effectiveDryRun = options.dryRun !== undefined ? options.dryRun : settings.dryRun;
    return await resellerService.executeListings({ ...options, dryRun: effectiveDryRun });
  });

  // --- Build Analyzer ---
  ipcMain.handle("analyzer:run", async (_, options) => {
    return await analyzerService.runAnalysis(options);
  });

  // --- Telemetry ---
  ipcMain.handle("telemetry:getStatus", () => {
    return telemetryService.getDaemonStatus();
  });

  ipcMain.handle("telemetry:getAnalytics", () => {
    return telemetryService.getAnalytics();
  });

  ipcMain.handle("telemetry:start", (_, interval) => {
    return telemetryService.startDaemon(interval);
  });

  ipcMain.handle("telemetry:stop", () => {
    return telemetryService.stopDaemon();
  });

  ipcMain.handle("telemetry:installTask", (_, interval) => {
    return telemetryService.installTask(interval);
  });

  ipcMain.handle("telemetry:uninstallTask", () => {
    return telemetryService.uninstallTask();
  });

  // --- Windows Scheduler ---
  ipcMain.handle("scheduler:getStatus", () => {
    return schedulerService.getTasksStatus();
  });

  ipcMain.handle("scheduler:dailyInstall", (_, cadence) => {
    return schedulerService.installDaily(cadence);
  });

  ipcMain.handle("scheduler:dailyUninstall", () => {
    return schedulerService.uninstallDaily();
  });

  ipcMain.handle("scheduler:dailyEnable", () => {
    return schedulerService.enableDaily();
  });

  ipcMain.handle("scheduler:dailyDisable", () => {
    return schedulerService.disableDaily();
  });

  ipcMain.handle("scheduler:telemetryInstall", (_, interval) => {
    return schedulerService.installTelemetry(interval);
  });

  ipcMain.handle("scheduler:telemetryUninstall", () => {
    return schedulerService.uninstallTelemetry();
  });

  ipcMain.handle("scheduler:telemetryEnable", () => {
    return schedulerService.enableTelemetry();
  });

  ipcMain.handle("scheduler:telemetryDisable", () => {
    return schedulerService.disableTelemetry();
  });

  // --- Logs Viewer ---
  ipcMain.handle("logs:read", (_, { category, options }) => {
    return logsService.readLogs(category, options);
  });

  ipcMain.handle("logs:openFolder", () => {
    return logsService.openLogFolder();
  });

  // --- Settings & Auth ---
  ipcMain.handle("settings:load", () => {
    return loadSettings();
  });

  ipcMain.handle("settings:save", (_, newSettings) => {
    return saveSettings(newSettings);
  });

  ipcMain.handle("settings:authStatus", () => {
    return getSanitizedAuthStatus();
  });

  ipcMain.handle("settings:updateToken", (_, token) => {
    const info = updateStoredJwt(token);
    return {
      success: true,
      expiresAt: info.expiresAt ? info.expiresAt.toISOString() : null,
      isValid: info.isValid,
      expiresInMinutes: info.expiresInMinutes,
    };
  });

  ipcMain.handle("settings:launchBrowserLogin", async () => {
    let browserInstance = null;
    try {
      const { browser } = await connect({ headless: false });
      browserInstance = browser;
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    } finally {
      if (browserInstance) {
        await disconnectBrowser(browserInstance);
      }
    }
  });

  ipcMain.handle("settings:detectRepoData", () => {
    return detectRepoData(REPO_ROOT);
  });

  ipcMain.handle("settings:importRepoData", (_, options) => {
    return importRepoData(REPO_ROOT, getAppDir(), options);
  });
}
