/**
 * WarEra Tools - Electron Main Process
 * 
 * Manages desktop window lifecycle, tray integration, single instance lock,
 * and secure IPC communications.
 */

import { app, BrowserWindow, Tray, Menu, nativeImage, shell } from "electron";
import path from "path";
import { fileURLToPath } from "url";
import { registerIpcHandlers } from "./ipc_handlers.mjs";
import { initRuntimePaths, isPackaged } from "../services/paths.mjs";
import { loadSettings } from "../services/settings_service.mjs";
import { telemetryService } from "../services/telemetry_service.mjs";
import { dailyService } from "../services/daily_service.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize paths and environment variables
initRuntimePaths();

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Single-Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function getAppIcon() {
  const customIcon = path.resolve(__dirname, "../../assets/icon.png");
  try {
    return nativeImage.createFromPath(customIcon);
  } catch {
    return null;
  }
}

function createWindow() {
  const icon = getAppIcon();

  mainWindow = new BrowserWindow({
    title: "WarEra Tools",
    width: 1440,
    height: 900,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: "#0b0f19",
    show: false,
    icon: icon || undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load renderer index.html
  const indexPath = path.join(__dirname, "../renderer/index.html");
  mainWindow.loadFile(indexPath);

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
  });

  // Handle external links safely
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });

  // Window close behavior: minimize to tray if background run is enabled
  mainWindow.on("close", (e) => {
    if (!isQuitting) {
      const settings = loadSettings();
      if (settings.runInBackground) {
        e.preventDefault();
        mainWindow.hide();
        if (tray) {
          tray.displayBalloon({
            title: "WarEra Tools",
            content: "WarEra Tools is still running in the background. Access it from the system tray.",
          });
        }
      }
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Register all secure IPC channels
  registerIpcHandlers(mainWindow);
}

function createTray() {
  const icon = getAppIcon();
  if (!icon || icon.isEmpty()) return;

  try {
    tray = new Tray(icon.resize({ width: 16, height: 16 }));
    tray.setToolTip("WarEra Tools");

    const updateTrayMenu = () => {
      const status = telemetryService.getDaemonStatus();
      const telemetryText = status.running
        ? `Telemetry: Running (PID ${status.pid})`
        : "Telemetry: Stopped";

      const contextMenu = Menu.buildFromTemplate([
        {
          label: "Open WarEra Tools",
          click: () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
            }
          },
        },
        {
          label: telemetryText,
          enabled: false,
        },
        {
          label: "Run Daily Automation",
          click: async () => {
            if (mainWindow) {
              mainWindow.show();
              mainWindow.focus();
            }
            try {
              await dailyService.startDaily({ mode: "nothing", dryRun: true });
            } catch (err) {
              console.error("Tray launch daily failed:", err.message);
            }
          },
        },
        { type: "separator" },
        {
          label: "Exit",
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ]);

      tray.setContextMenu(contextMenu);
    };

    updateTrayMenu();
    tray.on("double-click", () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      }
    });
  } catch (err) {
    console.warn("Tray initialization skipped:", err.message);
  }
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("window-all-closed", () => {
  const settings = loadSettings();
  if (process.platform !== "darwin" && !settings.runInBackground) {
    app.quit();
  }
});
