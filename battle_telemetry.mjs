#!/usr/bin/env node

/**
 * WarEra Battle Availability Telemetry Recorder (Productionized)
 * 
 * Periodically samples active WarEra battles via direct API inspection to track
 * whether a qualifying battle (Country + MU consensus) is available.
 * Accumulates real live telemetry in data/battle_availability/telemetry.jsonl.
 * 
 * Production Features:
 * - Single Instance Guarantee (telemetry.lock with PID checking & stale recovery)
 * - Error resilience with bounded exponential backoff
 * - Finite request timeouts (15s)
 * - Strictly sequential non-overlapping scans
 * - Heartbeat / health state maintenance (recorder_status.json)
 * - Enhanced --status report with recorder status, PID, and uptime
 * - Telemetry Watchdog (--health) with exit codes 0-3
 * - Graceful shutdown and atomic file operations
 * - Windows Task Scheduler service management
 * 
 * Usage:
 *   npm run battle-telemetry                   # Run continuous sampler daemon (default 5m)
 *   npm run battle-telemetry -- --interval=15m # Sample every 15 minutes
 *   npm run battle-telemetry -- --once         # Single scan and exit
 *   npm run battle-telemetry -- --status       # View recorder health & telemetry statistics
 *   npm run battle-telemetry -- --health       # Watchdog check (exits 0, 1, 2, 3)
 *   npm run battle-telemetry:install           # Register Windows Scheduled Task
 *   npm run battle-telemetry:uninstall         # Unregister Windows Scheduled Task
 */

import os from "os";
import chalk from "chalk";
import { visualWidth, visualPadEnd } from "./ui.mjs";
import { fetchMe, sleep } from "./analyzer/api.mjs";
import { scanLiveBattlesTelemetry, scanLiveQualifyingBattles } from "./analyzer/battle_windows.mjs";
import {
  recordTelemetrySample,
  loadTelemetrySamples,
  calculateObservedAvailability,
  generateSeedTelemetry,
  getTelemetryFilePath,
  getSyntheticFilePath,
  getLockFilePath,
  getStatusFilePath,
  resolveTelemetryContext,
  getLatestTelemetryContextSync,
} from "./analyzer/battle_telemetry.mjs";
import {
  acquireRecorderLock,
  releaseRecorderLock,
  getRecorderStatus,
  updateRecorderStatus,
  calculateBackoff,
  evaluateRecorderHealth,
  renderRecorderHeader,
  installWindowsTask,
  uninstallWindowsTask,
  queryWindowsTask,
} from "./analyzer/recorder_daemon.mjs";

const colors = {
  accent: chalk.hex("#00b4d8").bold,
  border: chalk.hex("#264653"),
  gold: chalk.hex("#e9c46a").bold,
  dim: chalk.gray,
  success: chalk.hex("#2a9d8f").bold,
  warning: chalk.hex("#f4a261").bold,
  error: chalk.hex("#e76f51").bold,
};

function parseInterval(val) {
  if (!val) return 300000; // 5m default
  const str = String(val).trim().toLowerCase();
  if (str.endsWith("m")) {
    const mins = parseFloat(str.replace("m", ""));
    return Math.max(30000, mins * 60000);
  }
  if (str.endsWith("s")) {
    const secs = parseFloat(str.replace("s", ""));
    return Math.max(30000, secs * 1000);
  }
  if (str.endsWith("h")) {
    const hrs = parseFloat(str.replace("h", ""));
    return Math.max(60000, hrs * 3600000);
  }
  const num = parseFloat(str);
  if (!isNaN(num)) {
    return Math.max(30000, num * 60000); // assume minutes
  }
  return 300000;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    intervalMs: 300000,
    intervalStr: "5m",
    once: false,
    status: false,
    health: false,
    installTask: false,
    uninstallTask: false,
    dryRun: false,
    seed: false,
    seedDays: 8.2,
    synthetic: false,
    telemetryContext: "current",
  };

  for (const arg of args) {
    if (arg === "--once") {
      options.once = true;
    } else if (arg === "--status") {
      options.status = true;
    } else if (arg === "--health") {
      options.health = true;
    } else if (arg === "--install-task" || arg === "--install") {
      options.installTask = true;
    } else if (arg === "--uninstall-task" || arg === "--uninstall") {
      options.uninstallTask = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--synthetic") {
      options.synthetic = true;
    } else if (arg.startsWith("--interval=")) {
      const val = arg.split("=")[1];
      options.intervalStr = val;
      options.intervalMs = parseInterval(val);
    } else if (arg.startsWith("--seed")) {
      options.seed = true;
      if (arg.includes("=")) {
        options.seedDays = parseFloat(arg.split("=")[1]) || 8.2;
      }
    } else if (arg.startsWith("--telemetry-context=")) {
      options.telemetryContext = arg.split("=")[1].trim();
    }
  }

  return options;
}

