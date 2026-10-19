/**
 * WarEra Daily Automation - Terminal Dashboard & UI Abstraction
 * 
 * Provides polished ANSI styling, Unicode icons, interactive spinners,
 * and structured summary tables while remaining safe and non-intrusive.
 */

import readline from "node:readline";
import chalk from "chalk";
import ora from "ora";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";

const isTTY = Boolean(process.stdout.isTTY) && !process.env.CI;
export const isDebug = Boolean(process.env.DEBUG);

// Color Palette
export const colors = {
  health: chalk.hex("#22C55E"),         // Green
  hunger: chalk.hex("#EF4444"),         // Red
  energy: chalk.hex("#06B6D4"),         // Cyan / Blue
  ent: chalk.hex("#EC4899"),            // Magenta / Pink
  success: chalk.greenBright.bold,      // Bright green
  warning: chalk.yellow,               // Yellow
  error: chalk.redBright.bold,         // Bright red
  info: chalk.cyan,                    // Cyan
  dim: chalk.gray,                     // Gray
  highlight: chalk.whiteBright.bold,   // Bright white
  accent: chalk.cyanBright.bold,       // Bright cyan
  target: chalk.cyanBright.bold,       // Bold cyan for targets/regions
  border: chalk.hex("#4B5563"),         // Border gray
  gold: chalk.hex("#F59E0B"),           // Amber/Gold
};

// Unicode Icons
export const icons = {
  health: "❤️",
  hunger: "🍴",
  bread: "🍞",
  energy: "⚡",
  ent: "🧠",
  work: "⛏",
  company: "🏭",
  mu: "🪖",
  help: "🤝",
  battles: "⚔",
  resistance: "🚩",
  success: "✓",
  warning: "⚠",
  error: "✗",
  info: "ℹ",
  cooldown: "⏳",
  transition: "→",
  bullet: "•",
  clock: "⏱",
  chart: "📊",
};

/**
 * Helper to compute true terminal display width without ANSI escape codes
 */
export function visualWidth(str) {
  return stringWidth(stripAnsi(str));
}

/**
 * Pad a string to visual terminal width
 */
export function visualPadEnd(str, targetWidth) {
  const currentWidth = visualWidth(str);
  const diff = targetWidth - currentWidth;
  return diff > 0 ? str + " ".repeat(diff) : str;
}

/**
 * Format a box header with borders
 */
export function drawBox(title, icon = "", width = 56) {
  const content = icon ? `${icon}  ${title}` : title;
  const innerWidth = width - 2; // Exact space between the two vertical border characters
  const padded = visualPadEnd(` ${content}`, innerWidth);

  console.log();
  console.log(colors.border(`╭${"─".repeat(width - 2)}╮`));
  console.log(colors.border(`│`) + colors.accent(padded) + colors.border(`│`));
  console.log(colors.border(`╰${"─".repeat(width - 2)}╯`));
}

class UIManager {
  constructor() {
    this.currentSpinner = null;
  }

  banner() {
    if (isTTY && !isDebug) {
      console.clear?.();
    }
    const width = 56;
    const innerWidth = width - 2;
    console.log();
    console.log(colors.border(`╭${"─".repeat(width - 2)}╮`));
    console.log(
      colors.border(`│`) +
      colors.accent(visualPadEnd(` ⚔️  WARERA DAILY AUTOMATION DASHBOARD`, innerWidth)) +
      colors.border(`│`)
    );
    console.log(
      colors.border(`│`) +
      colors.dim(visualPadEnd(`    Automated Routine & Resource Manager`, innerWidth)) +
      colors.border(`│`)
    );
    console.log(colors.border(`╰${"─".repeat(width - 2)}╯`));
  }

  section(title, icon = "") {
    this.stopSpinner();
    drawBox(title, icon, 56);
  }

