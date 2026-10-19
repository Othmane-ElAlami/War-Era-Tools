#!/usr/bin/env node

/**
 * WarEra Equipment Resale Automation
 *
 * Scoped strictly to:
 * - Slots: Helmet, Chest, Gloves, Pants, Boots
 * - Qualities: Grey (common), Green (uncommon), Blue (rare)
 *
 * CRITICAL SAFETY INVARIANT:
 * KEEP an item ONLY if its relevant rolled stat is the MAXIMUM POSSIBLE STAT
 * for that exact slot + quality from live gameConfig.
 * Never sell a perfect/max-roll item, even if multiple copies exist.
 */

import readline from "node:readline";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import ui, { colors, icons, drawBox, isDebug, visualPadEnd } from "./ui.mjs";
import { USER_ID, resolveUserId } from "./config.mjs";
import { fetchGameConfig, fetchWithRetry, getCookieHeader, sleep } from "./analyzer/api.mjs";
import {
  ARMOR_SLOTS,
  TARGET_SLOTS,
  TARGET_RARITIES,
  extractEquipmentRanges,
  classifyInventoryItems,
  formatWeaponInspection,
} from "./analyzer/equipment_rolls.mjs";
import {
  fetchMarketOffers,
  fetchMarketTaxRate,
  analyzeItemPricing,
  performInventoryAudit,
  buildPriceCurve,
  formatWarEraNumber,
  ActiveOffersTracker,
} from "./analyzer/market_pricing.mjs";

const DEFAULT_HEADERS = {
  "content-type": "application/json",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0",
};

const API_BASE = "https://api6.warera.io/trpc";

// Parse CLI arguments
export function parseArgs(args = process.argv.slice(2)) {
  const config = {
    mode: "dry-run", // 'scan', 'dry-run', 'execute'
    pricingStrategy: "competitive", // 'competitive', 'median', 'quick'
    maxUndercutPct: 0.05,
    minConfidence: "LOW", // 'LOW', 'MODERATE', 'HIGH'
    maxListings: 1, // Default for staged live execution
    maxListingsExplicit: false,
    slotFilter: null,
    qualityFilter: null,
    itemIdFilter: null,
    yes: false,
    verbose: false,
    showPriceCurves: false,
    duplicateHandling: "same-price", // 'same-price' (default) | 'skip'
    maxSimultaneous: 3, // maximum simultaneous listings per roll (flood limit)
  };

  for (const arg of args) {
    if (arg === "--scan") {
      config.mode = "scan";
    } else if (arg === "--dry-run") {
      config.mode = "dry-run";
    } else if (arg === "--execute") {
      config.mode = "execute";
    } else if (arg === "--yes" || arg === "-y") {
      config.yes = true;
    } else if (arg === "--verbose" || arg === "-v") {
      config.verbose = true;
    } else if (arg === "--show-price-curves") {
      config.showPriceCurves = true;
    } else if (arg.startsWith("--pricing=")) {
      config.pricingStrategy = arg.split("=")[1].toLowerCase().trim();
    } else if (arg.startsWith("--max-undercut=")) {
      const val = arg.split("=")[1].replace("%", "");
      config.maxUndercutPct = Number(val) > 1 ? Number(val) / 100 : Number(val);
    } else if (arg.startsWith("--min-confidence=")) {
      config.minConfidence = arg.split("=")[1].toUpperCase().trim();
    } else if (arg.startsWith("--max-listings=")) {
      config.maxListings = parseInt(arg.split("=")[1], 10);
      config.maxListingsExplicit = true;
    } else if (arg.startsWith("--slot=")) {
      config.slotFilter = arg.split("=")[1].toLowerCase().trim();
    } else if (arg.startsWith("--quality=")) {
      config.qualityFilter = arg.split("=")[1].toLowerCase().trim();
    } else if (arg.startsWith("--item-id=")) {
      config.itemIdFilter = arg.split("=")[1].trim();
    } else if (arg.startsWith("--duplicate-handling=") || arg.startsWith("--duplicate-strategy=")) {
      const val = arg.split("=")[1].toLowerCase().trim();
      if (val !== "same-price" && val !== "skip") {
        throw new Error(`Invalid --duplicate-handling '${val}'. Must be 'same-price' or 'skip'.`);
      }
      config.duplicateHandling = val;
    } else if (arg.startsWith("--max-simultaneous=") || arg.startsWith("--flood-limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      if (isNaN(n) || n < 1 || n > 20) {
        throw new Error(`Invalid --max-simultaneous '${arg.split("=")[1]}'. Must be an integer between 1 and 20.`);
      }
      config.maxSimultaneous = n;
    }
  }

  // Slot filter validation
  if (config.slotFilter && !TARGET_SLOTS.includes(config.slotFilter)) {
    throw new Error(
      `Invalid slot filter '${config.slotFilter}'. Valid slots: ${TARGET_SLOTS.join(", ")}`
    );
  }

  // Quality filter validation
  if (config.qualityFilter) {
    const validQualities = ["grey", "green", "blue", "common", "uncommon", "rare"];
    if (!validQualities.includes(config.qualityFilter)) {
      throw new Error(
        `Invalid quality filter '${config.qualityFilter}'. Valid qualities: grey, green, blue`
      );
    }
    // Normalize quality filter
    if (config.qualityFilter === "common") config.qualityFilter = "grey";
    if (config.qualityFilter === "uncommon") config.qualityFilter = "green";
    if (config.qualityFilter === "rare") config.qualityFilter = "blue";
  }

  return config;
}

/**
 * Create an ActiveOffersTracker from active myOffers and stat ranges.
 */
export function createActiveOffersTracker(myOffers, statRanges, config) {
  const tracker = new ActiveOffersTracker([], {
    duplicateHandling: config.duplicateHandling,
    maxSimultaneous: config.maxSimultaneous,
  });

  const codeToRange = {};
  for (const info of Object.values(statRanges || {})) {
    codeToRange[info.itemCode] = info;
  }

  for (const o of myOffers || []) {
    const range = codeToRange[o.itemCode || o.item?.code];
    if (range) {
      const statVal = Number(o.item?.skills?.[range.statName]);
      tracker.addOffer({
        offerId: o._id,
        itemId: o.item?._id,
        slot: range.slot,
        quality: range.qualityName,
        statValue: statVal,
        price: o.price,
      });
    }
  }

  return tracker;
}

/**
 * Execution-time price state maintaining successfully submitted and active own offers
 * keyed by slot + quality, tracking statValue -> sellerPrice to enforce execution-time monotonicity.
 */
export class ExecutionPriceState {
  constructor(initialActiveOffers = [], statRanges = {}) {
    // Key: "slot_quality" -> Map(statValue -> [prices])
    this.bySlotQuality = new Map();
    this.addOffers(initialActiveOffers, statRanges);
  }

  static getKey(slot, quality) {
    return `${(slot || "").toLowerCase()}_${(quality || "").toLowerCase()}`;
  }

  addOffers(offers, statRanges = {}) {
    const codeToRange = {};
    for (const info of Object.values(statRanges || {})) {
      codeToRange[info.itemCode] = info;
    }

    for (const off of offers || []) {
      const code = off.itemCode || off.item?.code;
      const range = codeToRange[code];
      const slot = (off.slot || off.item?.slot || range?.slot || "").toLowerCase();
      const quality = (off.quality || off.item?.quality || range?.qualityName || "").toLowerCase();
      let statVal = off.statValue;
      if (statVal === undefined && range && off.item?.skills) {
        statVal = Number(off.item.skills[range.statName]);
      } else if (statVal === undefined && off.item?.skills) {
        statVal = Number(Object.values(off.item.skills)[0]);
      }
      const price = Number(off.price);

      if (slot && quality && statVal !== undefined && !isNaN(statVal) && !isNaN(price) && price > 0) {
        this.recordPrice(slot, quality, Number(statVal), price);
      }
    }
  }

  recordPrice(slot, quality, statValue, price) {
    const key = ExecutionPriceState.getKey(slot, quality);
    if (!this.bySlotQuality.has(key)) {
      this.bySlotQuality.set(key, new Map());
    }
    const statMap = this.bySlotQuality.get(key);
    const numStat = Number(statValue);
    const numPrice = Number(price);

    if (!statMap.has(numStat)) {
      statMap.set(numStat, []);
    }
    statMap.get(numStat).push(numPrice);
  }

  getRequiredMonotonicFloor(slot, quality, statValue) {
    const key = ExecutionPriceState.getKey(slot, quality);
    const statMap = this.bySlotQuality.get(key);
    if (!statMap) return null;

    const targetStat = Number(statValue);
    let maxLowerPrice = null;

    for (const [sVal, prices] of statMap.entries()) {
      if (sVal < targetStat) {
        for (const p of prices) {
          if (maxLowerPrice === null || p > maxLowerPrice) {
            maxLowerPrice = p;
          }
        }
      }
    }

    return maxLowerPrice !== null ? Number(maxLowerPrice.toFixed(2)) : null;
  }

  getIdenticalRollPrices(slot, quality, statValue) {
    const key = ExecutionPriceState.getKey(slot, quality);
    const statMap = this.bySlotQuality.get(key);
    if (!statMap) return [];
    return statMap.get(Number(statValue)) || [];
  }
}

/**
 * Enforce execution-time monotonic pricing immediately before live listing submission.
 */
export function applyExecutionMonotonicFloor(item, pricing, executionPriceState, options = {}) {
  const { slot, quality, statValue } = item;
  const taxRate = options.taxRate ?? pricing.taxRate ?? 1;

  const requiredMonotonicFloor = executionPriceState.getRequiredMonotonicFloor(
    slot,
    quality,
    statValue
  );

  if (requiredMonotonicFloor === null) {
    return { action: "PROCEED" };
  }

  const allowedCeiling = Number(
    (pricing.robustFairValue ?? pricing.suggestedPrice ?? 1.0).toFixed(2)
  );

  if (requiredMonotonicFloor > allowedCeiling) {
    return {
      action: "SKIP",
      disposition: "SKIP - MONOTONIC PRICE CONFLICT",
      reason: `Required monotonic floor (${requiredMonotonicFloor.toFixed(2)} Gold from lower roll) exceeds fair-value ceiling (${allowedCeiling.toFixed(2)} Gold)`,
    };
  }

  if (pricing.suggestedPrice < requiredMonotonicFloor) {
    pricing.suggestedPrice = requiredMonotonicFloor;
    pricing.enteredPrice = requiredMonotonicFloor;
    pricing.pricingReason = "MONOTONIC_EXECUTION_FLOOR";

    const rawBuyerPrice = pricing.enteredPrice * (1 + taxRate / 100);
    pricing.displayedBuyerPrice = Number(rawBuyerPrice.toFixed(3));
    pricing.displayedBuyerPriceFormatted = formatWarEraNumber(rawBuyerPrice, 3);
  }

  return { action: "PROCEED" };
}

/**
 * Filter candidates according to CLI parameters.
 * Safety invariant: only narrows the existing safe candidate set.
 * Never includes items marked KEEP (perfect, equipped, damaged, listed, or very low confidence).
 */
export function filterCandidates(items, config) {
  const rank = { HIGH: 3, MODERATE: 2, MOD: 2, LOW: 1, "VERY LOW": 0 };
  const minRank = rank[config.minConfidence] !== undefined ? rank[config.minConfidence] : 1;

  return items.filter((item) => {
    // Only SELL - ELIGIBLE items are sell candidates
    // Allow SKIP - MONOTONIC PRICE CONFLICT to pass through so prepareExecutionCandidates tracks them in skipped
    if (
      item.finalDisposition &&
      item.finalDisposition !== "SELL - ELIGIBLE" &&
      item.finalDisposition !== "SKIP - MONOTONIC PRICE CONFLICT"
    ) {
      return false;
    }

    // Exact Item ID filter
    if (config.itemIdFilter && item.itemId !== config.itemIdFilter) {
      return false;
    }

    // Slot filter
    if (config.slotFilter && item.slot.toLowerCase() !== config.slotFilter) {
      return false;
    }

    // Quality filter
    if (config.qualityFilter && item.quality.toLowerCase() !== config.qualityFilter) {
      return false;
    }

    // Confidence filter
    if (item.pricing?.confidence !== undefined) {
      const itemConfRank = rank[item.pricing.confidence] ?? 0;
      if (itemConfRank < minRank) {
        return false;
      }
    }

    return true;
  });
}

/**
 * Normalize listing prices across candidates to enforce monotonic pricing:
 * For items sharing the same slot + quality, sorted by statValue ascending:
 * price(stat n+1) >= price(stat n)
 *
 * A better roll must never be listed cheaper than a worse roll.
 * Constraints:
 * 1. Never violate the 5% price floor guard: price >= robustFairValue * (1 - maxUndercutPct)
 * 2. Never raise above robust fair-value ceiling: price <= robustFairValue
 * 3. Identical rolls (same slot + quality + statValue) share the exact same price
 * 4. Perfect rolls remain completely untouched
 */
