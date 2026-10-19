#!/usr/bin/env node

/**
 * WarEra Build + Skill Analyzer CLI
 * 
 * Determines the strongest optimized combat setup for each player level
 * combining empirical leaderboard evidence, exact mathematical theoretical optimization,
 * and a full sustained combat resource economy optimizer.
 */

import chalk from "chalk";
import { colors, icons, drawBox, visualPadEnd } from "./ui.mjs";
import { collectTopPlayers, getGameConfig, getAllCachedPlayers, getCachedPlayer } from "./analyzer/collector.mjs";
import { analyzeLevel, analyzeRange, analyzeMyBuild, compareBuilds } from "./analyzer/optimizer.mjs";
import { ACTIVITY_PRESETS } from "./analyzer/sustain_model.mjs";
import { fetchMe } from "./analyzer/api.mjs";
import { resolveTelemetryContext, getLatestTelemetryContextSync } from "./analyzer/battle_telemetry.mjs";

/**
 * Parse CLI command line flags
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    level: null,
    minLevel: null,
    maxLevel: null,
    me: false,
    refresh: false,
    collectCount: 250,
    compare: null,
    objective: "damage",
    gear: "average",
    hours: null,
    days: null,
    bread: null,
    activity: "active",
    telemetryContext: "current",
  };

  for (const arg of args) {
    if (arg.startsWith("--level=")) {
      options.level = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--min-level=")) {
      options.minLevel = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--max-level=")) {
      options.maxLevel = parseInt(arg.split("=")[1], 10);
    } else if (arg === "--me") {
      options.me = true;
    } else if (arg === "--refresh") {
      options.refresh = true;
    } else if (arg.startsWith("--collect=")) {
      options.collectCount = parseInt(arg.split("=")[1], 10);
    } else if (arg.startsWith("--compare=")) {
      options.compare = arg.split("=")[1].split(",");
    } else if (arg.startsWith("--objective=")) {
      options.objective = arg.split("=")[1].toLowerCase();
    } else if (arg.startsWith("--gear=")) {
      options.gear = arg.split("=")[1];
    } else if (arg.startsWith("--hours=")) {
      options.hours = parseFloat(arg.split("=")[1]);
    } else if (arg.startsWith("--days=")) {
      options.days = parseFloat(arg.split("=")[1]);
    } else if (arg.startsWith("--bread=")) {
      const val = arg.split("=")[1];
      options.bread = val.toLowerCase() === "unlimited" ? Infinity : parseInt(val, 10);
    } else if (arg.startsWith("--activity=")) {
      options.activity = arg.split("=")[1].toLowerCase();
    } else if (arg.startsWith("--battle-availability=")) {
      options.battleAvailability = arg.split("=")[1].trim();
    } else if (arg.startsWith("--telemetry-context=")) {
      options.telemetryContext = arg.split("=")[1].trim();
    }
  }

  // If objective is "weekly", default days to 7 unless explicitly provided
  if (options.objective === "weekly" && !options.days && !options.hours) {
    options.days = 7;
  }

  return options;
}

/**
 * Draw a clean section header
 */
function drawHeader(title, icon = "", width = 68) {
  const content = icon ? `${icon}  ${title}` : title;
  const innerWidth = width - 2;
  const padded = visualPadEnd(` ${content}`, innerWidth);

  console.log();
  console.log(colors.border(`╭${"─".repeat(width - 2)}╮`));
  console.log(colors.border(`│`) + colors.accent(padded) + colors.border(`│`));
  console.log(colors.border(`╰${"─".repeat(width - 2)}╯`));
}

/**
 * Render a single level analysis report
 */