function renderStatusReport(metrics, synthMetrics = null, currentContext = null, recorderStatus = null) {
  // 1. Recorder Daemon Status Header
  renderRecorderHeader(recorderStatus);

  console.log();
  console.log(colors.accent(`📡 Historical Battle Telemetry Dataset`));
  console.log(colors.border(`  ${"─".repeat(66)}`));

  // Critical integrity warning if synthetic data contaminated live file
  if (metrics.syntheticDetectedInLive) {
    console.log(colors.error(`  ⚠ CRITICAL INTEGRITY WARNING: Synthetic data detected in production telemetry.jsonl!`));
    console.log(colors.dim(`    All synthetic records have been filtered out from calculations.`));
    console.log(colors.dim(`    Run data cleanup or inspect data/battle_availability/telemetry.jsonl.`));
    console.log(colors.border(`  ${"─".repeat(66)}`));
  }

  const liveCount = metrics.totalSamples || 0;
  const synthCount = synthMetrics?.totalSamples || 0;

  console.log(`  Live samples:              ${chalk.white.bold(liveCount.toLocaleString())}`);
  console.log(`  Synthetic test samples:    ${chalk.dim(synthCount.toLocaleString())} ${colors.dim(`(stored in synthetic.jsonl)`)}`);

  if (!metrics || !metrics.hasTelemetry || metrics.totalSamples === 0) {
    console.log();
    console.log(colors.warning(`  ⚠ No live historical battle telemetry found in telemetry.jsonl.`));
    console.log(`    Run ${chalk.cyan("npm run battle-telemetry")} to begin collecting historical samples.`);
    console.log(`    Or  ${chalk.cyan("npm run battle-telemetry -- --seed")} to generate synthetic test fixtures.`);
    console.log(colors.border(`  ${"─".repeat(66)}`));
    return;
  }

  const confColor = metrics.confidence === "HIGH" || metrics.confidence === "VERY HIGH"
    ? colors.success
    : metrics.confidence === "MODERATE"
    ? colors.warning
    : colors.error;

  console.log(`  First live observation:    ${chalk.dim(metrics.firstObservationTimestamp || "N/A")}`);
  console.log(`  Last live observation:     ${chalk.dim(metrics.lastObservationTimestamp || "N/A")}`);
  console.log();

  if (!metrics.hasEstablishedIntervals) {
    const stateColor = metrics.currentState?.includes("Qualifying") ? chalk.greenBright.bold : chalk.yellow;
    console.log(`  Current state:             ${stateColor(metrics.currentState || "Qualifying battle available")}`);
    console.log(`  Confirmed historical duration: ${chalk.white(metrics.confirmedHistoricalDuration || "0m")}`);
    console.log(`  Coverage:                  ${chalk.yellow(metrics.coverageDisplay || "Insufficient data")}`);
    console.log(`  Window duration:           ${chalk.dim(metrics.longestQualifyingWindow || "Not yet established")}`);
    console.log(`  Distinct battle windows:   ${chalk.dim("0 (Not yet established)")}`);
  } else {
    console.log(`  Wall-clock span:           ${chalk.white(`${metrics.wallClockDays} days`)} (${metrics.wallClockHours} hours)`);
    console.log(`  Confirmed historical duration: ${chalk.greenBright.bold(`${metrics.actualObservedDays} days`)} (${metrics.actualObservedHours} hours known)`);
    console.log(`  Unknown/offline:           ${metrics.unknownDurationHours > 0 ? chalk.yellow(`${metrics.unknownDurationDays} days (${metrics.unknownDurationHours}h)`) : colors.dim("0 hours (Continuous)")}`);
    console.log();
    console.log(`  Qualifying battle time:    ${chalk.greenBright(`${metrics.qualifyingDurationHours} hours`)}`);
    console.log(`  Known non-battle time:     ${chalk.white(`${metrics.lullDurationHours} hours`)}`);
    console.log(`  Coverage:                  ${chalk.greenBright.bold(`${metrics.observedCoveragePct}%`)} ${colors.dim(`(qualifying / known time)`)}`);
    console.log();
    console.log(`  Window duration:           ${chalk.cyan(metrics.longestQualifyingWindow)}`);
    console.log(`  Longest known lull:        ${chalk.yellow(metrics.longestLull)}`);
    console.log(`  Distinct battle windows:   ${chalk.white(metrics.distinctBattleWindowsCount)}`);
  }
  console.log();

  if (currentContext) {
    if (currentContext.all) {
      console.log(colors.warning(`  ⚠ Combining battle telemetry from multiple Country/MU contexts. This may not represent the current battle environment.`));
      console.log(`  Telemetry context:`);
      console.log(`    Mode:                    ${chalk.yellow("ALL CONTEXTS COMBINED")}`);
    } else {
      console.log(`  Telemetry context:`);
      console.log(`    Country:                 ${chalk.dim(currentContext.countryId || "None")}`);
      console.log(`    MU:                      ${chalk.dim(currentContext.muId || "None")}`);
    }
  }

  console.log(`  Confidence:                ${confColor(metrics.confidence)} ${colors.dim(metrics.isSufficient ? "(Sufficient for build simulation: >= 24h)" : "(Insufficient: < 24h)")}`);
  console.log(colors.border(`  ${"─".repeat(66)}`));

  // Hourly coverage table (only shown when real intervals exist)
  if (metrics.hasEstablishedIntervals && metrics.coverageByHourOfDay?.length > 0) {
    console.log();
    console.log(colors.accent(`🕒 Coverage by Hour of Day (24h Distribution)`));
    console.log(colors.border(`  ${"─".repeat(66)}`));
    const row1 = metrics.coverageByHourOfDay.slice(0, 12);
    const row2 = metrics.coverageByHourOfDay.slice(12, 24);

    const formatBucket = (b) => {
      const h = String(b.hour).padStart(2, "0");
      const p = Math.round(b.coveragePct);
      return `${h}h:${String(p).padStart(2)}%`;
    };

    console.log(`  ${row1.map(formatBucket).join(" ")}`);
    console.log(`  ${row2.map(formatBucket).join(" ")}`);
    console.log(colors.border(`  ${"─".repeat(66)}`));
  }
}

