import { chromium } from "playwright-core";
import fs from "fs";
import os from "os";
import path from "path";
import { spawn, execSync } from "child_process";
import { CDP_URL, BASE, COOKIE_FILE, API4_BASE } from "./config.mjs";
import { sleep, log } from "./utils.mjs";

/* ═══════════════════════════════════════════════════════════════════════════
   BROWSER PROFILE & EXECUTABLE RESOLUTION
   ═══════════════════════════════════════════════════════════════════════════ */

export const ISOLATED_PROFILE_DIR =
  process.env.WARERA_USER_DATA_DIR ||
  path.join(os.homedir(), ".warera", "browser_profile");

/**
 * Locate a system Chromium-based browser executable (Edge, Chrome, Chromium)
 */
export function findBrowserExecutable() {
  if (process.env.WARERA_BROWSER_PATH && fs.existsSync(process.env.WARERA_BROWSER_PATH)) {
    return process.env.WARERA_BROWSER_PATH;
  }

  const platform = process.platform;
  const candidates = [];

  if (platform === "win32") {
    const progFiles86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const progFiles = process.env.ProgramFiles || "C:\\Program Files";
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

    candidates.push(
      path.join(progFiles86, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(progFiles, "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join(progFiles, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(progFiles86, "Google", "Chrome", "Application", "chrome.exe"),
      path.join(localAppData, "Microsoft", "Edge SxS", "Application", "msedge.exe")
    );
  } else if (platform === "darwin") {
    candidates.push(
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    );
  } else {
    // Linux / BSD
    candidates.push(
      "/usr/bin/microsoft-edge",
      "/usr/bin/microsoft-edge-stable",
      "/usr/bin/google-chrome",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser"
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }

  return null;
}

/**
 * Forcefully terminate any stale/hung browser processes using our isolated profile
 */
export function killStaleEdge() {
  try {
    if (process.platform === "win32") {
      execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name = 'msedge.exe' or Name = 'chrome.exe'\\" | Where-Object { $_.CommandLine -like '*.warera*browser_profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
        { stdio: "ignore", timeout: 10000 }
      );
    }
  } catch {}
}

/**
 * Launch isolated browser in remote debugging mode
 */
export async function launchEdge(isHeadless) {
  log(
    "SESSION",
    "LAUNCH",
    `Browser not detected — launching with remote debugging${isHeadless ? " (headless background mode)" : ""}...`,
  );

  const browserPath = findBrowserExecutable();
  if (!browserPath) {
    throw new Error(
      "No compatible browser executable found (Microsoft Edge or Google Chrome). " +
      "Please install Edge/Chrome or set WARERA_BROWSER_PATH to your browser binary."
    );
  }

  if (!fs.existsSync(ISOLATED_PROFILE_DIR)) {
    fs.mkdirSync(ISOLATED_PROFILE_DIR, { recursive: true });
  }

  const browserArgs = [
    `--remote-debugging-port=${new URL(CDP_URL).port || "9222"}`,
    `--user-data-dir=${ISOLATED_PROFILE_DIR}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-session-crashed-bubble",
    "--disable-infobars",
  ];

  if (isHeadless) {
    browserArgs.push("--headless=new", "--disable-gpu", "--window-position=-32000,-32000");
  }

  spawn(browserPath, browserArgs, { detached: true, stdio: "ignore" }).unref();

  // Wait for browser to start and expose CDP
  let reachable = false;
  for (let i = 0; i < 15; i++) {
    await sleep(2000);
    try {
      const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        reachable = true;
        break;
      }
    } catch {
      /* still starting */
    }
  }

  if (!reachable) {
    throw new Error(`Browser did not expose CDP on ${CDP_URL} within 30s — launch it manually or run 'npm run login'.`);
  }
  log("SESSION", "OK", `Browser launched and CDP ready${isHeadless ? " (headless)" : ""}.`);
}

/**
 * Connect to running browser or start an isolated instance
 */
export async function connect(options = {}) {
  const isHeadless =
    options.headless === true ||
    process.env.HEADLESS === "true" ||
    process.argv.includes("--headless") ||
    !process.stdin.isTTY;

  // Auto-launch browser if CDP is not reachable
  let reachable = false;
  try {
    const res = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(3000) });
    reachable = res.ok;
  } catch {
    reachable = false;
  }

  if (!reachable) {
    killStaleEdge();
    await launchEdge(isHeadless);
  }

  let browser = null;
  try {
    try {
      browser = await chromium.connectOverCDP(CDP_URL, { timeout: 15000 });
    } catch (cdpErr) {
      log("SESSION", "WARN", `CDP connection failed or unresponsive (${cdpErr.message}) — restarting browser...`);
      killStaleEdge();
      await sleep(1500);
      await launchEdge(isHeadless);
      browser = await chromium.connectOverCDP(CDP_URL, { timeout: 25000 });
    }

    const ctx = browser.contexts()[0];

    // Re-use existing warera tab or open one
    let page = ctx.pages().find((p) => p.url().includes("warera"));
    if (!page) page = await ctx.newPage();

    // Check if the game recognises the current session
    const loggedIn = await isLoggedIn(page);
    if (!loggedIn) {
      let injected = false;
      if (fs.existsSync(COOKIE_FILE)) {
        try {
          const saved = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf8"));
          if (Array.isArray(saved) && saved.length > 0) {
            await ctx.addCookies(saved);
            log(
              "SESSION",
              "AUTH",
              `Trying ${saved.length} saved cookies from ${COOKIE_FILE}...`,
            );
            if (await isLoggedIn(page)) {
              log("SESSION", "OK", "Session restored from saved cookies.");
              injected = true;
            }
          }
        } catch {
          /* corrupt or expired — fall through */
        }
      }

      if (!injected) {
        if (isHeadless) {
          throw new Error(
            "Authentication required: WarEra session cookies are expired or missing, and interactive login cannot be completed in headless background mode.\n" +
            "Please run 'npm run login' once in an interactive terminal to authenticate."
          );
        }

        log(
          "SESSION",
          "AUTH",
          "══════════════════════════════════════════════",
        );
        log(
          "SESSION",
          "AUTH",
          "  ACTION REQUIRED: Please log into warera.io  ",
        );
        log(
          "SESSION",
          "AUTH",
          "══════════════════════════════════════════════",
        );

        let loggedInManually = false;
        const start = Date.now();
        const POLL_MS = 2000;
        const TIMEOUT_MS = 3 * 60 * 1000;

        while (Date.now() - start < TIMEOUT_MS) {
          await sleep(POLL_MS);
          if (await isLoggedIn(page)) {
            loggedInManually = true;
            break;
          }
          const elapsed = Math.round((Date.now() - start) / 1000);
          if (elapsed % 30 < POLL_MS / 1000 + 1) {
            log(
              "SESSION",
              "AUTH",
              `Still waiting for login… (${elapsed}s / 3 min)`,
            );
          }
        }

        if (!loggedInManually) {
          throw new Error(
            "Login timeout — no login detected within 3 minutes. Please log into warera.io and restart.",
          );
        }

        // Save freshly-acquired session cookies
        const freshCookies = await ctx.cookies();
        const wareraCookies = freshCookies.filter((c) => (c.domain || "").includes("warera.io"));
        const cookieDir = path.dirname(COOKIE_FILE);
        if (!fs.existsSync(cookieDir)) {
          fs.mkdirSync(cookieDir, { recursive: true });
        }
        fs.writeFileSync(COOKIE_FILE, JSON.stringify(wareraCookies, null, 2));
        log(
          "SESSION",
          "OK",
          `Logged in. ${wareraCookies.length} cookies saved to ${COOKIE_FILE} for future runs.`,
        );
      }
    }

    return { browser, ctx, page };
  } catch (err) {
    if (browser) {
      await disconnectBrowser(browser, { terminate: isHeadless });
    }
    throw err;
  }
}

/**
 * Check whether the current session is authenticated
 */
async function isLoggedIn(page) {
  try {
    const currentUrl = page.url() || "";
    if (currentUrl.includes("/world") || currentUrl.includes("/companies") || currentUrl.includes("/battles")) {
      const fastCheck = await page.evaluate(() => !!document.getElementById("layoutUserMenu")).catch(() => false);
      if (fastCheck) return true;
    }

    await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const res = await page.evaluate(() => {
        if (document.getElementById("layoutUserMenu")) return true;
        const p = window.location.pathname;
        if (p === "/world" || p.startsWith("/companies") || p.startsWith("/battles") || p.startsWith("/market")) return true;
        return false;
      }).catch(() => false);
      if (res) return true;
    }

    try {
      const apiCheck = await page.evaluate(async (apiBase) => {
        try {
          const res = await fetch(`${apiBase}/user.getMe`, { credentials: "include" });
          if (!res.ok) return false;
          const data = await res.json();
          return !!(data[0]?.result?.data?.user?._id || data?.result?.data?.user?._id || data[0]?.result?.data?.username);
        } catch {
          return false;
        }
      }, API4_BASE);
      if (apiCheck) return true;
    } catch {}

    return false;
  } catch {
    return false;
  }
}

/**
 * Safely disconnect from CDP and optionally terminate headless browser process.
 */
export async function disconnectBrowser(browser, options = {}) {
  if (!browser) return;
  try {
    if (options.terminate) {
      try {
        const session = await browser.newBrowserCDPSession();
        await session.send("Browser.close");
      } catch {}
    }
    await browser.close();
  } catch {
    /* ignore disconnect error */
  }
}
