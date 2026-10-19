#!/usr/bin/env node

/**
 * WarEra Authentication & Session Refresh Utility
 *
 * Usage:
 *   npm run login               Launch browser window to log in and save cookies
 *   npm run login -- --status   Check current session validity and expiration
 *   npm run login -- --token <jwt> Directly update the session token in cookies.json
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { connect, disconnectBrowser } from "./browser.mjs";
import { COOKIE_FILE } from "./config.mjs";
import ui, { colors, icons, drawBox } from "./ui.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export function resolveCookiePath(customPath = null) {
  return customPath || process.env.WARERA_COOKIE_FILE || COOKIE_FILE;
}

/**
 * Inspect JWT token payload without external dependencies
 */
export function inspectJwt(jwtValue) {
  if (!jwtValue || typeof jwtValue !== "string") return null;
  const parts = jwtValue.split(".");
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    const expMs = payload.exp ? payload.exp * 1000 : null;
    const iatMs = payload.iat ? payload.iat * 1000 : null;
    const now = Date.now();
    return {
      userId: payload.data?._id || payload.userId || null,
      issuedAt: iatMs ? new Date(iatMs) : null,
      expiresAt: expMs ? new Date(expMs) : null,
      isValid: expMs ? now < expMs : true,
      expiresInMinutes: expMs && now < expMs ? Math.round((expMs - now) / 60000) : null,
      expiredMinutesAgo: expMs && now >= expMs ? Math.round((now - expMs) / 60000) : null,
    };
  } catch {
    return null;
  }
}

/**
 * Check current cookie status in cookies.json
 */
export function getStoredSessionStatus(customPath = null) {
  const targetPath = resolveCookiePath(customPath);
  if (!fs.existsSync(targetPath)) {
    return { status: "MISSING", message: `Cookie file not found at ${targetPath}` };
  }
  try {
    const raw = fs.readFileSync(targetPath, "utf8");
    const cookies = JSON.parse(raw);
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return { status: "EMPTY", message: "cookies.json contains no cookies" };
    }
    const jwt = cookies.find((c) => c.name === "jwt");
    if (!jwt || !jwt.value) {
      return { status: "NO_JWT", message: "No 'jwt' session cookie found in cookies.json" };
    }
    const info = inspectJwt(jwt.value);
    if (!info) {
      return { status: "MALFORMED", message: "JWT token in cookies.json is malformed" };
    }
    return {
      status: info.isValid ? "VALID" : "EXPIRED",
      ...info,
      totalCookies: cookies.length,
    };
  } catch (err) {
    return { status: "ERROR", message: err.message };
  }
}

/**
 * Directly update or insert the JWT token in cookies.json
 */
export function updateStoredJwt(token, customPath = null) {
  const targetPath = resolveCookiePath(customPath);
  const cleanToken = token.trim().replace(/^jwt=/i, "").replace(/;.*$/, "");
  const info = inspectJwt(cleanToken);
  if (!info) {
    throw new Error("Invalid JWT token format. Token must be a 3-part base64-encoded string.");
  }

  let cookies = [];
  if (fs.existsSync(targetPath)) {
    try {
      const raw = fs.readFileSync(targetPath, "utf8");
      cookies = JSON.parse(raw);
    } catch {
      cookies = [];
    }
  }
  if (!Array.isArray(cookies)) cookies = [];

  const existingIdx = cookies.findIndex((c) => c.name === "jwt");
  const expiresEpoch = info.expiresAt ? Math.floor(info.expiresAt.getTime() / 1000) : -1;
  const cookieEntry = {
    name: "jwt",
    value: cleanToken,
    domain: ".warera.io",
    path: "/",
    expires: expiresEpoch,
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
  };

  if (existingIdx >= 0) {
    cookies[existingIdx] = { ...cookies[existingIdx], ...cookieEntry };
  } else {
    cookies.push(cookieEntry);
  }

  fs.writeFileSync(targetPath, JSON.stringify(cookies, null, 2), "utf8");
  return info;
}

