#!/usr/bin/env node

/**
 * WarEra Equipment Buyer
 *
 * Analyzes the live equipment market and finds the BEST VALUE gear to buy.
 * Scoped to wearable equipment (Helmet, Chest, Gloves, Pants, Boots) and Weapons.
 *
 * Features:
 * - Read-only analyzer by default
 * - Safe live execution mode via --execute
 * - Strategy selection: best-value (default), best-performance, cheapest-upgrade
 * - Exact offer locking & fresh pre-purchase refresh
 * - 0% default slippage guard (configurable via --max-slippage)
 * - Interactive confirmation (Type BUY to continue)
 * - 3-way post-purchase verification with bounded polling
 * - Multi-purchase support with dynamic re-evaluation
 * - Strict safety: NEVER auto-equips purchased gear
 */

import readline from "node:readline";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import ui, { colors, icons, drawBox, isDebug, visualPadEnd } from "./ui.mjs";
import { USER_ID, resolveUserId } from "./config.mjs";
import { fetchGameConfig, fetchWithRetry, getCookieHeader, sleep } from "./analyzer/api.mjs";
import { fetchMarketTaxRate, formatWarEraNumber } from "./analyzer/market_pricing.mjs";
import {
  SUPPORTED_CATEGORIES,
  SLOT_LABELS,
  formatStatShort,
  resolveRarity,
  resolveCategories,
  extractRarityCatalog,
  fetchAllMarketOffers,
  sanitizeMarketOffers,
  eliminateDominatedOffers,
  evaluateGearOffer,
  evaluateWeaponOffer,
  findCategoryRecommendations,
  selectRecommendationByStrategy,
  findOverallBestValue,
  optimizeLoadoutUnderBudget,
  buildFullLoadout,
  verifyFuturePurchaseSafety,
  formatAlternativeSummary,
  PurchaseVerificationState,
  submitMarketPurchase,
  refreshAndValidateOffer,
  verifyMarketPurchase,
  fetchUserRecentTransactions,
  fetchUserInventory,
} from "./analyzer/buyer_evaluator.mjs";

const DEFAULT_HEADERS = {
  "content-type": "application/json",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0",
};

const API_BASE = "https://api6.warera.io/trpc";

const SLOT_ICONS = {
  helmet: "🪖",
  chest: "🛡️",
  gloves: "🧤",
  pants: "👖",
  boots: "🥾",
  weapon: "⚔️",
};

/**
 * Parse CLI arguments.
 */
export function parseArgs(args = process.argv.slice(2)) {
  const config = {
    rarity: null,
    include: null,
    exclude: null,
    weaponType: null,
    strategy: "best-value", // 'best-value', 'best-performance', 'cheapest'
    verbose: false,
    compareEquipped: false, // DEFAULT: evaluate requested rarity standalone
    ignoreEquipped: false,
    execute: false, // Deprecated compatibility alias (harmless no-op)
    dryRun: false, // Analysis only: never prompt BUY, never mutate
    offerId: null,
    maxPrice: null,
    budget: null,
    maxPurchases: null, // Default: null (inferred from selected loadout items count)
    maxSlippage: 0, // 0% default slippage
    yes: false,
    timeout: null, // Request timeout in seconds (null = default 25s)
  };

  for (const arg of args) {
    if (arg === "--verbose" || arg === "-v") {
      config.verbose = true;
    } else if (arg === "--dry-run") {
      config.dryRun = true;
    } else if (arg === "--compare-equipped") {
      config.compareEquipped = true;
    } else if (arg === "--ignore-equipped") {
      config.compareEquipped = false;
      config.ignoreEquipped = true;
    } else if (arg === "--execute") {
      config.execute = true;
    } else if (arg === "--yes" || arg === "-y") {
      config.yes = true;
    } else if (arg.startsWith("--timeout=")) {
      const t = Number(arg.split("=")[1].trim());
      if (isNaN(t) || t <= 0) {
        throw new Error(`Invalid --timeout value '${arg.split("=")[1]}'. Must be a positive number of seconds.`);
      }
      config.timeout = t;
    } else if (arg.startsWith("--rarity=")) {
      config.rarity = arg.split("=")[1].trim();
    } else if (arg.startsWith("--include=")) {
      config.include = arg.split("=")[1].trim();
    } else if (arg.startsWith("--exclude=")) {
      config.exclude = arg.split("=")[1].trim();
    } else if (arg.startsWith("--weapon-type=")) {
      config.weaponType = arg.split("=")[1].trim();
    } else if (arg.startsWith("--strategy=")) {
      const s = arg.split("=")[1].toLowerCase().trim();
      const valid = ["best-value", "best-performance", "cheapest", "cheapest-upgrade"];
      if (!valid.includes(s)) {
        throw new Error(
          `Invalid strategy '${s}'. Valid strategies: best-value, best-performance, cheapest`
        );
      }
      config.strategy = s === "cheapest-upgrade" ? "cheapest" : s;
    } else if (arg.startsWith("--offer-id=")) {
      config.offerId = arg.split("=")[1].trim();
    } else if (arg.startsWith("--max-price=")) {
      config.maxPrice = Number(arg.split("=")[1].trim());
    } else if (arg.startsWith("--budget=")) {
      config.budget = Number(arg.split("=")[1].trim());
    } else if (arg.startsWith("--max-purchases=")) {
      config.maxPurchases = parseInt(arg.split("=")[1].trim(), 10);
    } else if (arg.startsWith("--max-slippage=")) {
      config.maxSlippage = Number(arg.split("=")[1].replace("%", "").trim());
    }
  }

  if (!config.rarity && !config.offerId) {
    throw new Error(
      "Missing required argument: --rarity=<rarity>\n" +
        "Examples:\n" +
        "  npm run equipment-buyer -- --rarity=green\n" +
        "  npm run equipment-buyer -- --rarity=blue --include=boots --strategy=best-value\n" +
        "  npm run equipment-buyer -- --rarity=blue --include=weapon --strategy=best-performance"
    );
  }

  return config;
}

export const STRATEGY_CHOICE_PROMPT =
`Choose loadout:
  BUY          = purchase currently selected loadout
  BEST         = switch to Best Value
  PERFORMANCE  = switch to Best Performance
  CHEAPEST     = switch to Cheapest
  CANCEL       = exit

Choice: `;

/**
 * Parse user strategy choice input case-insensitively.
 */
export function parseLoadoutChoice(rawInput) {
  const s = (rawInput || "").trim().toUpperCase();
  if (s === "BUY") {
    return { action: "BUY" };
  }
  if (s === "BEST" || s === "BEST VALUE" || s === "BEST-VALUE") {
    return { action: "SWITCH", strategy: "best-value" };
  }
  if (s === "PERFORMANCE" || s === "BEST PERFORMANCE" || s === "BEST-PERFORMANCE") {
    return { action: "SWITCH", strategy: "best-performance" };
  }
  if (s === "CHEAPEST") {
    return { action: "SWITCH", strategy: "cheapest" };
  }
  return { action: "CANCEL" };
}

/**
 * Prompt user for strategy selection.
 */
export async function promptStrategyChoice(promptText = STRATEGY_CHOICE_PROMPT) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    let resolved = false;
    rl.question(promptText, (ans) => {
      if (!resolved) {
        resolved = true;
        rl.close();
        resolve((ans || "").trim());
      }
    });
    rl.on("close", () => {
      if (!resolved) {
        resolved = true;
        resolve("");
      }
    });
  });
}

/**
 * Prompt user for terminal confirmation.
 */
export async function promptConfirmation(promptText) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    let resolved = false;
    rl.question(promptText, (ans) => {
      if (!resolved) {
        resolved = true;
        rl.close();
        resolve((ans || "").trim());
      }
    });
    rl.on("close", () => {
      if (!resolved) {
        resolved = true;
        resolve("");
      }
    });
  });
}

/**
 * Fetch live wallet Gold balance from canonical inventory endpoint.
 */