function renderLevelReport(report, options = {}) {
  if (report.error) {
    console.log(colors.warning(`\n⚠ ${report.error}`));
    return;
  }

  const sampleLabel = report.isExpanded
    ? `Levels ${report.bracket[0]}-${report.bracket[1]} (Exact: ${report.exactCount})`
    : `Exact level (${report.sampleSize} players)`;

  const confColor =
    report.confidence === "HIGH"
      ? colors.success
      : report.confidence === "MODERATE"
      ? colors.warning
      : colors.error;

  drawHeader(`Level ${report.level} Combat Optimization`, "🧠", 68);
  console.log(`   Players Sampled:  ${chalk.white.bold(report.sampleSize)} (${sampleLabel})`);
  console.log(`   Sample Quality:   ${confColor(report.confidence)}`);
  console.log(`   Archetype:        ${colors.gold(report.archetype)}`);
  console.log(
    `   Weekly Dmg:       Median: ${chalk.cyan(
      report.damageBenchmarks.median.toLocaleString()
    )} | Top 10%: ${chalk.cyanBright(report.damageBenchmarks.p90.toLocaleString())}`
  );

  // ==========================================================
  // PLAY HORIZON & ACTIVITY PROFILE DETAILS
  // ==========================================================
  const sus = report.sustainedTheoretical?.sustainProfile || report.theoretical?.sustainProfile;
  if (sus) {
    const act = ACTIVITY_PRESETS[sus.activityPreset] || ACTIVITY_PRESETS.active;
    const breadLabel = sus.breadLimit === Infinity ? "Unlimited (capped only by Hunger)" : `${sus.breadLimit} breads`;
    console.log(`   Optimization Obj: ${chalk.magentaBright.bold(options.objective ? options.objective.toUpperCase() : "WEEKLY / SUSTAINED")}`);
    console.log(`   Time Horizon:     ${chalk.yellowBright(`${sus.durationHours} hours`)} (${sus.durationDays} days)`);
    console.log(`   Activity Profile: ${chalk.white.bold(act.name)} ${colors.dim(`[Utilization: ${Math.round(sus.activityFactor * 100)}%]`)}`);
    console.log(`   Battle Windows:   ${chalk.cyanBright.bold(sus.schedule?.label || "Unlimited (100%)")}`);
    if (sus.schedule?.isAssumption) {
      console.log(`   Model Basis:      ${colors.warning("Configured Assumption")} ${colors.dim(`(User-specified ${sus.schedule.coveragePct}% window)`)}`);
    } else if (sus.schedule?.isHistoricalTimeline) {
      console.log(`   Model Basis:      ${colors.success("Real Recorded Battle Windows")} ${colors.dim(`(${sus.schedule.coveragePct}% observed coverage over ${sus.schedule.telemetryMetrics?.observationPeriodDays} days)`)}`);
    } else if (sus.schedule?.insufficient) {
      console.log(`   Model Basis:      ${colors.warning("Insufficient Historical Telemetry")} ${colors.dim(`(< 24h of recorded samples)`)}`);
    }
    console.log(`   Food Allowance:   ${chalk.cyan(breadLabel)}`);
    console.log(`   Activity Model:   ${colors.dim(act.description)}`);

    // Historical Battle Availability Block
    if (sus.schedule?.isHistoricalTimeline && sus.schedule.telemetryMetrics) {
      const tm = sus.schedule.telemetryMetrics;
      const ctx = sus.schedule.context || options.context || tm.context;
      const ctxCountry = ctx?.all ? "All / Mixed" : (ctx?.countryId || "None");
      const ctxMu = ctx?.all ? "All / Mixed" : (ctx?.muId || "None");

      console.log();
      console.log(colors.accent(`📡 Historical Battle Availability`));
      console.log(colors.border(`  ${"─".repeat(66)}`));
      if (ctx?.all) {
        console.log(colors.warning(`  ⚠ Combining battle telemetry from multiple Country/MU contexts. This may not represent the current battle environment.`));
        console.log(colors.border(`  ${"─".repeat(66)}`));
      }
      console.log(`  Telemetry context:`);
      console.log(`    Country:                 ${chalk.dim(ctxCountry)}`);
      console.log(`    MU:                      ${chalk.dim(ctxMu)}`);
      console.log(`  Data source:               ${chalk.greenBright.bold("LIVE RECORDED TELEMETRY")}`);
      console.log(`  Sample count:              ${chalk.cyan(tm.totalSamples.toLocaleString())}`);
      console.log(`  Confirmed duration:        ${chalk.white.bold(`${tm.actualObservedDays} days`)} (${tm.actualObservedHours} hours known)`);
      console.log(`  Unknown/offline duration:  ${tm.unknownDurationHours > 0 ? chalk.yellow(`${tm.unknownDurationDays} days (${tm.unknownDurationHours}h)`) : colors.dim("0 hours (Continuous)")}`);
      console.log(`  Qualifying battle time:    ${chalk.greenBright(`${tm.qualifyingDurationHours} hours`)}`);
      console.log(`  Known non-battle time:     ${chalk.white(`${tm.lullDurationHours} hours`)}`);
      console.log(`  Observed coverage:         ${chalk.greenBright.bold(`${tm.observedCoveragePct}%`)} (qualifying / known time)`);
      console.log(`  Longest battle window:     ${chalk.cyan(tm.longestQualifyingWindow)}`);
      console.log(`  Longest lull:              ${chalk.yellow(tm.longestLull)}`);
      console.log(`  Confidence:                ${colors.success(tm.confidence)}`);
      console.log();
      console.log(colors.accent(`📊 Build Optimization`));
      console.log(colors.border(`  ${"─".repeat(66)}`));
      console.log(`  Using:                     ${chalk.greenBright.bold("REAL RECORDED BATTLE WINDOWS")}`);
      console.log(`  (replaying exact sequence of historical windows via event-based simulation)`);
    } else if (sus.schedule?.insufficient) {
      const tm = sus.schedule.telemetryMetrics;
      const ctx = sus.schedule.context || options.context || tm?.context;
      const ctxCountry = ctx?.all ? "All / Mixed" : (ctx?.countryId || "None");
      const ctxMu = ctx?.all ? "All / Mixed" : (ctx?.muId || "None");

      console.log();
      console.log(colors.accent(`📡 Historical Battle Availability`));
      console.log(colors.border(`  ${"─".repeat(66)}`));
      if (ctx?.all) {
        console.log(colors.warning(`  ⚠ Combining battle telemetry from multiple Country/MU contexts. This may not represent the current battle environment.`));
        console.log(colors.border(`  ${"─".repeat(66)}`));
      }
      console.log(`  Telemetry context:`);
      console.log(`    Country:                 ${chalk.dim(ctxCountry)}`);
      console.log(`    MU:                      ${chalk.dim(ctxMu)}`);
      console.log(`  Data source:               ${chalk.greenBright.bold("LIVE RECORDED TELEMETRY")}`);
      console.log(`  Sample count:              ${chalk.cyan((tm?.totalSamples || 0).toLocaleString())}`);
      console.log(`  Confirmed duration:        ${chalk.white.bold(`${tm?.actualObservedDays || 0} days`)} (${tm?.actualObservedHours || 0} hours known)`);
      console.log(`  Coverage:                  ${chalk.yellow(tm?.coverageDisplay || "Insufficient data")}`);
      console.log(`  Confidence:                ${colors.error(tm?.confidence || "VERY LOW")}`);
      console.log(colors.warning(`  ⚠ Insufficient historical battle telemetry.`));
      if (!tm?.hasEstablishedIntervals) {
        console.log(`    Current state:                 ${chalk.greenBright(tm?.currentState || "Qualifying battle available")}`);
        console.log(`    Window duration:               ${chalk.dim(tm?.longestQualifyingWindow || "Not yet established")}`);
      } else {
        console.log(colors.dim(`    Current dataset has ${tm?.totalSamples || 0} sample(s) (< 24 hours of observation).`));
      }
      console.log(colors.dim(`    WarEra does not preserve historical order logs, so telemetry is accumulated locally.`));
      console.log(`    To begin recording historical samples, run:`);
      console.log(`      ${chalk.cyan("npm run battle-telemetry")}`);
      console.log();
      console.log(colors.accent(`📊 Scenario Estimates (Assumptions)`));
      console.log(colors.border(`  ${"─".repeat(66)}`));
      console.log(
        colors.dim(
          `  ${"Scenario / Availability".padEnd(34)} ${"Weekly Hits".padStart(14)} ${"Expected Damage".padStart(16)}`
        )
      );
      console.log(colors.border(`  ${"─".repeat(66)}`));
      for (const sc of (report.threeWayComparison?.scenarioProjections || [])) {
        console.log(
          `  ${chalk.white(sc.scenario.padEnd(34))} ${chalk.cyan(
            `${sc.hits.toLocaleString()} hits`.padStart(14)
          )} ${chalk.greenBright(sc.totalDamage.toLocaleString().padStart(16))}`
        );
      }
      console.log(colors.border(`  ${"─".repeat(66)}`));
      console.log(
        colors.dim(
          `  * Note: The above projections are hypothetical assumptions. Run with\n    --battle-availability=25%, 50%, or unlimited to optimize under a specific assumption.`
        )
      );
    }

    // Real Battle Window Throughput & Resource Storage
    if (sus.isRealisticSim) {
      console.log();
      console.log(colors.accent(`⏳ Battle Availability & Resource Storage Model`));
      console.log(colors.border(`  ${"─".repeat(66)}`));
      console.log(`  ${chalk.white.bold("Resource capacity:")}`);
      console.log(`    Health-derived hits:        ${chalk.cyan(`${sus.resourceLimitedHits} hits`)}`);
      console.log(`  ${chalk.white.bold("Eligible battle capacity:")}`);
      console.log(`    Estimated available hits:   ${chalk.greenBright(`${sus.battleWindowCapacity} hits`)}`);
      console.log(`  ${chalk.white.bold("Actual modeled hits:")}          ${chalk.greenBright.bold(`${sus.actualPossibleHits} hits`)}`);
      console.log();
      console.log(`  Health-limited loss:          ${chalk.dim("0")}`);
      console.log(`  Battle-window loss:           ${sus.battleWindowLoss > 0 ? chalk.yellow(`${sus.battleWindowLoss} hits`) : colors.dim("0")}`);
      console.log(`  HP regen wasted at cap:       ${sus.hpRegenWastedAtCap > 0 ? chalk.yellow(`${sus.hpRegenWastedAtCap} HP`) : colors.dim("0 HP")}`);
      if (sus.hungerRegenWastedAtCap > 0) {
        console.log(`  Hunger wasted at cap:         ${chalk.yellow(`${sus.hungerRegenWastedAtCap} pts`)}`);
      }
      console.log();
      console.log(`  Expected damage/hit:          ${chalk.greenBright(report.theoretical.expectedDamage.toLocaleString())}`);
      console.log(`  Expected weekly damage:       ${chalk.greenBright.bold(report.theoretical.expectedTotalDamage.toLocaleString())}`);
    }
  }

  // ==========================================================
  // 1. 3-WAY BUILD COMPARISON: PER-HIT vs SUSTAINED vs LEADERBOARD
  // ==========================================================
  if (report.threeWayComparison) {
    const cmp = report.threeWayComparison;
    const summary = cmp.summary;

    console.log();
    console.log(colors.accent(`⚖ 3-Way Build Comparison: Per-Hit vs. Sustained vs. Leaderboard Meta`));
    console.log(colors.border(`  ${"─".repeat(66)}`));
    console.log(
      colors.dim(
        `  ${"Metric / Skill".padEnd(18)} ${"Per-Hit".padStart(12)} ${"Sustained".padStart(14)} ${"Leaderboard".padStart(14)}`
      )
    );
    console.log(colors.border(`  ${"─".repeat(66)}`));

    // Metric rows
    console.log(
      `  ${chalk.white.bold("Damage / Hit".padEnd(18))} ${chalk.green(
        summary.perHit.dmgPerHit.toLocaleString().padStart(12)
      )} ${chalk.cyanBright(summary.sustained.dmgPerHit.toLocaleString().padStart(14))} ${chalk.white(
        summary.meta.dmgPerHit.toLocaleString().padStart(14)
      )}`
    );

    console.log(
      `  ${chalk.white.bold("Available Hits".padEnd(18))} ${chalk.dim(
        summary.perHit.totalHits.toLocaleString().padStart(12)
      )} ${chalk.greenBright.bold(summary.sustained.totalHits.toLocaleString().padStart(14))} ${chalk.cyan(
        summary.meta.totalHits.toLocaleString().padStart(14)
      )}`
    );

    const susDmgColor = cmp.sustainedVsPerHitPct >= 0 ? chalk.greenBright.bold : chalk.yellow.bold;
    console.log(
      `  ${chalk.white.bold("Total Damage".padEnd(18))} ${chalk.dim(
        summary.perHit.totalDamage.toLocaleString().padStart(12)
      )} ${susDmgColor(summary.sustained.totalDamage.toLocaleString().padStart(14))} ${chalk.white(
        summary.meta.totalDamage.toLocaleString().padStart(14)
      )}`
    );

    console.log(
      `  ${chalk.white("Bread Consumed".padEnd(18))} ${chalk.dim(
        String(summary.perHit.breads).padStart(12)
      )} ${chalk.cyan(String(summary.sustained.breads).padStart(14))} ${chalk.cyan(
        String(summary.meta.breads).padStart(14)
      )}`
    );

    console.log(
      `  ${chalk.white("Wasted HP Regen".padEnd(18))} ${chalk.dim(
        `${summary.perHit.wastedHealth} HP`.padStart(12)
      )} ${chalk.yellow(`${summary.sustained.wastedHealth} HP`.padStart(14))} ${chalk.yellow(
        `${summary.meta.wastedHealth} HP`.padStart(14)
      )}`
    );

    console.log(
      `  ${chalk.white("Resource Effic.".padEnd(18))} ${chalk.dim(
        `${summary.perHit.efficiency}%`.padStart(12)
      )} ${chalk.cyan(`${summary.sustained.efficiency}%`.padStart(14))} ${chalk.cyan(
        `${summary.meta.efficiency}%`.padStart(14)
      )}`
    );

    console.log(colors.border(`  ${"─".repeat(66)}`));
    console.log(colors.dim(`  Skill Allocations (Point Distribution):`));

    for (const row of cmp.skillComparison) {
      if (row.perHit === 0 && row.sustained === 0 && row.meta === 0) continue;

      let label = row.skillName;
      if (label === "criticalChance") label = "Crit Chance";
      if (label === "criticalDamages") label = "Crit Damage";

      const pStr = row.perHit > 0 ? String(row.perHit) : colors.dim("0");
      const sStr = row.sustained > 0 ? chalk.greenBright.bold(String(row.sustained)) : colors.dim("0");
      const mStr = row.meta > 0 ? chalk.cyan(String(row.meta)) : colors.dim("0");

      console.log(
        `  ${chalk.white(label.padEnd(18))} ${pStr.padStart(12)} ${sStr.padStart(14)} ${mStr.padStart(14)}`
      );
    }

    console.log(colors.border(`  ${"─".repeat(66)}`));
    console.log(
      `  Sustained vs Per-Hit Damage Advantage: ${colors.success(
        `+${cmp.sustainedVsPerHitPct}%`
      )} ${colors.dim(`(+${summary.sustained.totalHits - summary.perHit.totalHits} extra combat hits)`)}`
    );
    console.log(
      `  Model Agreement with Leaderboard Meta: ${colors.accent(`${cmp.agreementPct}%`)}`
    );

    // Observations
    if (cmp.observations?.length > 0) {
      console.log();
      console.log(colors.dim(`  Analytical Insights:`));
      cmp.observations.forEach((obs) => {
        console.log(`  ${colors.dim("•")} ${chalk.white(obs)}`);
      });
    }

    // Availability Comparison: Unlimited vs. Realistic
    if (cmp.availabilityComparison) {
      const ac = cmp.availabilityComparison;
      console.log();
      console.log(colors.accent(`📊 Unlimited Availability vs. Realistic Windows Comparison`));
      console.log(colors.border(`  ${"─".repeat(66)}`));
      console.log(
        colors.dim(
          `  ${"Scenario".padEnd(26)} ${"Weekly Hits".padStart(16)} ${"Expected Damage".padStart(20)}`
        )
      );
      console.log(colors.border(`  ${"─".repeat(66)}`));
      console.log(
        `  ${chalk.white("Unlimited (24/7 Combat)".padEnd(26))} ${chalk.cyan(
          `${ac.unlimitedHits.toLocaleString()} hits`.padStart(16)
        )} ${chalk.cyanBright(ac.unlimitedTotalDamage.toLocaleString().padStart(20))}`
      );
      console.log(
        `  ${chalk.white("Realistic Windows".padEnd(26))} ${chalk.greenBright(
          `${ac.realisticHits.toLocaleString()} hits`.padStart(16)
        )} ${chalk.greenBright.bold(ac.realisticTotalDamage.toLocaleString().padStart(20))}`
      );
      console.log(
        `  ${chalk.yellow("Window Bottleneck Loss".padEnd(26))} ${chalk.yellow(
          `-${ac.battleWindowLossHits} hits`.padStart(16)
        )} ${chalk.yellow(`-${ac.damageLostToWindows.toLocaleString()}`.padStart(20))}`
      );
      console.log(
        `  ${chalk.dim(`HP Capped Loss: ${ac.hpWastedAtCap} HP wasted at Max HP during quiet inter-battle lulls`)}`
      );
    }
  }

  // ==========================================================
  // 2. RESOURCE ECONOMY & COMBAT ACTION THROUGHPUT
  // ==========================================================
  if (sus) {
    console.log();
    console.log(colors.accent(`🍞 Resource Economy & Hit Production (${sus.durationHours}h Horizon)`));
    console.log(colors.border(`  ${"─".repeat(66)}`));
    console.log(
      `  ${chalk.white.bold("Max Resource Bars:")}  Health: ${chalk.green(sus.maxHealth)} HP | Hunger: ${chalk.yellow(
        sus.maxHunger
      )} pts`
    );
    console.log(
      `  ${chalk.white.bold("Natural Regen:")}     Health: ${chalk.green(`+${sus.hourlyHealthRegen}/hr`)} (${sus.dailyHealthRegen}/day) | Hunger: ${chalk.yellow(`+${sus.hourlyHungerRegen}/hr`)}`
    );
    console.log(
      `  ${chalk.white.bold("Bread Restores:")}    ${chalk.greenBright(`+${sus.hpPerBread} HP per bread`)} (10% of Max HP, costs 1 hunger)`
    );
    console.log(
      `  ${chalk.white.bold("Total Hits Breakdown:")} ${chalk.greenBright.bold(`${sus.totalHits} hits`)} @ 10 HP/hit`
    );
    console.log(
      `     • Initial Pool:     ${chalk.cyan(`${sus.hitsFromInitial} hits`)} ${colors.dim(`(${sus.initialHealth} HP initial pool)`)}`
    );
    console.log(
      `     • Natural Regen:    ${chalk.cyan(`${sus.hitsFromRegen} hits`)} ${colors.dim(`(${sus.usablePassiveHealth} HP utilized over ${sus.durationHours}h)`)}`
    );
    console.log(
      `     • Bread Meals:      ${chalk.cyan(`${sus.hitsFromBread} hits`)} ${colors.dim(`(${sus.breadsConsumed} breads eaten, +${sus.healthFromBread} HP)`)}`
    );
    console.log(
      `  ${chalk.white.bold("Capped / Wasted:")}   ${chalk.yellow(`${sus.healthWasted} HP`)} ${colors.dim(`(${Math.round((1 - sus.activityFactor) * 100)}% waste under ${sus.activityName} activity)`)}`
    );
  }

  // ==========================================================
  // 3. MARGINAL UPGRADE ROI (TOTAL DAMAGE / PER-HIT DAMAGE)
  // ==========================================================
  if (report.marginalROI?.length > 0) {
    const isSustainedObj = options.objective === "sustained" || options.objective === "weekly";
    console.log();
    console.log(
      colors.accent(
        isSustainedObj
          ? `📈 Marginal Value & ROI for Next Upgrades (Ranked by Total Damage Gain)`
          : `📈 Marginal Value & ROI for Next Point Upgrades (Per-Hit Damage)`
      )
    );
    console.log(colors.border(`  ${"─".repeat(66)}`));
    console.log(
      colors.dim(
        `  ${"Skill".padEnd(16)} ${"Type".padEnd(10)} ${"Upgrade".padStart(10)} ${"Cost".padStart(6)} ${"Gain".padStart(12)} ${"ROI".padStart(8)}`
      )
    );
    console.log(colors.border(`  ${"─".repeat(66)}`));

    report.marginalROI.forEach((roi) => {
      const roiColor = roi.roi >= 0.5 ? colors.success : roi.roi >= 0.2 ? colors.warning : colors.dim;
      const typeColor = roi.category === "sustain" ? chalk.magenta : chalk.cyan;

      let gainStr = `+${roi.percentGain}%`;
      if (roi.category === "sustain" && roi.hitGain) {
        gainStr = `+${roi.hitGain} hits`;
      } else if (roi.perHitGain) {
        gainStr = `+${roi.perHitGain} dmg`;
      }

      console.log(
        `  ${chalk.white(roi.skillName.padEnd(16))} ${typeColor(
          (roi.category || "combat").padEnd(10)
        )} ${chalk.white(`${roi.currentLevel} → ${roi.nextLevel}`.padStart(10))} ${chalk.dim(
          String(roi.pointCost).padStart(6)
        )} ${chalk.green(gainStr.padStart(12))} ${roiColor(String(roi.roi).padStart(8))}`
      );
    });
  }

  // ==========================================================
  // 4. EMPIRICAL SKILL ALLOCATION
  // ==========================================================
  console.log();
  console.log(
    colors.accent(
      `⚔ Empirical Leaderboard Skill Priorities (Budget: ${report.skillAnalysis.spentBudget}/${report.skillAnalysis.totalBudget} pts)`
    )
  );
  console.log(colors.border(`  ${"─".repeat(66)}`));
  console.log(
    colors.dim(
      `  ${"Skill".padEnd(20)} ${"Rec Level".padStart(10)} ${"Top Median".padStart(14)} ${"Correlation".padStart(14)}`
    )
  );
  console.log(colors.border(`  ${"─".repeat(66)}`));

  const sortedSkills = Object.entries(report.skillAnalysis.recommendedBuild).sort(
    (a, b) => b[1] - a[1]
  );

  for (const [skillName, lvl] of sortedSkills) {
    const stat = report.skillAnalysis.skillStats[skillName];
    if (!stat || (!stat.isUnlocked && lvl === 0)) continue;

    const corrStr =
      stat.correlation >= 0
        ? `+${stat.correlation.toFixed(2)}`
        : stat.correlation.toFixed(2);
    const corrColored =
      stat.correlation > 0.25
        ? colors.success(corrStr)
        : stat.correlation < -0.1
        ? colors.error(corrStr)
        : colors.dim(corrStr);

    const lvlStr = lvl > 0 ? chalk.greenBright.bold(String(lvl)) : colors.dim("0");
    const medStr = String(stat.topMedian);

    console.log(
      `  ${chalk.white(skillName.padEnd(20))} ${lvlStr.padStart(10)} ${medStr.padStart(14)} ${corrColored.padStart(22)}`
    );
  }

  // ==========================================================
  // 5. EQUIPMENT & WEAPON PRIORITIES
  // ==========================================================
  console.log();
  console.log(colors.accent(`🛡 Equipment & Weapon Priorities`));
  console.log(colors.border(`  ${"─".repeat(66)}`));
  for (const slot of ["weapon", "ammo", "helmet", "chest", "boots", "gloves", "pants"]) {
    const info = report.equipAnalysis.slotAnalysis[slot];
    if (!info) continue;

    const topItem = info.recommendedItem;
    const statSummary = Object.entries(info.stats || {})
      .map(([k, v]) => `${k} ≥ ${v.median}`)
      .join(", ");

    console.log(
      `  ${chalk.white.bold(slot.padEnd(10))} ${chalk.cyan(
        topItem.padEnd(12)
      )} ${statSummary ? colors.dim(`(${statSummary})`) : ""}`
    );
  }

  // ==========================================================
  // 6. COMBAT STAT BENCHMARKS
  // ==========================================================
  console.log();
  console.log(colors.accent(`📊 Combat Stat Benchmarks (Level ${report.level})`));
  console.log(colors.border(`  ${"─".repeat(66)}`));
  console.log(
    colors.dim(
      `  ${"Stat".padEnd(20)} ${"Top Median".padStart(16)} ${"Top 10% (P90)".padStart(20)}`
    )
  );
  console.log(colors.border(`  ${"─".repeat(66)}`));
  for (const [statName, bench] of Object.entries(report.statBenchmarks)) {
    console.log(
      `  ${chalk.white(statName.padEnd(20))} ${chalk.cyan(
        String(bench.median).padStart(16)
      )} ${chalk.cyanBright(String(bench.p90).padStart(20))}`
    );
  }

  // ==========================================================
  // 7. TOP PERFORMERS
  // ==========================================================
  if (report.representativeTopPlayers?.length > 0) {
    console.log();
    console.log(colors.accent(`🏆 Top Performers at this Level`));
    console.log(colors.border(`  ${"─".repeat(66)}`));
    report.representativeTopPlayers.forEach((p, idx) => {
      console.log(
        `  ${idx + 1}. ${chalk.white.bold(p.name.padEnd(16))} Rank #${chalk.yellow(
          String(p.rank).padEnd(6)
        )} Dmg: ${chalk.green(p.weeklyDamage.toLocaleString().padEnd(12))} Weapon: ${chalk.cyan(
          p.weapon
        )}`
      );
    });
  }
}