  /**
   * Start a spinner or log text if non-TTY
   */
  spinner(text) {
    this.stopSpinner();

    if (!isTTY || isDebug) {
      console.log(colors.dim(`  ⠋ ${text}`));
      return {
        text: (t) => { if (isDebug) console.log(colors.dim(`    ${t}`)); },
        succeed: (t) => console.log(`  ${colors.success(icons.success)} ${t || text}`),
        warn: (t) => console.log(`  ${colors.warning(icons.warning)} ${t || text}`),
        fail: (t) => console.log(`  ${colors.error(icons.error)} ${t || text}`),
        info: (t) => console.log(`  ${colors.info(icons.transition)} ${t || text}`),
        stop: () => {},
      };
    }

    const s = ora({
      text: colors.dim(text),
      color: "cyan",
      spinner: "dots",
    }).start();

    this.currentSpinner = s;

    return {
      text: (t) => { s.text = colors.dim(t); },
      succeed: (t) => {
        s.succeed(t ? colors.highlight(t) : undefined);
        this.currentSpinner = null;
      },
      warn: (t) => {
        s.warn(t ? colors.warning(t) : undefined);
        this.currentSpinner = null;
      },
      fail: (t) => {
        s.fail(t ? colors.error(t) : undefined);
        this.currentSpinner = null;
      },
      info: (t) => {
        s.info(t ? colors.info(t) : undefined);
        this.currentSpinner = null;
      },
      stop: () => {
        s.stop();
        this.currentSpinner = null;
      },
    };
  }

  stopSpinner() {
    if (this.currentSpinner) {
      try { this.currentSpinner.stop(); } catch {}
      this.currentSpinner = null;
    }
  }

  success(text) {
    this.stopSpinner();
    console.log(`  ${colors.success(icons.success)} ${text}`);
  }

  warn(text) {
    this.stopSpinner();
    console.log(`  ${colors.warning(icons.warning)} ${colors.warning(text)}`);
  }

  error(text) {
    this.stopSpinner();
    console.log(`  ${colors.error(icons.error)} ${colors.error(text)}`);
  }

  info(text) {
    this.stopSpinner();
    console.log(`  ${colors.info(icons.transition)} ${text}`);
  }

  cooldown(text) {
    this.stopSpinner();
    console.log(`  ${colors.warning(icons.cooldown)} ${colors.warning(text)}`);
  }

  item(icon, text) {
    this.stopSpinner();
    console.log(`  ${icon} ${text}`);
  }

  subItem(text) {
    this.stopSpinner();
    console.log(`     ${text}`);
  }

  subItemWithIcon(icon, text) {
    this.stopSpinner();
    console.log(`     ${icon} ${text}`);
  }

  dim(text) {
    this.stopSpinner();
    console.log(`  ${colors.dim(text)}`);
  }

  debug(section, action, details = "") {
    if (isDebug) {
      const time = new Date().toLocaleTimeString();
      console.log(colors.dim(`[DEBUG ${time}] [${section}] [${action}] ${details}`));
    }
  }

  /**
   * Display player resource bar panel
   */
  resourceDisplay(resources) {
    this.stopSpinner();
    if (!resources) return;

    const hCur = resources.health.current.toFixed(1).padStart(5);
    const hMax = resources.health.max.toString().padEnd(3);

    const uCur = resources.hunger.current.toFixed(1).padStart(5);
    const uMax = resources.hunger.max.toString().padEnd(3);

    const eCur = resources.energy.current.toFixed(0).padStart(5);
    const eMax = resources.energy.max.toString().padEnd(3);

    const mCur = resources.entrepreneurship.current.toFixed(0).padStart(5);
    const mMax = resources.entrepreneurship.max.toString().padEnd(3);

    console.log(`  ${icons.health}  ${colors.health("Health           ")} ${colors.highlight(hCur)} ${colors.dim("/")} ${colors.dim(hMax)}`);
    console.log(`  ${icons.hunger}  ${colors.hunger("Hunger           ")} ${colors.highlight(uCur)} ${colors.dim("/")} ${colors.dim(uMax)}`);
    console.log(`  ${icons.energy}  ${colors.energy("Energy           ")} ${colors.highlight(eCur)} ${colors.dim("/")} ${colors.dim(eMax)}`);
    console.log(`  ${icons.ent}  ${colors.ent("Entrepreneurship ")} ${colors.highlight(mCur)} ${colors.dim("/")} ${colors.dim(mMax)}`);
  }