async function performScan(options, cachedContext = null) {
  let playerCountryId = cachedContext?.countryId || null;
  let playerMuId = cachedContext?.muId || null;
  let playerName = cachedContext?.playerName || "Player";

  const now = Date.now();
  // Refresh player context if not yet cached or if older than 1 hour
  if (!playerCountryId || !cachedContext?.lastChecked || (now - cachedContext.lastChecked > 3600000)) {
    try {
      const meData = await fetchMe();
      const u = meData.user || {};
      playerCountryId = u.citizenship || u.country || null;
      playerMuId = u.militaryUnit || u.mu || null;
      playerName = u.username || "Player";
      if (cachedContext) {
        cachedContext.countryId = playerCountryId;
        cachedContext.muId = playerMuId;
        cachedContext.playerName = playerName;
        cachedContext.lastChecked = now;
      }
    } catch (err) {
      // If cached context exists, fall back to it; else throw error to trigger retry
      if (!playerCountryId) {
        throw new Error(`Failed to resolve player context: ${err.message}`);
      }
    }
  }

  // Schema v2: full active battle snapshot with damage bonuses and selector rankings
  let live;
  try {
    live = await scanLiveBattlesTelemetry(playerCountryId, playerMuId);
  } catch (err) {
    // Fallback to v1 scan if v2 fails (e.g. getDamageBonuses endpoint issues)
    const v1 = await scanLiveQualifyingBattles(playerCountryId, playerMuId);
    live = {
      qualifyingBattles: v1.qualifyingBattles,
      activeBattles: [],
      totalActiveBattles: v1.totalActiveBattles || v1.qualifyingBattles.length,
      qualifyingBattlesCount: v1.qualifyingBattles.length,
      hasQualifyingBattle: v1.qualifyingBattles.length > 0,
      selectedBattleId: v1.qualifyingBattles[0]?.battleId || null,
    };
  }

  const hasQualifying = live.hasQualifyingBattle ?? live.qualifyingBattles.length > 0;

  const samplePayload = {
    timestamp: new Date().toISOString(),
    source: "live",
    samplingIntervalMs: options.intervalMs,
    playerCountryId,
    playerMuId,
    totalActiveBattles: live.totalActiveBattles,
    qualifyingBattlesCount: live.qualifyingBattlesCount ?? live.qualifyingBattles.length,
    hasQualifyingBattle: hasQualifying,
    selectedBattleId: live.selectedBattleId || null,
    activeBattles: live.activeBattles || [],
    qualifyingBattles: live.qualifyingBattles || [],
  };

  const recordResult = await recordTelemetrySample(samplePayload, {
    intervalMs: options.intervalMs,
  });

  return {
    playerName,
    playerCountryId,
    playerMuId,
    live,
    hasQualifying,
    recordResult,
  };
}