/**
 * Render personal build comparison
 */
function renderMyBuildReport(myAnalysis, options = {}) {
  drawHeader(`Your Build Analysis (Level ${myAnalysis.level})`, "🎯", 68);
  console.log(`   Player:                ${chalk.white.bold(myAnalysis.me.name)}`);
  console.log(`   Leaderboard Score:     ${chalk.cyan.bold(`${myAnalysis.score}/100`)}`);

  // Live Battle Status (Country & MU Consensus Snapshot)
  if (myAnalysis.liveBattleData?.qualifyingBattles?.length > 0) {
    console.log();
    console.log(colors.accent(`⚔ Live Battle Status: Battle available right now (Country & MU Consensus)`));
    console.log(colors.border(`  ${"─".repeat(66)}`));
    myAnalysis.liveBattleData.qualifyingBattles.forEach((qb) => {
      console.log(`  Battle ID:         ${chalk.yellow(qb.battleId)} (${qb.type.toUpperCase()})`);
      console.log(`  Ordered Side:      ${chalk.greenBright.bold(qb.orderedSide.toUpperCase())}`);
      console.log(`  Window Timing:     ${chalk.cyan(`${qb.elapsedHours}h elapsed`)} | Est. Remaining: ${chalk.green(`${qb.remainingHours}h`)}`);
      console.log(`  Order Consensus:   ${colors.success("✓ Country and MU orders both agree on this battle!")}`);
    });
  } else if (myAnalysis.liveBattleData) {
    console.log();
    console.log(colors.warning(`⚔ Live Battle Status: No qualifying battle open right now (Inter-battle lull)`));
    console.log(colors.dim(`  Current state: Health and Hunger accumulating up to bar caps; waiting for next orders.`));
  }

  // ==========================================================
  // 1. THEORETICAL & SUSTAINED COMBAT EFFICIENCY
  // ==========================================================
  if (myAnalysis.theoreticalEval) {
    const te = myAnalysis.theoreticalEval;
    const isSustained = te.objective === "sustained" || te.objective === "weekly";
    const effColor = te.efficiencyPct >= 90 ? colors.success : te.efficiencyPct >= 75 ? colors.warning : colors.error;

    console.log(
      `   Optimization Mode:     ${chalk.magentaBright.bold(te.objective ? te.objective.toUpperCase() : "WEEKLY")}`
    );
    if (te.mySustain?.schedule?.isHistoricalTimeline) {
      console.log(
        `   Battle Window Mode:    ${chalk.greenBright.bold("Real Recorded Battle Windows")} ${colors.dim(`(${te.mySustain.schedule.coveragePct}% coverage)`)}`
      );
    } else if (te.mySustain?.schedule?.insufficient) {
      console.log(
        `   Battle Window Mode:    ${colors.warning("Insufficient Telemetry")} ${colors.dim(`(< 24h observed)`)}`
      );
    } else if (te.mySustain?.isRealisticSim) {
      console.log(
        `   Battle Window Mode:    ${chalk.cyan(te.mySustain.schedule?.label || "Realistic")}`
      );
    }
    console.log(`   Theoretical Efficiency:${effColor.bold(` ${te.efficiencyPct}%`)}`);

    // Historical Battle Availability Block for personal build
    if (te.mySustain?.schedule?.isHistoricalTimeline && te.mySustain.schedule.telemetryMetrics) {
      const tm = te.mySustain.schedule.telemetryMetrics;
      const ctx = te.mySustain.schedule.context || options.context || tm.context;
      const ctxCountry = ctx?.all ? "All / Mixed" : (ctx?.countryId || myAnalysis.me?.citizenship || myAnalysis.me?.country || "None");
      const ctxMu = ctx?.all ? "All / Mixed" : (ctx?.muId || myAnalysis.me?.militaryUnit || myAnalysis.me?.mu || "None");

      console.log();
      console.log(colors.accent(`📡 Historical Battle Availability`));
      console.log(colors.border(`  ${"─".repeat(66)}`));
      if (ctx?.all) {
        console.log(colors.warning(`  ⚠ Combining battle telemetry from multiple Country/MU contexts. This may not represent the current battle environment.`));
        console.log(colors.border(`  ${"─".repeat(66)}`));
      }
      console.log(`  Telemetry context:`);
      console.log(`    Country:                 ${chalk.dim(ctxCountry)}`);
      console.log(`    MU:                      ${chalk.dim(ctxMu)}`);
      console.log(`  Data source:               ${chalk.greenBright.bold("LIVE RECORDED TELEMETRY")}`);
      console.log(`  Sample count:              ${chalk.cyan(tm.totalSamples.toLocaleString())}`);
      console.log(`  Confirmed duration:        ${chalk.white.bold(`${tm.actualObservedDays} days`)} (${tm.actualObservedHours} hours known)`);
      console.log(`  Unknown/offline duration:  ${tm.unknownDurationHours > 0 ? chalk.yellow(`${tm.unknownDurationDays} days (${tm.unknownDurationHours}h)`) : colors.dim("0 hours (Continuous)")}`);
      console.log(`  Qualifying battle time:    ${chalk.greenBright(`${tm.qualifyingDurationHours} hours`)}`);
      console.log(`  Known non-battle time:     ${chalk.white(`${tm.lullDurationHours} hours`)}`);
      console.log(`  Observed coverage:         ${chalk.greenBright.bold(`${tm.observedCoveragePct}%`)} (qualifying / known time)`);
      console.log(`  Longest battle window:     ${chalk.cyan(tm.longestQualifyingWindow)}`);
      console.log(`  Longest lull:              ${chalk.yellow(tm.longestLull)}`);
      console.log(`  Confidence:                ${colors.success(tm.confidence)}`);
      console.log();
      console.log(colors.accent(`📊 Build Optimization`));
      console.log(colors.border(`  ${"─".repeat(66)}`));
      console.log(`  Using:                     ${chalk.greenBright.bold("REAL RECORDED BATTLE WINDOWS")}`);
      console.log(`  (replaying exact sequence of historical windows via event-based simulation)`);
    } else if (te.mySustain?.schedule?.insufficient) {
      const tm = te.mySustain.schedule.telemetryMetrics;
      const ctx = te.mySustain.schedule.context || options.context || tm?.context;
      const ctxCountry = ctx?.all ? "All / Mixed" : (ctx?.countryId || myAnalysis.me?.citizenship || myAnalysis.me?.country || "None");
      const ctxMu = ctx?.all ? "All / Mixed" : (ctx?.muId || myAnalysis.me?.militaryUnit || myAnalysis.me?.mu || "None");

      console.log();
      console.log(colors.accent(`📡 Historical Battle Availability`));
      console.log(colors.border(`  ${"─".repeat(66)}`));
      if (ctx?.all) {
        console.log(colors.warning(`  ⚠ Combining battle telemetry from multiple Country/MU contexts. This may not represent the current battle environment.`));
        console.log(colors.border(`  ${"─".repeat(66)}`));
      }
      console.log(`  Telemetry context:`);
      console.log(`    Country:                 ${chalk.dim(ctxCountry)}`);
      console.log(`    MU:                      ${chalk.dim(ctxMu)}`);
      console.log(`  Data source:               ${chalk.greenBright.bold("LIVE RECORDED TELEMETRY")}`);
      console.log(`  Sample count:              ${chalk.cyan((tm?.totalSamples || 0).toLocaleString())}`);
      console.log(`  Confirmed duration:        ${chalk.white.bold(`${tm?.actualObservedDays || 0} days`)} (${tm?.actualObservedHours || 0} hours known)`);
      console.log(`  Coverage:                  ${chalk.yellow(tm?.coverageDisplay || "Insufficient data")}`);
      console.log(`  Confidence:                ${colors.error(tm?.confidence || "VERY LOW")}`);
      console.log(colors.warning(`  ⚠ Insufficient historical battle telemetry.`));
      console.log(colors.dim(`    Current dataset has ${tm?.totalSamples || 0} sample(s) (< 24 hours of actual observation).`));
      console.log(colors.dim(`    WarEra does not preserve historical order logs; observations must accumulate locally.`));
      console.log(`    To begin recording historical samples, run:`);
      console.log(`      ${chalk.cyan("npm run battle-telemetry")}`);
      console.log();
      console.log(colors.accent(`📊 Scenario Estimates (Assumptions)`));
      console.log(colors.border(`  ${"─".repeat(66)}`));
      console.log(
        colors.dim(
          `  ${"Scenario / Availability".padEnd(34)} ${"Weekly Hits".padStart(14)} ${"Expected Damage".padStart(16)}`
        )
      );
      console.log(colors.border(`  ${"─".repeat(66)}`));
      for (const sc of (myAnalysis.optimal?.threeWayComparison?.scenarioProjections || [])) {
        console.log(
          `  ${chalk.white(sc.scenario.padEnd(34))} ${chalk.cyan(
            `${sc.hits.toLocaleString()} hits`.padStart(14)
          )} ${chalk.greenBright(sc.totalDamage.toLocaleString().padStart(16))}`
        );
      }
      console.log(colors.border(`  ${"─".repeat(66)}`));
      console.log(
        colors.dim(
          `  * Note: The above projections are hypothetical assumptions. Run with\n    --battle-availability=25%, 50%, or unlimited to optimize under a specific assumption.`
        )
      );
    }

    if (isSustained) {
      console.log(
        `   Weekly Expected Dmg:   ${chalk.white.bold(te.currentTotalDamage.toLocaleString())} (Optimal: ${chalk.greenBright.bold(
          te.optimalTotalDamage.toLocaleString()
        )})`
      );
      if (te.mySustain?.isRealisticSim) {
        console.log(
          `   Weekly Combat Hits:    ${chalk.cyan.bold(te.currentHits.toLocaleString())} actual / ${te.mySustain.resourceLimitedHits} ideal (Optimal: ${chalk.greenBright.bold(
            te.optimalHits.toLocaleString()
          )})`
        );
        if (te.mySustain.battleWindowLoss > 0) {
          console.log(
            `   Battle-Window Loss:    ${chalk.yellow(`${te.mySustain.battleWindowLoss} hits lost`)} (${te.mySustain.hpRegenWastedAtCap} HP wasted at cap during lulls)`
          );
        }
      } else {
        console.log(
          `   Weekly Combat Hits:    ${chalk.cyan.bold(te.currentHits.toLocaleString())} (Optimal: ${chalk.greenBright.bold(
            te.optimalHits.toLocaleString()
          )})`
        );
      }
      console.log(
        `   Expected Damage/Hit:   ${chalk.white.bold(te.currentDamage.toLocaleString())} (Optimal: ${chalk.greenBright.bold(
          te.optimalDamage.toLocaleString()
        )})`
      );
    } else {
      console.log(
        `   Expected Damage/Hit:   ${chalk.white.bold(te.currentDamage.toLocaleString())} (Optimal: ${chalk.greenBright.bold(
          te.optimalDamage.toLocaleString()
        )})`
      );
    }
    console.log();

    // Respec delta guidance
    if (te.respecDiff?.length > 0) {
      console.log(
        colors.accent(
          isSustained
            ? `🔄 Best Legal Respec for Maximum Weekly Output (Level ${te.level} + Same Gear):`
            : `🔄 Best Legal Respec for Maximum Damage (Same Level + Gear):`
        )
      );
      te.respecDiff.forEach((rd) => {
        const sign = rd.delta > 0 ? `+${rd.delta}` : `${rd.delta}`;
        const color = rd.delta > 0 ? colors.success : colors.warning;
        console.log(`   ${color(`• ${rd.skillName}: ${rd.current} → ${rd.target} (${sign} levels)`)}`);
      });
      console.log();
    }

    // Wasted Points in non-combat skills
    if (te.wastedPoints?.length > 0) {
      const totalWasted = te.wastedPoints.reduce((sum, w) => sum + w.spentPoints, 0);
      console.log(colors.warning(`⚠ Non-Combat Points Allocation (${totalWasted} pts spent outside combat):`));
      te.wastedPoints.forEach((w) => {
        console.log(
          `   ${colors.dim("•")} ${chalk.white.bold(w.skillName)}: Level ${w.level} (${w.spentPoints} pts) ${colors.dim(`→ ${w.alternative}`)}`
        );
      });
      console.log();
    }

    // Marginal ROI for next upgrades
    if (te.nextUpgrades?.length > 0) {
      console.log(
        colors.accent(
          isSustained
            ? `📈 Next Skill Investment ROI (Ranked by Weekly Damage Gain):`
            : `📈 Next Skill Investment ROI (Ranked by Mathematical Gain):`
        )
      );
      console.log(colors.border(`  ${"─".repeat(66)}`));
      console.log(
        colors.dim(
          `  ${"Skill".padEnd(16)} ${"Type".padEnd(10)} ${"Upgrade".padStart(10)} ${"Cost".padStart(6)} ${"Gain".padStart(12)} ${"ROI".padStart(8)}`
        )
      );
      console.log(colors.border(`  ${"─".repeat(66)}`));

      te.nextUpgrades.forEach((u) => {
        const roiColor = u.roi >= 0.5 ? colors.success : u.roi >= 0.2 ? colors.warning : colors.dim;
        const typeColor = u.category === "sustain" ? chalk.magenta : chalk.cyan;

        let gainStr = `+${u.percentGain}%`;
        if (u.category === "sustain" && u.hitGain) {
          gainStr = `+${u.hitGain} hits`;
        } else if (u.perHitGain) {
          gainStr = `+${u.perHitGain} dmg`;
        }

        console.log(
          `  ${chalk.white(u.skillName.padEnd(16))} ${typeColor(
            (u.category || "combat").padEnd(10)
          )} ${chalk.white(`${u.currentLevel} → ${u.nextLevel}`.padStart(10))} ${chalk.dim(
            String(u.pointCost).padStart(6)
          )} ${chalk.green(gainStr.padStart(12))} ${roiColor(String(u.roi).padStart(8))}`
        );
      });
      console.log();
    }
  }

  // ==========================================================
  // 2. MODEL VALIDATION AGAINST IN-GAME STATS
  // ==========================================================
  if (myAnalysis.validation) {
    const val = myAnalysis.validation;
    console.log(colors.accent(`🔍 Model Validation against In-Game Stats:`));
    console.log(colors.border(`  ${"─".repeat(66)}`));
    console.log(
      colors.dim(
        `  ${"Stat".padEnd(20)} ${"In-Game".padStart(12)} ${"Model Predicted".padStart(18)} ${"Status".padStart(12)}`
      )
    );
    console.log(colors.border(`  ${"─".repeat(66)}`));

    val.checks.forEach((c) => {
      const match = c.diff <= 2 ? colors.success("✓ Exact") : colors.warning(`Δ ${c.diff}`);
      console.log(
        `  ${chalk.white(c.stat.padEnd(20))} ${chalk.cyan(
          String(c.actual).padStart(12)
        )} ${chalk.greenBright(String(c.predicted).padStart(18))} ${match.padStart(20)}`
      );
    });
    console.log();
  }

  // Actionable improvements
  if (myAnalysis.improvements?.length > 0) {
    console.log(colors.warning(`⚡ Actionable Equipment & Setup Upgrades:`));
    myAnalysis.improvements.forEach((imp, i) => {
      console.log(`   ${i + 1}. ${chalk.yellow(imp)}`);
    });
    console.log();
  }

  // Skill comparison table
  console.log(colors.accent(`Skills: Mine vs Empirical Leaderboard Benchmarks`));
  console.log(colors.border(`  ${"─".repeat(66)}`));
  console.log(
    colors.dim(
      `  ${"Skill".padEnd(20)} ${"Mine".padStart(10)} ${"Optimal".padStart(12)} ${"Status".padStart(16)}`
    )
  );
  console.log(colors.border(`  ${"─".repeat(66)}`));

  for (const s of myAnalysis.skillComparison) {
    let status = colors.success("Optimal");
    if (s.diff > 0) {
      status = colors.error(`-${s.diff} pts`);
    } else if (s.diff < 0) {
      status = colors.warning(`+${Math.abs(s.diff)} extra`);
    }

    console.log(
      `  ${chalk.white(s.name.padEnd(20))} ${chalk.cyan(
        String(s.mine).padStart(10)
      )} ${chalk.greenBright(String(s.optimal).padStart(12))} ${status.padStart(24)}`
    );
  }

  // Equipment comparison
  console.log();
  console.log(colors.accent(`Equipment Comparison`));
  console.log(colors.border(`  ${"─".repeat(66)}`));
  for (const [slot, eq] of Object.entries(myAnalysis.equipComparison)) {
    const matchIcon = eq.matches ? colors.success("✓ Match") : colors.warning("→ Upgrade");
    console.log(
      `  ${chalk.white.bold(slot.padEnd(10))} Mine: ${chalk.cyan(
        eq.mine.padEnd(12)
      )} Rec: ${chalk.green(eq.recommended.padEnd(12))} ${matchIcon}`
    );
  }

  // Stat comparison
  console.log();
  console.log(colors.accent(`Combat Stat Gaps vs Top-Player Median`));
  console.log(colors.border(`  ${"─".repeat(66)}`));
  console.log(
    colors.dim(
      `  ${"Stat".padEnd(20)} ${"Mine".padStart(12)} ${"Top Median".padStart(16)} ${"Ratio".padStart(12)}`
    )
  );
  console.log(colors.border(`  ${"─".repeat(66)}`));
  for (const st of myAnalysis.statComparison) {
    const ratioColored =
      st.ratio >= 1.0 ? colors.success(`${Math.round(st.ratio * 100)}%`) : colors.warning(`${Math.round(st.ratio * 100)}%`);
    console.log(
      `  ${chalk.white(st.name.padEnd(20))} ${chalk.cyan(
        String(st.mine).padStart(12)
      )} ${chalk.white(String(st.topMedian).padStart(16))} ${ratioColored.padStart(20)}`
    );
  }
}