  /**
   * Visual resource transition
   */
  resourceChange(type, before, after, diff = null, max = null) {
    this.stopSpinner();

    let icon = icons.energy;
    let colorFn = colors.energy;
    let label = "Energy";

    if (type === "health") {
      icon = icons.health;
      colorFn = colors.health;
      label = "Health";
    } else if (type === "hunger") {
      icon = icons.hunger;
      colorFn = colors.hunger;
      label = "Hunger";
    } else if (type === "ent" || type === "entrepreneurship") {
      icon = icons.ent;
      colorFn = colors.ent;
      label = "Entrepreneurship";
    }

    const bStr = max != null ? `${before}/${max}` : `${before}`;
    const aStr = max != null ? `${after}/${max}` : `${after}`;
    const diffVal = parseFloat(diff);
    let diffStr = "";
    if (diff != null) {
      if (diffVal > 0) {
        diffStr = colors.health(`(+${diff})`);
      } else if (diffVal < 0) {
        diffStr = colors.hunger(`(${diff})`);
      } else {
        diffStr = colors.dim(`(${diff})`);
      }
    }

    console.log(`     ${icon}  ${colorFn(label.padEnd(16))} ${colors.highlight(bStr)} ${colors.info(icons.transition)} ${colors.highlight(aStr)}   ${diffStr}`);
  }

  /**
   * Compact transition for repetitive company / resistance loops
   */
  compactTransition(icon, colorFn, before, after, extra = "") {
    this.stopSpinner();
    const trans = `${colors.highlight(before)} ${colors.info(icons.transition)} ${colors.highlight(after)}`;
    const extraStr = extra ? `   ${colors.dim(extra)}` : "";
    console.log(`     ${icon}  ${trans}${extraStr}`);
  }

  /**
   * Log decision reasoning for a single scanned battle
   */
  battleScanItem(battle) {
    this.stopSpinner();
    if (battle.eligible) {
      console.log(`  ${colors.highlight(battle.region)}`);
      console.log(`    ${colors.success(icons.success)} Country order`);
      console.log(`    ${colors.success(icons.success)} MU order`);
      console.log(`    ${colors.success(icons.success)} Orders agree: ${colors.target(battle.orderedSide)} side`);
      if (battle.playerCountryInvolved) {
        console.log(`    ${colors.gold("★")} ${colors.gold.bold("Country war")}`);
      } else {
        console.log(`    ${colors.dim("·")} ${colors.dim("Foreign war")}`);
      }
      const bSign = battle.damageBonus >= 0 ? `+${battle.damageBonus}%` : `${battle.damageBonus}%`;
      console.log(`    🔥 Damage bonus: ${colors.health(bSign)}`);
      console.log(`    💰 Damage bounty rate: ${colors.gold((battle.bountyRewardRate ?? battle.damageBountyRate ?? 0).toString())}`);
    } else {
      const hasAnyOrder = battle.countryOrder?.exists || battle.muOrder?.exists;
      if (hasAnyOrder) {
        console.log(`  ${colors.highlight(battle.region)}`);
        if (battle.countryOrder?.exists) {
          console.log(`    ${colors.success(icons.success)} Country order`);
        } else {
          console.log(`    ${colors.error(icons.error)} No Country order`);
        }
        if (battle.muOrder?.exists) {
          console.log(`    ${colors.success(icons.success)} MU order`);
        } else {
          console.log(`    ${colors.error(icons.error)} No MU order`);
        }
        console.log(`    ${colors.dim("→")} ${colors.warning(`Skipped: ${battle.skipReason}`)}`);
      } else {
        console.log(`  ${colors.dim(battle.region.padEnd(24))} ${colors.dim("· No orders → Skipped")}`);
      }
    }
  }

  /**
   * Framed card for the selected battle
   */
  selectedBattleCard(battle, reason, action) {
    this.stopSpinner();
    const width = 56;
    const innerWidth = width - 2;

    const row = (label, value) => {
      const left = `  ${label}:`;
      const right = `${value} `;
      const leftW = visualWidth(left);
      const rightW = visualWidth(right);
      const spaces = " ".repeat(Math.max(1, innerWidth - leftW - rightW));
      return colors.border(`│`) + left + spaces + colors.highlight(right) + colors.border(`│`);
    };

    const bSign = battle.damageBonus >= 0 ? `+${battle.damageBonus}%` : `${battle.damageBonus}%`;

    console.log();
    console.log(colors.border(`╭${"─".repeat(width - 2)}╮`));
    console.log(
      colors.border(`│`) +
      colors.accent(visualPadEnd(` ⚔  Selected Battle`, innerWidth)) +
      colors.border(`│`)
    );
    console.log(colors.border(`├${"─".repeat(width - 2)}┤`));
    console.log(row("Region", colors.highlight(battle.region)));
    console.log(row("Reason", colors.accent(reason)));
    console.log(row("Action", colors.warning(battle.actionType || "ATTACK")));
    console.log(row("Side", colors.target(battle.orderedSide)));
    console.log(row("🔥 Damage bonus", colors.health(bSign)));
    console.log(row("💰 Damage bounty rate", colors.gold((battle.bountyRewardRate ?? battle.damageBountyRate ?? 0).toString())));
    console.log(colors.border(`╰${"─".repeat(width - 2)}╯`));
  }

