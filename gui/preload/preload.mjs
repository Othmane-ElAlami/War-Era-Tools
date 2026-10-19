/**
 * WarEra Tools - Preload Script
 * 
 * Exposes a narrow typed API to the renderer via contextBridge.
 * Enforces contextIsolation: true and nodeIntegration: false.
 */

import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("wareraApi", {
  // --- Dashboard ---
  getDashboardState: () => ipcRenderer.invoke("dashboard:getState"),

  // --- Daily Automator ---
  getDailyStatus: () => ipcRenderer.invoke("daily:getStatus"),
  startDaily: (options) => ipcRenderer.invoke("daily:start", options),
  cancelDaily: () => ipcRenderer.invoke("daily:cancel"),

  // --- Battles ---
  scanBattles: (context) => ipcRenderer.invoke("battles:scan", context),
  executeBattles: (options) => ipcRenderer.invoke("battles:execute", options),

  // --- Equipment Buyer ---
  analyzeBuyerMarket: (options) => ipcRenderer.invoke("buyer:analyze", options),
  cancelBuyerAnalysis: () => ipcRenderer.invoke("buyer:cancel"),
  executePurchases: (options) => ipcRenderer.invoke("buyer:execute", options),

  // --- Equipment Reseller ---
  auditResellerInventory: (options) => ipcRenderer.invoke("reseller:audit", options),
  executeListings: (options) => ipcRenderer.invoke("reseller:execute", options),

  // --- Build Analyzer ---
  runBuildAnalysis: (options) => ipcRenderer.invoke("analyzer:run", options),

  // --- Telemetry ---
  getTelemetryStatus: () => ipcRenderer.invoke("telemetry:getStatus"),
  getTelemetryAnalytics: () => ipcRenderer.invoke("telemetry:getAnalytics"),
  startTelemetry: (interval) => ipcRenderer.invoke("telemetry:start", interval),
  stopTelemetry: () => ipcRenderer.invoke("telemetry:stop"),
  installTelemetryTask: (interval) => ipcRenderer.invoke("telemetry:installTask", interval),
  uninstallTelemetryTask: () => ipcRenderer.invoke("telemetry:uninstallTask"),

  // --- Scheduler ---
  getSchedulerStatus: () => ipcRenderer.invoke("scheduler:getStatus"),
  dailyInstallTask: (cadence) => ipcRenderer.invoke("scheduler:dailyInstall", cadence),
  dailyUninstallTask: () => ipcRenderer.invoke("scheduler:dailyUninstall"),
  dailyEnableTask: () => ipcRenderer.invoke("scheduler:dailyEnable"),
  dailyDisableTask: () => ipcRenderer.invoke("scheduler:dailyDisable"),
  telemetryInstallTask: (interval) => ipcRenderer.invoke("scheduler:telemetryInstall", interval),
  telemetryUninstallTask: () => ipcRenderer.invoke("scheduler:telemetryUninstall"),
  telemetryEnableTask: () => ipcRenderer.invoke("scheduler:telemetryEnable"),
  telemetryDisableTask: () => ipcRenderer.invoke("scheduler:telemetryDisable"),

  // --- Logs ---
  readLogs: (category, options) => ipcRenderer.invoke("logs:read", { category, options }),
  openLogFolder: () => ipcRenderer.invoke("logs:openFolder"),

  // --- Settings & Auth ---
  loadSettings: () => ipcRenderer.invoke("settings:load"),
  saveSettings: (settings) => ipcRenderer.invoke("settings:save", settings),
  getAuthStatus: () => ipcRenderer.invoke("settings:authStatus"),
  updateToken: (token) => ipcRenderer.invoke("settings:updateToken", token),
  launchBrowserLogin: () => ipcRenderer.invoke("settings:launchBrowserLogin"),
  detectRepoData: () => ipcRenderer.invoke("settings:detectRepoData"),
  importRepoData: (options) => ipcRenderer.invoke("settings:importRepoData", options),

  // --- Subscriptions / Event Listeners ---
  onDailyLog: (callback) => {
    const handler = (_, entry) => callback(entry);
    ipcRenderer.on("daily:log", handler);
    return () => ipcRenderer.removeListener("daily:log", handler);
  },
  onDailyStage: (callback) => {
    const handler = (_, stage) => callback(stage);
    ipcRenderer.on("daily:stage", handler);
    return () => ipcRenderer.removeListener("daily:stage", handler);
  },
  onBattleHit: (callback) => {
    const handler = (_, record) => callback(record);
    ipcRenderer.on("battles:hit", handler);
    return () => ipcRenderer.removeListener("battles:hit", handler);
  },
  onBuyerProgress: (callback) => {
    const handler = (_, info) => callback(info);
    ipcRenderer.on("buyer:progress", handler);
    return () => ipcRenderer.removeListener("buyer:progress", handler);
  },
  onBuyerItemPurchased: (callback) => {
    const handler = (_, record) => callback(record);
    ipcRenderer.on("buyer:item-purchased", handler);
    return () => ipcRenderer.removeListener("buyer:item-purchased", handler);
  },
  onResellerItemListed: (callback) => {
    const handler = (_, record) => callback(record);
    ipcRenderer.on("reseller:item-listed", handler);
    return () => ipcRenderer.removeListener("reseller:item-listed", handler);
  },
  onResellerAuditStatus: (callback) => {
    const handler = (_, info) => callback(info);
    ipcRenderer.on("reseller:audit-status", handler);
    return () => ipcRenderer.removeListener("reseller:audit-status", handler);
  },
});