/**
 * CLI execution
 */
async function main() {
  const args = process.argv.slice(2);

  // 1. Status mode
  if (args.includes("--status") || args.includes("-s")) {
    drawBox("🔐  WarEra Session Status");
    const status = getStoredSessionStatus();
    if (status.status === "VALID") {
      ui.item("Status", colors.success("VALID"));
      if (status.userId) ui.subItem(`User ID:    ${status.userId}`);
      if (status.expiresAt) ui.subItem(`Expires at: ${status.expiresAt.toISOString()} (${status.expiresInMinutes}m remaining)`);
      if (status.totalCookies) ui.subItem(`Cookies:    ${status.totalCookies} stored`);
      process.exit(0);
    } else {
      ui.item("Status", colors.error(status.status));
      if (status.status === "EXPIRED") {
        ui.subItem(`User ID:    ${status.userId}`);
        ui.subItem(`Expired at: ${status.expiresAt?.toISOString()} (${status.expiredMinutesAgo}m ago)`);
        console.log(`\n${colors.warning("Your session has expired.")} Run ${colors.highlight("npm run login")} to re-authenticate.`);
      } else {
        ui.subItem(status.message);
        console.log(`\nRun ${colors.highlight("npm run login")} to establish a session.`);
      }
      process.exit(1);
    }
  }

  // 2. Direct token update mode
  const tokenIdx = args.findIndex((a) => a === "--token" || a === "-t");
  if (tokenIdx >= 0 && args[tokenIdx + 1]) {
    drawBox("🔐  WarEra Token Update");
    const token = args[tokenIdx + 1];
    try {
      const info = updateStoredJwt(token);
      ui.item("Session Token", colors.success("UPDATED"));
      if (info.userId) ui.subItem(`User ID:    ${info.userId}`);
      if (info.expiresAt) ui.subItem(`Expires at: ${info.expiresAt.toISOString()}`);
      if (info.isValid) {
        ui.subItem(colors.success(`Valid for the next ${info.expiresInMinutes} minutes.`));
      } else {
        ui.subItem(colors.warning(`Warning: Token appears to be expired (${info.expiredMinutesAgo}m ago).`));
      }
      console.log(`\n✓ Saved to ${COOKIE_FILE}`);
      process.exit(0);
    } catch (err) {
      ui.error(`Failed to update token: ${err.message}`);
      process.exit(1);
    }
  }

  // 3. Interactive Browser Login Mode
  drawBox("🔐  WarEra Browser Login");
  console.log("Opening Edge browser to authenticate with WarEra...\n");

  let browserInstance = null;
  try {
    const { browser, ctx, page } = await connect({ headless: false });
    browserInstance = browser;

    // Extract all cookies from active context
    const cookies = await ctx.cookies();
    const wareraCookies = cookies.filter((c) => (c.domain || "").includes("warera.io"));
    if (wareraCookies.length > 0) {
      fs.writeFileSync(COOKIE_PATH, JSON.stringify(wareraCookies, null, 2), "utf8");
    }

    const jwt = wareraCookies.find((c) => c.name === "jwt");
    const info = jwt ? inspectJwt(jwt.value) : null;

    console.log();
    ui.item("Authentication", colors.success("SUCCESS"));
    if (info?.userId) ui.subItem(`User ID:    ${info.userId}`);
    if (info?.expiresAt) ui.subItem(`Expires at: ${info.expiresAt.toISOString()}`);
    ui.subItem(`Cookies:    ${wareraCookies.length} saved to ${COOKIE_FILE}`);

    console.log(`\n✓ You can now run ${colors.highlight("npm run equipment-reseller")} or ${colors.highlight("npm run equipment-buyer")}.`);
  } catch (err) {
    ui.error(`Login failed: ${err.message}`);
    process.exit(1);
  } finally {
    if (browserInstance) {
      await disconnectBrowser(browserInstance);
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error("Unhandled error:", err);
    process.exit(1);
  });
}