  /**
   * Section header card specifically formatted for Battle Mode execution
   */
  battleModeBanner(isDryRun = false) {
    this.stopSpinner();
    const width = 46;
    const title = isDryRun ? " ⚔ Battle Mode (Dry-Run)" : " ⚔ Battle Mode";
    console.log();
    console.log(colors.border(`╭${"─".repeat(width - 2)}╮`));
    console.log(
      colors.border(`│`) +
      colors.accent(visualPadEnd(title, width - 2)) +
      colors.border(`│`)
    );
    console.log(colors.border(`╰${"─".repeat(width - 2)}╯`));
    console.log();
  }

  /**
   * Display target battle information before executing hit
   */
  battleTargetInfo(battle) {
    this.stopSpinner();
    console.log(`Battle: ${colors.highlight(battle.region || (battle.sideA + " vs " + battle.sideB))}`);
    console.log(`Side: ${colors.target(battle.orderedSide)}`);
    const cOrder = battle.countryOrder?.exists ? `${colors.success("Country ✓")}` : `${colors.dim("Country -")}`;
    const mOrder = battle.muOrder?.exists ? `${colors.success("MU ✓")}` : `${colors.dim("MU -")}`;
    console.log(`Orders: ${cOrder}  ${mOrder}`);
    const bSign = battle.damageBonus >= 0 ? `+${battle.damageBonus}%` : `${battle.damageBonus}%`;
    console.log(`Damage bonus: ${colors.health(bSign)}`);
    const bountyRate = battle.bountyRewardRate ?? battle.damageBountyRate ?? 0;
    console.log(`Bounty: ${colors.gold(bountyRate.toString())}`);
    if (battle.timeRemaining) {
      console.log(`Time remaining: ${colors.dim(battle.timeRemaining)}`);
    }
    console.log();
  }

  /**
   * Display progress and outcome of a battle hit
   */
  battleHitResult(result) {
    this.stopSpinner();
    console.log(`  ${colors.success("✓")} ${colors.dim("Battle revalidated")}`);
    console.log(`  ${colors.success("✓")} ${colors.dim("Resources verified")}`);

    if (result.dryRun) {
      console.log(`  ${colors.warning("⚡")} ${colors.warning("DRY-RUN: Simulated hit (0 mutations submitted)")}`);
      console.log(`  ${colors.info(icons.info)} Intended Action: ${colors.warning(result.action || "ATTACK")}`);
      console.log(`  Health: ${colors.health(result.beforeHealth.toString())} -> ${colors.health(result.afterHealth.toString())}`);
      console.log();
      return;
    }

    if (result.status === "VERIFIED_HIT") {
      console.log(`  ${colors.success("✓")} ${colors.dim("Hit submitted")}`);
      console.log(`  ${colors.success("✓")} ${colors.success.bold("VERIFIED_HIT")}`);
      if (result.damage !== undefined && result.damage !== null) {
        console.log(`  Damage: ${colors.gold("+" + Number(result.damage).toLocaleString())}`);
      }
      console.log(`  Health: ${colors.health(result.beforeHealth.toString())} -> ${colors.health(result.afterHealth.toString())}`);
      if (result.loot) {
        const lootParts = [];
        if (result.loot.case1) lootParts.push(`Case 1: +${result.loot.case1}`);
        if (result.loot.case2) lootParts.push(`Case 2: +${result.loot.case2}`);
        if (lootParts.length > 0) {
          console.log(`  Loot: ${colors.accent(lootParts.join(", "))}`);
        }
      }
    } else if (result.status === "FAILED_HIT") {
      console.log(`  ${colors.error("✖")} ${colors.error.bold("FAILED_HIT")}`);
      console.log(`  Reason: ${colors.warning(result.reason || "Unknown failure")}`);
    } else if (result.status === "UNKNOWN_HIT") {
      console.log(`  ${colors.error("✖")} ${colors.error.bold("UNKNOWN_HIT (CRITICAL SAFETY STOP)")}`);
      console.log(`  Reason: ${colors.error(result.reason || "Outcome indeterminate - immediate halt to avoid duplicates")}`);
    }
    console.log();
  }