export function normalizeBatchPricing(candidates, options = {}) {
  const maxUndercutPct = options.maxUndercutPct ?? 0.05;
  const pricingStrategy = options.pricingStrategy ?? "competitive";
  const minAllowedRatio = pricingStrategy === "quick" ? 0.90 : (1 - maxUndercutPct);
  const activeTracker = options.activeOffersTracker ?? null;

  // Separate non-sellable / perfect items (must remain completely untouched)
  const sellable = [];
  const untouched = [];

  for (const item of candidates) {
    if (item.isPerfectRoll || item.finalDisposition !== "SELL - ELIGIBLE") {
      untouched.push(item);
    } else {
      sellable.push({
        ...item,
        pricing: item.pricing ? { ...item.pricing } : null,
      });
    }
  }

  // Group sellable items by slot + quality
  const groups = new Map();
  for (const item of sellable) {
    const key = `${item.slot}_${item.quality?.toLowerCase()}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(item);
  }

  const normalizedSellable = [];

  for (const [key, group] of groups.entries()) {
    // 1. Sort by statValue ascending
    group.sort((a, b) => (a.statValue || 0) - (b.statValue || 0));

    // 2. Unify prices for identical statValue
    const statGroups = new Map();
    for (const item of group) {
      const s = item.statValue || 0;
      if (!statGroups.has(s)) {
        statGroups.set(s, []);
      }
      statGroups.get(s).push(item);
    }

    const distinctStats = Array.from(statGroups.keys()).sort((a, b) => a - b);
    const statPrices = new Map();
    const statFloors = new Map();
    const statCeilings = new Map();
    const conflictedStats = new Set();
    const conflictReasons = new Map();

    for (const s of distinctStats) {
      const itemsForStat = statGroups.get(s);
      const firstItem = itemsForStat[0];
      const fairVal = Number(
        (firstItem.pricing?.robustFairValue ?? firstItem.pricing?.suggestedPrice ?? 1.0).toFixed(2)
      );
      const floor = Number((fairVal * minAllowedRatio).toFixed(2));
      const activeOffers = activeTracker ? activeTracker.getOffersForRoll(firstItem.slot, firstItem.quality, s) : [];

      let basePrice;
      if (activeOffers.length > 0 && (options.duplicateHandling || "same-price") === "same-price") {
        basePrice = Number(activeOffers[0].price);
      } else {
        basePrice = Number((firstItem.pricing?.suggestedPrice || fairVal).toFixed(2));
        basePrice = Math.max(floor, basePrice);
      }

      const trackerFloor = activeTracker ? activeTracker.getFloorForRoll(firstItem.slot, firstItem.quality, s) : null;
      const ceiling = Number(
        (firstItem.pricing?.robustFairValue ?? fairVal).toFixed(2)
      );

      // Check conflict against pre-existing active offers floor
      if (trackerFloor !== null && trackerFloor > ceiling) {
        conflictedStats.add(s);
        conflictReasons.set(
          s,
          `Required monotonic floor (${trackerFloor.toFixed(2)} Gold from active lower roll) exceeds fair-value ceiling (${ceiling.toFixed(2)} Gold)`
        );
      } else if (trackerFloor && basePrice < trackerFloor) {
        basePrice = trackerFloor;
      }

      statFloors.set(s, Math.max(floor, trackerFloor || 0));
      statCeilings.set(s, ceiling);
      statPrices.set(s, Number(basePrice.toFixed(2)));
    }

    // 2b. Infeasible Monotonicity Conflict Guard
    // If batch normalization cannot satisfy:
    // price(higherRoll) >= price(lowerRoll)
    // without violating either:
    // - lower item's minimum allowed price floor
    // - higher item's maximum allowed fair-value ceiling
    // then DO NOT force a price.
    // Mark the affected higher/lower roll group:
    // SKIP - MONOTONIC PRICE CONFLICT
    // and exclude those items from live execution.
    for (let i = 0; i < distinctStats.length; i++) {
      for (let j = i + 1; j < distinctStats.length; j++) {
        const lowerStat = distinctStats[i];
        const higherStat = distinctStats[j];
        const lowerFloor = statFloors.get(lowerStat);
        const higherCeiling = statCeilings.get(higherStat);

        if (lowerFloor > higherCeiling) {
          const reason = `Infeasible monotonicity: lower roll (+${lowerStat}) floor (${lowerFloor.toFixed(2)}) > higher roll (+${higherStat}) ceiling (${higherCeiling.toFixed(2)})`;
          for (let k = i; k <= j; k++) {
            const st = distinctStats[k];
            conflictedStats.add(st);
            if (!conflictReasons.has(st)) {
              conflictReasons.set(st, reason);
            }
          }
        }
      }
    }

    // 3. Monotonic non-decreasing adjustment for feasible stats
    const feasibleStats = distinctStats.filter((s) => !conflictedStats.has(s));

    // Pass 1: Backward pass — lower worse rolls down to better rolls where floor permits
    for (let i = feasibleStats.length - 2; i >= 0; i--) {
      const currentStat = feasibleStats[i];
      const nextStat = feasibleStats[i + 1];
      let pCurr = statPrices.get(currentStat);
      const pNext = statPrices.get(nextStat);
      const floorCurr = statFloors.get(currentStat);

      if (pCurr > pNext) {
        // Lower currentStat down to pNext, but never below floorCurr
        pCurr = Math.max(floorCurr, pNext);
        statPrices.set(currentStat, Number(pCurr.toFixed(2)));
      }
    }

    // Pass 2: Forward pass — if a worse roll was blocked from lowering by its floor,
    // raise the higher roll up to at least the lower roll's price (bounded by ceiling)
    for (let i = 0; i < feasibleStats.length - 1; i++) {
      const currentStat = feasibleStats[i];
      const nextStat = feasibleStats[i + 1];
      const pCurr = statPrices.get(currentStat);
      let pNext = statPrices.get(nextStat);
      const ceilNext = statCeilings.get(nextStat);

      if (pNext < pCurr) {
        pNext = Math.min(ceilNext, Math.max(pNext, pCurr));
        statPrices.set(nextStat, Number(pNext.toFixed(2)));
      }
    }

    // Defense-in-depth: assert no non-monotonic sequence remains in feasibleStats
    for (let i = 0; i < feasibleStats.length - 1; i++) {
      const sCurr = feasibleStats[i];
      const sNext = feasibleStats[i + 1];
      if (statPrices.get(sCurr) > statPrices.get(sNext)) {
        conflictedStats.add(sCurr);
        conflictedStats.add(sNext);
        conflictReasons.set(sCurr, "Monotonic adjustment unresolved");
        conflictReasons.set(sNext, "Monotonic adjustment unresolved");
      }
    }

    // 4. Assign normalized prices and dispositions back to items
    for (const s of distinctStats) {
      const itemsForStat = statGroups.get(s);
      const isConflicted = conflictedStats.has(s);

      if (isConflicted) {
        const reason = conflictReasons.get(s) || "Monotonic price conflict";
        for (const item of itemsForStat) {
          const origPrice = item.pricing?.suggestedPrice;
          const taxRate = item.pricing?.taxRate ?? options.taxRate ?? 1;
          // DO NOT force a price: keep original evaluated price or unforced suggested price
          const priceToKeep = Number((origPrice || item.pricing?.robustFairValue || 1.0).toFixed(2));
          const rawBuyerPrice = priceToKeep * (1 + taxRate / 100);

          item.finalDisposition = "SKIP - MONOTONIC PRICE CONFLICT";
          item.pricing = {
            ...item.pricing,
            suggestedPrice: priceToKeep,
            enteredPrice: priceToKeep,
            displayedBuyerPrice: Number(rawBuyerPrice.toFixed(3)),
            displayedBuyerPriceFormatted: formatWarEraNumber(rawBuyerPrice, 3),
            pricingReason: "MONOTONIC_PRICE_CONFLICT",
            conflictReason: reason,
          };

          normalizedSellable.push(item);
        }
      } else {
        const finalPrice = statPrices.get(s);
        for (const item of itemsForStat) {
          const origPrice = item.pricing?.suggestedPrice;
          const taxRate = item.pricing?.taxRate ?? options.taxRate ?? 1;
          const rawBuyerPrice = finalPrice * (1 + taxRate / 100);

          item.pricing = {
            ...item.pricing,
            suggestedPrice: finalPrice,
            enteredPrice: finalPrice,
            displayedBuyerPrice: Number(rawBuyerPrice.toFixed(3)),
            displayedBuyerPriceFormatted: formatWarEraNumber(rawBuyerPrice, 3),
            pricingReason:
              origPrice !== finalPrice
                ? "MONOTONIC_NORMALIZATION"
                : item.pricing?.pricingReason || "MARKET_COMPETITIVE",
          };

          normalizedSellable.push(item);
        }
      }
    }
  }

  // Sort overall sellable by slot, quality, and statValue ascending
  const SLOT_ORDER = { helmet: 0, chest: 1, gloves: 2, pants: 3, boots: 4, weapon: 5 };
  const QUALITY_ORDER = { grey: 0, common: 0, green: 1, uncommon: 1, blue: 2, rare: 2 };

  normalizedSellable.sort((a, b) => {
    const slotA = SLOT_ORDER[a.slot] ?? 99;
    const slotB = SLOT_ORDER[b.slot] ?? 99;
    if (slotA !== slotB) return slotA - slotB;

    const qA = QUALITY_ORDER[a.quality?.toLowerCase()] ?? 99;
    const qB = QUALITY_ORDER[b.quality?.toLowerCase()] ?? 99;
    if (qA !== qB) return qA - qB;

    return (a.statValue || 0) - (b.statValue || 0);
  });

  return [...normalizedSellable, ...untouched];
}

/**
 * Prepare and stage execution candidates sequentially, simulating active listings
 * to enforce the market-flood guard, duplicate handling strategy, and self-undercut prevention.
 */
export function prepareExecutionCandidates(items, config, baseTracker = null) {
  // 1. Filter candidates according to config (slot, quality, minConfidence, etc.)
  const eligible = filterCandidates(items, config);

  // 2. Apply batch-level monotonic pricing normalization
  const normalized = normalizeBatchPricing(eligible, {
    maxUndercutPct: config.maxUndercutPct,
    pricingStrategy: config.pricingStrategy,
    activeOffersTracker: baseTracker,
    duplicateHandling: config.duplicateHandling,
  });

  // 3. Clone tracker so dry-run simulation does not mutate base tracker
  const simTracker = new ActiveOffersTracker([], {
    duplicateHandling: config.duplicateHandling,
    maxSimultaneous: config.maxSimultaneous,
  });
  if (baseTracker) {
    for (const offers of baseTracker.byRoll.values()) {
      for (const off of offers) {
        simTracker.addOffer(off);
      }
    }
  }

  const staged = [];
  const skipped = [];

  for (const item of normalized) {
    // Perfect rolls and non-sellable items are never staged for execution
    if (item.isPerfectRoll || item.finalDisposition !== "SELL - ELIGIBLE") {
      if (item.finalDisposition === "SKIP - MONOTONIC PRICE CONFLICT") {
        skipped.push({
          item,
          reason: `MONOTONIC_PRICE_CONFLICT (${item.pricing?.conflictReason || "infeasible floor > ceiling"})`,
        });
      }
      continue;
    }
    const activeOffers = simTracker.getOffersForRoll(item.slot, item.quality, item.statValue);
    const activeCount = activeOffers.length;

    // Market-flood guard check
    if (activeCount >= config.maxSimultaneous) {
      skipped.push({
        item,
        reason: `FLOOD_LIMIT (${activeCount}/${config.maxSimultaneous} active)`,
      });
      continue;
    }

    // Duplicate skip check
    if (activeCount > 0 && config.duplicateHandling === "skip") {
      skipped.push({
        item,
        reason: `DUPLICATE_ACTIVE_OFFER (active offer at ${activeOffers[0].price} Gold)`,
      });
      continue;
    }

    // Determine price (match active offer if same-price)
    let candidatePrice = item.pricing?.suggestedPrice || 1.0;
    let pricingReason = item.pricing?.pricingReason || "MARKET_COMPETITIVE";
    if (activeCount > 0 && config.duplicateHandling === "same-price") {
      candidatePrice = activeOffers[0].price;
      pricingReason = "MATCH_ACTIVE_OFFER";
    }

    // Floor guard against lower rolls
    const floor = simTracker.getFloorForRoll(item.slot, item.quality, item.statValue);
    if (floor && candidatePrice < floor) {
      candidatePrice = floor;
    }

    candidatePrice = Number(candidatePrice.toFixed(2));
    const taxRate = item.pricing?.taxRate ?? 1;
    const rawBuyerPrice = candidatePrice * (1 + taxRate / 100);

    const candidateItem = {
      ...item,
      pricing: {
        ...item.pricing,
        suggestedPrice: candidatePrice,
        enteredPrice: candidatePrice,
        displayedBuyerPrice: Number(rawBuyerPrice.toFixed(3)),
        displayedBuyerPriceFormatted: formatWarEraNumber(rawBuyerPrice, 3),
        pricingReason,
      },
    };

    staged.push(candidateItem);

    // Record simulated offer into simTracker so subsequent items in queue see it
    simTracker.addOffer({
      slot: item.slot,
      quality: item.quality,
      statValue: item.statValue,
      price: candidatePrice,
    });
  }

  return { staged, skipped };
}

/**
 * Resolve target candidates with strict abort checks when --item-id is passed.
 * If the requested item ID is not in-scope or not SELL - ELIGIBLE: ABORT.
 */
export function resolveTargetCandidates(items, config, rawInventory = [], tracker = null) {
  if (config.itemIdFilter) {
    const targetItem = items.find((i) => i.itemId === config.itemIdFilter);
    if (!targetItem) {
      // Check if it exists in raw inventory to give specific error
      const inRaw = rawInventory.find((i) => i._id === config.itemIdFilter);
      if (inRaw) {
        throw new Error(
          `Requested item ID '${config.itemIdFilter}' exists but is not an in-scope Grey/Green/Blue equipment item. Only Grey/Green/Blue Helmet/Chest/Gloves/Pants/Boots are eligible. ABORTING.`
        );
      }
      throw new Error(
        `Requested item ID '${config.itemIdFilter}' was not found in inventory. ABORTING.`
      );
    }

    if (targetItem.finalDisposition !== "SELL - ELIGIBLE") {
      throw new Error(
        `Requested item ID '${config.itemIdFilter}' is NOT eligible for sale. Current disposition: ${targetItem.finalDisposition}. ABORTING.`
      );
    }

    if (tracker) {
      const activeCount = tracker.getCountForRoll(targetItem.slot, targetItem.quality, targetItem.statValue);
      if (activeCount >= config.maxSimultaneous) {
        throw new Error(
          `Requested item ID '${config.itemIdFilter}' cannot be listed because the market-flood guard limit of ${config.maxSimultaneous} active listings for this roll has been reached. ABORTING.`
        );
      }
      if (activeCount > 0 && config.duplicateHandling === "skip") {
        throw new Error(
          `Requested item ID '${config.itemIdFilter}' cannot be listed because an active listing for this roll already exists (--duplicate-handling=skip). ABORTING.`
        );
      }
    }
  }

  const filtered = filterCandidates(items, config);

  if (config.itemIdFilter) {
    const matched = filtered.filter((i) => i.itemId === config.itemIdFilter);
    if (matched.length === 0) {
      throw new Error(
        `Requested item ID '${config.itemIdFilter}' was excluded by active filters (slot: ${config.slotFilter || "none"}, quality: ${config.qualityFilter || "none"}, minConfidence: ${config.minConfidence}). ABORTING.`
      );
    }
    return matched;
  }

  return filtered;
}

/**
 * Strict 4-way post-listing verification state.
 */
export const ListingVerificationState = {
  VERIFIED_LISTED: "VERIFIED_LISTED",
  VERIFIED_SOLD: "VERIFIED_SOLD",
  FAILED_NOT_LISTED: "FAILED_NOT_LISTED",
  UNKNOWN: "UNKNOWN",
};

/**
 * Fetch all active market offers for a user across all paginated pages.
 */
export async function fetchAllUserActiveOffers(userId, options = {}) {
  const cookieHeader = options.cookieHeader ?? getCookieHeader();
  const fetchFn = options.fetchFn ?? fetchWithRetry;
  const apiBase = options.apiBase ?? API_BASE;
  const allOffers = [];
  let cursor = undefined;

  while (true) {
    const res = await fetchFn(`${apiBase}/itemOffer.getItemOffers?batch=1`, {
      method: "POST",
      headers: { ...DEFAULT_HEADERS, ...(cookieHeader ? { cookie: cookieHeader } : {}) },
      body: JSON.stringify({
        "0": {
          userId,
          limit: 50,
          direction: "forward",
          ...(cursor ? { cursor } : {}),
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch user active offers (HTTP ${res.status})`);
    }

    const json = await res.json();
    const data = json[0]?.result?.data;
    const items = data?.items || [];
    allOffers.push(...items);
    cursor = data?.nextCursor;
    if (!cursor || items.length === 0) break;
  }

  return allOffers;
}