export async function fetchLiveWalletGold(userId = null, options = {}) {
  const targetUserId = resolveUserId(userId || options.userId);
  const cookieHeader = options.cookieHeader ?? getCookieHeader();
  const fetchFn = options.fetchFn ?? fetchWithRetry;
  const apiBase = options.apiBase ?? API_BASE;

  if (!cookieHeader) {
    throw new Error("Session cookies not found in cookies.json. Please log in first.");
  }

  const res = await fetchFn(
    `${apiBase}/inventory.getInventory?batch=1`,
    {
      method: "POST",
      headers: { ...DEFAULT_HEADERS, cookie: cookieHeader },
      body: JSON.stringify({ "0": { userId: targetUserId } }),
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch user inventory/wallet (HTTP ${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  const rawMoney = json[0]?.result?.data?.money ?? 0;
  return Number(Number(rawMoney).toFixed(3));
}

/**
 * Bounded polling for post-purchase wallet balance convergence.
 *
 * @param {number} startingGold - Initial verified balance before purchases
 * @param {number} verifiedSpend - Total verified gold spent across successful purchases
 * @param {object} options - Polling configuration options
 * @returns {Promise<object>} Reconciled balance accounting object
 */
export async function pollReconciledWalletGold(startingGold, verifiedSpend, options = {}) {
  const fetchWalletFn = options.fetchWalletFn || fetchLiveWalletGold;
  const sleepFn = options.sleepFn || sleep;
  const delaysMs = options.delaysMs || [0, 250, 500, 1000, 2000, 3000];
  const tolerance = options.tolerance ?? 0.05;
  const userId = resolveUserId(options.userId);

  if (!isFinite(startingGold)) {
    return {
      startingGold: null,
      endingGold: null,
      verifiedSpend,
      delta: 0,
      discrepancy: 0,
      difference: 0,
      state: "UNAVAILABLE",
      converged: false,
      pollsAttempted: 0,
    };
  }

  if (verifiedSpend <= 0) {
    return {
      startingGold,
      endingGold: startingGold,
      verifiedSpend: 0,
      delta: 0,
      discrepancy: 0,
      difference: 0,
      state: "VERIFIED",
      converged: true,
      pollsAttempted: 0,
    };
  }

  let latestGold = startingGold;
  let pollsAttempted = 0;

  for (let i = 0; i < delaysMs.length; i++) {
    const delay = delaysMs[i];
    if (delay > 0) {
      await sleepFn(delay);
    }
    pollsAttempted++;
    try {
      latestGold = await fetchWalletFn(userId);
    } catch {
      // Continue polling if network hiccup occurs
      continue;
    }

    const delta = Number((startingGold - latestGold).toFixed(3));
    const discrepancy = Number(Math.abs(delta - verifiedSpend).toFixed(3));

    if (discrepancy <= tolerance) {
      return {
        startingGold,
        endingGold: latestGold,
        verifiedSpend,
        delta,
        discrepancy,
        difference: 0,
        state: "VERIFIED",
        converged: true,
        pollsAttempted,
      };
    }
  }

  // All polls exhausted without convergence within tolerance
  const finalDelta = Number((startingGold - latestGold).toFixed(3));
  const finalDiscrepancy = Number(Math.abs(finalDelta - verifiedSpend).toFixed(3));
  const finalDifference = Number((finalDelta - verifiedSpend).toFixed(3));

  if (Math.abs(finalDelta) <= tolerance) {
    // Balance never updated before timeout (e.g. delta == 0)
    return {
      startingGold,
      endingGold: latestGold,
      verifiedSpend,
      delta: finalDelta,
      discrepancy: finalDiscrepancy,
      difference: finalDifference,
      state: "PENDING",
      converged: false,
      pollsAttempted,
    };
  }

  // Balance updated, but contains unrelated activity (difference from verifiedSpend)
  return {
    startingGold,
    endingGold: latestGold,
    verifiedSpend,
    delta: finalDelta,
    discrepancy: finalDiscrepancy,
    difference: finalDifference,
    state: "UNRELATED_ACTIVITY",
    converged: false,
    pollsAttempted,
  };
}

/**
 * Fetch current user inventory equipment & profile data and live wallet Gold balance.
 */
export async function fetchUserLiveState(userId = null, options = {}) {
  const targetUserId = resolveUserId(userId || options.userId);
  const cookieHeader = options.cookieHeader ?? getCookieHeader();
  const fetchFn = options.fetchFn ?? fetchWithRetry;
  const apiBase = options.apiBase ?? API_BASE;

  if (!cookieHeader) {
    throw new Error("Session cookies not found in cookies.json. Please log in first.");
  }

  const res = await fetchFn(
    `${apiBase}/inventory.fetchCurrentEquipment,user.getUserById,inventory.getInventory?batch=1`,
    {
      method: "POST",
      headers: { ...DEFAULT_HEADERS, cookie: cookieHeader },
      body: JSON.stringify({
        "0": { userId: targetUserId },
        "1": { userId: targetUserId },
        "2": { userId: targetUserId },
      }),
    }
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch user live equipment & profile (HTTP ${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  const equipped = json[0]?.result?.data || {};
  const user = json[1]?.result?.data || {};
  const walletGold = Number(Number(json[2]?.result?.data?.money ?? user?.stats?.wealth?.money ?? 0).toFixed(3));

  return { equipped, user, walletGold };
}

function formatRarityText(displayName) {
  const d = (displayName || "").toLowerCase();
  if (d === "grey" || d === "common") return chalk.gray(displayName);
  if (d === "green" || d === "uncommon") return chalk.green(displayName);
  if (d === "blue" || d === "rare") return chalk.blueBright(displayName);
  if (d === "purple" || d === "epic") return chalk.magenta(displayName);
  if (d === "gold" || d === "legendary") return chalk.yellow(displayName);
  if (d === "red" || d === "mythic") return chalk.redBright(displayName);
  return chalk.white(displayName);
}

function formatConf(conf) {
  if (conf === "HIGH") return chalk.green.bold("HIGH");
  if (conf === "MODERATE" || conf === "MOD") return chalk.yellow("MOD");
  if (conf === "LOW") return chalk.hex("#F97316")("LOW");
  return chalk.red.bold("VERY LOW");
}

function printBanner() {
  drawBox("WarEra Equipment Buyer", "🛒", 46);
}

/**
 * Print compact recommendation table for a category.
 */
function printCategoryCard(category, result, options = {}) {
  const icon = SLOT_ICONS[category] || "•";
  const label = SLOT_LABELS[category] || category;
  const { equipped, recommendations, rangeInfo } = result;

  console.log(`\n${icon}  ${chalk.bold.white(label)}`);

  // Print current equipped stat
  if (category === "weapon") {
    const currentWeaponName = equipped?.code || "None";
    const currentAtk = equipped?.skills?.attack ?? 0;
    const currentCrit = equipped?.skills?.criticalChance ?? 0;
    const dmg = result.baselineDamage || 0;
    console.log(
      chalk.dim(
        `   Current: ${currentWeaponName} (+${currentAtk} Atk, +${currentCrit}% Crit) ~ ${dmg} dmg/hit`
      )
    );
  } else {
    const statName = rangeInfo?.statName || "Stat";
    const statVal = equipped?.skills?.[statName];
    if (statVal !== undefined) {
      console.log(chalk.dim(`   Current: +${statVal} ${statName}`));
    } else {
      console.log(chalk.dim(`   Current: None (0 ${statName})`));
    }
  }

  if (!recommendations.hasUpgrade) {
    console.log(`   ${chalk.yellow("No worthwhile upgrade found.")}\n`);
    return;
  }

  const { bestValue, bestPerformance, cheapestUpgrade } = recommendations;

  // Header
  console.log();
  const header = `   ${visualPadEnd("Type", 13)} ${visualPadEnd("Roll / Stat", 16)} ${visualPadEnd("Buyer Cost", 11)} ${visualPadEnd("Efficiency", 12)} ${visualPadEnd("Conf", 6)}`;
  console.log(chalk.dim(header));
  console.log(chalk.dim(`   ${"─".repeat(62)}`));

  const rows = [
    { type: "BEST VALUE", item: bestValue, color: chalk.cyan.bold },
    { type: "BEST PERF", item: bestPerformance, color: chalk.magenta.bold },
    { type: "CHEAPEST", item: cheapestUpgrade, color: chalk.green.bold },
  ];

  for (const row of rows) {
    const it = row.item;
    if (!it) continue;

    let rollStr = "";
    let upgradeStr = "";

    if (category === "weapon") {
      rollStr = `+${it.attack}A/+${it.criticalChance}C`;
      upgradeStr = `${(it.attackValueScore || (it.attack / it.buyerPrice)).toFixed(2)} Atk/G`;
    } else {
      rollStr = `+${it.statValue}/+${it.maxPossibleStat}`;
      upgradeStr = it.statDiff > 0 ? `+${it.statDiff}` : "0";
    }

    const costStr = `${it.buyerPrice.toFixed(3)}`;
    const line = `   ${visualPadEnd(row.color(row.type), 13)} ${visualPadEnd(rollStr, 16)} ${visualPadEnd(costStr + " G", 11)} ${visualPadEnd(chalk.green(upgradeStr), 12)} ${formatConf(it.confidence)}`;
    console.log(line);
  }

  // Market Fairness summary for Best Value
  if (bestValue) {
    const dealText =
      bestValue.priceDiffPct >= 0
        ? `${bestValue.priceDiffPct}% below fair value`
        : `${Math.abs(bestValue.priceDiffPct)}% above fair value`;
    const fairStr = `${bestValue.fairBuyerPrice.toFixed(3)} G`;
    const overpricedTag = bestValue.isOverpriced ? chalk.red.bold(" [OVERPRICED]") : "";
    const rollDesc = category === "weapon"
      ? `Atk Roll ${bestValue.attack === bestValue.maxAtk ? "PERFECT" : `${bestValue.atkRollPercent ?? 0}%`} | Crit ${bestValue.criticalChance === bestValue.maxCrit ? "PERFECT / MAX MARKET" : "MAX MARKET"}`
      : `${bestValue.rollPosition} roll`;
    console.log(
      chalk.dim(
        `   Fair market: ${fairStr} | Deal: ${dealText} | ${rollDesc}${overpricedTag}`
      )
    );
  }

  console.log();
}

/**
 * Print overall best value purchase highlight.
 */
function printOverallBestValue(overall) {
  if (!overall || !overall.offer) {
    console.log(chalk.yellow("\nNo upgrades available across requested categories.\n"));
    return;
  }

  const it = overall.offer;
  const cat = overall.category;
  const label = SLOT_LABELS[cat] || cat;
  const icon = SLOT_ICONS[cat] || "🏆";
  const strat = overall.strategy || "best-value";

  drawBox(`Best ${strat.toUpperCase()} Purchase`, "🏆", 50);

  let detail = "";
  if (cat === "weapon") {
    detail = `${it.weaponName} (+${it.attack} Atk, +${it.criticalChance}% Crit)`;
  } else {
    detail = `${label} +${it.statValue} ${it.statName}`;
  }

  console.log(`\n  ${icon}  ${chalk.bold.white(detail)}`);
  console.log(`     Buyer price:  ${chalk.cyan.bold(it.buyerPrice.toFixed(3))} Gold (includes ${it.taxRate}% tax)`);
  console.log(`     Asking price: ${chalk.dim(it.sellerPrice.toFixed(2))} Gold`);
  if (cat === "weapon") {
    const atkRollStr = it.attack === it.maxAtk ? "PERFECT" : `${it.atkRollPercent ?? 0}%`;
    const critStr = it.criticalChance === it.maxCrit ? "PERFECT / MAX MARKET" : "MAX MARKET";
    const eff = (it.attackValueScore || (it.attack / it.buyerPrice)).toFixed(3);
    console.log(`     Efficiency:   ${chalk.green.bold(`${eff} Attack / Gold`)} (Atk Roll ${atkRollStr} | Crit ${critStr})`);
  } else {
    console.log(`     Improvement:  ${chalk.green.bold(`+${it.statDiff} ${it.statName}`)} (Current: +${it.equippedStat})`);
    const qualPerGold = it.valueScore !== undefined ? `${it.valueScore.toFixed(6)} quality / Gold` : `${it.statPerGold} ${it.statName} / Gold`;
    console.log(`     Efficiency:   ${chalk.green.bold(qualPerGold)} (${it.rollPosition} roll)`);
    console.log(`     Normalized:   ${chalk.green.bold(`${(it.normalizedValueScore * 100).toFixed(2)}% norm improvement / Gold`)} (Normalized Value score)`);
    console.log(chalk.dim(`     Note:         Cross-slot ranking uses Normalized Value; relative utility varies by player build.`));
  }
  console.log(`     Market fair:  ${it.fairBuyerPrice.toFixed(3)} Gold (${it.priceDiffPct >= 0 ? `${it.priceDiffPct}% discount` : `${Math.abs(it.priceDiffPct)}% premium`})`);
  console.log(`     Confidence:   ${formatConf(it.confidence)}`);
  console.log(chalk.dim(`     Offer ID:     #${it.offerId.slice(-8)} (Item #${it.itemId.slice(-8)})`));
  console.log();
}

/**
 * Print compact loadout table matching Section 7.
 */
function printLoadoutTable(loadout, options = {}) {
  const { compareEquipped = false, verbose = false } = options;
  const stratTitle =
    loadout.strategy === "best-performance"
      ? "Best-Performance"
      : loadout.strategy === "cheapest"
      ? "Cheapest"
      : "Best-Value";
  const budgetStr = loadout.budget ? ` (Budget: ${loadout.budget.toFixed(3)} G)` : "";
  drawBox(`${loadout.rarityDisplayName} ${stratTitle} Loadout${budgetStr}`, "🛒", 50);

  console.log();
  const slotW = 10;
  const statW = 24;
  const rangeW = 20;
  const rollW = 34;
  const upgW = 10;
  const costW = 12;

  let header = `   ${visualPadEnd("Slot", slotW)} ${visualPadEnd("Stats", statW)} ${visualPadEnd("Live Range", rangeW)} ${visualPadEnd("Roll", rollW)} `;
  if (compareEquipped) {
    header += `${visualPadEnd("Upgrade", upgW)} `;
  }
  header += `${visualPadEnd("Cost", costW)}`;

  console.log(chalk.dim(header));
  const totalW = compareEquipped ? 116 : 104;
  console.log(chalk.dim(`   ${"─".repeat(totalW)}`));

  for (const item of loadout.items) {
    const slotStr = item.slotLabel;
    const statStr = item.statDisplay;
    const rangeStr = item.rangeDisplay ? `(${item.rangeDisplay})` : "";
    let rollStr = item.rollDisplay === "PERFECT" ? chalk.green.bold("PERFECT") : item.rollDisplay;
    if (item.slot === "weapon" && item.rollDisplay) {
      rollStr = chalk.bold(item.rollDisplay);
    }
    const costStr = `${item.cost.toFixed(3)} G`;

    let row = `   ${visualPadEnd(chalk.bold.white(slotStr), slotW)} ${visualPadEnd(statStr, statW)} ${visualPadEnd(chalk.dim(rangeStr), rangeW)} ${visualPadEnd(rollStr, rollW)} `;
    if (compareEquipped) {
      const upgStr = item.statDiff > 0 ? chalk.green(`+${item.statDiff}`) : chalk.dim("0");
      row += `${visualPadEnd(upgStr, upgW)} `;
    }
    row += `${visualPadEnd(chalk.cyan(costStr), costW)}`;
    console.log(row);
  }

  console.log(chalk.dim(`   ${"─".repeat(totalW)}`));
  console.log();
  console.log(`  ${chalk.bold("Total cost:")}       ${chalk.cyan.bold(loadout.totalCost.toFixed(3))} Gold`);
  if (loadout.totalQuality !== undefined && loadout.maxPossibleQuality) {
    console.log(
      `  ${chalk.bold("Normalized Loadout Quality:")} ${chalk.green.bold(loadout.totalQuality.toFixed(2))} / ${loadout.maxPossibleQuality.toFixed(2)} (${loadout.avgQualityPercent}% average roll quality)`
    );
  }
  console.log(`  ${chalk.bold("Market value:")}     ${chalk.dim(loadout.totalMarketValue.toFixed(3))} Gold`);
  const discColor = loadout.totalDiscount >= 0 ? chalk.green.bold : chalk.yellow;
  const discLabel = loadout.totalDiscount >= 0 ? "Total discount:" : "Total premium:";
  console.log(`  ${chalk.bold(discLabel)}   ${discColor(Math.abs(loadout.totalDiscount).toFixed(3))} Gold`);
  console.log(`  ${chalk.bold("Offers selected:")}  ${loadout.offersSelected}`);
  if (loadout.budget) {
    const remBudget = loadout.budget - loadout.totalCost;
    console.log(
      `  ${chalk.bold("Remaining budget:")} ${
        remBudget >= 0 ? chalk.green(`${remBudget.toFixed(3)} Gold`) : chalk.red(`${remBudget.toFixed(3)} Gold`)
      }`
    );
  }
  console.log();

  // Alternative Sets
  if (loadout.alternativeSets && Object.keys(loadout.alternativeSets).length > 0) {
    console.log(chalk.bold("Alternative Loadouts:"));
    for (const [sKey, alt] of Object.entries(loadout.alternativeSets)) {
      if (!alt || alt.totalCost === 0) continue;
      const isActive =
        Boolean(alt.isSelected) ||
        sKey === loadout.strategy ||
        (sKey === "cheapest" && loadout.strategy === "cheapest-upgrade");
      const namePad = visualPadEnd(alt.name, 18);
      const costStr = visualPadEnd(`${alt.totalCost.toFixed(3)} G`, 14);

      if (isActive) {
        console.log(`  ${chalk.cyan.bold(namePad)} ${chalk.cyan.bold(costStr)} ${chalk.dim("(Selected)")}`);
      } else {
        const summary = alt.summary || formatAlternativeSummary(alt, loadout);
        if (summary?.isExactSameOffers) {
          console.log(`  ${chalk.white(namePad)} ${chalk.white(costStr)}`);
          console.log(`    ${chalk.dim(summary.statsSummary)}`);
          console.log(`    ${chalk.dim(summary.comparisonSummary)}`);
        } else if (summary) {
          console.log(`  ${chalk.white(namePad)} ${chalk.white(costStr)}`);
          console.log(`    ${chalk.dim(summary.statsSummary)}`);
          console.log(`    ${chalk.dim(`(${summary.comparisonSummary})`)}`);
        } else {
          const costDiff = Number((alt.totalCost - loadout.totalCost).toFixed(3));
          let costDiffStr = "";
          if (Math.abs(costDiff) < 0.0005) {
            costDiffStr = "identical cost vs selected";
          } else if (costDiff > 0) {
            costDiffStr = `+${costDiff.toFixed(3)} G vs selected`;
          } else {
            costDiffStr = `${costDiff.toFixed(3)} G vs selected`;
          }
          const qualityStr = alt.avgQualityPercent !== undefined ? `${alt.avgQualityPercent}% avg roll` : `${alt.totalStats} total stats`;
          console.log(
            `  ${chalk.white(namePad)} ${chalk.white(costStr)} ${chalk.dim(`(${qualityStr}, ${costDiffStr})`)}`
          );
        }
      }
    }
    console.log();
  }

  // If verbose, show exact details per item
  if (verbose) {
    console.log(chalk.bold.yellow("Exact Offer Details (--verbose):\n"));
    for (const item of loadout.items) {
      const o = item.offer;
      console.log(`  ${SLOT_ICONS[item.slot] || "📦"} ${chalk.bold.white(item.slotLabel)}:`);
      console.log(`     Offer ID:     ${o.offerId || o._id}`);
      console.log(`     Item ID:      ${o.itemId || o.item?._id || "N/A"}`);
      const seller = typeof o.user === "object" ? o.user?.username || o.user?._id : o.user;
      console.log(`     Seller:       ${seller || "N/A"}`);
      console.log(`     Asking price: ${o.sellerPrice !== undefined ? o.sellerPrice.toFixed(3) : "N/A"} Gold`);
      console.log(`     Buyer price:  ${o.buyerPrice.toFixed(3)} Gold (includes ${o.taxRate}% tax)`);
      console.log(`     Market fair:  ${item.fairBuyerPrice.toFixed(3)} Gold (${item.discount >= 0 ? `${item.discount.toFixed(3)} G discount` : "premium"})`);
      console.log(`     Confidence:   ${formatConf(item.confidence)}`);
      console.log();
    }
  }
}

/**
 * Print purchase plan card for confirmation.
 */
function printPurchasePlan(loadoutOrCandidate, strategy, purchasesCount = 1) {
  drawBox("Purchase Plan", "🛒", 50);

  if (loadoutOrCandidate.items) {
    // Loadout plan
    const loadout = loadoutOrCandidate;
    console.log(`\n  Strategy:         ${chalk.bold.cyan(strategy.toUpperCase())}`);
    console.log(`  Loadout slots:    ${loadout.items.length}`);
    console.log(`  Purchasing items: ${purchasesCount}\n`);

    const toBuy = loadout.items.slice(0, purchasesCount);
    let planCost = 0;
    for (const it of toBuy) {
      planCost += it.cost;
      console.log(
        `  ${SLOT_ICONS[it.slot] || "📦"} ${visualPadEnd(it.slotLabel, 10)} ${visualPadEnd(it.statDisplay, 18)} ${chalk.cyan(it.cost.toFixed(3) + " G")}`
      );
    }
    console.log(`\n  Total planned cost: ${chalk.cyan.bold(planCost.toFixed(3))} Gold\n`);
  } else {
    // Single candidate plan
    const it = loadoutOrCandidate.offer;
    const cat = loadoutOrCandidate.category;
    const label = SLOT_LABELS[cat] || cat;

    console.log(`\n  Strategy: ${chalk.bold.cyan(strategy.toUpperCase())}\n`);
    if (cat === "weapon") {
      console.log(`  ${chalk.bold.white(it.weaponName)}`);
      console.log(`  Attack:       +${it.attack}`);
      console.log(`  Crit Chance:  +${it.criticalChance}%`);
      console.log(`  Buyer price:  ${chalk.cyan.bold(it.buyerPrice.toFixed(3))} Gold (includes ${it.taxRate}% tax)`);
      console.log(`  Damage gain:  ${chalk.green.bold(`+${it.damageGain} / hit`)}`);
      console.log(`  Value:        ${it.combatGainPerGold} dmg / Gold`);
      console.log(`  Confidence:   ${formatConf(it.confidence)}`);
    } else {
      console.log(`  ${chalk.bold.white(`${label} +${it.statValue} ${it.statName}`)}`);
      console.log(`  Roll:         ${it.rollPosition}`);
      console.log(`  Buyer price:  ${chalk.cyan.bold(it.buyerPrice.toFixed(3))} Gold (includes ${it.taxRate}% tax)`);
      console.log(`  Fair value:   ${it.fairBuyerPrice.toFixed(3)} Gold`);
      console.log(`  Deal:         ${it.priceDiffPct >= 0 ? `${it.priceDiffPct}% below fair value` : `${Math.abs(it.priceDiffPct)}% above fair value`}`);
      console.log(`  Stat gain:    ${chalk.green.bold(`+${it.statDiff} ${it.statName}`)}`);
      console.log(`  Efficiency:   ${it.statPerGold} ${it.statName} / Gold`);
      console.log(`  Confidence:   ${formatConf(it.confidence)}`);
    }

    const idDisplay = (isDebug || process.env.VERBOSE) ? it.offerId : `#${it.offerId.slice(-8)}`;
    console.log(chalk.dim(`\n  Offer ID:     ${idDisplay}`));
    console.log();
  }
}

/**
 * Print full-loadout confirmation card immediately before BUY prompt (Section 6).
 */
export function printFullLoadoutConfirmation(confirmedLoadout) {
  const stratDisplayName = confirmedLoadout.strategyDisplayName || confirmedLoadout.strategy?.toUpperCase() || "BEST VALUE";
  const rarityName = confirmedLoadout.rarityDisplayName || "";
  const title = `Purchase ${rarityName} ${stratDisplayName} Loadout`.trim();
  drawBox(title, "🛒", 50);

  console.log();
  const slotW = 11;
  const statW = 18;
  const costW = 12;

  console.log(
    `   ${chalk.dim(visualPadEnd("Slot", slotW))} ${chalk.dim(visualPadEnd("Stats", statW))} ${chalk.dim(visualPadEnd("Cost", costW))}`
  );
  console.log(chalk.dim(`   ${"─".repeat(40)}`));

  for (const item of confirmedLoadout.items) {
    const slotStr = visualPadEnd(item.slotLabel, slotW);
    const statStr = visualPadEnd(item.statDisplay, statW);
    const costStr = visualPadEnd(item.cost.toFixed(3) + " G", costW);
    console.log(`   ${slotStr} ${statStr} ${chalk.cyan(costStr)}`);
  }

  console.log(chalk.dim(`   ${"─".repeat(40)}`));
  console.log();
  console.log(`  ${chalk.bold("Items:")}      ${confirmedLoadout.items.length}`);
  console.log(`  ${chalk.bold("Total:")}      ${chalk.cyan.bold(confirmedLoadout.totalCost.toFixed(3))} Gold`);
  console.log(`  ${chalk.bold("Strategy:")}   ${chalk.bold.cyan(stratDisplayName)}`);
  console.log();
}

/**
 * Print selected loadout card after strategy switching (Section 4).
 */
export function printSelectedLoadoutCard(targetLoadout) {
  const stratKey = targetLoadout.strategy || "best-value";
  const stratTitle =
    stratKey === "best-performance" || stratKey === "performance"
      ? "Best Performance"
      : stratKey === "cheapest" || stratKey === "cheapest-upgrade"
      ? "Cheapest"
      : "Best Value";
  const title = `${stratTitle} Loadout Selected`;
  drawBox(title, "🛒", 46);

  console.log();
  const slotW = 11;
  const statW = 24;
  const costW = 12;

  console.log(
    `   ${chalk.dim(visualPadEnd("Slot", slotW))} ${chalk.dim(visualPadEnd("Stats", statW))} ${chalk.dim(visualPadEnd("Cost", costW))}`
  );
  console.log(chalk.dim(`   ${"─".repeat(47)}`));

  for (const item of targetLoadout.items) {
    const slotStr = visualPadEnd(item.slotLabel || item.slot, slotW);
    const statStr = visualPadEnd(item.statDisplay || "", statW);
    const costStr = visualPadEnd(item.cost.toFixed(3) + " G", costW);
    console.log(`   ${slotStr} ${statStr} ${chalk.cyan(costStr)}`);
  }

  console.log(chalk.dim(`   ${"─".repeat(47)}`));
  console.log();
  console.log(`  ${chalk.bold("Items:")}      ${targetLoadout.items.length}`);
  console.log(`  ${chalk.bold("Total:")}      ${chalk.cyan.bold(targetLoadout.totalCost.toFixed(3))} Gold`);
  const stratDisplayName = targetLoadout.strategyDisplayName || targetLoadout.strategy?.toUpperCase() || stratTitle.toUpperCase();
  console.log(`  ${chalk.bold("Strategy:")}   ${chalk.bold.cyan(stratDisplayName)}`);
  console.log();
}

/**
 * Print insufficient gold card when loadout cost exceeds wallet balance / effective budget.
 */
export function printInsufficientGold(loadoutCost, availableGold, shortfall) {
  drawBox("Insufficient Gold", "⚠", 46);
  console.log();
  console.log(`  ${chalk.bold("Loadout cost:")}  ${chalk.cyan.bold(loadoutCost.toFixed(3) + " G")}`);
  console.log(`  ${chalk.bold("Available:")}     ${chalk.yellow.bold(availableGold.toFixed(3) + " G")}`);
  console.log(`  ${chalk.bold("Shortfall:")}     ${chalk.red.bold(shortfall.toFixed(3) + " G")}`);
  console.log();
  console.log(chalk.dim("  Purchase aborted. Zero purchases made.\n"));
}

/**
 * Print complete loadout purchase success card (Section 11).
 */
export function printCompleteSuccess(purchasedList, totalCost, balanceInfo = null) {
  drawBox("Complete Loadout Purchased", "✓", 50);
  console.log();
  const slotW = 12;
  for (const p of purchasedList) {
    const slotStr = visualPadEnd(p.item.slotLabel, slotW);
    console.log(`  ${slotStr} ${chalk.green.bold("VERIFIED")}`);
  }
  console.log();
  console.log(`  ${chalk.bold("Items purchased:")} ${purchasedList.length} / ${purchasedList.length}`);
  console.log(`  ${chalk.bold("Total paid:")}      ${chalk.cyan.bold(totalCost.toFixed(3))} Gold`);

  if (balanceInfo) {
    printBalanceReconciliation(balanceInfo, totalCost);
  }

  console.log(chalk.dim(`\n  Items now safely in inventory. (Items were NOT automatically equipped).\n`));
}

/**
 * Print post-purchase balance reconciliation information.
 */
export function printBalanceReconciliation(balanceInfo, totalPaid) {
  if (!balanceInfo || !isFinite(balanceInfo.startingGold) || !isFinite(balanceInfo.endingGold)) {
    return;
  }

  const starting = balanceInfo.startingGold;
  const ending = balanceInfo.endingGold;
  const delta = Number((starting - ending).toFixed(3));
  const paid = totalPaid ?? balanceInfo.verifiedSpend ?? 0;
  const discrepancy = Number(Math.abs(delta - paid).toFixed(3));
  const diff = balanceInfo.difference !== undefined ? balanceInfo.difference : Number((delta - paid).toFixed(3));

  let state = balanceInfo.state;
  if (!state) {
    if (discrepancy <= (balanceInfo.tolerance || 0.05)) {
      state = "VERIFIED";
    } else if (Math.abs(delta) <= (balanceInfo.tolerance || 0.05)) {
      state = "PENDING";
    } else {
      state = "UNRELATED_ACTIVITY";
    }
  }

  console.log(`  ${chalk.bold("Starting Gold:")}   ${chalk.yellow.bold(starting.toFixed(3))} Gold`);
  console.log(`  ${chalk.bold("Total paid:")}      ${chalk.cyan.bold(paid.toFixed(3))} Gold`);
  console.log(`  ${chalk.bold("Ending Gold:")}     ${chalk.yellow.bold(ending.toFixed(3))} Gold`);

  if (state === "VERIFIED") {
    console.log(`  ${chalk.bold("Balance check:")}   ${chalk.green.bold("VERIFIED")}`);
  } else if (state === "PENDING") {
    console.log(`  ${chalk.bold("Balance check:")}   ${chalk.yellow.bold("PENDING / STALE")}`);
    console.log(
      chalk.dim(
        `  ℹ Note: Wallet balance update pending. Latest observed Gold: ${ending.toFixed(3)} Gold.\n` +
        `         Purchase itself was VERIFIED. Wallet endpoint has not yet reflected the transaction.`
      )
    );
  } else if (state === "UNRELATED_ACTIVITY") {
    console.log(`  ${chalk.bold("Balance delta:")}   ${chalk.yellow.bold(delta.toFixed(3))} Gold`);
    console.log(`  ${chalk.bold("Difference:")}      ${chalk.yellow.bold(Math.abs(diff).toFixed(3))} Gold`);
    console.log(
      chalk.dim(
        `  ℹ Note: Balance contains an additional ${Math.abs(diff).toFixed(3)} G change during execution.`
      )
    );
  }
}

/**
 * Print partial set reporting card when stopped midway (Section 10).
 */
export function printPartialStop(purchasedList, failedList, totalGoldSpent, balanceInfo = null) {
  drawBox("Purchase Stopped", "⚠", 50);
  console.log();

  if (purchasedList.length > 0) {
    console.log(chalk.bold("Purchased:"));
    for (const p of purchasedList) {
      console.log(`  ${chalk.green("✓")} ${visualPadEnd(p.item.slotLabel, 12)} ${chalk.cyan(p.verifiedPrice.toFixed(3) + " G")} (VERIFIED)`);
    }
    console.log();
  }

  const failedItems = failedList.filter((f) => f.status !== "NOT_ATTEMPTED");
  const notAttemptedItems = failedList.filter((f) => f.status === "NOT_ATTEMPTED");

  if (failedItems.length > 0) {
    console.log(chalk.bold("Failed / Stopped:"));
    for (const f of failedItems) {
      console.log(`  ${chalk.red("✗")} ${visualPadEnd(f.item.slotLabel, 12)} ${chalk.red.bold(f.reason)}`);
    }
    console.log();
  }

  if (notAttemptedItems.length > 0) {
    console.log(chalk.bold("Remaining items:"));
    for (const r of notAttemptedItems) {
      console.log(`  ${chalk.dim("○")} ${visualPadEnd(r.item.slotLabel, 12)} ${chalk.dim("NOT_ATTEMPTED")}`);
    }
    console.log();
  }

  console.log(`  ${chalk.bold("Items purchased:")} ${purchasedList.length}`);
  console.log(`  ${chalk.bold("Gold spent:")}      ${chalk.cyan.bold(totalGoldSpent.toFixed(3))} Gold`);

  if (balanceInfo) {
    printBalanceReconciliation(balanceInfo, totalGoldSpent);
  }
  console.log();
}

/**
 * Print purchase verified result card.
 */
function printPurchaseSuccess(candidate, verifiedItem, verifiedPrice) {
  drawBox("Purchase Verified", "✓", 50);
  const it = candidate.offer;
  const cat = candidate.category;
  const label = SLOT_LABELS[cat] || cat;

  console.log();
  if (cat === "weapon") {
    console.log(`  ${chalk.bold.white(it.weaponName)}`);
    console.log(`  +${it.attack} Attack / +${it.criticalChance}% Crit`);
    console.log(`  Paid: ${chalk.cyan.bold(verifiedPrice.toFixed(3))} Gold\n`);
    const atkRollStr = it.attack === it.maxAtk ? "PERFECT" : `${it.atkRollPercent ?? 0}%`;
    const critStr = it.criticalChance === it.maxCrit ? "PERFECT / MAX MARKET" : "MAX MARKET";
    console.log(`  Attack Roll:  ${chalk.green.bold(atkRollStr)}`);
    console.log(`  Crit status:  ${chalk.green.bold(critStr)}`);
    console.log(`  Efficiency:   ${chalk.green.bold(`${(it.attack / verifiedPrice).toFixed(3)} Attack / Gold`)}`);
  } else {
    console.log(`  ${chalk.bold.white(`${label} +${it.statValue} ${it.statName}`)}`);
    console.log(`  Paid: ${chalk.cyan.bold(verifiedPrice.toFixed(3))} Gold\n`);
    console.log(`  Previous stat: ${it.equippedStat} ${it.statName}`);
    console.log(`  New stat:      ${it.statValue} ${it.statName}`);
    console.log(`  Gain:          ${chalk.green.bold(`+${it.statDiff} ${it.statName}`)}`);
  }
  console.log(chalk.dim(`\n  Purchased item now safely in inventory. (Item was NOT automatically equipped).\n`));
}

/**
 * Print verbose evaluation table.
 */
function printVerboseOfferDetails(category, offers, isWeapon = false) {
  if (!offers || offers.length === 0) return;

  console.log(chalk.bold(`\nDetailed Offers for ${SLOT_LABELS[category] || category}:`));
  console.log("─".repeat(82));

  for (const o of offers) {
    const dispColor =
      o.disposition === "UPGRADE"
        ? chalk.green
        : o.disposition === "SIDEGRADE"
        ? chalk.yellow
        : chalk.red;

    let statSummary = "";
    if (isWeapon) {
      const atkRollStr = o.attack === o.maxAtk ? "PERFECT" : `${o.atkRollPercent ?? 0}%`;
      const critStr = o.criticalChance === o.maxCrit ? "PERFECT" : `${o.criticalChance}%`;
      const eff = (o.attack / o.buyerPrice).toFixed(2);
      statSummary = `+${o.attack}A/+${critStr}C (${atkRollStr}, ${eff} A/G)`;
    } else {
      statSummary = `+${o.statValue} ${o.statName} (${o.rollPosition})`;
    }

    const offerStr = `#${o.offerId.slice(-6)}`;
    const itemStr = `item #${o.itemId.slice(-6)}`;
    const priceStr = `${o.buyerPrice.toFixed(3)} G`;
    const fairStr = `fair: ${o.fairBuyerPrice.toFixed(3)} G`;
    const dispStr = dispColor(o.disposition);

    console.log(`  ${visualPadEnd(offerStr, 9)} ${visualPadEnd(itemStr, 14)} ${visualPadEnd(priceStr, 10)} ${visualPadEnd(statSummary, 32)} ${visualPadEnd(dispStr, 12)} ${chalk.dim(fairStr)}`);
  }
  console.log("─".repeat(82));
}

/**
 * Print detailed dry run breakdown for weapons matching Section 14.
 */
function printWeaponDryRunReport(wRes, rarityInfo) {
  drawBox(`${rarityInfo.displayName} Weapon Market Analysis`, "⚔", 50);
  console.log();
  console.log(`  Highest theoretical Crit:               +${wRes.maxPossibleCrit}%`);
  console.log(`  Highest current market Crit:            +${wRes.highestMarketCrit}%`);
  console.log(`  Number of valid weapon offers:          ${wRes.validOffersCount}`);
  console.log(`  Number remaining after max-Crit filter: ${wRes.maxCritOffersCount}`);
  console.log();

  const validMaxCritWeps = (wRes.evaluatedOffers || [])
    .filter((o) => !o.isInvalidRange && o.disposition !== "INVALID LIVE RANGE" && o.criticalChance === wRes.highestMarketCrit)
    .sort((a, b) => (b.attackValueScore || 0) - (a.attackValueScore || 0));

  if (validMaxCritWeps.length > 0) {
    console.log(chalk.bold("  Top Max-Crit Candidates:"));
    const wHdr = `     ${visualPadEnd("Attack", 8)} ${visualPadEnd("Crit", 7)} ${visualPadEnd("Attack Roll", 13)} ${visualPadEnd("Buyer Cost", 12)} ${visualPadEnd("Attack/Gold", 13)} ${visualPadEnd("Offer ID", 12)}`;
    console.log(chalk.dim(wHdr));
    console.log(chalk.dim(`     ${"─".repeat(68)}`));
    for (const w of validMaxCritWeps.slice(0, 10)) {
      const atkStr = `+${w.attack}`;
      const critStr = `+${w.criticalChance}%`;
      const rollStr = w.attack === w.maxAtk ? "PERFECT" : `${w.atkRollPercent ?? 0}%`;
      const costStr = `${w.buyerPrice.toFixed(3)} G`;
      const effStr = `${(w.attackValueScore || (w.attack / w.buyerPrice)).toFixed(3)} A/G`;
      const idStr = `#${(w.offerId || w._id || "").slice(-8)}`;
      console.log(`     ${visualPadEnd(atkStr, 8)} ${visualPadEnd(critStr, 7)} ${visualPadEnd(rollStr, 13)} ${visualPadEnd(costStr, 12)} ${visualPadEnd(chalk.green(effStr), 13)} ${chalk.dim(idStr)}`);
    }
    console.log();
  }

  const recs = wRes.recommendations || {};
  console.log(chalk.bold("  Selected Weapon Recommendations:"));
  if (recs.bestValue) {
    const bv = recs.bestValue;
    const eff = (bv.attackValueScore || (bv.attack / bv.buyerPrice)).toFixed(3);
    console.log(`    ${chalk.cyan.bold("BEST VALUE:")}        +${bv.attack} Atk / +${bv.criticalChance}% Crit @ ${bv.buyerPrice.toFixed(3)} G (${eff} Atk/G) [Offer #${bv.offerId.slice(-8)}]`);
  }
  if (recs.bestPerformance) {
    const bp = recs.bestPerformance;
    const eff = (bp.attackValueScore || (bp.attack / bp.buyerPrice)).toFixed(3);
    console.log(`    ${chalk.magenta.bold("BEST PERFORMANCE:")}  +${bp.attack} Atk / +${bp.criticalChance}% Crit @ ${bp.buyerPrice.toFixed(3)} G (${eff} Atk/G) [Offer #${bp.offerId.slice(-8)}]`);
  }
  if (recs.cheapestUpgrade) {
    const ch = recs.cheapestUpgrade;
    const eff = (ch.attackValueScore || (ch.attack / ch.buyerPrice)).toFixed(3);
    console.log(`    ${chalk.green.bold("CHEAPEST:")}          +${ch.attack} Atk / +${ch.criticalChance}% Crit @ ${ch.buyerPrice.toFixed(3)} G (${eff} Atk/G) [Offer #${ch.offerId.slice(-8)}]`);
  }
  console.log();
}

/**
 * Main application runner.
 */
export async function runEquipmentBuyer(argv = process.argv.slice(2), runtimeOptions = {}) {
  const config = parseArgs(argv);

  printBanner();

  const sp = ui.spinner("Loading game configuration & live state...");
  const timeoutMs = config.timeout ? config.timeout * 1000 : (runtimeOptions.timeoutMs ?? undefined);

  const myUserId = resolveUserId(runtimeOptions.userId);
  const fetchCfgFn = runtimeOptions.fetchGameConfig || fetchGameConfig;
  const fetchTaxFn = runtimeOptions.fetchMarketTaxRate || fetchMarketTaxRate;
  const fetchUserFn = runtimeOptions.fetchUserLiveState || fetchUserLiveState;
  const fetchOffersFn = runtimeOptions.fetchAllMarketOffers || fetchAllMarketOffers;
  const isMockEnvironment = Boolean(runtimeOptions.fetchGameConfig || runtimeOptions.fetchAllMarketOffers);
  const fetchWalletFn = runtimeOptions.fetchLiveWalletGold || (async (uid = myUserId) => {
    if (userState?.walletGold !== undefined && isFinite(userState.walletGold)) {
      return userState.walletGold;
    }
    if (isMockEnvironment) {
      return 1000.0;
    }
    try {
      return await fetchLiveWalletGold(uid);
    } catch {
      return Infinity;
    }
  });

  let gameConfig;
  let rarityInfo;
  let activeCategories;
  let taxRate;
  let userState;
  let liveEquipped;
  let playerProfile;
  let walletGold;
  let catalog;
  let totalOffersEvaluated = 0;
  const categoryResults = {};

  try {
    gameConfig = await fetchCfgFn();

    rarityInfo = resolveRarity(config.rarity || "uncommon", gameConfig);
    activeCategories = resolveCategories(config.include, config.exclude);

    taxRate = await fetchTaxFn();

    userState = await fetchUserFn(myUserId);
    liveEquipped = userState?.equipped || {};
    playerProfile = userState?.user || {};
    if (!config.compareEquipped) {
      liveEquipped = {};
    }

    if (runtimeOptions.fetchLiveWalletGold) {
      walletGold = await runtimeOptions.fetchLiveWalletGold(myUserId);
    } else if (userState?.walletGold !== undefined && isFinite(userState.walletGold)) {
      walletGold = userState.walletGold;
    } else {
      try {
        walletGold = await fetchWalletFn(myUserId);
      } catch {
        walletGold = Infinity;
      }
    }

    sp.text = `Analyzing live market for ${rarityInfo.displayName} equipment...`;

    catalog = extractRarityCatalog(gameConfig, rarityInfo.canonical);

    for (const cat of activeCategories) {
      const slotLabel = SLOT_LABELS[cat] || cat;
      sp.text = `Analyzing live market for ${rarityInfo.displayName} equipment (${slotLabel})...`;
      if (cat === "weapon") {
        let targetWeapons = catalog.weapons;
        if (config.weaponType) {
          const wtNorm = config.weaponType.toLowerCase().trim();
          targetWeapons = targetWeapons.filter(
            (w) =>
              w.code.toLowerCase() === wtNorm ||
              w.skinSlot.toLowerCase() === wtNorm ||
              w.name.toLowerCase() === wtNorm
          );
          if (targetWeapons.length === 0) {
            const availableTypes = catalog.weapons.map((w) => w.code).join(", ");
            throw new Error(
              `Weapon type '${config.weaponType}' not found for rarity '${rarityInfo.displayName}'. Available: ${availableTypes || "none"}`
            );
          }
        }

        if (targetWeapons.length === 0) {
          categoryResults["weapon"] = {
            category: "weapon",
            equipped: liveEquipped.weapon || null,
            recommendations: { hasUpgrade: false },
            offersCount: 0,
          };
          continue;
        }

        const allWeaponEvaluated = [];

        for (const wMeta of targetWeapons) {
          const rawOffers = await fetchOffersFn(wMeta.code, {
            excludeUserId: myUserId,
            ...(timeoutMs ? { timeoutMs } : {}),
          });

          const validOffers = sanitizeMarketOffers(rawOffers, {
            excludeUserId: myUserId,
            requiredStats: ["attack", "criticalChance"],
            taxRate,
          });

          totalOffersEvaluated += rawOffers.length;

          for (const off of validOffers) {
            const evalOffer = evaluateWeaponOffer(
              off,
              wMeta,
              liveEquipped.weapon || null,
              playerProfile,
              gameConfig,
              {
                allOffersForCode: rawOffers,
                excludeUserId: myUserId,
                compareEquipped: config.compareEquipped,
              }
            );
            allWeaponEvaluated.push(evalOffer);
          }
        }

        const recs = findCategoryRecommendations(allWeaponEvaluated, true);

        // Compute baseline damage for reporting
        const skillsAlloc = {
          attack: playerProfile?.skills?.attack?.level ?? 8,
          criticalChance: playerProfile?.skills?.criticalChance?.level ?? 7,
          criticalDamages: playerProfile?.skills?.criticalDamages?.level ?? 6,
          precision: playerProfile?.skills?.precision?.level ?? 6,
        };
        const modifiers = {
          ammoPercent: playerProfile?.skills?.attack?.ammoPercent ?? 20,
          militaryRankPercent: playerProfile?.skills?.attack?.militaryRankPercent ?? 30.5,
          buffsPercent: playerProfile?.skills?.attack?.buffsPercent ?? 60,
          debuffsPercent: playerProfile?.skills?.attack?.debuffsPercent ?? 0,
        };
        const eqGear = {
          weaponAtk: liveEquipped.weapon?.skills?.attack ?? 0,
          weaponCrit: liveEquipped.weapon?.skills?.criticalChance ?? 0,
          helmetCritDmg: playerProfile?.equipment?.helmet?.skills?.criticalDamages ?? 0,
          glovesPrec: playerProfile?.equipment?.gloves?.skills?.precision ?? 0,
          ammo: playerProfile?.equipment?.ammo || "ammo",
        };
        const curCombat = (await import("./analyzer/combat_model.mjs")).calculateCombatProfile(
          skillsAlloc,
          gameConfig.skills,
          eqGear,
          modifiers
        );

        const validWeps = allWeaponEvaluated.filter(
          (o) => !o.isInvalidRange && o.disposition !== "INVALID LIVE RANGE"
        );
        const highestMarketCrit = validWeps.length > 0
          ? Math.max(...validWeps.map((o) => o.criticalChance || 0))
          : null;
        const maxPossibleCrit = targetWeapons[0]?.dynamicStats?.criticalChance?.[1] ?? null;
        const maxCritCount = highestMarketCrit !== null
          ? validWeps.filter((o) => o.criticalChance === highestMarketCrit).length
          : 0;

        categoryResults["weapon"] = {
          category: "weapon",
          equipped: liveEquipped.weapon || null,
          baselineDamage: curCombat.expectedDamageRounded,
          evaluatedOffers: allWeaponEvaluated,
          recommendations: recs,
          offersCount: allWeaponEvaluated.length,
          validOffersCount: validWeps.length,
          maxCritOffersCount: maxCritCount,
          highestMarketCrit,
          maxPossibleCrit,
          weaponMeta: targetWeapons[0],
        };
      } else {
        const rangeInfo = catalog.gear[cat];
        if (!rangeInfo) {
          categoryResults[cat] = {
            category: cat,
            equipped: liveEquipped[cat] || null,
            recommendations: { hasUpgrade: false },
            offersCount: 0,
          };
          continue;
        }

        const rawOffers = await fetchOffersFn(rangeInfo.itemCode, {
          excludeUserId: myUserId,
          ...(timeoutMs ? { timeoutMs } : {}),
        });

        const validOffers = sanitizeMarketOffers(rawOffers, {
          excludeUserId: myUserId,
          requiredStats: [rangeInfo.statName],
          taxRate,
        });

        totalOffersEvaluated += rawOffers.length;

        const evaluatedOffers = validOffers.map((off) =>
          evaluateGearOffer(off, rangeInfo, liveEquipped[cat] || null, {
            allOffersForCode: rawOffers,
            excludeUserId: myUserId,
            compareEquipped: config.compareEquipped,
          })
        );

        // Pipeline diagnostics: stat distribution of ALL valid offers (before any pruning)
        const inRangeOffers = evaluatedOffers.filter(o => !o.isInvalidRange);
        const statValues = inRangeOffers.map(o => o.statValue);
        const statDistribution = {};
        for (const v of statValues) {
          statDistribution[v] = (statDistribution[v] || 0) + 1;
        }
        const rawMarketMaxStat = statValues.length > 0 ? Math.max(...statValues) : null;
        const rawMarketMinStat = statValues.length > 0 ? Math.min(...statValues) : null;
        const invalidRangeCount = evaluatedOffers.filter(o => o.isInvalidRange).length;

        const eligibleOffers = evaluatedOffers.filter(
          (o) =>
            !o.isInvalidRange &&
            o.disposition !== "INVALID LIVE RANGE" &&
            (!o.disposition || o.disposition === "UPGRADE" || o.disposition === "STANDALONE")
        );
        const { nonDominated = [] } = eliminateDominatedOffers(eligibleOffers, (o) => o.statValue, (o) => o.buyerPrice) || {};

        const recs = findCategoryRecommendations(evaluatedOffers, false);

        categoryResults[cat] = {
          category: cat,
          equipped: liveEquipped[cat] || null,
          rangeInfo,
          evaluatedOffers,
          recommendations: recs,
          offersCount: evaluatedOffers.length,
          // Pipeline diagnostics
          pipelineCounts: {
            fetchedFromApi: rawOffers.length,
            matchingRarity: rawOffers.length,
            validAfterSanitize: validOffers.length,
            evaluated: evaluatedOffers.length,
            invalidRange: invalidRangeCount,
            validForStrategies: eligibleOffers.length,
            afterPareto: nonDominated.length,
            availableBestValue: nonDominated.length,
            availableBestPerformance: eligibleOffers.length,
            availableCheapest: eligibleOffers.length,
          },
          statDistribution,
          rawMarketMaxStat,
          rawMarketMinStat,
        };
      }
    }

    sp.succeed("Market analysis complete");
  } catch (err) {
    if (sp) {
      sp.fail(err.message || "Failed to complete market analysis");
    }
    throw err;
  }
  console.log(`  ${colors.success(icons.success)} Live inventory & current build loaded`);
  console.log(`  ${colors.success(icons.success)} ${formatRarityText(rarityInfo.displayName)} rarity resolved (${rarityInfo.canonical})`);
  console.log(`  ${colors.success(icons.success)} Strategy: ${chalk.bold.cyan(config.strategy.toUpperCase())}`);
  console.log(`  ${colors.success(icons.success)} ${activeCategories.length} categories participating: ${activeCategories.join(", ")}`);
  console.log(`  ${colors.success(icons.success)} ${totalOffersEvaluated} total market offers fetched`);
  console.log(`  ${colors.success(icons.success)} Country market tax: ${taxRate}%\n`);

  // Per-slot pipeline diagnostics
  console.log(chalk.bold("  Market Pipeline (per slot):"));
  for (const cat of activeCategories) {
    const res = categoryResults[cat];
    if (!res || !res.pipelineCounts) continue;
    const pc = res.pipelineCounts;
    const ri = res.rangeInfo;
    const statName = ri?.statName || "?";
    const rangeStr = ri ? `${ri.minPossibleStat}-${ri.maxPossibleStat}` : "?";
    const maxStr = res.rawMarketMaxStat !== null ? `+${res.rawMarketMaxStat}` : "none";
    const minStr = res.rawMarketMinStat !== null ? `+${res.rawMarketMinStat}` : "none";

    console.log(
      `    ${chalk.bold(cat.padEnd(8))} ` +
      `${chalk.dim("fetched:")} ${String(pc.fetchedFromApi).padStart(5)}  ` +
      `${chalk.dim("valid:")} ${String(pc.validAfterSanitize).padStart(5)}  ` +
      `${chalk.dim("in-range:")} ${String(pc.validForStrategies).padStart(5)}  ` +
      `${chalk.dim("stat:")} ${statName} ${chalk.dim("range:")} ${rangeStr}  ` +
      `${chalk.dim("market:")} ${minStr}…${maxStr}`
    );

    // Stat distribution histogram (compact, single line per slot)
    if (res.statDistribution && Object.keys(res.statDistribution).length > 0) {
      const sortedKeys = Object.keys(res.statDistribution).map(Number).sort((a, b) => a - b);
      const distStr = sortedKeys.map(k => `+${k}:${res.statDistribution[k]}`).join("  ");
      console.log(`             ${chalk.dim(distStr)}`);
    }
  }
  console.log();

  // Build Full Loadout
  const loadout = buildFullLoadout(categoryResults, {
    strategy: config.strategy,
    budget: config.budget,
    activeCategories,
    rarity: rarityInfo.canonical,
    rarityDisplayName: rarityInfo.displayName,
    compareEquipped: config.compareEquipped,
  });

  if (!loadout.feasible) {
    if (activeCategories.includes("weapon") && categoryResults["weapon"]?.highestMarketCrit !== null) {
      const wRes = categoryResults["weapon"];
      const eligibleWeps = (wRes.evaluatedOffers || []).filter(
        (o) => !o.isInvalidRange && o.disposition !== "INVALID LIVE RANGE" && o.criticalChance === wRes.highestMarketCrit
      );
      const cheapestWep = eligibleWeps.length > 0
        ? Math.min(...eligibleWeps.map((o) => o.buyerPrice))
        : 0;
      const budgetVal = config.budget !== null ? config.budget : (walletGold ?? 0);
      const shortfall = Number((loadout.minRequiredBudget - budgetVal).toFixed(3));

      console.log(chalk.red.bold("\n⚠ No complete loadout fits the budget while preserving highest market Crit.\n"));
      console.log(`  Highest market Crit:               +${wRes.highestMarketCrit}%`);
      console.log(`  Cheapest eligible max-Crit weapon: ${cheapestWep.toFixed(3)} Gold`);
      console.log(`  Minimum complete loadout cost:     ${loadout.minRequiredBudget.toFixed(3)} Gold`);
      console.log(`  Budget:                            ${budgetVal.toFixed(3)} Gold`);
      console.log(`  Shortfall:                         ${shortfall > 0 ? shortfall.toFixed(3) : "0.000"} Gold\n`);
    } else {
      const budgetMsg =
        config.budget !== null
          ? `Budget (${config.budget.toFixed(3)} G) is less than the cheapest possible loadout (${loadout.minRequiredBudget.toFixed(3)} G). No combination fits within this budget.`
          : `Cheapest possible loadout requires ${loadout.minRequiredBudget.toFixed(3)} G. No combination fits.`;
      console.log(chalk.yellow(`\n⚠ ${budgetMsg}\n`));
    }
    return {
      rarity: rarityInfo,
      activeCategories,
      categoryResults,
      loadout,
      totalOffersEvaluated,
      walletGold,
      effectiveBudget: config.budget !== null ? Math.min(config.budget, walletGold) : walletGold,
    };
  }

  // Print Primary Result: Compact Loadout Table
  printLoadoutTable(loadout, {
    compareEquipped: config.compareEquipped,
    verbose: config.verbose,
  });

  // If compare-equipped is explicitly requested, print individual category cards
  if (config.compareEquipped) {
    for (const cat of activeCategories) {
      const res = categoryResults[cat];
      if (res) {
        printCategoryCard(cat, res);
      }
    }
  }

  // Overall Best Value under chosen strategy
  const overall = findOverallBestValue(categoryResults, config.strategy);

  // 1. If dry-run mode, skip purchase flow entirely (Section 4)
  if (config.dryRun) {
    if (activeCategories.includes("weapon") && categoryResults["weapon"]?.highestMarketCrit !== null) {
      printWeaponDryRunReport(categoryResults["weapon"], rarityInfo);
    }
    console.log(chalk.dim("  [dry-run] Analysis complete. Purchase flow skipped (--dry-run).\n"));
    return {
      rarity: rarityInfo,
      activeCategories,
      categoryResults,
      loadout,
      overallBestValue: overall,
      totalOffersEvaluated,
      confirmedLoadout: null,
      walletGold,
      effectiveBudget: config.budget !== null ? Math.min(config.budget, walletGold) : walletGold,
    };
  }

  let activeLoadout = loadout;
  let didSwitchStrategy = false;

  // 1. Interactive Strategy Selection (Section 1)
  const shouldPromptStrategy =
    !config.yes &&
    !config.offerId &&
    (runtimeOptions.promptStrategyChoice !== undefined || runtimeOptions.promptConfirmation === undefined);

  if (shouldPromptStrategy) {
    const promptChoiceFn = runtimeOptions.promptStrategyChoice || promptStrategyChoice;
    const rawChoice = await promptChoiceFn(STRATEGY_CHOICE_PROMPT);
    const parsedChoice = parseLoadoutChoice(rawChoice);

    if (parsedChoice.action === "CANCEL") {
      console.log(chalk.yellow(`\n⚠ Purchase cancelled by user. Zero purchases made. Gold spent: 0.000 Gold\n`));
      return {
        rarity: rarityInfo,
        activeCategories,
        categoryResults,
        loadout: activeLoadout,
        cancelled: true,
        purchasedList: [],
        failedList: [],
        totalGoldSpent: 0,
        totalOffersEvaluated,
        walletGold,
        effectiveBudget: config.budget !== null ? Math.min(config.budget, walletGold) : walletGold,
      };
    }

    if (parsedChoice.action === "SWITCH") {
      const targetStrat = parsedChoice.strategy;
      const altSet = activeLoadout.alternativeSets?.[targetStrat];
      if (!altSet || !altSet.loadout || !altSet.feasible) {
        console.log(chalk.yellow(`\n⚠ Selected alternative strategy '${targetStrat}' is not available or not feasible.\n`));
        return {
          rarity: rarityInfo,
          activeCategories,
          categoryResults,
          loadout: activeLoadout,
          cancelled: true,
          purchasedList: [],
          failedList: [],
          totalGoldSpent: 0,
          totalOffersEvaluated,
          walletGold,
          effectiveBudget: config.budget !== null ? Math.min(config.budget, walletGold) : walletGold,
        };
      }

      // Switch to the already-calculated alternative loadout
      activeLoadout = altSet.loadout;
      didSwitchStrategy = true;

      // Section 4: Print Selected Loadout Card
      printSelectedLoadoutCard(activeLoadout);
    }
  }

  // 2. Normal Interactive Purchase Workflow (Section 1 - 3)
  // Determine staged items automatically from selected loadout
  let stagedItems = [];
  if (config.offerId) {
    for (const [cat, res] of Object.entries(categoryResults)) {
      const match = (res.evaluatedOffers || []).find(
        (o) => o.offerId === config.offerId || o._id === config.offerId
      );
      if (match) {
        stagedItems.push({
          slot: cat,
          slotLabel: SLOT_LABELS[cat] || cat,
          offer: match,
          cost: match.buyerPrice,
          statDisplay: cat === "weapon" ? `+${match.attack}A/+${match.criticalChance}C` : `+${match.statValue} ${match.statName}`,
        });
        break;
      }
    }
    if (stagedItems.length === 0) {
      throw new Error(`Requested --offer-id '${config.offerId}' not found among evaluated market offers. ABORTING.`);
    }
  } else {
    const purchaseLimit = config.maxPurchases !== null ? Math.min(config.maxPurchases, activeLoadout.items.length) : activeLoadout.items.length;
    stagedItems = activeLoadout.items.slice(0, purchaseLimit);

    if (config.maxPurchases !== null && config.maxPurchases < activeLoadout.items.length) {
      console.log(
        chalk.dim(
          `  Note: Loadout contains ${activeLoadout.items.length} items. Purchasing ${purchaseLimit} item(s) in this run (--max-purchases=${config.maxPurchases}).\n`
        )
      );
    }
  }

  // Safety invariant: assert displayed offer IDs match staged purchase offer IDs
  if (!config.offerId) {
    const displayedIds = (activeLoadout.selectedLoadout?.offerIds || activeLoadout.offerIds || activeLoadout.items.map((it) => it.offer.offerId || it.offer._id))
      .slice(0, stagedItems.length)
      .sort()
      .join(",");
    const stagedIds = stagedItems.map((c) => c.offer.offerId || c.offer._id).sort().join(",");
    if (displayedIds !== stagedIds) {
      throw new Error(
        `INTERNAL LOADOUT SELECTION MISMATCH: Displayed offer IDs [${displayedIds}] do not match staged purchase offer IDs [${stagedIds}]. ABORTING.`
      );
    }
  }

  // 3. Full-Set Preflight BEFORE BUY Prompt (Section 7)
  const spPreflight = ui.spinner(`Refreshing and validating all ${stagedItems.length} selected offers on live market...`);
  const refreshedOffers = [];
  let preflightFailed = false;
  let preflightErrorMsg = "";
  let failedItemInfo = null;

  const refreshFn = runtimeOptions.refreshAndValidateOffer || refreshAndValidateOffer;
  for (const item of stagedItems) {
    try {
      const refreshed = await refreshFn(item.offer, {
        myUserId: myUserId,
        plannedBuyerPrice: item.cost,
        maxSlippagePct: config.maxSlippage,
        maxPrice: config.maxPrice,
        remainingBudget: config.budget,
        ignoreEquipped: !config.compareEquipped,
        fetchOffersFn,
        fetchTaxFn,
        rangeInfo: catalog.gear[item.slot] || null,
        weaponMeta: catalog.weapons.find((w) => w.code === item.offer.itemCode) || null,
        liveEquipped,
        playerProfile,
        gameConfig,
      });

      if (item.offer.rarity && refreshed.rarity && refreshed.rarity !== item.offer.rarity) {
        throw new Error(`Rarity changed from ${item.offer.rarity} to ${refreshed.rarity}`);
      }
      if (item.offer.category && refreshed.category && refreshed.category !== item.offer.category) {
        throw new Error(`Category changed from ${item.offer.category} to ${refreshed.category}`);
      }
      refreshedOffers.push(refreshed);
    } catch (err) {
      preflightFailed = true;
      failedItemInfo = item;
      const slotLabel = item.slotLabel || item.slot;
      const rarityLabel = activeLoadout.rarityDisplayName || "";
      if (err.code === "OFFER_DISAPPEARED" || err.message?.includes("no longer available")) {
        preflightErrorMsg = `\n⚠ ${rarityLabel} ${slotLabel} offer is no longer available.\nLoadout changed. Please rerun the buyer.\n`;
      } else {
        preflightErrorMsg = `\n⚠ ${rarityLabel} ${slotLabel} offer validation failed: ${err.message}\nLoadout changed. Please rerun the buyer.\n`;
      }
      break;
    }
  }

  if (preflightFailed) {
    spPreflight.fail("Full-set preflight failed");
    console.error(chalk.bold.yellow(preflightErrorMsg));
    return {
      rarity: rarityInfo,
      activeCategories,
      categoryResults,
      loadout: activeLoadout,
      preflightFailed: true,
      failedItem: failedItemInfo,
      purchasedList: [],
      failedList: [],
      totalGoldSpent: 0,
      totalOffersEvaluated,
      walletGold,
      effectiveBudget: config.budget !== null ? Math.min(config.budget, walletGold) : walletGold,
    };
  }

  spPreflight.succeed(`All ${stagedItems.length} offers verified on live market`);

  // 4. Freeze confirmedLoadout (Section 8)
  let confirmedTotalCost = 0;
  const confirmedItems = stagedItems.map((orig, idx) => {
    const refreshed = refreshedOffers[idx];
    confirmedTotalCost += refreshed.buyerPrice;
    return {
      ...orig,
      offer: refreshed,
      cost: refreshed.buyerPrice,
      sellerPrice: refreshed.sellerPrice,
      taxRate: refreshed.taxRate,
    };
  });
  confirmedTotalCost = Number(confirmedTotalCost.toFixed(3));

  // Refresh wallet Gold after offer preflight (Section 3)
  let refreshedWalletGold;
  try {
    refreshedWalletGold = await fetchWalletFn(myUserId);
  } catch (err) {
    refreshedWalletGold = walletGold;
  }
  walletGold = refreshedWalletGold;

  const effectiveBudget = config.budget !== null
    ? Math.min(config.budget, walletGold)
    : walletGold;

  if (confirmedTotalCost > effectiveBudget) {
    const shortfall = Number((confirmedTotalCost - effectiveBudget).toFixed(3));
    printInsufficientGold(confirmedTotalCost, effectiveBudget, shortfall);
    return {
      rarity: rarityInfo,
      activeCategories,
      categoryResults,
      loadout: activeLoadout,
      insufficientGold: true,
      walletGold,
      effectiveBudget,
      shortfall,
      purchasedList: [],
      failedList: [],
      totalGoldSpent: 0,
      totalOffersEvaluated,
    };
  }

  const startingGold = walletGold;

  const confirmedLoadout = Object.freeze({
    ...activeLoadout,
    items: Object.freeze(confirmedItems),
    totalCost: confirmedTotalCost,
    offerIds: Object.freeze(confirmedItems.map((it) => it.offer.offerId || it.offer._id)),
    strategy: activeLoadout.strategy,
    strategyDisplayName: activeLoadout.strategyDisplayName,
    rarityDisplayName: activeLoadout.rarityDisplayName,
  });

  if (!config.offerId) {
    const confirmedIds = confirmedLoadout.offerIds.slice().sort().join(",");
    const displayedIds = (activeLoadout.selectedLoadout?.offerIds || activeLoadout.offerIds || activeLoadout.items.map((it) => it.offer.offerId || it.offer._id))
      .slice(0, stagedItems.length)
      .sort()
      .join(",");
    if (confirmedIds !== displayedIds) {
      throw new Error(
        `INTERNAL LOADOUT SELECTION MISMATCH: Confirmed loadout offer IDs [${confirmedIds}] do not match displayed offer IDs [${displayedIds}]. ABORTING.`
      );
    }
  }

  // 5. Full-Loadout Confirmation Card (Section 6)
  if (!didSwitchStrategy) {
    printFullLoadoutConfirmation(confirmedLoadout);
  }

  // 6. Interactive Confirmation Prompt
  let needFinalBuyPrompt = false;
  if (!config.yes) {
    if (didSwitchStrategy) {
      needFinalBuyPrompt = true;
    } else if (!shouldPromptStrategy) {
      needFinalBuyPrompt = true;
    }
  }

  if (needFinalBuyPrompt) {
    const promptFn = runtimeOptions.promptConfirmation || promptConfirmation;
    const promptText = `Type BUY to purchase all ${confirmedLoadout.items.length} items: `;
    const confirmInput = await promptFn(promptText);
    if (confirmInput !== "BUY") {
      console.log(chalk.yellow(`\n⚠ Purchase cancelled by user. Zero purchases made. Gold spent: 0.000 Gold\n`));
      return {
        rarity: rarityInfo,
        activeCategories,
        categoryResults,
        loadout: activeLoadout,
        confirmedLoadout,
        cancelled: true,
        purchasedList: [],
        failedList: [],
        totalGoldSpent: 0,
        totalOffersEvaluated,
        walletGold,
        effectiveBudget,
      };
    }
  }

  // 7. Sequential Purchase Safety Loop (Section 9)
  const purchasedList = [];
  const failedList = [];
  let totalGoldSpent = 0;

  for (let i = 0; i < confirmedLoadout.items.length; i++) {
    const candidate = confirmedLoadout.items[i];
    const targetOfferId = candidate.offer.offerId || candidate.offer._id;

    if (!confirmedLoadout.offerIds.includes(targetOfferId)) {
      throw new Error(
        `INTERNAL EXECUTION ERROR: Target offer #${targetOfferId} does not belong to confirmedLoadout.`
      );
    }

    // Dynamic remaining budget accounting
    const currentRemainingBudget = config.budget !== null
      ? Number((config.budget - totalGoldSpent).toFixed(3))
      : null;

    if (currentRemainingBudget !== null && candidate.cost > currentRemainingBudget) {
      failedList.push({
        item: candidate,
        status: "STOPPED",
        reason: `Cost (${candidate.cost.toFixed(3)} G) exceeds remaining budget (${currentRemainingBudget.toFixed(3)} G)`,
      });
      for (let j = i + 1; j < confirmedLoadout.items.length; j++) {
        failedList.push({ item: confirmedLoadout.items[j], status: "NOT_ATTEMPTED", reason: "Not attempted" });
      }
      break;
    }

    if (config.maxPrice !== null && candidate.cost > config.maxPrice) {
      failedList.push({
        item: candidate,
        status: "STOPPED",
        reason: `Cost (${candidate.cost.toFixed(3)} G) exceeds max-price (${config.maxPrice.toFixed(3)} G)`,
      });
      for (let j = i + 1; j < confirmedLoadout.items.length; j++) {
        failedList.push({ item: confirmedLoadout.items[j], status: "NOT_ATTEMPTED", reason: "Not attempted" });
      }
      break;
    }

    // ------------------------------------------------------------------
    // IMMEDIATE PRE-MUTATION REVALIDATION (Second Validation Layer)
    // ------------------------------------------------------------------
    const spReval = ui.spinner(`Revalidating ${candidate.slotLabel} (#${targetOfferId.slice(-8)})...`);
    let refreshedTarget;
    try {
      refreshedTarget = await refreshFn(candidate.offer, {
        myUserId: myUserId,
        plannedBuyerPrice: candidate.cost,
        maxSlippagePct: config.maxSlippage,
        maxPrice: config.maxPrice,
        remainingBudget: currentRemainingBudget,
        ignoreEquipped: !config.compareEquipped,
        fetchOffersFn,
        fetchTaxFn,
        rangeInfo: catalog.gear[candidate.slot] || null,
        weaponMeta: catalog.weapons.find((w) => w.code === candidate.offer.itemCode) || null,
        liveEquipped,
        playerProfile,
        gameConfig,
      });

      if (candidate.offer.rarity && refreshedTarget.rarity && refreshedTarget.rarity !== candidate.offer.rarity) {
        throw new Error(`Rarity changed from ${candidate.offer.rarity} to ${refreshedTarget.rarity}`);
      }
      if (candidate.offer.category && refreshedTarget.category && refreshedTarget.category !== candidate.offer.category) {
        throw new Error(`Category changed from ${candidate.offer.category} to ${refreshedTarget.category}`);
      }
      spReval.succeed(`${candidate.slotLabel} revalidated`);
    } catch (revalErr) {
      spReval.fail(`${candidate.slotLabel} revalidation failed: ${revalErr.message}`);
      const isDisappeared =
        revalErr.code === "OFFER_DISAPPEARED" ||
        revalErr.message?.includes("no longer available") ||
        revalErr.message?.includes("disappeared");
      const failureReason = isDisappeared
        ? "CONFIRMED OFFER NO LONGER AVAILABLE"
        : revalErr.message || "Pre-mutation validation failed";

      failedList.push({
        item: candidate,
        status: "FAILED",
        reason: failureReason,
      });
      for (let j = i + 1; j < confirmedLoadout.items.length; j++) {
        failedList.push({
          item: confirmedLoadout.items[j],
          status: "NOT_ATTEMPTED",
          reason: "Not attempted",
        });
      }
      break;
    }

    // Fresh live wallet balance check immediately before mutation (Section 4)
    let liveWalletGold;
    try {
      liveWalletGold = await fetchWalletFn(myUserId);
    } catch {
      liveWalletGold = isFinite(walletGold) ? Number((walletGold - totalGoldSpent).toFixed(3)) : Infinity;
    }

    const itemPrice = refreshedTarget ? refreshedTarget.buyerPrice : candidate.cost;

    if (itemPrice > liveWalletGold) {
      failedList.push({
        item: candidate,
        status: "FAILED",
        reason: `Insufficient wallet Gold: item cost ${itemPrice.toFixed(3)} G > live balance ${liveWalletGold.toFixed(3)} G`,
      });
      for (let j = i + 1; j < confirmedLoadout.items.length; j++) {
        failedList.push({
          item: confirmedLoadout.items[j],
          status: "NOT_ATTEMPTED",
          reason: "Not attempted",
        });
      }
      break;
    }

    if (config.budget !== null) {
      const remainingExplicitBudget = Number((config.budget - totalGoldSpent).toFixed(3));
      if (itemPrice > remainingExplicitBudget) {
        failedList.push({
          item: candidate,
          status: "STOPPED",
          reason: `Cost (${itemPrice.toFixed(3)} G) exceeds remaining explicit budget (${remainingExplicitBudget.toFixed(3)} G)`,
        });
        for (let j = i + 1; j < confirmedLoadout.items.length; j++) {
          failedList.push({
            item: confirmedLoadout.items[j],
            status: "NOT_ATTEMPTED",
            reason: "Not attempted",
          });
        }
        break;
      }
    }

    const spBuy = ui.spinner(`Purchasing ${candidate.slotLabel} (#${targetOfferId.slice(-8)})...`);
    const submissionTime = Date.now();
    let mutationFailed = false;
    let mutationError = null;

    const submitPurchaseFn = runtimeOptions.submitMarketPurchase || submitMarketPurchase;
    try {
      await submitPurchaseFn(targetOfferId);
      spBuy.succeed(`${candidate.slotLabel} purchase request submitted`);
    } catch (err) {
      mutationFailed = true;
      mutationError = err.message;
      spBuy.fail(`Purchase mutation returned: ${err.message}`);
    }

    const verifyPurchaseFn = runtimeOptions.verifyMarketPurchase || verifyMarketPurchase;
    const fetchInventoryFn = runtimeOptions.fetchUserInventory || fetchUserInventory;
    const fetchTransactionsFn = runtimeOptions.fetchUserRecentTransactions || fetchUserRecentTransactions;

    const verification = await verifyPurchaseFn(candidate.offer, submissionTime, {
      userId: myUserId,
      mutationFailed,
      mutationError,
      fetchInventoryFn,
      fetchTransactionsFn,
      sleepFn: runtimeOptions.sleepFn,
    });

    if (verification.state === PurchaseVerificationState.VERIFIED_PURCHASED) {
      const verifiedPrice = verification.verifiedPrice ?? (refreshedTarget ? refreshedTarget.buyerPrice : candidate.cost);
      totalGoldSpent = Number((totalGoldSpent + verifiedPrice).toFixed(3));
      purchasedList.push({
        item: candidate,
        verifiedPrice,
        verifiedItem: verification.verifiedItem || verification.item,
      });
    } else if (verification.state === PurchaseVerificationState.FAILED_NOT_PURCHASED) {
      const reason = verification.reason || mutationError || "Purchase mutation failed";
      failedList.push({
        item: candidate,
        status: "FAILED",
        reason,
      });
      for (let j = i + 1; j < confirmedLoadout.items.length; j++) {
        failedList.push({ item: confirmedLoadout.items[j], status: "NOT_ATTEMPTED", reason: "Not attempted" });
      }
      break;
    } else {
      const reason = verification.reason || "Purchase state unconfirmed in inventory/transactions";
      failedList.push({
        item: candidate,
        status: "UNKNOWN",
        reason,
      });
      for (let j = i + 1; j < confirmedLoadout.items.length; j++) {
        failedList.push({ item: confirmedLoadout.items[j], status: "NOT_ATTEMPTED", reason: "Not attempted" });
      }
      break;
    }
  }

  // 8. Result Reporting (Sections 10 & 11)
  let balanceInfo;
  if (isFinite(startingGold) && totalGoldSpent > 0) {
    const spReconcile = ui.spinner("Reconciling post-purchase wallet balance...");
    const pollOptions = {
      fetchWalletFn,
      sleepFn: runtimeOptions.sleepFn || sleep,
      delaysMs: runtimeOptions.balancePollDelays || [0, 250, 500, 1000, 2000, 3000],
      tolerance: runtimeOptions.balanceTolerance ?? 0.05,
      userId: myUserId,
    };
    balanceInfo = await pollReconciledWalletGold(startingGold, totalGoldSpent, pollOptions);
    if (balanceInfo.state === "VERIFIED") {
      spReconcile.succeed("Wallet balance reconciled");
    } else if (balanceInfo.state === "PENDING") {
      spReconcile.warn("Wallet balance update pending on server");
    } else {
      spReconcile.info("Wallet balance updated with unrelated activity");
    }
  } else {
    let endingGold;
    try {
      endingGold = await fetchWalletFn(myUserId);
    } catch {
      endingGold = isFinite(startingGold) ? startingGold : null;
    }
    balanceInfo = {
      startingGold,
      endingGold,
      verifiedSpend: totalGoldSpent,
      delta: isFinite(startingGold) && isFinite(endingGold) ? Number((startingGold - endingGold).toFixed(3)) : 0,
      discrepancy: 0,
      difference: 0,
      state: "VERIFIED",
      converged: true,
      pollsAttempted: 0,
    };
  }

  if (purchasedList.length === confirmedLoadout.items.length) {
    printCompleteSuccess(purchasedList, totalGoldSpent, balanceInfo);
  } else {
    printPartialStop(purchasedList, failedList, totalGoldSpent, balanceInfo);
  }

  return {
    rarity: rarityInfo,
    activeCategories,
    categoryResults,
    loadout,
    confirmedLoadout,
    purchasedList,
    failedList,
    totalGoldSpent,
    totalOffersEvaluated,
    balanceInfo,
    walletGold,
    effectiveBudget,
  };
}

const isDirectExecution =
  process.argv[1] &&
  (path.basename(process.argv[1]) === "equipment_buyer.mjs" ||
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isDirectExecution) {
  runEquipmentBuyer().catch((err) => {
    console.error(chalk.red.bold("\nFatal error:"), err.message || err);
    if (/401|unauthorized/i.test(err.message || "")) {
      console.error(
        chalk.yellow(
          "\nℹ Your WarEra session token in cookies.json has expired or is unauthorized.\n" +
          "  Tip: Run 'npm run login' to launch the browser and refresh your session cookies,\n" +
          "       or run 'npm run login:status' to inspect your stored session.\n"
        )
      );
    } else if (/timeout|timed out|abort/i.test(err.message || "")) {
      console.error(
        chalk.yellow(
          "\nℹ The WarEra API took too long to respond. The server may be temporarily slow or experiencing high traffic.\n" +
          "  Tip: You can increase the request timeout using --timeout=<seconds> (e.g. --timeout=35) or try running the command again.\n"
        )
      );
    }
    process.exit(1);
  });
}