  /**
   * Final summary statistics for Battle Mode execution
   */
  battleModeSummary(summary) {
    this.stopSpinner();
    console.log(`Battles considered: ${colors.highlight(summary.considered.toString())}`);
    console.log(`Battles joined:     ${colors.highlight(summary.joined.toString())}`);
    console.log(`Hits verified:      ${colors.success(summary.hitsVerified.toString())}`);
    console.log(`Hits failed:        ${summary.hitsFailed > 0 ? colors.error(summary.hitsFailed.toString()) : colors.dim("0")}`);
    console.log(`Skipped:            ${colors.dim(summary.skipped.toString())}`);
    console.log(`Resource spent:     ${colors.health(summary.healthSpent.toString() + " Health")}`);
    console.log();
  }

  /**
   * Diagnostic table across all scanned battles
   */
  battleDiagnosticTable(battles) {
    this.stopSpinner();
    console.log();
    console.log(`  ${colors.highlight("BATTLES DIAGNOSTIC SUMMARY TABLE:")}`);

    const tableData = battles.map((b) => ({
      Region: b.region,
      "Country Order": b.countryOrder?.exists ? "YES" : "NO",
      "MU Order": b.muOrder?.exists ? "YES" : "NO",
      Agree: b.eligible ? "YES" : (b.countryOrder?.exists && b.muOrder?.exists ? "CONFLICT" : "-"),
      "Country War": b.playerCountryInvolved ? "YES" : "NO",
      Side: b.orderedSide || "-",
      Action: b.actionType || "-",
      Bonus: b.eligible ? (b.damageBonus >= 0 ? `+${b.damageBonus}%` : `${b.damageBonus}%`) : "-",
      "Bounty Rate": b.eligible ? (b.bountyRewardRate ?? b.damageBountyRate ?? 0) : (b.cardBountyRate ?? 0),
      Status: b.eligible ? "ELIGIBLE" : "SKIPPED",
    }));

    console.table(tableData);
  }

  /**
   * Final summary card
   */
  summaryTable(stats, resources, duration) {
    this.stopSpinner();
    const width = 56;
    const innerWidth = width - 2; // 54

    const row = (icon, label, value) => {
      const left = ` ${icon}  ${label}`;
      const right = `${value} `;
      const leftW = visualWidth(left);
      const rightW = visualWidth(right);
      const spaces = " ".repeat(Math.max(1, innerWidth - leftW - rightW));
      return colors.border(`│`) + left + spaces + colors.highlight(right) + colors.border(`│`);
    };

    console.log();
    console.log(colors.border(`╭${"─".repeat(width - 2)}╮`));
    console.log(
      colors.border(`│`) +
      colors.success(visualPadEnd(` ${icons.success} Daily Automation Completed`, innerWidth)) +
      colors.border(`│`)
    );
    console.log(colors.border(`├${"─".repeat(width - 2)}┤`));
    console.log(row(icons.work, "Energy Work (Pickaxe)", `${stats.energyActions} actions`));
    console.log(row(icons.ent, "Company Work (Brain)", `${stats.entActions} actions`));
    console.log(row(icons.company, "Companies Produced", `${stats.companiesProduced} companies`));
    console.log(row(icons.help, "Military Unit Help", `${stats.membersHelped} members`));
    console.log(row(icons.bread, "Bread Consumed", `${stats.breadEaten} loaves`));
    console.log(row(icons.resistance, "Regional Resistance", `${stats.resistanceContribs} contributions`));
    console.log(row(icons.energy, "Energy in Resistance", `${colors.success("0 (Untouched)")}`));
    if (stats.participationHits) {
      console.log(row(icons.battles, "Participation Sweep", `${stats.participationHits} distinct battles`));
    } else if (stats.battleHitsVerified) {
      console.log(row(icons.battles, "Battle Mode", `${stats.battleHitsVerified} verified hit(s)`));
    } else if (stats.selectedBattle) {
      console.log(row(icons.battles, "Selected Battle", stats.selectedBattle));
    }
    console.log(row(icons.clock, "Total Runtime", `${duration}s`));
    console.log(colors.border(`╰${"─".repeat(width - 2)}╯`));

    if (resources) {
      console.log();
      console.log(`  ${colors.accent("Final Resources:")}`);
      this.resourceDisplay(resources);
    }
    console.log();
  }