/**
 * Fetch recent market sales for a user from transaction history.
 */
export async function fetchRecentUserMarketSales(userId, options = {}) {
  const cookieHeader = options.cookieHeader ?? getCookieHeader();
  const fetchFn = options.fetchFn ?? fetchWithRetry;
  const apiBase = options.apiBase ?? API_BASE;
  const limit = options.limit ?? 20;

  const res = await fetchFn(`${apiBase}/transaction.getPaginatedTransactions?batch=1`, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    body: JSON.stringify({
      "0": {
        userId,
        limit,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch user transactions (HTTP ${res.status})`);
  }

  const json = await res.json();
  const items = json[0]?.result?.data?.items || [];
  return items.filter(
    (t) =>
      t.sellerId === userId &&
      (t.transactionType === "itemMarket" || t.transactionType?.includes("Market"))
  );
}

/**
 * Verify post-listing state confirms exact item was listed with quantity 1, matching price, and offer.
 * (Synchronous snapshot verification helper)
 */
export function verifyListedOffer(verifyState, itemId, enteredPrice) {
  const myOffers = verifyState.myOffers || [];
  const matchingOffers = myOffers.filter(
    (o) => (o.item?._id === itemId || o.itemId === itemId)
  );

  if (matchingOffers.length === 0) {
    return {
      verified: false,
      reason: `No active market offer found with item ID ${itemId}`,
    };
  }

  if (matchingOffers.length > 1) {
    return {
      verified: false,
      reason: `Multiple active market offers (${matchingOffers.length}) found for item ID ${itemId}`,
    };
  }

  const offer = matchingOffers[0];
  const qty = offer.item?.quantity ?? offer.quantity;
  if (qty !== 1) {
    return {
      verified: false,
      reason: `Offer quantity is ${qty}, expected exactly 1`,
    };
  }

  const offerPrice = Number(offer.price);
  if (Math.abs(offerPrice - enteredPrice) > 0.001) {
    return {
      verified: false,
      reason: `Offer price is ${offerPrice}, expected ${enteredPrice}`,
    };
  }

  // Check that item is reflected as listed
  if (!verifyState.listedItemIds.has(itemId)) {
    return {
      verified: false,
      reason: `Item ID ${itemId} is not registered in active listedItemIds`,
    };
  }

  return {
    verified: true,
    offer,
  };
}

/**
 * Verify a listing with bounded exponential backoff polling, multi-page pagination,
 * immediate-sale fallback detection, and inventory safety checking.
 */
export async function verifyListingWithBackoff(itemId, enteredPrice, options = {}) {
  const userId = resolveUserId(options.userId);
  const submissionTime = options.submissionTime ?? Date.now();
  const pollScheduleMs = options.pollScheduleMs ?? [500, 500, 1000, 2000, 3000];
  const sleepFn = options.sleepFn ?? sleep;
  const createdOfferId = options.createdOfferId ?? null;
  const itemCode = options.itemCode ?? null;
  const statName = options.statName ?? null;
  const statValue = options.statValue ?? null;
  const mutationFailed = options.mutationFailed ?? false;

  const fetchOffersFn = options.fetchOffersFn ?? (() => fetchAllUserActiveOffers(userId));
  const fetchTransactionsFn = options.fetchTransactionsFn ?? (() => fetchRecentUserMarketSales(userId));
  const fetchInventoryFn = options.fetchInventoryFn ?? (() => fetchUserInventoryState());

  // 1. If mutation explicitly failed before server commit, check inventory
  if (mutationFailed) {
    try {
      const invState = await fetchInventoryFn(userId);
      const inBag = (invState.inv?.items?.equipments || []).some((e) => e._id === itemId);
      if (inBag) {
        return {
          state: ListingVerificationState.FAILED_NOT_LISTED,
          reason: "Listing mutation failed and item remains safely in inventory.",
        };
      }
    } catch {
      // Fall through to polling
    }
  }

  // 2. Bounded Polling Loop for Active Listing
  let lastOffers = [];
  for (let attempt = 0; attempt < pollScheduleMs.length; attempt++) {
    const delay = pollScheduleMs[attempt];
    if (delay > 0) {
      await sleepFn(delay);
    }

    try {
      const offers = await fetchOffersFn(userId);
      lastOffers = offers;

      // Find matching offer
      const match = offers.find((o) => {
        if (createdOfferId && (o._id === createdOfferId || o.offerId === createdOfferId)) {
          return true;
        }
        return o.item?._id === itemId || o.itemId === itemId;
      });

      if (match) {
        // Assert quantity
        const qty = match.item?.quantity ?? match.quantity;
        if (qty !== 1) {
          return {
            state: ListingVerificationState.UNKNOWN,
            reason: `Found active offer #${match._id} but quantity is ${qty}, expected 1.`,
            offer: match,
          };
        }

        // Assert price
        const offerPrice = Number(match.price);
        if (Math.abs(offerPrice - enteredPrice) > 0.001) {
          return {
            state: ListingVerificationState.UNKNOWN,
            reason: `Found active offer #${match._id} but price is ${offerPrice}, expected ${enteredPrice}.`,
            offer: match,
          };
        }

        return {
          state: ListingVerificationState.VERIFIED_LISTED,
          offer: match,
          attempts: attempt + 1,
        };
      }
    } catch (err) {
      // Allow retry on transient error during backoff
    }
  }

  // 3. Immediate Sale Detection Fallback
  // If active offer was not found after all retries, check if it was already sold!
  const consumedTxIds = options.consumedTxIds ?? new Set();

  try {
    const recentSales = await fetchTransactionsFn(userId);
    // Filter to eligible, unconsumed market sale transactions for current user with exact matching price
    const eligibleSales = (recentSales || []).filter((tx) => {
      if (!tx || !tx._id || consumedTxIds.has(tx._id)) return false;
      if (tx.sellerId !== userId) return false;
      const txType = tx.transactionType || "";
      if (txType !== "itemMarket" && !txType.includes("Market")) return false;
      const salePrice = Number(tx.money ?? tx.price);
      if (Math.abs(salePrice - enteredPrice) > 0.001) return false;
      return true;
    });

    let matchedTx = null;

    // Priority 1: exact original item ID
    const p1Matches = eligibleSales.filter(
      (tx) => tx.item?._id === itemId || tx.itemId === itemId
    );
    if (p1Matches.length === 1) {
      matchedTx = p1Matches[0];
    } else if (p1Matches.length > 1) {
      p1Matches.sort((a, b) => {
        const tA = new Date(a.offerCreatedAt || a.createdAt).getTime();
        const tB = new Date(b.offerCreatedAt || b.createdAt).getTime();
        return Math.abs(tA - submissionTime) - Math.abs(tB - submissionTime);
      });
      matchedTx = p1Matches[0];
    }

    // Priority 2: exact created offer ID, if transaction exposes it
    if (!matchedTx && createdOfferId) {
      const p2Matches = eligibleSales.filter(
        (tx) =>
          tx.offerId === createdOfferId ||
          tx.itemOfferId === createdOfferId ||
          tx._id === createdOfferId
      );
      if (p2Matches.length === 1) {
        matchedTx = p2Matches[0];
      } else if (p2Matches.length > 1) {
        matchedTx = p2Matches[0];
      }
    }

    // Priority 3: exact seller + itemCode + stat roll + price + offerCreatedAt closest to submissionTime
    if (!matchedTx) {
      const windowMs = options.fallbackWindowMs ?? 60000;
      const p3Candidates = [];

      for (const tx of eligibleSales) {
        // Require exact itemCode
        const codeMatch =
          itemCode &&
          (tx.itemCode === itemCode || tx.item?.code === itemCode);
        if (!codeMatch) continue;

        // Require exact stat roll
        const statMatch =
          statName &&
          Number(tx.item?.skills?.[statName]) === Number(statValue);
        if (!statMatch) continue;

        // Require offerCreatedAt within a narrow bounded window around submissionTime
        const txOfferTime = new Date(tx.offerCreatedAt || tx.createdAt).getTime();
        if (!Number.isFinite(txOfferTime)) continue;
        const timeDiff = Math.abs(txOfferTime - submissionTime);
        if (timeDiff > windowMs) continue;

        p3Candidates.push({ tx, timeDiff });
      }

      if (p3Candidates.length === 1) {
        matchedTx = p3Candidates[0].tx;
      } else if (p3Candidates.length > 1) {
        // Sort by timeDiff ascending (nearest first)
        p3Candidates.sort((a, b) => a.timeDiff - b.timeDiff);

        // Check for ambiguity: if multiple equally plausible unmatched transactions exist
        // (i.e. tie on timeDiff within ambiguity tolerance, default 0ms)
        const toleranceMs = options.ambiguityToleranceMs ?? 0;
        if (Math.abs(p3Candidates[0].timeDiff - p3Candidates[1].timeDiff) <= toleranceMs) {
          return {
            state: ListingVerificationState.UNKNOWN,
            reason: `Ambiguous sale transaction mapping: ${p3Candidates.length} unmatched transactions have equal proximity (${p3Candidates[0].timeDiff}ms) to submissionTime for roll ${statName} +${statValue}.`,
          };
        }

        matchedTx = p3Candidates[0].tx;
      }
    }

    if (matchedTx) {
      consumedTxIds.add(matchedTx._id);
      return {
        state: ListingVerificationState.VERIFIED_SOLD,
        transaction: matchedTx,
        salePrice: Number(matchedTx.money ?? enteredPrice),
      };
    }
  } catch (err) {
    // If sales check fails, fall through to inventory check
  }

  // 4. Inventory Presence Check
  try {
    const invState = await fetchInventoryFn(userId);
    const inBag =
      (invState.inv?.items?.equipments || []).some((e) => e._id === itemId) ||
      (invState.inv?.items?.weapons || []).some((e) => e._id === itemId);
    const inMarket =
      (invState.inv?.market?.equipments || []).some((e) => e._id === itemId) ||
      (invState.inv?.market?.weapons || []).some((e) => e._id === itemId);

    if (inBag && !inMarket) {
      return {
        state: ListingVerificationState.FAILED_NOT_LISTED,
        reason: `Item ${itemId} was not listed and remains safely in inventory.`,
      };
    }
  } catch {
    // Fall through to UNKNOWN
  }

  // 5. If item is missing from inventory, not in offers, and not in sales: UNKNOWN
  return {
    state: ListingVerificationState.UNKNOWN,
    reason: `Item ${itemId} not found in active offers (after ${pollScheduleMs.length} retries), not in recent sales, and missing from inventory.`,
  };
}