async function main() {
  const options = parseArgs();

  // Mode 1: Task Scheduler Installation
  if (options.installTask) {
    console.log(colors.accent(`⚙ Installing WarEra Battle Telemetry Windows Task...`));
    try {
      const res = installWindowsTask({ dryRun: options.dryRun });
      if (res.dryRun) {
        console.log(colors.success(`✓ Task Scheduler XML definition generated successfully (Dry Run).`));
        console.log(colors.dim(`  Task Name: ${res.taskName}`));
      } else {
        console.log(colors.success(`✓ Scheduled Task "${res.taskName}" installed successfully.`));
        console.log(colors.dim(`  The telemetry daemon will now start automatically at user logon.`));
        console.log(colors.dim(`  To view status anytime: npm run battle-telemetry -- --status`));
        console.log(colors.dim(`  To uninstall:           npm run battle-telemetry:uninstall`));
      }
    } catch (err) {
      console.error(colors.error(`\n✖ Task installation failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  // Mode 2: Task Scheduler Uninstallation
  if (options.uninstallTask) {
    console.log(colors.accent(`⚙ Removing WarEra Battle Telemetry Windows Task...`));
    try {
      const res = uninstallWindowsTask({ dryRun: options.dryRun });
      if (res.dryRun) {
        console.log(colors.success(`✓ Task uninstaller validated successfully (Dry Run).`));
      } else {
        console.log(colors.success(`✓ Scheduled Task "${res.taskName}" removed successfully.`));
      }
    } catch (err) {
      console.error(colors.error(`\n✖ Task removal failed: ${err.message}`));
      process.exit(1);
    }
    return;
  }

  // Mode 3: Telemetry Watchdog Health Check (--health)
  if (options.health) {
    const status = getRecorderStatus();
    const liveSamples = await loadTelemetrySamples({ onlyLive: true });
    const health = evaluateRecorderHealth(status, liveSamples);

    if (health.code === 0) {
      console.log(colors.success(`✓ [HEALTHY] ${health.message}`));
      console.log(colors.dim(`  ${health.details}`));
    } else if (health.code === 1) {
      console.log(colors.error(`✖ [OFFLINE] ${health.message}`));
      console.log(colors.dim(`  ${health.details}`));
    } else if (health.code === 2) {
      console.log(colors.warning(`⚠ [STALE] ${health.message}`));
      console.log(colors.dim(`  ${health.details}`));
    } else {
      console.log(colors.error(`✖ [FAILURES] ${health.message}`));
      console.log(colors.dim(`  ${health.details}`));
    }

    process.exit(health.code);
  }

  // Mode 4: Seed synthetic dataset (EXCLUSIVELY writes to synthetic.jsonl)
  if (options.seed) {
    console.log(colors.accent(`🌱 Seeding realistic synthetic battle telemetry (${options.seedDays} days)...`));
    console.log(colors.dim(`  Safety Notice: Synthetic fixtures are isolated in synthetic.jsonl and NEVER touch telemetry.jsonl.`));
    let playerContext = {};
    try {
      const meData = await fetchMe();
      const u = meData.user || {};
      playerContext = {
        countryId: u.citizenship || u.country,
        muId: u.militaryUnit || u.mu,
      };
    } catch {}

    const seedRes = await generateSeedTelemetry(options.seedDays, playerContext);
    console.log(colors.success(`✓ Generated ${seedRes.samplesCount.toLocaleString()} synthetic samples over ${seedRes.seededDays} days.`));
    console.log(colors.dim(`  Saved to: ${seedRes.filePath}`));
    
    const synthSamples = await loadTelemetrySamples({ synthetic: true, onlyLive: false });
    const metrics = calculateObservedAvailability(synthSamples);
    console.log();
    console.log(colors.accent(`📊 Synthetic Test Dataset Summary:`));
    console.log(`  Total Synthetic Samples:   ${chalk.cyan(metrics.totalSamples.toLocaleString())}`);
    console.log(`  Synthetic Observed Time:   ${chalk.greenBright(`${metrics.actualObservedHours} hours`)}`);
    console.log(`  Synthetic Coverage:        ${chalk.greenBright.bold(`${metrics.observedCoveragePct}%`)}`);
    console.log(`  Longest Window:            ${chalk.cyan(metrics.longestQualifyingWindow)} | Longest Lull: ${chalk.yellow(metrics.longestLull)}`);
    return;
  }

  // Mode 5: View status report
  if (options.status) {
    let currentContext = null;
    try {
      const meData = await fetchMe();
      const u = meData.user || {};
      currentContext = {
        countryId: u.citizenship || u.country,
        muId: u.militaryUnit || u.mu,
      };
    } catch {}
    if (!currentContext?.countryId && !currentContext?.muId) {
      currentContext = getLatestTelemetryContextSync();
    }

    const resolvedContext = resolveTelemetryContext(options.telemetryContext, currentContext);
    const recorderStatus = getRecorderStatus();

    if (options.synthetic) {
      console.log(colors.dim(`Reading synthetic test dataset from synthetic.jsonl...`));
      const synthSamples = await loadTelemetrySamples({ synthetic: true, onlyLive: false, context: resolvedContext });
      const synthMetrics = calculateObservedAvailability(synthSamples, { context: resolvedContext });
      renderStatusReport(synthMetrics, null, resolvedContext, recorderStatus);
      return;
    }

    const liveSamples = await loadTelemetrySamples({ onlyLive: true, context: resolvedContext });
    const liveMetrics = calculateObservedAvailability(liveSamples, { context: resolvedContext });

    let synthMetrics = null;
    try {
      const synthSamples = await loadTelemetrySamples({ synthetic: true, onlyLive: false });
      synthMetrics = calculateObservedAvailability(synthSamples);
    } catch {}

    renderStatusReport(liveMetrics, synthMetrics, resolvedContext, recorderStatus);
    return;
  }

  // Mode 6: Single live scan
  if (options.once) {
    process.stdout.write("📡 Scanning active WarEra battles for Country & MU consensus... ");
    const result = await performScan(options);
    console.log(colors.success("✓"));

    const qCount = result.live.qualifyingBattles?.length || 0;
    const totalActive = result.live.totalActiveBattles || 0;
    console.log();
    console.log(`  Player:             ${chalk.white.bold(result.playerName)}`);
    console.log(`  Country:            ${chalk.dim(result.playerCountryId || "None")} | MU: ${chalk.dim(result.playerMuId || "None")}`);
    console.log(`  Active Battles:     ${chalk.cyan(totalActive)} scanned`);
    console.log(`  Qualifying Battles: ${qCount > 0 ? colors.success(`${qCount} open right now`) : colors.warning("0 (Inter-battle lull)")}`);
    if (result.live.selectedBattleId) {
      console.log(`  Selected Target:    ${chalk.white.bold(result.live.selectedBattleId)}`);
    }

    if (qCount > 0 && result.live.qualifyingBattles) {
      for (const b of result.live.qualifyingBattles) {
        const type = (b.type || b.battleType || "regular").toUpperCase();
        const side = (b.orderedSide || b.resolvedSide || "attacker").toUpperCase();
        console.log(`    • Battle ${chalk.white.bold(b.battleId)} [${type}] → Side: ${chalk.greenBright.bold(side)}`);
      }
    }

    // Show v2 active battles with damage bonuses if available
    if (result.live.activeBattles?.length > 0) {
      console.log();
      console.log(colors.accent(`  📊 Active Battle Snapshots (Schema v2):`));
      for (const ab of result.live.activeBattles) {
        const eligible = ab.selectorEligible ? chalk.greenBright("✓") : chalk.dim("✗");
        const bonus = typeof ab.damageBonusPercent === "number" ? `+${ab.damageBonusPercent}%` : "N/A";
        const rank = ab.selectorRank ? `#${ab.selectorRank}` : "-";
        const skipReason = ab.selectorSkipReason ? chalk.dim(` (${ab.selectorSkipReason})`) : "";
        console.log(`    ${eligible} ${chalk.white(ab.battleId)} ${chalk.cyan(bonus)} bounty:${ab.bountyRate || 0} rank:${rank}${skipReason}`);
      }
    }

    console.log(colors.dim(`\n  Schema: v2 | Hostname: ${os.hostname()}`));

    if (result.recordResult.recorded) {
      console.log(colors.success(`\n✓ Recorded new live telemetry observation to ${getTelemetryFilePath()}`));
      console.log(colors.dim(`  Source: live | Interval: ${options.intervalStr} | Metadata tagged.`));
    } else {
      console.log(colors.dim(`\nℹ Skipped recording: Identical live state already recorded ${Math.round(result.recordResult.elapsedMs / 1000)}s ago.`));
    }

    const allSamples = await loadTelemetrySamples({ onlyLive: true });
    console.log(colors.dim(`  Total real live samples in production dataset: ${allSamples.length}`));
    return;
  }

  // Mode 7: Continuous Daemon Loop (Production Operation)
  // 1. Single instance guarantee
  const lockRes = acquireRecorderLock();
  if (!lockRes.acquired) {
    console.log(colors.warning(`\n⚠ Another WarEra Battle Telemetry recorder is already running.`));
    console.log(`  Active PID:   ${chalk.white.bold(lockRes.lock?.pid || "Unknown")}`);
    console.log(`  Started at:   ${chalk.dim(lockRes.lock?.startedAt || "N/A")}`);
    console.log(`  Host:         ${chalk.dim(lockRes.lock?.hostname || os.hostname())}`);
    console.log(`  Lock file:    ${colors.dim(getLockFilePath())}`);
    console.log(colors.dim(`\nExiting cleanly. Only one recorder daemon may run at a time to prevent duplicate observations.\n`));
    process.exit(1);
  }

  if (lockRes.staleRecovered) {
    if (lockRes.crossHostRecovered) {
      console.log(colors.dim(`ℹ Safely recovered cross-host stale lock from ${lockRes.staleHostname || "unknown host"} PID ${lockRes.stalePid}.`));
    } else {
      console.log(colors.dim(`ℹ Safely recovered stale lock from dead PID ${lockRes.stalePid}.`));
    }
  }

  // 2. Setup graceful shutdown handling
  let isRunning = true;
  const shutdown = (signal) => {
    if (!isRunning) return;
    isRunning = false;
    console.log(colors.warning(`\nShutting down battle telemetry recorder (${signal})...`));
    try {
      updateRecorderStatus({
        running: false,
        stoppedAt: new Date().toISOString(),
      });
      releaseRecorderLock();
      console.log(colors.success(`✓ Recorder stopped cleanly. Lock released.\n`));
    } catch {}
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));

  // 3. Initialize recorder status state
  const startedAt = new Date().toISOString();
  updateRecorderStatus({
    running: true,
    pid: process.pid,
    startedAt,
    lastAttemptAt: startedAt,
    samplingIntervalMs: options.intervalMs,
    consecutiveFailures: 0,
    lastError: null,
    nextSampleAt: startedAt,
  });

  // 4. Print clean startup banner
  const bannerLines = [
    colors.accent("📡  WARERA BATTLE AVAILABILITY TELEMETRY RECORDER DAEMON"),
    `PID:               ${chalk.white.bold(String(process.pid))} (Single-instance lock acquired)`,
    `Sampling Interval: ${chalk.cyan.bold(options.intervalStr)} (${Math.round(options.intervalMs / 1000)}s)`,
    `Storage File:      ${colors.dim(getTelemetryFilePath())}`,
    `Heartbeat Status:  ${colors.dim(getStatusFilePath())}`,
    `Lock File:         ${colors.dim(getLockFilePath())}`,
    `Dataset Mode:      ${colors.success("LIVE OBSERVATIONS ONLY (Resilient & Bounded)")}`,
    `Press ${chalk.yellow("Ctrl+C")} to stop recorder cleanly.`,
  ];

  const maxContentWidth = Math.max(...bannerLines.map((l) => visualWidth(l)));
  const innerWidth = Math.max(88, maxContentWidth + 2);

  console.log(colors.border(`╭${"─".repeat(innerWidth)}╮`));
  for (let i = 0; i < bannerLines.length; i++) {
    if (i === 1) console.log(colors.border(`├${"─".repeat(innerWidth)}┤`));
    console.log(colors.border("│") + visualPadEnd(` ${bannerLines[i]}`, innerWidth) + colors.border("│"));
  }
  console.log(colors.border(`╰${"─".repeat(innerWidth)}╯`));
  console.log();

  // 5. Sequential Non-Overlapping Scan Loop
  let consecutiveFailures = 0;
  let scanCount = 0;
  const cachedContext = { countryId: null, muId: null, playerName: null, lastChecked: 0 };

  while (isRunning) {
    scanCount++;
    const nowIso = new Date().toISOString();
    updateRecorderStatus({ lastAttemptAt: nowIso });

    let delayMs = options.intervalMs;

    try {
      // Strictly sequential: current scan finishes completely before next sleep is scheduled
      const res = await performScan(options, cachedContext);
      consecutiveFailures = 0;

      const nowTime = new Date().toLocaleTimeString();
      const nextTime = new Date(Date.now() + options.intervalMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

      if (res.hasQualifying) {
        const q = res.live.qualifyingBattles[0];
        console.log(
          `\n${colors.success(`✓ ${nowTime}  Qualifying battle available`)}\n` +
          `  Battle:    ${chalk.white.bold(q.battleId)} [${(q.type || "regular").toUpperCase()}]\n` +
          `  Side:      ${chalk.greenBright.bold((q.orderedSide || "attacker").toUpperCase())}\n` +
          `  Next scan: ${chalk.dim(nextTime)}`
        );
      } else {
        console.log(
          `• ${nowTime}  No qualifying battle (Inter-battle lull) | Next scan: ${chalk.dim(nextTime)}`
        );
      }

      updateRecorderStatus({
        lastSuccessfulSampleAt: new Date().toISOString(),
        nextSampleAt: new Date(Date.now() + options.intervalMs).toISOString(),
        consecutiveFailures: 0,
        lastError: null,
      });

      delayMs = options.intervalMs;
    } catch (err) {
      consecutiveFailures++;
      delayMs = calculateBackoff(consecutiveFailures);
      const retrySec = Math.round(delayMs / 1000);
      const nextTime = new Date(Date.now() + delayMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

      console.log(
        colors.warning(`\n⚠ ${new Date().toLocaleTimeString()}  WarEra API unavailable (${err.message})`) +
        `\n  Retry in ${chalk.yellow(`${retrySec}s`)} at ${chalk.dim(nextTime)} (consecutive failure #${chalk.red(consecutiveFailures)})`
      );

      if (process.env.DEBUG) {
        console.error(err.stack);
      }

      updateRecorderStatus({
        consecutiveFailures,
        lastError: err.message,
        nextSampleAt: new Date(Date.now() + delayMs).toISOString(),
      });
    }

    if (!isRunning) break;
    await sleep(delayMs);
  }
}

main().catch(err => {
  console.error(colors.error(`Fatal telemetry error: ${err.message}`));
  try {
    updateRecorderStatus({ running: false, lastError: err.message });
    releaseRecorderLock();
  } catch {}
  process.exit(1);
});