  /**
   * Display combat debuff status banner
   */
  debuffBanner(debuffInfo) {
    this.stopSpinner();
    if (debuffInfo?.debuffActive) {
      console.log();
      console.log(`  ${colors.warning("☣ Combat debuff active")}`);
      console.log(`    ${colors.dim("Remaining duration:")} ${colors.gold(debuffInfo.remainingDurationFormatted)}`);
      if (debuffInfo.attackDebuffPercent) {
        console.log(`    ${colors.dim("Attack damage penalty:")} ${colors.error(`-${debuffInfo.attackDebuffPercent}%`)}`);
      }
      console.log(`    ${colors.accent("🛡 Resistance priority enabled")}`);
      console.log();
    }
  }

  /**
   * Display a single hit row during the participation sweep
   */
  sweepHitItem(battleName, action, beforeHp, afterHp, isDryRun = false) {
    this.stopSpinner();
    const actionFormatted = colors.warning((action || "ATTACK").padEnd(8));
    const hpChange = `${colors.health(beforeHp.toString().padStart(4))} ${colors.info(icons.transition)} ${colors.health(afterHp.toString().padStart(4))} HP`;
    const dryRunTag = isDryRun ? `   ${colors.dim("(Dry-Run: simulated)")}` : "";
    console.log(`  ${colors.success(icons.success)} ${colors.highlight((battleName || "Battle").padEnd(28))} ${actionFormatted} ${hpChange}${dryRunTag}`);
  }