/**
 * Fetch live inventory, equipped items, and active market listings.
 */
export async function fetchUserInventoryState(options = {}) {
  const cookieHeader = options.cookieHeader ?? getCookieHeader();
  if (!cookieHeader) {
    throw new Error("Session cookies not found in cookies.json. Please log in first.");
  }
  const userId = resolveUserId(options.userId);

  // 1. Fetch inventory and equipped items
  const invRes = await fetchWithRetry(`${API_BASE}/inventory.getById,inventory.equippedItems?batch=1`, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, cookie: cookieHeader },
    body: JSON.stringify({ "0": { userId }, "1": { userId } }),
  });

  if (!invRes.ok) {
    throw new Error(`Failed to fetch inventory (HTTP ${invRes.status}): ${await invRes.text()}`);
  }

  const invJson = await invRes.json();
  const inv = invJson[0]?.result?.data;
  const equipped = invJson[1]?.result?.data;

  // 2. Fetch all my active listings with pagination
  const myOffers = await fetchAllUserActiveOffers(userId, { cookieHeader });
  const listedItemIds = new Set(myOffers.map((o) => o.item?._id || o.itemId).filter(Boolean));

  // Also include items from inv.market.equipments and inv.market.weapons if any
  if (inv?.market?.equipments) {
    inv.market.equipments.forEach((eq) => {
      if (eq?._id) listedItemIds.add(eq._id);
    });
  }
  if (inv?.market?.weapons) {
    inv.market.weapons.forEach((w) => {
      if (w?._id) listedItemIds.add(w._id);
    });
  }

  return {
    inv,
    equipped,
    myOffers,
    listedItemIds,
  };
}

/**
 * Submit a single listing to the market.
 */