/**
 * Main execution
 */
async function main() {
  const options = parseArgs();

  // Resolve active telemetry context
  let currentContext = null;
  try {
    const meData = await fetchMe();
    const u = meData.user || {};
    currentContext = {
      countryId: u.citizenship || u.country || null,
      muId: u.militaryUnit || u.mu || null,
    };
  } catch {}
  if (!currentContext?.countryId && !currentContext?.muId) {
    currentContext = getLatestTelemetryContextSync();
  }

  const resolvedContext = resolveTelemetryContext(options.telemetryContext, currentContext);
  options.context = resolvedContext;
  options.countryId = resolvedContext.countryId;
  options.muId = resolvedContext.muId;

  drawHeader("WARERA BUILD & SKILL ANALYZER", "📊", 68);
  console.log(colors.dim("Empirical, Theoretical & Sustained Combat Optimization for WarEra"));
  console.log();

  // Step 1: Ensure game config and player data
  process.stdout.write("🔎 Loading live game configuration... ");
  const gameConfig = await getGameConfig(options.refresh);
  console.log(colors.success("✓"));

  let cachedPlayers = getAllCachedPlayers();
  if (cachedPlayers.length < options.collectCount || options.refresh) {
    console.log(`🔎 Collecting top ${options.collectCount} weekly damage players...`);
    cachedPlayers = await collectTopPlayers(
      options.collectCount,
      options.refresh,
      (current, total) => {
        process.stdout.write(`\r   Progress: ${current}/${total} players cached...`);
      }
    );
    console.log(`\n${colors.success(`✓ ${cachedPlayers.length} high-ranking players ready in cache.`)}`);
  } else {
    console.log(`${colors.success(`✓ Loaded ${cachedPlayers.length} high-ranking players from local cache.`)}`);
  }

  // Route actions
  if (options.compare && options.compare.length === 2) {
    const pA = getCachedPlayer(options.compare[0]);
    const pB = getCachedPlayer(options.compare[1]);
    if (!pA || !pB) {
      console.log(colors.error("One or both players not found in cache."));
      return;
    }
    const cmp = compareBuilds(pA, pB);
    drawHeader(`Player Comparison: ${pA.name} vs ${pB.name}`, "⚔", 68);
    console.log(
      `Weekly Damage: ${pA.name} (${pA.weeklyDamage.toLocaleString()}) vs ${pB.name} (${pB.weeklyDamage.toLocaleString()})`
    );
    console.log(`Damage Diff: ${cmp.damageDiff > 0 ? "+" : ""}${cmp.damageDiff.toLocaleString()}`);
    return;
  }

  if (options.minLevel && options.maxLevel) {
    drawHeader(`Scanning Levels ${options.minLevel} to ${options.maxLevel}`, "🔍", 68);
    const results = await analyzeRange(options.minLevel, options.maxLevel, cachedPlayers, gameConfig);
    for (const res of results) {
      renderLevelReport(res, options);
    }
    return;
  }

  if (options.level) {
    const report = await analyzeLevel(options.level, cachedPlayers, gameConfig, options);
    renderLevelReport(report, options);
    return;
  }

  // Default behavior: if session cookies exist or --me specified, analyze my build; else prompt level
  try {
    const myReport = await analyzeMyBuild(options);
    renderMyBuildReport(myReport, options);
  } catch (err) {
    console.log(colors.dim(`No active player session detected (${err.message}).`));
    console.log(colors.info(`Displaying benchmark for top player levels (e.g. Level 39 & Level 40):`));
    const rep39 = await analyzeLevel(39, cachedPlayers, gameConfig, options);
    renderLevelReport(rep39, options);
  }

  console.log();
  console.log(colors.border(`╭${"─".repeat(66)}╮`));
  console.log(
    colors.border(`│ `) +
      colors.dim("CLI Modes & Examples:") +
      colors.border(`                                            │`)
  );
  console.log(
    colors.border(`│ `) +
      chalk.white("node analyze.mjs --level=40 --objective=weekly") +
      colors.border(`                    │`)
  );
  console.log(
    colors.border(`│ `) +
      chalk.white("node analyze.mjs --level=40 --battle-availability=50%") +
      colors.border(`             │`)
  );
  console.log(
    colors.border(`│ `) +
      chalk.white("node analyze.mjs --me --objective=weekly --battle-availability=observed") +
      colors.border(`│`)
  );
  console.log(
    colors.border(`│ `) +
      chalk.white("node analyze.mjs --level=39 --hours=6 --bread=50") +
      colors.border(`                 │`)
  );
  console.log(colors.border(`╰${"─".repeat(66)}╯`));
}

main().catch((err) => {
  console.error(colors.error(`\nFatal analyzer error: ${err.message}`));
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