  /**
   * Interactive prompt for Resistance and Battles execution mode.
   * Defaults to 'nothing' (0) if no input within timeoutSeconds (default: 60s).
   */
  async promptModeSelection(timeoutSeconds = 60, currentResources = null) {
    this.stopSpinner();

    // 1. Check CLI flags: --mode=none, --mode=resistance, --mode=battles, --mode=both
    const modeArg = process.argv.find((a) => a.startsWith("--mode="));
    if (modeArg) {
      const val = modeArg.split("=")[1].trim().toLowerCase();
      if (val === "1" || val === "resistance" || val === "r") return "resistance";
      if (val === "2" || val === "battles" || val === "battle" || val === "b") return "battles";
      if (val === "3" || val === "both" || val === "all") return "both";
      return "nothing";
    }

    // CLI sweep flags automatically set mode
    if (process.argv.includes("--sweep-only") || process.argv.includes("--live-sweep-only")) {
      console.log();
      console.log(
        `  ${colors.accent("▶")} ${colors.highlight("CLI Flag detected:")} ${colors.warning(process.argv.includes("--live-sweep-only") ? "--live-sweep-only" : "--sweep-only")} ${colors.dim("→ Auto-selecting mode Sweep only (Resistance skipped, Health reserved for Sweep)")}`
      );
      return "sweep_only";
    }
    if (process.argv.includes("--live-sweep") || process.argv.includes("--sweep")) {
      console.log();
      console.log(
        `  ${colors.accent("▶")} ${colors.highlight("CLI Flag detected:")} ${colors.warning(process.argv.includes("--live-sweep") ? "--live-sweep" : "--sweep")} ${colors.dim("→ Auto-selecting mode [3] Both (Resistance + Live Participation Sweep)")}`
      );
      return "both";
    }
    if (process.argv.includes("--dry-sweep")) {
      console.log();
      console.log(
        `  ${colors.accent("▶")} ${colors.highlight("CLI Flag detected:")} ${colors.warning("--dry-sweep")} ${colors.dim("→ Auto-selecting mode [3] Both (Resistance + Dry-Run Participation Sweep)")}`
      );
      return "both";
    }

    // 2. Non-interactive environment fallback
    if (!process.stdin.isTTY) {
      console.log();
      console.log(`  ${colors.info(icons.info)} ${colors.dim("Non-interactive terminal: default mode [0] Nothing (Resistance & Battles skipped)")}`);
      return "nothing";
    }

    // 3. Interactive prompt with live countdown
    return new Promise((resolve) => {
      let timeLeft = timeoutSeconds;
      let resolved = false;

      const width = 56;
      console.log();
      console.log(colors.border(`╭${"─".repeat(width - 2)}╮`));
      console.log(
        colors.border(`│`) +
        colors.accent(visualPadEnd(` ⚙️   MODE SELECTION: RESISTANCE & BATTLES`, width - 2)) +
        colors.border(`│`)
      );
      console.log(colors.border(`╰${"─".repeat(width - 2)}╯`));

      if (currentResources?.health) {
        console.log(`  ${colors.dim("Current Health:")} ${colors.health(currentResources.health.current + "/" + currentResources.health.max)}  ${colors.dim("|  Hunger:")} ${colors.hunger(currentResources.hunger?.current + "/" + currentResources.hunger?.max)}`);
        console.log();
      }

      console.log(`  ${colors.highlight("Select execution mode for Resistance and Battles:")}`);
      console.log(`    ${colors.accent("[0]")} ${colors.highlight("Nothing")}          ${colors.dim("Skip both Resistance and Battles (Default - Health preserved)")}`);
      console.log(`    ${colors.accent("[1]")} ${colors.highlight("Resistance only")}  ${colors.dim("Spend Health on occupied core regions (+ Bread)")}`);
      const isDryMode = process.argv.includes("--dry-run");
      console.log(`    ${colors.accent("[2]")} ${colors.highlight("Battles only")}     ${colors.dim(isDryMode ? "DRY RUN - intelligence only" : "LIVE battle execution")}`);
      console.log(`    ${colors.accent("[3]")} ${colors.highlight("Both")}             ${colors.dim("Run Resistance first, then Battles")}`);
      console.log();

      const cleanup = () => {
        clearInterval(timer);
        if (process.stdin.isTTY) {
          try {
            process.stdin.setRawMode(false);
          } catch {}
        }
        process.stdin.pause();
        process.stdin.removeAllListeners("data");
      };

      const finish = (mode, label) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        process.stdout.write(`\r  ${colors.accent("▶")} Choice [0-3] (Default [0] in ${timeLeft}s): ${colors.success(label)}\n\n`);
        resolve(mode);
      };

      const renderPrompt = () => {
        const timeStr = timeLeft <= 10 ? colors.error(`${timeLeft}s`) : colors.gold(`${timeLeft}s`);
        process.stdout.write(`\r  ${colors.accent("▶")} Choice [0-3] (Default [0] in ${timeStr}): `);
      };

      renderPrompt();

      const timer = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
          finish("nothing", "[0] Nothing (⏱ Timeout: 60s elapsed → Defaulting to Nothing)");
        } else {
          renderPrompt();
        }
      }, 1000);

      // Raw mode single keypress
      let rawModeActive = false;
      try {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding("utf8");
        rawModeActive = true;

        process.stdin.on("data", (chunk) => {
          const key = chunk.toString();
          if (key === "\u0003") {
            cleanup();
            process.stdout.write("\n");
            process.exit(0);
          }

          const ch = key.trim().toLowerCase();
          if (ch === "0" || key === "\r" || key === "\n" || key === " " || key === "\u001b" || ch === "n" || ch === "q") {
            finish("nothing", "[0] Nothing (Resistance & Battles skipped)");
          } else if (ch === "1" || ch === "r") {
            finish("resistance", "[1] Resistance only (Use Health on occupied core regions)");
          } else if (ch === "2" || ch === "b") {
            const isDry = process.argv.includes("--dry-run");
            const label = isDry
              ? "[2] Battles only (DRY RUN - intelligence only)"
              : "[2] Battles only (LIVE battle execution)";
            finish("battles", label);
          } else if (ch === "3" || ch === "both" || ch === "a" || ch === "y") {
            finish("both", "[3] Both (Resistance + Battles)");
          } else if (ch === "4" || ch === "s" || ch === "sweep") {
            finish("sweep_only", "[4] Sweep only (Resistance skipped, Health reserved for Sweep)");
          }
        });
      } catch {
        rawModeActive = false;
      }

      if (!rawModeActive) {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.on("line", (line) => {
          const ch = line.trim().toLowerCase();
          const isDry = process.argv.includes("--dry-run");
          if (ch === "1" || ch === "r") finish("resistance", "[1] Resistance only");
          else if (ch === "2" || ch === "b") finish("battles", isDry ? "[2] Battles only (DRY RUN - intelligence only)" : "[2] Battles only (LIVE battle execution)");
          else if (ch === "3" || ch === "both" || ch === "a") finish("both", "[3] Both");
          else if (ch === "4" || ch === "s" || ch === "sweep") finish("sweep_only", "[4] Sweep only");
          else finish("nothing", "[0] Nothing");
          rl.close();
        });
      }
    });
  }
}

export const ui = new UIManager();
export default ui;