export async function submitMarketListing(itemId, price) {
  const cookieHeader = getCookieHeader();
  const res = await fetchWithRetry(`${API_BASE}/itemOffer.createItemOffer?batch=1`, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, cookie: cookieHeader },
    body: JSON.stringify({
      "0": {
        itemId,
        price: Number(price),
        quantity: 1,
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Market listing request failed (HTTP ${res.status}): ${errorText}`);
  }

  const json = await res.json();
  if (json[0]?.error) {
    throw new Error(`Server returned error creating offer: ${JSON.stringify(json[0].error)}`);
  }

  return json[0]?.result?.data;
}

// Presentation & Color Helpers
const SLOT_ICONS = {
  helmet: "🪖",
  chest: "🛡️",
  gloves: "🥊",
  pants: "👖",
  boots: "🥾",
  weapon: "⚔️",
};

const SLOT_LABELS = {
  helmet: "Helmet",
  chest: "Chest",
  gloves: "Gloves",
  pants: "Pants",
  boots: "Boots",
  weapon: "Weapon",
};

function formatQuality(quality) {
  const q = (quality || "").toLowerCase();
  if (q === "grey" || q === "common") return chalk.gray("Grey");
  if (q === "green" || q === "uncommon") return chalk.green("Green");
  if (q === "blue" || q === "rare") return chalk.blueBright("Blue");
  return quality;
}

export function getItemDisplayName(item) {
  if (!item) return "";
  if (item.slot === "weapon") {
    if (item.name && item.name !== "Weapon") return item.name;
    const code = item.code || item.itemCode || "";
    if (code) return code.charAt(0).toUpperCase() + code.slice(1);
    return "Weapon";
  }
  return SLOT_LABELS[item.slot] || item.slot || "";
}

export function getFullItemTitle(item, fallbackQuality = null) {
  if (!item) return "";
  const quality = item.quality || fallbackQuality || "";
  const q = formatQuality(quality);
  const name = getItemDisplayName(item);
  return q ? `${q} ${name}` : name;
}

export function formatArmorDebugTrace(item) {
  if (!item) return "";
  const p = item.pricing || {};
  const trace = p.debugTrace || {};
  const statMin = item.statMin ?? item.minPossibleStat ?? "-";
  const statMax = item.statMax ?? item.maxPossibleStat ?? "-";
  const rollPct = item.rollPercent !== undefined ? `${item.rollPercent}%` : `${item.rollPosition || 0}`;

  const exactComps = trace.exactComps ?? p.comparablesCount?.exact ?? 0;
  const nearComps = trace.nearComps ?? p.comparablesCount?.near ?? 0;
  const pricesUsedStr = (trace.pricesUsed && trace.pricesUsed.length > 0)
    ? `[${trace.pricesUsed.map((v) => Number(v).toFixed(2)).join(", ")}]`
    : "[]";
  const rejectedOutliersStr = (trace.rejectedOutliers && trace.rejectedOutliers.length > 0)
    ? `[${trace.rejectedOutliers.map((v) => Number(v).toFixed(2)).join(", ")}]`
    : "[]";

  const fairValStr = p.robustFairValue !== null && p.robustFairValue !== undefined
    ? `${p.robustFairValue.toFixed(2)} G`
    : "null";
  const compTargetStr = trace.competitiveTarget !== null && trace.competitiveTarget !== undefined
    ? `${trace.competitiveTarget.toFixed(2)} G`
    : "null";
  const sellerPriceStr = p.suggestedPrice !== null && p.suggestedPrice !== undefined
    ? `${p.suggestedPrice.toFixed(2)} G`
    : "null";
  const buyerPriceStr = p.displayedBuyerPrice !== null && p.displayedBuyerPrice !== undefined
    ? `${(p.displayedBuyerPriceFormatted ?? p.displayedBuyerPrice)} G`
    : "null";

  return [
    `Armor Price Trace:`,
    `  itemId:                      ${item.itemId || item._id}`,
    `  itemCode:                    ${item.code || item.itemCode}`,
    `  slot:                        ${item.slot}`,
    `  rarity:                      ${item.quality || item.rarityKey}`,
    `  relevantStat:                ${item.relevantStat || item.statName}`,
    `  statValue:                   ${item.statValue}`,
    `  statMin:                     ${statMin}`,
    `  statMax:                     ${statMax}`,
    `  rollPercent:                 ${rollPct}`,
    `  exact comparables:           ${exactComps}`,
    `  near comparables:            ${nearComps}`,
    `  prices used:                 ${pricesUsedStr}`,
    `  prices rejected as outliers: ${rejectedOutliersStr}`,
    `  robustFairValue:             ${fairValStr}`,
    `  competitive target:          ${compTargetStr}`,
    `  final seller price:          ${sellerPriceStr}`,
    `  buyer price:                 ${buyerPriceStr}`,
    `  confidence:                  ${p.confidence || "UNKNOWN"}`,
    `  pricing reason:              ${p.pricingReason || "UNKNOWN"}`,
  ].join("\n");
}

function formatConf(conf) {
  if (conf === "HIGH") return chalk.green.bold("HIGH");
  if (conf === "MODERATE" || conf === "MOD") return chalk.yellow("MOD");
  if (conf === "LOW") return chalk.hex("#F97316")("LOW");
  return chalk.red.bold("VERY LOW");
}

function formatRoll(rollPosition, isPerfect) {
  if (isPerfect || rollPosition === "PERFECT") {
    return chalk.magenta.bold("PERFECT");
  }
  return chalk.dim(rollPosition);
}

function formatStatShort(statName, statValue) {
  const s = (statName || "").toLowerCase();
  let name = s;
  if (s.includes("crit")) name = "crit";
  else if (s.includes("armor")) name = "armor";
  else if (s.includes("dodge")) name = "dodge";
  else if (s.includes("preci")) name = "prec";
  return `+${statValue} ${name}`;
}

function printBanner() {
  drawBox("WarEra Equipment Reseller", "💰", 46);
}

/**
 * Print compact roll audit by slot and quality for --scan mode.
 */
function printScanReport(classifiedItems, statRanges, config) {
  console.log(`\n🪖 ${chalk.bold.white("Equipment Inventory Roll Audit (Read-Only)")}\n`);

  for (const slot of TARGET_SLOTS) {
    const icon = SLOT_ICONS[slot] || "•";
    const slotLabel = SLOT_LABELS[slot] || slot;
    console.log(`${icon}  ${chalk.bold.white(slotLabel)}`);

    for (const rarity of TARGET_RARITIES) {
      const range = statRanges[`${slot}_${rarity}`];
      const qName = range.qualityName;
      const inGroup = classifiedItems.filter(
        (i) => i.slot === slot && i.quality.toLowerCase() === qName.toLowerCase()
      );
      const perfCount = inGroup.filter((i) => i.isPerfectRoll).length;
      const sellCount = inGroup.filter((i) => i.decision === "SELL").length;
      const reviewCount = inGroup.filter((i) => i.decisionReason === "VERY LOW CONFIDENCE").length;
      const eqCount = inGroup.filter((i) => i.equipped).length;

      const rangeStr = slot === "weapon" && range.minAtk !== undefined
        ? `Atk [${range.minAtk}-${range.maxAtk}] Crit [${range.minCrit}-${range.maxCrit}]`
        : `+[${range.minPossibleStat}-${range.maxPossibleStat}]`;
      let parts = [
        `Range ${chalk.dim(rangeStr.padEnd(slot === "weapon" ? 30 : 9))}`,
        `Perfect: ${perfCount > 0 ? chalk.magenta.bold(perfCount) : chalk.dim(0)}`,
        `Sell: ${sellCount > 0 ? chalk.cyan.bold(sellCount) : chalk.dim(0)}`,
      ];
      if (reviewCount > 0) parts.push(`Review: ${chalk.yellow.bold(reviewCount)}`);
      if (eqCount > 0) parts.push(`Equipped: ${chalk.blue(eqCount)}`);

      console.log(`   ${visualPadEnd(formatQuality(qName), 8)} ${parts.join("   ")}`);
    }
    console.log();
  }

  const totalInScope = classifiedItems.length;
  const perfect = classifiedItems.filter((i) => i.isPerfectRoll).length;
  const sell = classifiedItems.filter((i) => i.decision === "SELL").length;
  console.log(`Total: ${chalk.bold(totalInScope)} in scope | ${chalk.green(`${perfect} perfect kept`)} | ${chalk.cyan(`${sell} sell candidates`)}`);

  if (config.verbose) {
    console.log(chalk.bold("\nDetailed Classified Items:"));
    console.log("─".repeat(70));
    console.log(chalk.bold("Slot      Quality  Roll Position  Stat Value   Possible Range  Decision"));
    console.log("─".repeat(70));
    for (const item of classifiedItems) {
      const color = item.decision === "SELL" ? chalk.cyan : chalk.green;
      const statStr = item.slot === "weapon" && item.attack !== undefined
        ? `+${item.attack}A/+${item.statValue}C`
        : `+${item.statValue} ${item.relevantStat}`;
      const rangeStr = item.slot === "weapon" && item.minAtk !== undefined
        ? `[${item.minAtk}-${item.maxAtk}]/[${item.minCrit}-${item.maxCrit}]`
        : `[${item.minPossibleStat}-${item.maxPossibleStat}]`;
      console.log(
        `${item.slot.padEnd(9)} ` +
        `${item.quality.padEnd(8)} ` +
        `${item.rollPosition.padEnd(14)} ` +
        `${statStr.padEnd(14)} ` +
        `${rangeStr.padEnd(15)} ` +
        color(`${item.decision} (${item.decisionReason})`)
      );
    }
    console.log("─".repeat(70));
  } else {
    console.log(chalk.dim("\nUse --verbose to list all individual items."));
  }
}

/**
 * Print full market price curves (Infra-Roll Median Pricing).
 */
function printPriceCurves(statRanges, marketBooks) {
  console.log(chalk.bold("\nMarket Price Curves (Infra-Roll Median Pricing):"));
  console.log("─".repeat(82));

  for (const slot of TARGET_SLOTS) {
    for (const rarity of TARGET_RARITIES) {
      const range = statRanges[`${slot}_${rarity}`];
      const offers = marketBooks[range.itemCode] || [];
      const curve = buildPriceCurve(offers, range.statName, range.minPossibleStat, range.maxPossibleStat);

      const curveSegments = [];
      for (let s = range.minPossibleStat; s <= range.maxPossibleStat; s++) {
        const pt = curve[s];
        if (pt.isProtected) {
          curveSegments.push(`+${s}: ${chalk.green("PROTECTED (MAX)")}`);
        } else if (pt.median !== null) {
          curveSegments.push(`+${s}: ${chalk.cyan(pt.median.toFixed(2))}`);
        } else {
          curveSegments.push(`+${s}: ${chalk.gray("no listings")}`);
        }
      }
      console.log(
        `${chalk.yellow((range.qualityName + " " + slot).padEnd(18))}: ${curveSegments.join(" | ")}`
      );
    }
  }
  console.log("─".repeat(82));
}

/**
 * Compute categorized hold reasons and counts for audit reporting.
 */
export function computeHoldReasonCounts({ items = [], summary = {}, skipped = [], myOffers = [], config = {} } = {}) {
  const scopeItems = items.filter((item) => {
    if (config.slotFilter && item.slot?.toLowerCase() !== config.slotFilter.toLowerCase()) return false;
    if (config.qualityFilter && item.quality?.toLowerCase() !== config.qualityFilter.toLowerCase()) return false;
    return true;
  });

  const hasFilter = Boolean(config.slotFilter || config.qualityFilter || config.itemIdFilter);
  const d = summary?.dispositions || {};

  const alreadyListedCount = hasFilter
    ? scopeItems.filter((i) => i.finalDisposition === "KEEP - ALREADY LISTED" || i.listed).length
    : (d["KEEP - ALREADY LISTED"] ?? scopeItems.filter((i) => i.finalDisposition === "KEEP - ALREADY LISTED" || i.listed).length);

  const floodHeldCount = skipped.filter(
    (s) => s.reason?.startsWith("FLOOD_LIMIT") || s.reason?.startsWith("DUPLICATE_ACTIVE_OFFER")
  ).length;

  const manualReviewCount = hasFilter
    ? scopeItems.filter((i) => i.finalDisposition === "KEEP - VERY LOW PRICE CONFIDENCE").length
    : (d["KEEP - VERY LOW PRICE CONFIDENCE"] ?? scopeItems.filter((i) => i.finalDisposition === "KEEP - VERY LOW PRICE CONFIDENCE").length);

  const perfectCount = hasFilter
    ? scopeItems.filter((i) => i.finalDisposition === "KEEP - PERFECT" || i.isPerfectRoll).length
    : (d["KEEP - PERFECT"] ?? scopeItems.filter((i) => i.finalDisposition === "KEEP - PERFECT" || i.isPerfectRoll).length);

  const equippedCount = hasFilter
    ? scopeItems.filter((i) => i.finalDisposition === "KEEP - EQUIPPED" || i.equipped).length
    : (d["KEEP - EQUIPPED"] ?? scopeItems.filter((i) => i.finalDisposition === "KEEP - EQUIPPED" || i.equipped).length);

  const priceConflictCount = skipped.filter(
    (s) => s.reason?.startsWith("MONOTONIC_PRICE_CONFLICT")
  ).length || (
    hasFilter
      ? scopeItems.filter((i) => i.finalDisposition === "SKIP - MONOTONIC PRICE CONFLICT").length
      : (d["SKIP - MONOTONIC PRICE CONFLICT"] ?? 0)
  );

  const damagedCount = hasFilter
    ? scopeItems.filter((i) => i.finalDisposition === "KEEP - DAMAGED" || (!i.tradable && !i.equipped && !i.isPerfectRoll)).length
    : (d["KEEP - DAMAGED"] ?? scopeItems.filter((i) => i.finalDisposition === "KEEP - DAMAGED").length);

  const noComparablesCount = hasFilter
    ? scopeItems.filter((i) => i.finalDisposition === "HELD - NO SAFE WEAPON COMPARABLES").length
    : (d["HELD - NO SAFE WEAPON COMPARABLES"] ?? scopeItems.filter((i) => i.finalDisposition === "HELD - NO SAFE WEAPON COMPARABLES").length);

  const insufficientStatCount = hasFilter
    ? scopeItems.filter((i) => i.finalDisposition === "HELD - INSUFFICIENT STAT COMPARABLES").length
    : (d["HELD - INSUFFICIENT STAT COMPARABLES"] ?? scopeItems.filter((i) => i.finalDisposition === "HELD - INSUFFICIENT STAT COMPARABLES").length);

  const activeOffersCount = (myOffers && Array.isArray(myOffers) && myOffers.length > 0)
    ? myOffers.length
    : alreadyListedCount;

  return {
    alreadyListedCount,
    floodHeldCount,
    manualReviewCount,
    perfectCount,
    equippedCount,
    priceConflictCount,
    damagedCount,
    noComparablesCount,
    insufficientStatCount,
    activeOffersCount,
  };
}

/**
 * Print compact explanation when zero listings can be created.
 */
export function printNothingToListReport({ items = [], summary = {}, skipped = [], myOffers = [], config = {} } = {}) {
  const counts = computeHoldReasonCounts({ items, summary, skipped, myOffers, config });

  drawBox("Nothing to List", "💤", 46);

  console.log("\nNo safe listings are currently available.\n");

  const categories = [
    { icon: "📋", label: "Already listed", count: counts.alreadyListedCount, color: chalk.yellow.bold },
    { icon: "🚦", label: "Flood guard held", count: counts.floodHeldCount, color: chalk.hex("#F97316").bold },
    { icon: "⚠", label: "Manual review", count: counts.manualReviewCount, color: chalk.yellow.bold },
    { icon: "⚔️", label: "No safe weapon comparables", count: counts.noComparablesCount, color: chalk.magenta.bold },
    { icon: "🛡️", label: "Insufficient stat evidence", count: counts.insufficientStatCount, color: chalk.magenta.bold },
    { icon: "💎", label: "Perfect protected", count: counts.perfectCount, color: chalk.green.bold },
    { icon: "🛡", label: "Equipped protected", count: counts.equippedCount, color: chalk.blue.bold },
    { icon: "⛔", label: "Price conflicts", count: counts.priceConflictCount, color: chalk.red.bold },
    { icon: "🔧", label: "Damaged (untradable)", count: counts.damagedCount, color: chalk.gray.bold },
  ];

  for (const cat of categories) {
    if (cat.count > 0) {
      console.log(`  ${cat.icon} ${chalk.white(cat.label.padEnd(20))} ${cat.color(String(cat.count).padStart(4))}`);
    }
  }

  if (counts.activeOffersCount > 0) {
    console.log(`\nActive market offers:        ${chalk.bold(counts.activeOffersCount)}`);
    console.log(chalk.dim("\nWaiting for existing offers to sell before adding more duplicates."));
  }

  if (counts.floodHeldCount > 0) {
    const itemWord = counts.floodHeldCount === 1 ? "item is" : "items are";
    console.log(chalk.cyan(`\nℹ ${counts.floodHeldCount} sellable ${itemWord} waiting behind active market offers.`));
  }

  if (counts.activeOffersCount > 0) {
    console.log(chalk.bold("\nNext action:"));
    console.log(chalk.white("Run again after some active offers sell.\n"));
  } else {
    console.log(chalk.bold("\nNext action:"));
    console.log(chalk.white("No sub-max equipment available to sell. All target items are kept.\n"));
  }
}

/**
 * Print compact inventory audit summary.
 */
function printAuditSummary(summary, items) {
  const d = summary.dispositions;

  console.log(`\n📦 ${chalk.bold.white("Inventory")}\n`);
  console.log(`  ${chalk.bold(summary.totalItems)} eligible-scope items\n`);

  if (summary.armor || summary.weapons) {
    console.log(`  ${chalk.bold("Armor:")}`);
    console.log(`    KEEP: ${chalk.green.bold(summary.armor?.keep ?? 0)}`);
    console.log(`    SELL: ${chalk.cyan.bold(summary.armor?.sell ?? 0)}`);
    console.log(`  ${chalk.bold("Weapons:")}`);
    console.log(`    KEEP: ${chalk.green.bold(summary.weapons?.keep ?? 0)}`);
    console.log(`    SELL: ${chalk.cyan.bold(summary.weapons?.sell ?? 0)}\n`);
  }

  console.log(`  💎 ${chalk.white("Perfect protected")}       ${chalk.green.bold(String(d["KEEP - PERFECT"]).padStart(3))}`);
  console.log(`  🛡 ${chalk.white("Equipped protected")}      ${chalk.blue.bold(String(d["KEEP - EQUIPPED"]).padStart(3))}`);
  if (d["KEEP - ALREADY LISTED"] > 0) {
    console.log(`  📋 ${chalk.white("Already listed")}          ${chalk.yellow.bold(String(d["KEEP - ALREADY LISTED"]).padStart(3))}`);
  }
  if (d["KEEP - DAMAGED"] > 0) {
    console.log(`  🔧 ${chalk.white("Damaged (untradable)")}  ${chalk.gray.bold(String(d["KEEP - DAMAGED"]).padStart(3))}`);
  }
  console.log(`  ⚠ ${chalk.white("Manual review")}            ${chalk.yellow.bold(String(d["KEEP - VERY LOW PRICE CONFIDENCE"]).padStart(3))}`);
  if (d["HELD - INSUFFICIENT STAT COMPARABLES"] > 0) {
    console.log(`  ⚠ ${chalk.white("Insufficient stat evidence")} ${chalk.magenta.bold(String(d["HELD - INSUFFICIENT STAT COMPARABLES"]).padStart(3))}`);
  }
  if (d["SKIP - MONOTONIC PRICE CONFLICT"] > 0) {
    console.log(`  ⚠ ${chalk.white("Monotonic conflict")}       ${chalk.yellow.bold(String(d["SKIP - MONOTONIC PRICE CONFLICT"]).padStart(3))}`);
  }
  console.log(`  💰 ${chalk.white("Ready to sell")}          ${chalk.cyan.bold(String(d["SELL - ELIGIBLE"]).padStart(3))}\n`);

  console.log(`  ${chalk.bold("Estimated sell value")}   ${chalk.cyan.bold(summary.totalSellCandidatesValue.toFixed(2))} Gold`);

  const sellItems = items.filter((i) => i.finalDisposition === "SELL - ELIGIBLE");
  if (sellItems.length > 0) {
    const qCounts = {
      Grey: sellItems.filter((i) => i.quality === "Grey").length,
      Green: sellItems.filter((i) => i.quality === "Green").length,
      Blue: sellItems.filter((i) => i.quality === "Blue").length,
    };
    const sCounts = {
      Helmet: sellItems.filter((i) => i.slot === "helmet").length,
      Chest: sellItems.filter((i) => i.slot === "chest").length,
      Gloves: sellItems.filter((i) => i.slot === "gloves").length,
      Pants: sellItems.filter((i) => i.slot === "pants").length,
      Boots: sellItems.filter((i) => i.slot === "boots").length,
      Weapon: sellItems.filter((i) => i.slot === "weapon").length,
    };

    console.log(`\n  ${chalk.dim("Breakdown:")}`);
    console.log(`    ${chalk.gray("Grey".padEnd(6))} ${String(qCounts.Grey).padStart(3)} sellable      ${chalk.dim("Helmet")}  ${String(sCounts.Helmet).padStart(3)}`);
    console.log(`    ${chalk.green("Green".padEnd(6))} ${String(qCounts.Green).padStart(3)} sellable      ${chalk.dim("Chest")}   ${String(sCounts.Chest).padStart(3)}`);
    console.log(`    ${chalk.blueBright("Blue".padEnd(6))} ${String(qCounts.Blue).padStart(3)} sellable      ${chalk.dim("Gloves")}  ${String(sCounts.Gloves).padStart(3)}`);
    console.log(`                              ${chalk.dim("Pants")}   ${String(sCounts.Pants).padStart(3)}`);
    console.log(`                              ${chalk.dim("Boots")}   ${String(sCounts.Boots).padStart(3)}`);
    if (sCounts.Weapon > 0) {
      console.log(`                              ${chalk.dim("Weapon")}  ${String(sCounts.Weapon).padStart(3)}`);
    }
  }
}

/**
 * Print detailed verbose accounting tables when --verbose is active.
 */
function printVerboseAuditDetails(summary, items) {
  const d = summary.dispositions;
  console.log(chalk.bold("\nMutually Exclusive Final Disposition Accounting:"));
  console.log(`  KEEP - PERFECT:                   ${chalk.green.bold(d["KEEP - PERFECT"])}`);
  console.log(`  KEEP - EQUIPPED:                  ${chalk.blue.bold(d["KEEP - EQUIPPED"])}`);
  console.log(`  KEEP - DAMAGED:                   ${chalk.gray.bold(d["KEEP - DAMAGED"])}`);
  console.log(`  KEEP - ALREADY LISTED:            ${chalk.yellow.bold(d["KEEP - ALREADY LISTED"])}`);
  console.log(`  KEEP - VERY LOW PRICE CONFIDENCE: ${chalk.magenta.bold(d["KEEP - VERY LOW PRICE CONFIDENCE"])}`);
  if (d["HELD - NO SAFE WEAPON COMPARABLES"] !== undefined && d["HELD - NO SAFE WEAPON COMPARABLES"] > 0) {
    console.log(`  HELD - NO SAFE WEAPON COMPARABLES: ${chalk.magenta.bold(d["HELD - NO SAFE WEAPON COMPARABLES"])}`);
  }
  if (d["HELD - INSUFFICIENT STAT COMPARABLES"] !== undefined && d["HELD - INSUFFICIENT STAT COMPARABLES"] > 0) {
    console.log(`  HELD - INSUFFICIENT STAT COMPARABLES: ${chalk.magenta.bold(d["HELD - INSUFFICIENT STAT COMPARABLES"])}`);
  }
  if (d["SKIP - MONOTONIC PRICE CONFLICT"] !== undefined && d["SKIP - MONOTONIC PRICE CONFLICT"] > 0) {
    console.log(`  SKIP - MONOTONIC PRICE CONFLICT:  ${chalk.yellow.bold(d["SKIP - MONOTONIC PRICE CONFLICT"])}`);
  }
  console.log(`  SELL - ELIGIBLE:                  ${chalk.redBright.bold(d["SELL - ELIGIBLE"])}`);
  console.log("  " + "─".repeat(38));
  console.log(
    `  Total In-Scope Items:             ${chalk.bold(summary.totalItems)}  ` +
    chalk.green.bold(`✓ (sum = ${summary.totalItems}, 100% accounted for)`)
  );

  console.log(chalk.bold("\nOverlapping Inventory Attributes:"));
  console.log(`  Total Perfect Max-Rolls Owned:    ${chalk.green(summary.overlapping.totalPerfectRollsOwned)}`);
  console.log(`  Perfect Items Currently Equipped:  ${chalk.cyan(summary.overlapping.perfectEquippedCount)}`);
  console.log(`  Total Equipped Items in Scope:     ${chalk.blue(summary.overlapping.totalEquippedCount)}`);

  console.log(chalk.bold("\nFinancial Valuation:"));
  console.log(`  Est. Total Inventory Value:       ${chalk.cyan.bold(summary.totalInventoryValue.toFixed(2))} WarEra Gold`);
  console.log(`  Est. Perfect Items Value:         ${chalk.green.bold(summary.totalPerfectRollsValue.toFixed(2))} WarEra Gold`);
  console.log(`  Est. Eligible Sell Candidates:    ${chalk.yellow.bold(summary.totalSellCandidatesValue.toFixed(2))} WarEra Gold`);

  console.log(chalk.bold("\nAll In-Scope Items (Detailed Breakdown):"));
  console.log(
    chalk.bold(
      "Item ID        Slot     Quality  Roll       Stat         Final Disposition                  Fair Val  List Price  Buyer Price  Conf"
    )
  );
  console.log("─".repeat(128));

  for (const item of items) {
    const p = item.pricing;
    const shortId = `#${item.itemId.slice(-6)}`;
    const statStr = `+${item.statValue} ${item.relevantStat.slice(0, 5)}`;
    const isSell = item.finalDisposition === "SELL - ELIGIBLE";

    const dispColor = isSell
      ? chalk.cyan
      : item.finalDisposition === "KEEP - VERY LOW PRICE CONFIDENCE"
      ? chalk.yellow
      : chalk.green;

    const fairValStr =
      p.robustFairValue !== null && p.robustFairValue !== undefined
        ? p.robustFairValue.toFixed(2)
        : "-";
    const listPriceStr =
      isSell && p.suggestedPrice !== null && p.suggestedPrice !== undefined
        ? p.suggestedPrice.toFixed(2)
        : "-";
    const buyerPriceStr =
      isSell && p.displayedBuyerPrice !== null && p.displayedBuyerPrice !== undefined
        ? (p.displayedBuyerPriceFormatted ?? p.displayedBuyerPrice.toFixed(3))
        : "-";

    console.log(
      `${shortId.padEnd(14)} ` +
      `${item.slot.padEnd(8)} ` +
      `${item.quality.padEnd(8)} ` +
      `${item.rollPosition.padEnd(10)} ` +
      `${statStr.padEnd(12)} ` +
      dispColor(`${item.finalDisposition.padEnd(34)} `) +
      `${fairValStr.padStart(8)}  ` +
      `${listPriceStr.padStart(10)}  ` +
      `${buyerPriceStr.padStart(11)}  ` +
      formatConf(p.confidence)
    );
  }
  console.log("─".repeat(128));
}

/**
 * Print the dry-run audit report.
 */
function printDryRunReport(auditResult, statRanges, config, activeTracker = null) {
  const { items, summary, marketBooks } = auditResult;

  if (config.verbose || config.showPriceCurves) {
    printPriceCurves(statRanges, marketBooks);
  }

  printAuditSummary(summary, items);

  if (config.verbose) {
    printVerboseAuditDetails(summary, items);
  }

  const { staged: sellCandidates, skipped: skippedCandidates } = prepareExecutionCandidates(
    items,
    config,
    activeTracker
  );

  if (config.itemIdFilter) {
    const target = sellCandidates.find((i) => i.itemId === config.itemIdFilter) || items.find((i) => i.itemId === config.itemIdFilter);
    if (target) {
      if (target.slot === "weapon") {
        console.log(chalk.bold.cyan("\n🎯 Targeted Weapon:"));
        console.log(`  ID:            ${chalk.bold(target.itemId)}`);
        console.log(formatWeaponInspection(target).split("\n").map((l) => `  ${l}`).join("\n"));
        console.log(`  Durability:    ${target.state}/100`);
        console.log(`  Disposition:   ${target.finalDisposition === "SELL - ELIGIBLE" ? chalk.green.bold(target.finalDisposition) : chalk.yellow.bold(target.finalDisposition)}`);
        if (target.pricing) {
          console.log(`  Confidence:    ${formatConf(target.pricing.confidence)}`);
          console.log(`  Fair Value:    ${chalk.cyan(target.pricing.robustFairValue?.toFixed(2))} Gold`);
          console.log(`  List Price:    ${chalk.yellow.bold(target.pricing.suggestedPrice?.toFixed(2))} Gold`);
          console.log(`  Buyer Price:   ${chalk.cyan(target.pricing.displayedBuyerPriceFormatted ?? target.pricing.displayedBuyerPrice)} Gold (${target.pricing.taxRate}% tax)`);
        }
      } else {
        console.log(chalk.bold.cyan("\n🎯 Targeted Armor:"));
        console.log(formatArmorDebugTrace(target));
      }
    }
  } else {
    // If weapons are discovered in inventory, print weapon inspection blocks
    const weaponItems = items.filter((i) => i.slot === "weapon");
    if (weaponItems.length > 0) {
      console.log(`\n⚔️  ${chalk.bold.white(`Weapon Inspection (${weaponItems.length} discovered)`)}\n`);
      for (const w of weaponItems) {
        console.log(formatWeaponInspection(w));
        if (w.decision === "SELL" && w.pricing?.suggestedPrice) {
          console.log(`Proposed Price: ${chalk.yellow.bold(w.pricing.suggestedPrice.toFixed(2))} Gold (Buyer: ${chalk.cyan(w.pricing.displayedBuyerPriceFormatted ?? w.pricing.displayedBuyerPrice)} Gold)`);
        }
        console.log();
      }
    }

    if (sellCandidates.length === 0) {
      printNothingToListReport({
        items,
        summary,
        skipped: skippedCandidates,
        config,
      });
      return;
    }

    console.log(chalk.bold.white("\n💰 Sell candidates\n"));
    console.log(
      chalk.bold("Item               Stat        Roll   Exact  Near   Price   Buyer   Conf")
    );
    console.log("─".repeat(70));

    const maxDisplay = config.verbose ? sellCandidates.length : 15;
    const toShow = sellCandidates.slice(0, maxDisplay);

    for (const c of toShow) {
      const p = c.pricing;
      const itemStr = visualPadEnd(getFullItemTitle(c), 18);
      const statStr = (c.slot === "weapon" && c.attack !== undefined)
        ? `+${c.attack}A/+${c.criticalChance}C`.padEnd(11)
        : `+${c.statValue}/+${c.maxPossibleStat}`.padEnd(11);
      const rollStr = `${c.rollPercent ?? 0}%`.padEnd(6);
      const exactStr = String(p.comparablesCount?.exact ?? 0).padStart(5);
      const nearStr = String(p.comparablesCount?.near ?? 0).padStart(5);
      const priceStr = chalk.yellow.bold(p.suggestedPrice.toFixed(2).padStart(7));
      const buyerStr = chalk.cyan((p.displayedBuyerPriceFormatted ?? p.displayedBuyerPrice).padStart(7));
      const confStr = formatConf(p.confidence);

      console.log(`${itemStr} ${statStr} ${rollStr} ${exactStr}  ${nearStr}  ${priceStr} ${buyerStr}   ${confStr}`);
    }
    console.log("─".repeat(70));

    if (!config.verbose && sellCandidates.length > maxDisplay) {
      const remaining = sellCandidates.length - maxDisplay;
      console.log(chalk.dim(`... +${remaining} more candidates\n`));
      console.log(chalk.dim("Use --verbose to show all items and market price curves."));
    }

    if (skippedCandidates.length > 0) {
      const floodCount = skippedCandidates.filter((s) => s.reason.startsWith("FLOOD_LIMIT")).length;
      const dupCount = skippedCandidates.filter((s) => s.reason.startsWith("DUPLICATE_ACTIVE_OFFER")).length;
      const conflictCount = skippedCandidates.filter((s) => s.reason.startsWith("MONOTONIC_PRICE_CONFLICT")).length;
      if (floodCount > 0) {
        console.log(chalk.dim(`  ℹ ${floodCount} item(s) held by market-flood guard (max ${config.maxSimultaneous} per roll)`));
      }
      if (dupCount > 0) {
        console.log(chalk.dim(`  ℹ ${dupCount} item(s) skipped because active listing exists (--duplicate-handling=skip)`));
      }
      if (conflictCount > 0) {
        console.log(chalk.yellow(`  ⚠ ${conflictCount} item(s) skipped due to monotonic price conflict`));
      }
    }

    const totalCandidateValue = sellCandidates.reduce((sum, c) => sum + (c.pricing?.suggestedPrice || 0), 0);
    console.log(`\n${chalk.bold(sellCandidates.length)} candidates | Estimated proceeds: ${chalk.cyan.bold(totalCandidateValue.toFixed(2))} Gold`);
  }

  const flags = [];
  if (config.itemIdFilter) flags.push(`--item-id=${config.itemIdFilter}`);
  if (config.slotFilter) flags.push(`--slot=${config.slotFilter}`);
  if (config.qualityFilter) flags.push(`--quality=${config.qualityFilter}`);
  flags.push(`--max-listings=${config.maxListings || 5}`);

  const execCmd = `npm run equipment-reseller -- --execute ${flags.join(" ")}`;

  console.log(
    chalk.dim(
      `\nTo execute staged live listings:\n  ${chalk.cyan(execCmd)}\n`
    )
  );
}

/**
 * Execute live market listings with staged limit, filtering, confirmation, and 17-point assertions.
 */
export async function executeLiveListings(
  auditResult,
  config,
  rawInventory = [],
  statRanges = {},
  myOffers = [],
  activeTracker = null,
  options = {}
) {
  const { items } = auditResult;
  const liveTracker = activeTracker || createActiveOffersTracker(myOffers, statRanges, config);
  resolveTargetCandidates(items, config, rawInventory, liveTracker);

  const { staged: allStaged, skipped } = prepareExecutionCandidates(items, config, liveTracker);
  const budget = config.maxListings;
  const stagedCandidates = allStaged.slice(0, budget);

  if (stagedCandidates.length === 0) {
    printNothingToListReport({
      items,
      summary: auditResult.summary,
      skipped,
      myOffers,
      config,
    });
    return {
      success: true,
      executed: 0,
      reason: "ZERO_EXECUTIONS",
    };
  }

  drawBox("Live Listing Plan", "🚀", 46);

  const totalEstProceeds = stagedCandidates.reduce(
    (sum, c) => sum + (c.pricing?.suggestedPrice || 0),
    0
  );

  console.log(`\n${chalk.bold(stagedCandidates.length)} listings`);
  console.log(`Expected proceeds: ${chalk.cyan.bold(totalEstProceeds.toFixed(2))} Gold\n`);

  if (config.itemIdFilter && stagedCandidates.length === 1) {
    const c = stagedCandidates[0];
    const p = c.pricing;
    console.log(`Requested Item ID: ${chalk.bold(config.itemIdFilter)}`);
    console.log(`Item:              ${getFullItemTitle(c)}`);
    if (c.slot === "weapon" && c.attack !== undefined) {
      console.log(`Roll:              +${c.attack} Atk / +${c.criticalChance}% Crit (${formatRoll(c.rollPosition, c.isPerfectRoll)})`);
    } else {
      console.log(`Roll:              +${c.statValue}/+${c.maxPossibleStat} ${c.relevantStat} (${formatRoll(c.rollPosition, c.isPerfectRoll)})`);
    }
    console.log(`Price:             ${chalk.yellow.bold(p.suggestedPrice.toFixed(2))} Gold (Buyer sees ${chalk.cyan(p.displayedBuyerPriceFormatted ?? p.displayedBuyerPrice)} Gold)`);
    console.log(`Confidence:        ${formatConf(p.confidence)}\n`);
  } else {
    console.log(
      chalk.bold("#   Item               Stat        Roll   Exact  Near   Price   Buyer   Conf")
    );
    console.log("─".repeat(74));

    for (let idx = 0; idx < stagedCandidates.length; idx++) {
      const c = stagedCandidates[idx];
      const p = c.pricing;
      const numStr = `${idx + 1}`.padEnd(3);
      const itemStr = visualPadEnd(getFullItemTitle(c), 18);
      const statStr = (c.slot === "weapon" && c.attack !== undefined)
        ? `+${c.attack}A/+${c.criticalChance}C`.padEnd(11)
        : `+${c.statValue}/+${c.maxPossibleStat}`.padEnd(11);
      const rollStr = `${c.rollPercent ?? 0}%`.padEnd(6);
      const exactStr = String(p.comparablesCount?.exact ?? 0).padStart(5);
      const nearStr = String(p.comparablesCount?.near ?? 0).padStart(5);
      const priceStr = chalk.yellow.bold(p.suggestedPrice.toFixed(2).padStart(7));
      const buyerStr = chalk.cyan((p.displayedBuyerPriceFormatted ?? p.displayedBuyerPrice).padStart(7));
      const confStr = formatConf(p.confidence);

      console.log(`${numStr} ${itemStr} ${statStr} ${rollStr} ${exactStr}  ${nearStr}  ${priceStr} ${buyerStr}   ${confStr}`);
    }
    console.log("─".repeat(74) + "\n");
  }

  // Confirmation prompt
  if (!config.yes) {
    let answer = "";
    if (typeof options.promptFn === "function") {
      answer = await options.promptFn();
    } else {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });

      answer = await new Promise((resolve) => {
        rl.question(
          chalk.bold.yellow("Type SELL to continue: "),
          resolve
        );
      });
      rl.close();
    }

    if (answer.trim() !== "SELL") {
      console.log(chalk.red("\n[ABORTED] Execution cancelled by user. Zero listings created.\n"));
      return { success: false, executed: 0, reason: "ABORTED_BY_USER" };
    }
  }

  console.log(chalk.bold.green("\nConfirmation accepted. Starting staged listing pipeline...\n"));

  let successCount = 0;
  let soldImmediatelyCount = 0;
  let skipCount = 0;
  let totalActualListedValue = 0;
  let totalRealizedProceeds = 0;
  let interrupted = false;
  const createdOffers = [];
  const consumedTxIds = new Set();

  const totalPlannedProceeds = stagedCandidates.reduce(
    (sum, c) => sum + (c.pricing?.suggestedPrice || 0),
    0
  );

  // Initialize execution-time monotonic state from pre-existing active offers
  const executionPriceState = new ExecutionPriceState(myOffers, statRanges);

  for (let idx = 0; idx < stagedCandidates.length; idx++) {
    const candidate = stagedCandidates[idx];
    const itemId = candidate.itemId;
    const { slot, quality, statValue, maxPossibleStat, relevantStat } = candidate;
    const itemTitle = candidate.slot === "weapon" && candidate.attack !== undefined
      ? `${getFullItemTitle(candidate)} +${candidate.attack}A/+${candidate.criticalChance}C`
      : `${getFullItemTitle(candidate)} +${statValue}`;
    const progressTag = `Listing ${idx + 1}/${stagedCandidates.length}`;

    // ─────────────────────────────────────────────────────────────
    // 17-POINT PRE-LISTING ASSERTION PIPELINE
    // ─────────────────────────────────────────────────────────────

    // 1. Refresh user inventory & live active offers
    const fetchInvFn = options.fetchUserInventoryStateFn || fetchUserInventoryState;
    const { inv, equipped, listedItemIds, myOffers: freshMyOffers } = await fetchInvFn();
    executionPriceState.addOffers(freshMyOffers, statRanges);

    // 2. Confirm item unique ID still exists
    const liveItem = (inv?.items?.equipments || []).find((i) => i._id === itemId)
      || (inv?.items?.weapons || []).find((i) => i._id === itemId);
    if (!liveItem) {
      console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
      console.error(chalk.yellow(`  Reason: Item ${itemId} no longer exists in inventory.\n`));
      skipCount++;
      break;
    }

    // 3. Confirm target slot
    const fetchCfgFn = options.fetchGameConfigFn || fetchGameConfig;
    const gameConfig = await fetchCfgFn();
    const liveItemCfg = gameConfig?.items?.[liveItem.code];
    const isWeapon = liveItemCfg?.type === "weapon" || liveItemCfg?.usage === "weapon";
    const liveSlot = isWeapon ? "weapon" : (liveItemCfg?.usage || liveItemCfg?.skinSlot);
    if (!TARGET_SLOTS.includes(liveSlot)) {
      console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
      console.error(chalk.yellow(`  Reason: Slot '${liveSlot}' is not in target slots.\n`));
      skipCount++;
      break;
    }

    // 4. Confirm quality is Grey/Green/Blue
    const liveRarity = liveItemCfg?.rarity;
    if (!TARGET_RARITIES.includes(liveRarity)) {
      console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
      console.error(chalk.yellow(`  Reason: Quality '${liveRarity}' is not in target qualities.\n`));
      skipCount++;
      break;
    }

    // 5. Confirm item is not equipped
    const isEquipped = Object.values(equipped || {}).some(
      (eq) => eq && typeof eq === "object" && eq._id === itemId
    );
    if (isEquipped) {
      console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
      console.error(chalk.yellow(`  Reason: Item is currently equipped.\n`));
      skipCount++;
      break;
    }

    // 6. Confirm item is tradable (state >= 100)
    const liveState = liveItem.state !== undefined ? liveItem.state : 100;
    if (liveState < 100) {
      console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
      console.error(chalk.yellow(`  Reason: Durability state ${liveState} < 100 (damaged / untradable).\n`));
      skipCount++;
      break;
    }

    // 7. Confirm item is not locked/bound
    // 8. Confirm item is not already listed
    if (listedItemIds.has(itemId)) {
      console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
      console.error(chalk.yellow(`  Reason: Item already has an active market listing.\n`));
      skipCount++;
      continue;
    }

    // 9. Refresh live gameConfig stat range
    const extractRangesFn = options.extractEquipmentRangesFn || extractEquipmentRanges;
    const liveRanges = extractRangesFn(gameConfig);
    const rangeKey = `${liveSlot}_${liveRarity}`;
    const liveRange = liveRanges[rangeKey];
    if (!liveRange) {
      console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
      console.error(chalk.yellow(`  Reason: Could not resolve stat range for ${rangeKey}.\n`));
      skipCount++;
      continue;
    }

    // 9b. Weapon dynamic stats validation (fail closed)
    if (liveSlot === "weapon") {
      const rawAtk = liveItem.skills?.attack;
      const rawCrit = liveItem.skills?.criticalChance;
      const atk = Number(rawAtk);
      const crit = Number(rawCrit);
      const minAtk = liveRange.minAtk ?? liveRange.dynamicStats?.attack?.[0];
      const maxAtk = liveRange.maxAtk ?? liveRange.dynamicStats?.attack?.[1];
      const minCrit = liveRange.minCrit ?? liveRange.dynamicStats?.criticalChance?.[0];
      const maxCrit = liveRange.maxCrit ?? liveRange.dynamicStats?.criticalChance?.[1];

      if (rawAtk === undefined || rawCrit === undefined || isNaN(atk) || isNaN(crit)) {
        console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
        console.error(chalk.yellow(`  Reason: Malformed weapon stats (missing attack or criticalChance).\n`));
        skipCount++;
        continue;
      }

      if (atk < minAtk || atk > maxAtk || crit < minCrit || crit > maxCrit) {
        console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
        console.error(chalk.yellow(`  Reason: Weapon stats outside live gameConfig range (Atk: ${atk} [${minAtk}-${maxAtk}], Crit: ${crit} [${minCrit}-${maxCrit}]).\n`));
        skipCount++;
        continue;
      }
    }

    // 10. Recalculate max possible roll
    const liveMax = liveRange.maxPossibleStat;
    const liveStatVal = Number(liveItem.skills?.[liveRange.statName]) || 0;

    // 11. CRITICAL SAFETY ASSERTION: statValue < maxPossibleStat
    if (liveStatVal >= liveMax) {
      console.error(
        chalk.bold.red(
          `\n⚠ [PERFECT ITEM BLOCKED] Item #${itemId.slice(-6)} has stat ${liveStatVal} >= maxPossible ${liveMax}! NEVER SELL A PERFECT ITEM. ABORTING LISTING.\n`
        )
      );
      skipCount++;
      continue;
    }

    // 12. Real-time active tracker guard (market-flood guard & duplicate skip)
    // Synchronize liveTracker from fresh live offers to detect if an earlier copy already sold!
    const currentTracker = createActiveOffersTracker(freshMyOffers || [], statRanges, config);
    const liveActiveOffers = currentTracker.getOffersForRoll(liveSlot, quality, liveStatVal);

    if (liveActiveOffers.length >= config.maxSimultaneous) {
      console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
      console.error(
        chalk.yellow(
          `  Reason: Market-flood guard (${liveActiveOffers.length}/${config.maxSimultaneous} active listings). Skipping to prevent flooding the market.\n`
        )
      );
      skipCount++;
      continue;
    }

    if (liveActiveOffers.length > 0 && config.duplicateHandling === "skip") {
      console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
      console.error(
        chalk.yellow(
          `  Reason: Active listing already exists at ${liveActiveOffers[0].price} Gold (--duplicate-handling=skip). Skipping until it sells.\n`
        )
      );
      skipCount++;
      continue;
    }

    // 13. Refresh market comparables
    const fetchOffersFn = options.fetchMarketOffersFn || fetchMarketOffers;
    const freshOffers = await fetchOffersFn(String(liveItem.code), { forceRefresh: true });

    // 14. Recalculate price with own-offer exclusion and active tracker
    // If an identical active own offer still exists: use exactly the same seller price.
    // If it has already sold: recalculate normally from fresh market data.
    const fetchTaxFn = options.fetchMarketTaxRateFn || fetchMarketTaxRate;
    const taxRate = await fetchTaxFn();
    const pricing = analyzeItemPricing(
      {
        itemId,
        code: liveItem.code,
        slot: liveSlot,
        quality,
        relevantStat: liveRange.statName,
        statValue: liveStatVal,
        minPossibleStat: liveRange.minPossibleStat,
        maxPossibleStat: liveMax,
        rollPosition: "",
        isPerfectRoll: false,
        decision: "SELL",
      },
      freshOffers,
      {
        pricingStrategy: config.pricingStrategy,
        maxUndercutPct: config.maxUndercutPct,
        taxRate,
        excludeUserId: resolveUserId(),
        activeOffersTracker: currentTracker,
        duplicateHandling: config.duplicateHandling,
        maxSimultaneous: config.maxSimultaneous,
      }
    );

    if (liveActiveOffers.length > 0 && config.duplicateHandling === "same-price") {
      pricing.suggestedPrice = Number(liveActiveOffers[0].price);
      pricing.enteredPrice = Number(liveActiveOffers[0].price);
      pricing.pricingReason = "MATCH_ACTIVE_OFFER";
    }

    // 14b. Enforce execution-time monotonic pricing against lower rolls & fair-value ceiling
    const monotonicResult = applyExecutionMonotonicFloor(
      { slot: liveSlot, quality, statValue: liveStatVal },
      pricing,
      executionPriceState,
      { taxRate }
    );

    if (monotonicResult.action === "SKIP") {
      console.error(chalk.bold.yellow(`\n⚠ [MONOTONIC PRICE CONFLICT] ${itemTitle}`));
      console.error(chalk.yellow(`  Reason: ${monotonicResult.reason}. Skipping listing.\n`));
      skipCount++;
      continue;
    }

    // 15. Absolute Price Floor & Finite Guards (Requirement 5)
    if (
      !Number.isFinite(pricing.suggestedPrice) ||
      isNaN(pricing.suggestedPrice) ||
      pricing.suggestedPrice <= 0
    ) {
      console.error(chalk.yellow(`\n⚠ Skipped ${itemTitle}`));
      console.error(chalk.yellow(`  Reason: Calculated price ${pricing.suggestedPrice} is invalid.\n`));
      skipCount++;
      break;
    }

    const minAllowedRatio = config.pricingStrategy === "quick" ? 0.90 : (1 - config.maxUndercutPct);
    const absoluteFloor = Number((pricing.robustFairValue * minAllowedRatio).toFixed(2));
    if (pricing.suggestedPrice < absoluteFloor) {
      console.error(chalk.bold.yellow(`\n⚠ [PRICE FLOOR REJECTED] ${itemTitle}`));
      console.error(chalk.yellow(`  Reason: Price ${pricing.suggestedPrice} violates floor ${absoluteFloor} (> ${(1 - minAllowedRatio) * 100}% below fair value).\n`));
      skipCount++;
      break;
    }

    // 16. Confirm pricing confidence meets threshold
    if (pricing.confidence === "VERY LOW") {
      console.error(chalk.bold.yellow(`\n⚠ [MARKET CONFIDENCE TOO LOW] ${itemTitle}`));
      console.error(chalk.yellow(`  Reason: Confidence is VERY LOW. Requires manual review.\n`));
      skipCount++;
      break;
    }

    // 17. Submit exactly one listing
    console.log(`🚀 ${progressTag}  ${itemTitle}...`);

    const submissionTime = Date.now();
    let createdOfferData = null;
    let mutationFailed = false;

    const submitFn = options.submitMarketListingFn || submitMarketListing;
    try {
      createdOfferData = await submitFn(itemId, pricing.enteredPrice);
    } catch (err) {
      mutationFailed = true;
      console.error(chalk.yellow(`  ⚠ Mutation error: ${err.message}`));
    }

    // 18. POST-LISTING STRICT VERIFICATION WITH BOUNDED POLLING & EVENTUAL CONSISTENCY
    const verifyFn = options.verifyListingWithBackoffFn || verifyListingWithBackoff;
    const verification = await verifyFn(itemId, pricing.enteredPrice, {
      userId: resolveUserId(),
      submissionTime,
      createdOfferId: createdOfferData?._id,
      itemCode: liveItem.code,
      statName: liveRange.statName,
      statValue: liveStatVal,
      mutationFailed,
      consumedTxIds,
    });

    if (verification.state === ListingVerificationState.VERIFIED_LISTED) {
      const offerId = verification.offer?._id || createdOfferData?._id;
      const idStr = (config.verbose || isDebug) && offerId ? chalk.dim(` (#${offerId.slice(-6)})`) : "";
      console.log(`  ${colors.success(icons.success)} Listed at ${chalk.cyan.bold(pricing.enteredPrice.toFixed(2))} Gold${idStr}\n`);
      successCount++;
      totalActualListedValue += pricing.enteredPrice;
      createdOffers.push({
        itemTitle,
        price: pricing.enteredPrice,
        offerId,
        status: "LISTED",
      });
      liveTracker.addOffer({
        offerId,
        itemId,
        slot: liveSlot,
        quality,
        statValue: liveStatVal,
        price: pricing.enteredPrice,
      });
      executionPriceState.recordPrice(liveSlot, quality, liveStatVal, pricing.enteredPrice);
    } else if (verification.state === ListingVerificationState.VERIFIED_SOLD) {
      const txId = verification.transaction?._id;
      const salePrice = verification.salePrice || pricing.enteredPrice;
      const idStr = (config.verbose || isDebug) && txId ? chalk.dim(` (Tx #${txId.slice(-6)})`) : "";
      console.log(`  ${colors.success(icons.success)} ${chalk.green.bold("✓ SOLD IMMEDIATELY")} at ${chalk.cyan.bold(salePrice.toFixed(2))} Gold${idStr}\n`);
      soldImmediatelyCount++;
      totalRealizedProceeds += salePrice;
      createdOffers.push({
        itemTitle,
        price: salePrice,
        offerId: txId,
        status: "SOLD",
      });
      // Preserve submitted/sold price in current batch state so later higher rolls cannot undercut it
      executionPriceState.recordPrice(liveSlot, quality, liveStatVal, salePrice);
    } else if (verification.state === ListingVerificationState.FAILED_NOT_LISTED) {
      console.error(chalk.bold.red(`\n${colors.error(icons.error)} [FAILED NOT LISTED] ${itemTitle}`));
      console.error(chalk.bold.red(`  Reason:  ${verification.reason}`));
      console.error(chalk.bold.red(`  Item remains safely in inventory. Stopping further execution.\n`));
      skipCount++;
      interrupted = true;
      break;
    } else {
      // UNKNOWN STATE
      console.error(chalk.bold.red(`\n${colors.error(icons.error)} [CRITICAL UNKNOWN STATE] Post-listing verification failed!`));
      console.error(chalk.bold.red(`  Item ID: ${itemId}`));
      console.error(chalk.bold.red(`  Reason:  ${verification.reason}`));
      console.error(chalk.bold.red(`  SAFETY INVARIANT: Never retry unconfirmed items. Halting batch execution immediately.\n`));
      skipCount++;
      interrupted = true;
      break;
    }

    const sleepFn = options.sleepFn || sleep;
    await sleepFn(1500);
  }

  // Final Summary Box
  if (interrupted) {
    drawBox("Resale Stopped Safely", "⚠", 46);
  } else {
    drawBox("Resale Complete", "✓", 46);
  }

  console.log(`\nListed on market:    ${chalk.green.bold(successCount)}`);
  if (soldImmediatelyCount > 0) {
    console.log(`Sold immediately:    ${chalk.green.bold(soldImmediatelyCount)}`);
  }
  console.log(`Skipped / halted:    ${skipCount > 0 ? chalk.yellow.bold(skipCount) : chalk.dim(0)}`);
  console.log(`Planned proceeds:    ${chalk.cyan.bold(totalPlannedProceeds.toFixed(2))} Gold`);
  console.log(`Actual listed value: ${chalk.cyan.bold(totalActualListedValue.toFixed(2))} Gold`);
  if (soldImmediatelyCount > 0) {
    console.log(`Realized proceeds:   ${chalk.green.bold(totalRealizedProceeds.toFixed(2))} Gold`);
  }
  const totalCombined = totalActualListedValue + totalRealizedProceeds;
  if (totalCombined > 0) {
    console.log(`Total value:         ${chalk.cyan.bold(totalCombined.toFixed(2))} Gold`);
  }
  console.log();

  if (createdOffers.length > 0) {
    console.log(chalk.bold("Activity:"));
    for (const o of createdOffers) {
      const idStr = (config.verbose || isDebug) && o.offerId ? chalk.dim(` (#${o.offerId.slice(-6)})`) : "";
      const statusLabel = o.status === "SOLD" ? chalk.green("[SOLD]") : chalk.cyan("[LISTED]");
      console.log(`  ${colors.success(icons.success)} ${statusLabel} ${o.itemTitle.padEnd(22)} ${chalk.cyan.bold(o.price.toFixed(2))} Gold${idStr}`);
    }
    console.log();
  }

  return {
    success: !interrupted,
    executed: successCount + soldImmediatelyCount,
    successCount,
    soldImmediatelyCount,
    skipCount,
    totalPlannedProceeds,
    totalActualListedValue,
    totalRealizedProceeds,
    createdOffers,
  };
}

/**
 * Main Runner
 */
async function main() {
  const config = parseArgs();

  printBanner();

  const sp = ui.spinner("Loading inventory & market...");
  const gameConfig = await fetchGameConfig();
  const statRanges = extractEquipmentRanges(gameConfig);
  const taxRate = await fetchMarketTaxRate();

  const { inv, equipped, listedItemIds, myOffers } = await fetchUserInventoryState();
  const seenIds = new Set();
  const inventoryEquipments = [];
  const allInv = [
    ...(inv?.items?.equipments || []),
    ...(inv?.items?.weapons || []),
    ...myOffers.map((o) => o.item).filter(Boolean),
  ];
  for (const eq of allInv) {
    if (eq && eq._id && !seenIds.has(eq._id)) {
      seenIds.add(eq._id);
      inventoryEquipments.push(eq);
    }
  }

  const classifiedItems = classifyInventoryItems(
    inventoryEquipments,
    equipped,
    listedItemIds,
    statRanges,
    gameConfig
  );

  if (config.mode === "scan") {
    sp.succeed("Inventory scanned");
    printScanReport(classifiedItems, statRanges, config);
    return;
  }

  sp.text("Analyzing live market offers & pricing curves...");
  const auditResult = await performInventoryAudit(classifiedItems, {
    pricingStrategy: config.pricingStrategy,
    maxUndercutPct: config.maxUndercutPct,
    taxRate,
    excludeUserId: resolveUserId(),
  });

  const activeTracker = createActiveOffersTracker(myOffers, statRanges, config);

  const { staged: allStaged, skipped } = prepareExecutionCandidates(auditResult.items, config, activeTracker);
  const totalScanned = classifiedItems.length;
  const currentlyExecutableCount = allStaged.length;
  const temporarilyHeldCount = skipped.length;
  const subMaxCandidatesCount = currentlyExecutableCount + temporarilyHeldCount;

  sp.succeed("Inventory & market loaded");
  console.log(`  ${colors.success(icons.success)} ${totalScanned} items scanned`);
  console.log(`  ${colors.success(icons.success)} ${subMaxCandidatesCount} sub-max sell candidates found`);
  console.log(`  ${colors.success(icons.success)} ${currentlyExecutableCount} currently executable`);
  console.log(`  ${colors.success(icons.success)} ${temporarilyHeldCount} temporarily held`);
  console.log(`  ${colors.success(icons.success)} Senegal tax: ${taxRate}%`);

  // If item-id is specified, validate it against target candidates
  if (config.itemIdFilter) {
    resolveTargetCandidates(auditResult.items, config, inventoryEquipments, activeTracker);
  }

  if (currentlyExecutableCount === 0) {
    printNothingToListReport({
      items: auditResult.items,
      summary: auditResult.summary,
      skipped,
      myOffers,
      config,
    });
    return;
  }

  if (config.mode === "execute") {
    if (config.verbose) {
      printDryRunReport(auditResult, statRanges, config, activeTracker);
    }
    await executeLiveListings(auditResult, config, inventoryEquipments, statRanges, myOffers, activeTracker);
  } else {
    printDryRunReport(auditResult, statRanges, config, activeTracker);
  }
}

const isDirectExecution =
  process.argv[1] &&
  (path.basename(process.argv[1]) === "equipment_reseller.mjs" ||
    path.resolve(process.argv[1]) === fileURLToPath(import.meta.url));

if (isDirectExecution) {
  main().catch((err) => {
    console.error(chalk.red.bold("\nFatal error:"), err.message || err);
    if (/401|unauthorized/i.test(err.message || "")) {
      console.error(
        chalk.yellow(
          "\nℹ Your WarEra session token in cookies.json has expired or is unauthorized.\n" +
          "  Tip: Run 'npm run login' to launch the browser and refresh your session cookies,\n" +
          "       or run 'npm run login:status' to inspect your stored session.\n"
        )
      );
    }
    process.exit(1);
  });
}
