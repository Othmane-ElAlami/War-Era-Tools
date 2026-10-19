/**
 * Market Pricing & Comparable Solver Module
 *
 * Implements:
 * 1. Live market offer retrieval & cursor pagination.
 * 2. Hierarchical comparables (EXACT, NEAR, SECONDARY).
 * 3. Outlier protection (IQR and 20% discount bounds).
 * 4. Pricing strategies: competitive (default), median, quick.
 * 5. Confidence scoring (HIGH, MODERATE, LOW, VERY LOW).
 * 6. Country market tax calculations.
 * 7. Complete inventory valuation audit.
 */

import { fetchWithRetry, getCookieHeader } from "./api.mjs";
import { median, percentile } from "./statistics.mjs";
import { calculateRollPosition } from "./equipment_rolls.mjs";

const DEFAULT_HEADERS = {
  "content-type": "application/json",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0",
};

const API_BASE = "https://api6.warera.io/trpc";

// In-memory cache for market books during a session
const marketCache = new Map();

/**
 * Fetch market offers for a specific equipment code.
 * Paginates using cursor until maxPages or end of listings.
 */
export async function fetchMarketOffers(itemCode, options = {}) {
  const { maxPages = 5, forceRefresh = false } = options;

  if (!forceRefresh && marketCache.has(itemCode)) {
    return marketCache.get(itemCode);
  }

  const cookieHeader = getCookieHeader();
  const allOffers = [];
  let cursor = undefined;

  for (let p = 0; p < maxPages; p++) {
    const body = {
      itemCode,
      limit: 50,
      direction: "forward",
      ...(cursor ? { cursor } : {}),
    };

    const res = await fetchWithRetry(`${API_BASE}/itemOffer.getItemOffers?batch=1`, {
      method: "POST",
      headers: {
        ...DEFAULT_HEADERS,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({ "0": body }),
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch offers for ${itemCode} (HTTP ${res.status}): ${await res.text()}`);
    }

    const json = await res.json();
    const pageData = json[0]?.result?.data;
    const items = pageData?.items || [];
    allOffers.push(...items);

    cursor = pageData?.nextCursor;
    if (!cursor || items.length === 0) break;
  }

  marketCache.set(itemCode, allOffers);
  return allOffers;
}

/**
 * Fetch country market tax rate.
 */
export async function fetchMarketTaxRate() {
  try {
    const cookieHeader = getCookieHeader();
    const res = await fetchWithRetry(`${API_BASE}/country.getMyCountry?batch=1`, {
      method: "POST",
      headers: {
        ...DEFAULT_HEADERS,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({ "0": {} }),
    });
    if (res.ok) {
      const json = await res.json();
      const country = json[0]?.result?.data;
      if (country?.taxes?.market !== undefined) {
        return Number(country.taxes.market);
      }
    }
  } catch {
    // Fallback to default 1% if network fails
  }
  return 1;
}

/**
 * Identify outlier prices using robust statistics (median & IQR).
 * Also flags prices that are > 20% below the median fair value.
 */
export function filterOutliers(prices) {
  if (!prices || prices.length === 0) {
    return { legitimate: [], outliers: [], medianPrice: 0 };
  }
  if (prices.length <= 2) {
    return { legitimate: [...prices], outliers: [], medianPrice: median(prices) };
  }

  const sorted = [...prices].sort((a, b) => a - b);
  const med = median(sorted);
  const q1 = percentile(sorted, 25);
  const q3 = percentile(sorted, 75);
  const iqr = q3 - q1;

  // Lower bound: minimum of (Q1 - 1.5 * IQR) and (0.80 * median)
  const lowerBoundIQR = q1 - 1.5 * iqr;
  const lowerBound20Pct = med * 0.8;
  const lowerThreshold = Math.max(0.01, Math.max(lowerBoundIQR, lowerBound20Pct));

  const legitimate = [];
  const outliers = [];

  for (const p of sorted) {
    if (p < lowerThreshold) {
      outliers.push(p);
    } else {
      legitimate.push(p);
    }
  }

  // Safety fallback: if all were considered outliers (e.g. tight cluster with 1 low price), keep non-empty
  if (legitimate.length === 0) {
    return { legitimate: sorted, outliers: [], medianPrice: med };
  }

  return { legitimate, outliers, medianPrice: median(legitimate) };
}

export const KNOWN_WEAPON_CODES = new Set(["knife", "gun", "rifle"]);

export function isWeaponComparable(offerOrItem) {
  if (!offerOrItem) return false;
  const code = offerOrItem.code || offerOrItem.itemCode || offerOrItem.item?.code || offerOrItem.item?.itemCode;
  if (code && KNOWN_WEAPON_CODES.has(code)) return true;
  const type = offerOrItem.type || offerOrItem.usage || offerOrItem.slot || offerOrItem.item?.type || offerOrItem.item?.usage || offerOrItem.item?.slot;
  if (type === "weapon") return true;
  const skills = offerOrItem.item?.skills || offerOrItem.skills;
  if (skills && (skills.criticalChance !== undefined || skills.attack !== undefined)) {
    if (!skills.armor && !skills.defense && !skills.dodge && !skills.precision && !skills.critDamage) {
      return true;
    }
  }
  return false;
}

/**
 * Gather market comparables according to strict hierarchy:
 * 1. EXACT (same slot, quality, stat)
 * 2. NEAR (stat ± 1)
 * 3. SECONDARY (stat ± 2 or ± 3)
 *
 * Strictly enforces:
 * - Weapon offers NEVER mix with armor offers.
 * - Armor offers NEVER mix with weapon offers.
 * - Different weapon itemCodes NEVER mix with each other (e.g. knife != gun != rifle).
 */
export function gatherComparables(offers, statName, targetStatValue, options = {}) {
  const { excludeUserId, excludeOfferIds, targetItem, expectedItemCode, slot } = options;
  const exact = [];
  const near = [];
  const secondary = [];

  const targetCode = expectedItemCode || targetItem?.code || targetItem?.itemCode;
  const targetSlot = slot || targetItem?.slot || targetItem?.usage;
  const targetIsWeapon =
    targetItem?.slot === "weapon" ||
    targetItem?.category === "weapon" ||
    (targetCode && KNOWN_WEAPON_CODES.has(targetCode));

  for (const offer of offers) {
    // Exclude own offers from competitor comparables
    if (excludeUserId) {
      const offerUserId = typeof offer.user === "object" ? offer.user?._id : offer.user;
      if (offerUserId && offerUserId === excludeUserId) continue;
    }
    if (excludeOfferIds && (excludeOfferIds.has(offer._id) || excludeOfferIds.has(offer.offerId))) {
      continue;
    }

    const offerCode = offer.itemCode || offer.item?.code;
    const offerIsWeapon = isWeaponComparable(offer);

    // CATEGORY ISOLATION ASSERTION & FILTER
    if (targetIsWeapon !== undefined) {
      // Weapon candidates must NEVER use armor comparables
      if (targetIsWeapon && !offerIsWeapon) continue;
      // Armor candidates must NEVER use weapon comparables
      if (!targetIsWeapon && offerIsWeapon) continue;
    }

    // ITEMCODE ISOLATION FILTER (Knife != Gun != Rifle, Helmet != Chest != Pants)
    if (targetCode && offerCode && offerCode !== targetCode) {
      continue;
    }

    // SLOT ISOLATION FILTER (Chest != Pants, Helmet != Gloves)
    const offerSlot = offer.slot || offer.item?.slot || offer.item?.usage || offer.item?.skinSlot;
    if (targetSlot && offerSlot && targetSlot.toLowerCase() !== offerSlot.toLowerCase()) {
      continue;
    }

    const val = Number(offer.item?.skills?.[statName]);
    if (val === undefined || isNaN(val)) continue;

    const diff = Math.abs(val - targetStatValue);
    const price = Number(offer.price);
    if (!price || isNaN(price) || price <= 0) continue;

    const compRecord = {
      offerId: offer._id,
      itemId: offer.itemId || offer.item?._id,
      itemCode: offerCode,
      category: offerIsWeapon ? "weapon" : (offer.item?.usage || offer.item?.type || "armor"),
      price,
      statValue: val,
      attack: offer.item?.skills?.attack,
      criticalChance: offer.item?.skills?.criticalChance,
      diff,
      state: offer.item?.state ?? 100,
      user: offer.user,
    };

    if (diff === 0) {
      exact.push(compRecord);
    } else if (diff === 1) {
      near.push(compRecord);
    } else if (diff <= 3) {
      secondary.push(compRecord);
    }
  }

  return { exact, near, secondary };
}

/**
 * Score price confidence based on available market evidence:
 * HIGH: >= 5 exact comparables
 * MODERATE: 2-4 exact comparables OR >= 5 near-stat comparables
 * LOW: sparse (<2 exact and <5 near)
 * VERY LOW: 0 exact and <2 near (insufficient market data)
 */
export function calculateConfidence(exactCount, nearCount, secondaryCount) {
  if (exactCount >= 5) {
    return "HIGH";
  }
  if (exactCount >= 2 || nearCount >= 5) {
    return "MODERATE";
  }
  if (exactCount >= 1 || nearCount >= 2 || secondaryCount >= 5) {
    return "LOW";
  }
  return "VERY LOW";
}

/**
 * Build the market price curve for a slot + quality combination.
 */
/**
 * Build the market price curve for a slot + quality combination.
 */
export function buildPriceCurve(offers, statName, minPossible, maxPossible, options = {}) {
  const { excludeUserId, excludeOfferIds } = options;
  const curve = {};

  for (let stat = minPossible; stat <= maxPossible; stat++) {
    const matching = offers.filter((o) => {
      if (excludeUserId) {
        const uid = typeof o.user === "object" ? o.user?._id : o.user;
        if (uid && uid === excludeUserId) return false;
      }
      if (excludeOfferIds && (excludeOfferIds.has(o._id) || excludeOfferIds.has(o.offerId))) {
        return false;
      }
      return Number(o.item?.skills?.[statName]) === stat;
    });
    const prices = matching.map((o) => Number(o.price)).filter((p) => p > 0);

    if (prices.length === 0) {
      curve[stat] = {
        stat,
        count: 0,
        min: null,
        median: null,
        max: null,
        isProtected: stat === maxPossible,
      };
      continue;
    }

    const { legitimate } = filterOutliers(prices);
    const sorted = [...legitimate].sort((a, b) => a - b);

    curve[stat] = {
      stat,
      count: prices.length,
      min: sorted[0],
      median: median(sorted),
      max: sorted[sorted.length - 1],
      isProtected: stat === maxPossible,
    };
  }

  return curve;
}

/**
 * Build a discrete market price curve by stat roll for a specific armor itemCode.
 */
export function buildArmorStatCurve(offers, itemCode, slot, statName, minPossible, maxPossible, options = {}) {
  const { excludeUserId, excludeOfferIds } = options;
  const curve = {};

  for (let s = minPossible; s <= maxPossible; s++) {
    curve[s] = {
      statValue: s,
      allOffers: [],
      rawPrices: [],
      legitimatePrices: [],
      outliers: [],
      median: null,
      cheapest: null,
      count: 0,
      isProtected: s === maxPossible,
    };
  }

  for (const offer of offers || []) {
    if (excludeUserId) {
      const uid = typeof offer.user === "object" ? offer.user?._id : offer.user;
      if (uid && uid === excludeUserId) continue;
    }
    if (excludeOfferIds && (excludeOfferIds.has(offer._id) || excludeOfferIds.has(offer.offerId))) {
      continue;
    }

    if (isWeaponComparable(offer)) continue;

    const offerCode = offer.itemCode || offer.item?.code || offer.code;
    if (itemCode && offerCode && offerCode !== itemCode) continue;

    const offerSlot = offer.slot || offer.item?.usage || offer.item?.slot || offer.item?.skinSlot || offer.usage || offer.type;
    if (slot && offerSlot && offerSlot.toLowerCase() !== slot.toLowerCase()) continue;

    const state = offer.item?.state ?? offer.state ?? 100;
    if (state < 100) continue;

    const price = Number(offer.price);
    if (!price || isNaN(price) || price <= 0) continue;

    let val = Number(offer.item?.skills?.[statName] ?? offer.skills?.[statName]);
    if (val === undefined || isNaN(val)) {
      const skills = offer.item?.skills || offer.skills;
      if (skills && typeof skills === "object") {
        const firstVal = Object.values(skills)[0];
        if (firstVal !== undefined && !isNaN(Number(firstVal))) {
          val = Number(firstVal);
        }
      }
    }
    if (val === undefined || isNaN(val)) continue;

    if (curve[val]) {
      curve[val].allOffers.push(offer);
      curve[val].rawPrices.push(price);
    }
  }

  for (let s = minPossible; s <= maxPossible; s++) {
    const bucket = curve[s];
    if (bucket.rawPrices.length > 0) {
      const { legitimate, outliers, medianPrice } = filterOutliers(bucket.rawPrices);
      const sortedLegit = [...legitimate].sort((a, b) => a - b);
      bucket.legitimatePrices = sortedLegit;
      bucket.outliers = outliers;
      bucket.median = sortedLegit.length > 0 ? medianPrice : null;
      bucket.cheapest = sortedLegit.length > 0 ? sortedLegit[0] : null;
      bucket.count = sortedLegit.length;
    }
  }

  return curve;
}

/**
 * Stat-aware pricing analysis for Armor items (Helmet, Chest, Gloves, Pants, Boots).
 */
export function analyzeArmorPricing(item, offers, options = {}) {
  const {
    pricingStrategy = "competitive",
    maxUndercutPct = 0.05,
    taxRate = 1,
    excludeUserId,
    excludeOfferIds,
    activeOffersTracker,
    activeRollOffers: explicitActiveOffers,
    duplicateHandling = "same-price",
    maxSimultaneous = 3,
    minPriceConstraint = null,
  } = options;

  const { slot, code, quality } = item;
  const statName =
    item.relevantStat ||
    (slot === "helmet"
      ? "critDamage"
      : slot === "gloves"
      ? "precision"
      : slot === "boots"
      ? "dodge"
      : "armor");

  const statValue = Number(item.statValue);
  const minPossibleStat = Number(item.minPossibleStat ?? item.statMin ?? 0);
  const maxPossibleStat = Number(item.maxPossibleStat ?? item.statMax ?? 0);
  const statMin = minPossibleStat;
  const statMax = maxPossibleStat;
  const statQuality =
    statMax > statMin ? (statValue - statMin) / (statMax - statMin) : 0;
  const rollPosition =
    item.rollPosition || calculateRollPosition(statValue, statMin, statMax).label;
  const rollPercent =
    item.rollPercent !== undefined
      ? item.rollPercent
      : Math.round(statQuality * 100);

  // Active listings & flood limit checks
  let activeRollOffers = explicitActiveOffers;
  if (!activeRollOffers && activeOffersTracker) {
    activeRollOffers = activeOffersTracker.getOffersForRoll(slot, quality, statValue);
  }
  activeRollOffers = activeRollOffers || [];

  const activeCount = activeRollOffers.length;
  const effectiveFloodLimit = activeOffersTracker?.maxSimultaneous || maxSimultaneous;
  const effectiveDupHandling = activeOffersTracker?.duplicateHandling || duplicateHandling;

  const isFloodBlocked = activeCount >= effectiveFloodLimit;
  const isDuplicateSkipped =
    !isFloodBlocked && activeCount > 0 && effectiveDupHandling === "skip";

  // Build full market price curve by roll for this exact armor itemCode
  const curve = buildArmorStatCurve(
    offers,
    code,
    slot,
    statName,
    minPossibleStat,
    maxPossibleStat,
    { excludeUserId, excludeOfferIds }
  );

  const exactBucket = curve[statValue];
  const exactLegitPrices = exactBucket?.legitimatePrices || [];
  const exactOutliers = exactBucket?.outliers || [];

  // Near comparables (stat ± 1)
  let nearLegitPrices = [];
  let nearOutliers = [];
  for (const delta of [-1, 1]) {
    const b = curve[statValue + delta];
    if (b) {
      nearLegitPrices.push(...b.legitimatePrices);
      nearOutliers.push(...b.outliers);
    }
  }

  // Secondary comparables (stat ± 2 or ± 3)
  let secondaryLegitPrices = [];
  for (const delta of [-3, -2, 2, 3]) {
    const b = curve[statValue + delta];
    if (b) {
      secondaryLegitPrices.push(...b.legitimatePrices);
    }
  }

  let robustFairValue = null;
  let confidence = "VERY LOW";
  let pricingReason = "UNKNOWN";
  let usedPrices = [];
  let rejectedOutliers = [...exactOutliers];

  // If active own offer exists and duplicateHandling === 'same-price', pin immediately
  if (activeCount > 0 && effectiveDupHandling === "same-price") {
    robustFairValue = Number(activeRollOffers[0].price);
    confidence = "HIGH";
    pricingReason = "MATCH_ACTIVE_OFFER";
    usedPrices = [robustFairValue];
  } else if (exactLegitPrices.length > 0) {
    // 1. EXACT STAT VALUE FIRST (Priority 1)
    usedPrices = [...exactLegitPrices];
    const exactMedian = exactBucket.median;

    // Requirement 9: Monotonic floor from lower rolls
    let maxLowerMedian = null;
    for (let s = minPossibleStat; s < statValue; s++) {
      const b = curve[s];
      if (b && b.count > 0 && b.median !== null) {
        if (maxLowerMedian === null || b.median > maxLowerMedian) {
          maxLowerMedian = b.median;
        }
      }
    }

    if (maxLowerMedian !== null && maxLowerMedian > exactMedian) {
      robustFairValue = maxLowerMedian;
      pricingReason = "EXACT_STAT_LOWER_ROLL_FLOOR";
    } else {
      robustFairValue = exactMedian;
      pricingReason = "EXACT_STAT_MARKET";
    }

    // Confidence: multiple exact => HIGH, 1 exact + near => MOD, 1 exact => LOW
    if (exactLegitPrices.length >= 2) {
      confidence = "HIGH";
    } else if (nearLegitPrices.length >= 2) {
      confidence = "MOD";
    } else {
      confidence = "LOW";
    }
  } else {
    // 2. NEARBY STAT FALLBACK (Priority 2, 3, 4)
    let nearestLower = null;
    let nearestHigher = null;

    for (let s = statValue - 1; s >= minPossibleStat; s--) {
      if (curve[s] && curve[s].count > 0) {
        nearestLower = curve[s];
        break;
      }
    }

    for (let s = statValue + 1; s <= maxPossibleStat; s++) {
      if (curve[s] && curve[s].count > 0) {
        nearestHigher = curve[s];
        break;
      }
    }

    if (nearestLower && nearestHigher) {
      const lowerStat = nearestLower.statValue;
      const higherStat = nearestHigher.statValue;
      const lowerMed = nearestLower.median;
      const higherMed = nearestHigher.median;

      usedPrices = [...nearestLower.legitimatePrices, ...nearestHigher.legitimatePrices];

      if (higherMed >= lowerMed) {
        const fraction = (statValue - lowerStat) / (higherStat - lowerStat);
        robustFairValue = lowerMed + fraction * (higherMed - lowerMed);
      } else {
        robustFairValue = lowerMed;
      }
      pricingReason = "NEARBY_STAT_INTERPOLATION";
      confidence = "MOD";
    } else if (nearestLower && statValue - nearestLower.statValue <= 2) {
      usedPrices = [...nearestLower.legitimatePrices];
      robustFairValue = nearestLower.median;
      pricingReason = "NEAREST_LOWER_STAT";
      confidence = nearestLower.count >= 2 ? "MOD" : "LOW";
    } else if (nearestHigher && nearestHigher.statValue - statValue <= 2) {
      usedPrices = [...nearestHigher.legitimatePrices];
      robustFairValue = nearestHigher.median;
      pricingReason = "NEAREST_HIGHER_STAT";
      confidence = "LOW";
    } else if (nearestLower && statValue - nearestLower.statValue <= 3) {
      usedPrices = [...nearestLower.legitimatePrices];
      robustFairValue = nearestLower.median;
      pricingReason = "WIDER_STAT_CURVE";
      confidence = "LOW";
    } else {
      robustFairValue = null;
      confidence = "VERY LOW";
      pricingReason = "INSUFFICIENT_STAT_COMPARABLES";
    }
  }

  const hasSafeComparables = robustFairValue !== null && confidence !== "VERY LOW";

  // FAIL CLOSED: If insufficient safe same-item stat evidence
  if (!hasSafeComparables) {
    return {
      itemId: item.itemId,
      code,
      slot,
      quality,
      statName,
      statValue,
      minPossibleStat,
      maxPossibleStat,
      statMin,
      statMax,
      statQuality,
      rollPosition,
      rollPercent,
      isPerfectRoll: item.isPerfectRoll,
      confidence: "VERY LOW",
      hasSafeComparables: false,
      comparablesCount: {
        exact: exactLegitPrices.length,
        near: nearLegitPrices.length,
        secondary: secondaryLegitPrices.length,
        outliersExcluded: exactOutliers.length + nearOutliers.length,
      },
      robustFairValue: null,
      pricingStrategy,
      suggestedPrice: null,
      taxRate,
      enteredPrice: null,
      displayedBuyerPrice: null,
      displayedBuyerPriceFormatted: "-",
      taxAmount: null,
      expectedSellerProceeds: null,
      requiresManualReview: true,
      isFloodBlocked,
      isDuplicateSkipped,
      activeOffersCount: activeCount,
      floodLimit: effectiveFloodLimit,
      duplicateHandling: effectiveDupHandling,
      pricingReason: "INSUFFICIENT_STAT_COMPARABLES",
      skipReason: isFloodBlocked
        ? `FLOOD_LIMIT (${activeCount}/${effectiveFloodLimit} active listings)`
        : isDuplicateSkipped
        ? `ACTIVE_OFFER_EXISTS (${activeCount} active at ${activeRollOffers[0]?.price} Gold)`
        : "INSUFFICIENT_STAT_COMPARABLES",
      debugTrace: {
        exactComps: exactLegitPrices.length,
        nearComps: nearLegitPrices.length,
        pricesUsed: usedPrices,
        rejectedOutliers: rejectedOutliers,
        competitiveTarget: null,
        robustFairValue: null,
        pricingReason: "INSUFFICIENT_STAT_COMPARABLES",
      },
    };
  }

  // Calculate suggested listing price
  let suggestedPrice = robustFairValue;
  let competitiveTarget = robustFairValue;

  if (activeCount > 0 && effectiveDupHandling === "same-price") {
    suggestedPrice = activeRollOffers[0].price;
    pricingReason = "MATCH_ACTIVE_OFFER";
  } else if (pricingStrategy === "competitive") {
    if (exactBucket && exactBucket.cheapest !== null) {
      pricingReason = "MARKET_COMPETITIVE";
      competitiveTarget = exactBucket.cheapest;
      const candidatePrice = exactBucket.cheapest - 0.01;

      // Floor guard: do not undercut below (1 - maxUndercutPct) * robustFairValue
      const floorPrice = Math.max(0.01, robustFairValue * (1 - maxUndercutPct));
      suggestedPrice = Math.max(floorPrice, candidatePrice);

      // Monotonic lower-roll price floor check
      let maxLowerCheapest = null;
      for (let s = minPossibleStat; s < statValue; s++) {
        const b = curve[s];
        if (b && b.count > 0 && b.cheapest !== null) {
          if (maxLowerCheapest === null || b.cheapest > maxLowerCheapest) {
            maxLowerCheapest = b.cheapest;
          }
        }
      }
      if (maxLowerCheapest !== null) {
        const lowerFloorPrice = Math.max(0.01, maxLowerCheapest - 0.01);
        suggestedPrice = Math.max(suggestedPrice, lowerFloorPrice);
      }
    } else {
      suggestedPrice = robustFairValue;
    }
  } else if (pricingStrategy === "median") {
    suggestedPrice = robustFairValue;
    pricingReason = "MEDIAN_FAIR_VALUE";
  } else if (pricingStrategy === "quick") {
    suggestedPrice = Math.max(0.01, robustFairValue * 0.965);
    pricingReason = "QUICK_SALE";
  }

  suggestedPrice = Number(suggestedPrice.toFixed(2));
  robustFairValue = Number(robustFairValue.toFixed(2));

  // ABSOLUTE SAFETY INVARIANT: Never undercut own active offer for this roll!
  if (activeCount > 0) {
    const minActivePrice = Math.min(...activeRollOffers.map((o) => o.price));
    if (suggestedPrice < minActivePrice) {
      suggestedPrice = minActivePrice;
      pricingReason = "PROTECT_ACTIVE_OFFER";
    }
  }

  // Cross-roll monotonic pricing constraint from activeOffersTracker / batch
  const monotonicFloor =
    minPriceConstraint ||
    (activeOffersTracker ? activeOffersTracker.getFloorForRoll(slot, quality, statValue) : null);
  if (monotonicFloor && suggestedPrice < monotonicFloor) {
    suggestedPrice = Number(monotonicFloor.toFixed(2));
  }

  // Price floor safety: must not undercut below (1 - maxUndercutPct) * robustFairValue
  const minAllowedDiscountRatio = pricingStrategy === "quick" ? 0.90 : (1 - maxUndercutPct);
  const minPriceFloor = Number((robustFairValue * minAllowedDiscountRatio).toFixed(2));
  if (pricingReason !== "MATCH_ACTIVE_OFFER" && suggestedPrice < minPriceFloor) {
    suggestedPrice = minPriceFloor;
  }

  // Ceil guard: Never exceed robustFairValue unless matching active offer or monotonic floor
  if (pricingReason !== "MATCH_ACTIVE_OFFER" && !monotonicFloor && suggestedPrice > robustFairValue) {
    suggestedPrice = robustFairValue;
  }

  // Market tax calculations
  const enteredPrice = suggestedPrice;
  const rawBuyerPrice = enteredPrice * (1 + taxRate / 100);
  const taxAmount = Number((enteredPrice * (taxRate / 100)).toFixed(3));
  const displayedBuyerPrice = Number(rawBuyerPrice.toFixed(3));
  const displayedBuyerPriceFormatted = formatWarEraNumber(rawBuyerPrice, 3);
  const expectedSellerProceeds = enteredPrice;

  const skipReason = isFloodBlocked
    ? `FLOOD_LIMIT (${activeCount}/${effectiveFloodLimit} active listings)`
    : isDuplicateSkipped
    ? `ACTIVE_OFFER_EXISTS (${activeCount} active at ${activeRollOffers[0]?.price} Gold)`
    : null;

  return {
    itemId: item.itemId,
    code,
    slot,
    quality,
    statName,
    statValue,
    minPossibleStat,
    maxPossibleStat,
    statMin,
    statMax,
    statQuality,
    rollPosition,
    rollPercent,
    isPerfectRoll: item.isPerfectRoll,
    confidence,
    comparablesCount: {
      exact: exactLegitPrices.length,
      near: nearLegitPrices.length,
      secondary: secondaryLegitPrices.length,
      outliersExcluded: exactOutliers.length + nearOutliers.length,
    },
    robustFairValue,
    pricingStrategy,
    suggestedPrice,
    taxRate,
    enteredPrice,
    displayedBuyerPrice,
    displayedBuyerPriceFormatted,
    taxAmount,
    expectedSellerProceeds,
    requiresManualReview: confidence === "VERY LOW",
    isFloodBlocked,
    isDuplicateSkipped,
    hasSafeComparables: true,
    activeOffersCount: activeCount,
    floodLimit: effectiveFloodLimit,
    duplicateHandling: effectiveDupHandling,
    pricingReason,
    skipReason,
    debugTrace: {
      exactComps: exactLegitPrices.length,
      nearComps: nearLegitPrices.length,
      pricesUsed: usedPrices,
      rejectedOutliers: rejectedOutliers,
      competitiveTarget,
      robustFairValue,
      pricingReason,
    },
  };
}

/**
 * Tracks and manages active market listings owned by the user.
 * Used to prevent self-undercutting, enforce duplicate strategies,
 * and implement the market-flood guard.
 */
export class ActiveOffersTracker {
  constructor(initialOffers = [], options = {}) {
    this.duplicateHandling = options.duplicateHandling || "same-price";
    this.maxSimultaneous = options.maxSimultaneous || 3;
    this.byRoll = new Map();
    this.bySlotQuality = new Map();

    for (const offer of initialOffers) {
      this.addOffer(offer);
    }
  }

  static getRollKey(slot, quality, statValue) {
    return `${(slot || "").toLowerCase()}_${(quality || "").toLowerCase()}_${statValue}`;
  }

  static getSlotQualityKey(slot, quality) {
    return `${(slot || "").toLowerCase()}_${(quality || "").toLowerCase()}`;
  }

  addOffer(offer) {
    if (!offer) return;
    const slot = (offer.slot || offer.item?.slot || "").toLowerCase();
    const quality = offer.quality || offer.item?.quality || "";
    let statValue = offer.statValue;
    if (statValue === undefined && offer.item?.skills) {
      statValue = Object.values(offer.item.skills)[0];
    }
    const price = Number(offer.price);

    if (slot && quality && statValue !== undefined && !isNaN(price) && price > 0) {
      const numStat = Number(statValue);
      const rollKey = ActiveOffersTracker.getRollKey(slot, quality, numStat);
      if (!this.byRoll.has(rollKey)) {
        this.byRoll.set(rollKey, []);
      }
      const record = {
        offerId: offer._id || offer.offerId,
        itemId: offer.itemId || offer.item?._id,
        price,
        statValue: numStat,
        slot,
        quality,
      };
      this.byRoll.get(rollKey).push(record);

      const sqKey = ActiveOffersTracker.getSlotQualityKey(slot, quality);
      if (!this.bySlotQuality.has(sqKey)) {
        this.bySlotQuality.set(sqKey, []);
      }
      this.bySlotQuality.get(sqKey).push(record);
    }
  }

  getOffersForRoll(slot, quality, statValue) {
    const rollKey = ActiveOffersTracker.getRollKey(slot, quality, statValue);
    return this.byRoll.get(rollKey) || [];
  }

  getCountForRoll(slot, quality, statValue) {
    return this.getOffersForRoll(slot, quality, statValue).length;
  }

  getFloorForRoll(slot, quality, statValue) {
    const sqKey = ActiveOffersTracker.getSlotQualityKey(slot, quality);
    const list = this.bySlotQuality.get(sqKey) || [];
    let highestFloor = 0;
    const numStat = Number(statValue);
    for (const item of list) {
      if (item.statValue <= numStat && item.price > highestFloor) {
        highestFloor = item.price;
      }
    }
    return highestFloor > 0 ? highestFloor : null;
  }
}

/**
 * Analyze pricing for a single item.
 *
 * @param {Object} item - Classified inventory item
 * @param {Array} offers - Market offers for item's code
 * @param {Object} options - Pricing options:
 *   - pricingStrategy: 'competitive' | 'median' | 'quick'
 *   - maxUndercutPct: max undercut below median fair value (default 0.05 = 5%)
 *   - taxRate: country market tax rate (default 1)
 *   - excludeUserId: user ID to exclude from competitor books (own offers)
 *   - excludeOfferIds: Set of offer IDs to exclude
 *   - activeOffersTracker: ActiveOffersTracker instance
 *   - activeRollOffers: explicit array of active offers for this roll
 *   - duplicateHandling: 'same-price' (default) | 'skip'
 *   - maxSimultaneous: maximum simultaneous listings per roll (default 3)
 *   - minPriceConstraint: minimum price floor constraint (e.g. from lower roll)
 * @returns {Object} Comprehensive pricing analysis
 */
export function analyzeItemPricing(item, offers, options = {}) {
  const {
    pricingStrategy = "competitive",
    maxUndercutPct = 0.05,
    taxRate = 1,
    excludeUserId,
    excludeOfferIds,
    activeOffersTracker,
    activeRollOffers: explicitActiveOffers,
    duplicateHandling = "same-price",
    maxSimultaneous = 3,
    minPriceConstraint = null,
  } = options;

  const { relevantStat, statValue, minPossibleStat, maxPossibleStat } = item;
  const isWeapon =
    item.slot === "weapon" ||
    item.category === "weapon" ||
    KNOWN_WEAPON_CODES.has(item.code);

  if (!isWeapon) {
    return analyzeArmorPricing(item, offers, options);
  }

  // Gather active offers for this roll if available
  let activeRollOffers = explicitActiveOffers;
  if (!activeRollOffers && activeOffersTracker) {
    activeRollOffers = activeOffersTracker.getOffersForRoll(item.slot, item.quality, statValue);
  }
  activeRollOffers = activeRollOffers || [];

  const activeCount = activeRollOffers.length;
  const effectiveFloodLimit = activeOffersTracker?.maxSimultaneous || maxSimultaneous;
  const effectiveDupHandling = activeOffersTracker?.duplicateHandling || duplicateHandling;

  // Market-flood guard check
  const isFloodBlocked = activeCount >= effectiveFloodLimit;

  // Duplicate handling check
  const isDuplicateSkipped = !isFloodBlocked && activeCount > 0 && effectiveDupHandling === "skip";

  // Gather hierarchical comparables (strictly excluding own offers, enforcing category and itemCode isolation)
  const { exact, near, secondary } = gatherComparables(offers, relevantStat, statValue, {
    excludeUserId,
    excludeOfferIds,
    targetItem: item,
    expectedItemCode: item.code,
  });

  const exactPrices = exact.map((c) => c.price);
  const nearPrices = near.map((c) => c.price);
  const secondaryPrices = secondary.map((c) => c.price);

  const exactAnalysis = filterOutliers(exactPrices);
  const nearAnalysis = filterOutliers(nearPrices);
  const secondaryAnalysis = filterOutliers(secondaryPrices);

  const confidence = calculateConfidence(
    exactAnalysis.legitimate.length,
    nearAnalysis.legitimate.length,
    secondaryAnalysis.legitimate.length
  );

  const hasSafeComparables =
    exactAnalysis.legitimate.length > 0 ||
    nearAnalysis.legitimate.length > 0 ||
    secondaryAnalysis.legitimate.length > 0;

  // FAIL-CLOSED WEAPON PRICING:
  // If no valid same-item weapon market comparables exist:
  // - do NOT fall back to armor prices
  // - do NOT fall back to generic rarity pricing
  // - Mark the weapon HELD - NO SAFE WEAPON COMPARABLES
  if (isWeapon && !hasSafeComparables) {
    return {
      itemId: item.itemId,
      code: item.code,
      slot: item.slot,
      quality: item.quality,
      statName: relevantStat,
      statValue,
      minPossibleStat,
      maxPossibleStat,
      rollPosition: item.rollPosition,
      isPerfectRoll: item.isPerfectRoll,
      confidence: "VERY LOW",
      hasSafeComparables: false,
      comparablesCount: {
        exact: 0,
        near: 0,
        secondary: 0,
        outliersExcluded: 0,
      },
      robustFairValue: null,
      pricingStrategy,
      suggestedPrice: null,
      taxRate,
      enteredPrice: null,
      displayedBuyerPrice: null,
      displayedBuyerPriceFormatted: "-",
      taxAmount: null,
      expectedSellerProceeds: null,
      requiresManualReview: true,
      isFloodBlocked: false,
      isDuplicateSkipped: false,
      activeOffersCount: activeCount,
      floodLimit: effectiveFloodLimit,
      duplicateHandling: effectiveDupHandling,
      pricingReason: "NO_SAFE_WEAPON_COMPARABLES",
      skipReason: "NO_SAFE_WEAPON_COMPARABLES",
    };
  }

  // Determine robust fair value (median) from competitor comparables
  let robustFairValue = null;
  if (exactAnalysis.legitimate.length > 0) {
    robustFairValue = exactAnalysis.medianPrice;
  } else if (nearAnalysis.legitimate.length > 0) {
    robustFairValue = nearAnalysis.medianPrice;
  } else if (secondaryAnalysis.legitimate.length > 0) {
    robustFairValue = secondaryAnalysis.medianPrice;
  } else if (!isWeapon && offers.length > 0) {
    // Broad fallback to legitimate competitor offers for this itemCode (armor only)
    const compOffers = offers.filter((o) => {
      if (excludeUserId) {
        const uid = typeof o.user === "object" ? o.user?._id : o.user;
        if (uid && uid === excludeUserId) return false;
      }
      return true;
    });
    const allPrices = compOffers.map((o) => Number(o.price)).filter((p) => p > 0);
    const broad = filterOutliers(allPrices);
    robustFairValue = broad.medianPrice || 1.0;
  } else {
    // No market data at all (armor only)
    robustFairValue = 1.0;
  }

  // Calculate suggested listing price based on strategy & duplicate handling
  let suggestedPrice = robustFairValue;
  let pricingReason = "MARKET_COMPETITIVE";

  if (activeCount > 0 && effectiveDupHandling === "same-price") {
    // Pin to exact same seller price as active offer!
    suggestedPrice = activeRollOffers[0].price;
    pricingReason = "MATCH_ACTIVE_OFFER";
  } else if (pricingStrategy === "competitive") {
    // Minimally undercut cheapest legitimate exact comparable
    const cheapestComparable = exactAnalysis.legitimate.length > 0
      ? Math.min(...exactAnalysis.legitimate)
      : (nearAnalysis.legitimate.length > 0 ? Math.min(...nearAnalysis.legitimate) : robustFairValue);

    // Minimum price increment in WarEra is 0.01
    const candidatePrice = cheapestComparable - 0.01;

    // Outlier / undercutting guardrail: do not undercut below (1 - maxUndercutPct) * robustFairValue
    const floorPrice = Math.max(0.01, robustFairValue * (1 - maxUndercutPct));
    suggestedPrice = Math.max(floorPrice, candidatePrice);
  } else if (pricingStrategy === "median") {
    suggestedPrice = robustFairValue;
    pricingReason = "MEDIAN_FAIR_VALUE";
  } else if (pricingStrategy === "quick") {
    // 3.5% discount below robust fair value
    suggestedPrice = Math.max(0.01, robustFairValue * 0.965);
    pricingReason = "QUICK_SALE";
  }

  // Round to 2 decimal places (standard market price)
  suggestedPrice = Number(suggestedPrice.toFixed(2));
  robustFairValue = Number(robustFairValue.toFixed(2));

  // ABSOLUTE SAFETY INVARIANT: Never undercut own active offer for this roll!
  if (activeCount > 0) {
    const minActivePrice = Math.min(...activeRollOffers.map((o) => o.price));
    if (suggestedPrice < minActivePrice) {
      suggestedPrice = minActivePrice;
      pricingReason = "PROTECT_ACTIVE_OFFER";
    }
  }

  // Cross-roll monotonic pricing protection (higher roll never cheaper than own active lower roll)
  const monotonicFloor =
    minPriceConstraint ||
    (activeOffersTracker ? activeOffersTracker.getFloorForRoll(item.slot, item.quality, statValue) : null);
  if (monotonicFloor && suggestedPrice < monotonicFloor) {
    suggestedPrice = Number(monotonicFloor.toFixed(2));
  }

  // Absolute price floor safety assertions
  if (!Number.isFinite(suggestedPrice) || isNaN(suggestedPrice) || suggestedPrice <= 0) {
    throw new Error(`Calculated invalid non-positive price: ${suggestedPrice} for item ${item.itemId}`);
  }

  // Price floor: must not undercut more than maxUndercutPct below robust fair value (unless matching active offer)
  const minAllowedDiscountRatio = pricingStrategy === "quick" ? 0.90 : (1 - maxUndercutPct);
  const minPriceFloor = Number((robustFairValue * minAllowedDiscountRatio).toFixed(2));
  if (pricingReason !== "MATCH_ACTIVE_OFFER" && suggestedPrice < minPriceFloor) {
    suggestedPrice = minPriceFloor;
  }

  // Market tax calculations
  // Seller enters suggestedPrice and receives suggestedPrice
  // Buyer pays suggestedPrice * (1 + taxRate / 100)
  // WarEra client displays buyer price with precision 3 (Module 37732 & 37686)
  const enteredPrice = suggestedPrice;
  const rawBuyerPrice = enteredPrice * (1 + taxRate / 100);
  const taxAmount = Number((enteredPrice * (taxRate / 100)).toFixed(3));
  const displayedBuyerPrice = Number(rawBuyerPrice.toFixed(3));
  const displayedBuyerPriceFormatted = formatWarEraNumber(rawBuyerPrice, 3);
  const expectedSellerProceeds = enteredPrice;

  const skipReason = isFloodBlocked
    ? `FLOOD_LIMIT (${activeCount}/${effectiveFloodLimit} active listings)`
    : isDuplicateSkipped
    ? `ACTIVE_OFFER_EXISTS (${activeCount} active at ${activeRollOffers[0]?.price} Gold)`
    : null;

  return {
    itemId: item.itemId,
    code: item.code,
    slot: item.slot,
    quality: item.quality,
    statName: relevantStat,
    statValue,
    minPossibleStat,
    maxPossibleStat,
    rollPosition: item.rollPosition,
    isPerfectRoll: item.isPerfectRoll,
    confidence,
    comparablesCount: {
      exact: exactAnalysis.legitimate.length,
      near: nearAnalysis.legitimate.length,
      secondary: secondaryAnalysis.legitimate.length,
      outliersExcluded: exactAnalysis.outliers.length + nearAnalysis.outliers.length,
    },
    robustFairValue,
    pricingStrategy,
    suggestedPrice,
    taxRate,
    enteredPrice,
    displayedBuyerPrice,
    displayedBuyerPriceFormatted,
    taxAmount,
    expectedSellerProceeds,
    requiresManualReview: confidence === "VERY LOW",
    isFloodBlocked,
    isDuplicateSkipped,
    hasSafeComparables: true,
    activeOffersCount: activeCount,
    floodLimit: effectiveFloodLimit,
    duplicateHandling: effectiveDupHandling,
    pricingReason,
    skipReason,
  };
}

/**
 * Format numbers according to WarEra frontend (Module 37686 & 37732).
 * For taxed market prices, precision is 3 with trailing zeros stripped.
 */
export function formatWarEraNumber(num, precision = 3) {
  if (!num || Number.isNaN(num)) return "0";
  const abs = Math.abs(num);
  if (abs >= 1e9) {
    const d = (num / 1e9).toFixed(precision);
    const t = precision > 0 ? d.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "").replace(/\.$/, "") : d;
    return `${t}B`;
  }
  if (abs >= 1e6) {
    const d = (num / 1e6).toFixed(precision);
    const t = precision > 0 ? d.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "").replace(/\.$/, "") : d;
    return `${t}M`;
  }
  if (abs >= 1e3) {
    const d = (num / 1e3).toFixed(precision);
    const t = precision > 0 ? d.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "").replace(/\.$/, "") : d;
    return `${t}K`;
  }
  const d = Number(num).toFixed(precision);
  return precision > 0 && d.includes(".")
    ? d.replace(/(\.\d*?[1-9])0+$/, "$1").replace(/\.0+$/, "").replace(/\.$/, "")
    : d;
}

/**
 * Conduct a complete inventory valuation audit across all target items (including perfect rolls).
 * Assigns mutually exclusive final disposition buckets such that:
 * sum(all disposition counts) === totalInScope
 */
export async function performInventoryAudit(classifiedItems, options = {}) {
  const { taxRate = 1 } = options;

  // Group items by itemCode to fetch market offers efficiently
  const uniqueCodes = [...new Set(classifiedItems.map((i) => i.code))];
  const marketBooks = {};

  const fetchOffersFn = options.fetchMarketOffersFn || fetchMarketOffers;
  const providedMarketBooks = options.marketBooks || {};

  for (const code of uniqueCodes) {
    if (providedMarketBooks[code] !== undefined) {
      marketBooks[code] = providedMarketBooks[code];
      continue;
    }
    try {
      marketBooks[code] = await fetchOffersFn(code);
    } catch {
      marketBooks[code] = [];
    }
  }

  const auditedItems = [];
  const dispositionCounts = {
    "KEEP - PERFECT": 0,
    "KEEP - EQUIPPED": 0,
    "KEEP - DAMAGED": 0,
    "KEEP - ALREADY LISTED": 0,
    "KEEP - VERY LOW PRICE CONFIDENCE": 0,
    "HELD - INSUFFICIENT STAT COMPARABLES": 0,
    "HELD - NO SAFE WEAPON COMPARABLES": 0,
    "SKIP - MONOTONIC PRICE CONFLICT": 0,
    "SELL - ELIGIBLE": 0,
  };

  let totalInventoryValue = 0;
  let totalSellCandidatesValue = 0;
  let totalPerfectRollsValue = 0;

  for (const item of classifiedItems) {
    const offers = marketBooks[item.code] || [];
    const pricing = analyzeItemPricing(item, offers, { ...options, taxRate });

    // Mutually exclusive disposition assignment
    let finalDisposition = "";
    let decision = "KEEP";

    if (item.equipped) {
      finalDisposition = "KEEP - EQUIPPED";
      decision = "KEEP";
    } else if (item.listed) {
      finalDisposition = "KEEP - ALREADY LISTED";
      decision = "KEEP";
    } else if (!item.tradable) {
      finalDisposition = "KEEP - DAMAGED";
      decision = "KEEP";
    } else if (item.isPerfectRoll) {
      finalDisposition = "KEEP - PERFECT";
      decision = "KEEP";
    } else if (item.slot === "weapon" && (!pricing.hasSafeComparables || pricing.confidence === "VERY LOW")) {
      finalDisposition = "HELD - NO SAFE WEAPON COMPARABLES";
      decision = "KEEP";
    } else if (item.slot !== "weapon" && (!pricing.hasSafeComparables || pricing.confidence === "VERY LOW")) {
      finalDisposition = "HELD - INSUFFICIENT STAT COMPARABLES";
      decision = "KEEP";
    } else if (pricing.confidence === "VERY LOW") {
      finalDisposition = "KEEP - VERY LOW PRICE CONFIDENCE";
      decision = "KEEP";
    } else {
      finalDisposition = "SELL - ELIGIBLE";
      decision = "SELL";
    }

    dispositionCounts[finalDisposition]++;

    // Value estimation
    const estimatedValue = pricing.robustFairValue || 0;
    totalInventoryValue += estimatedValue;

    if (finalDisposition === "SELL - ELIGIBLE") {
      totalSellCandidatesValue += (pricing.expectedSellerProceeds || 0);
    }
    if (item.isPerfectRoll) {
      totalPerfectRollsValue += estimatedValue;
    }

    auditedItems.push({
      ...item,
      decision,
      finalDisposition,
      pricing,
    });
  }

  // Mutually exclusive invariant assertion
  const sumDispositions = Object.values(dispositionCounts).reduce((a, b) => a + b, 0);
  if (sumDispositions !== classifiedItems.length) {
    throw new Error(
      `Disposition accounting invariant failed: sum(${sumDispositions}) !== total(${classifiedItems.length})`
    );
  }

  return {
    items: auditedItems,
    marketBooks,
    summary: {
      totalItems: classifiedItems.length,
      dispositions: dispositionCounts,
      overlapping: {
        totalPerfectRollsOwned: classifiedItems.filter((i) => i.isPerfectRoll).length,
        perfectEquippedCount: classifiedItems.filter((i) => i.isPerfectRoll && i.equipped).length,
        perfectDamagedCount: classifiedItems.filter((i) => i.isPerfectRoll && !i.tradable && !i.equipped).length,
        totalEquippedCount: classifiedItems.filter((i) => i.equipped).length,
      },
      armor: {
        total: classifiedItems.filter((i) => i.slot !== "weapon").length,
        keep: auditedItems.filter((i) => i.slot !== "weapon" && i.decision === "KEEP").length,
        sell: auditedItems.filter((i) => i.slot !== "weapon" && i.decision === "SELL").length,
      },
      weapons: {
        total: classifiedItems.filter((i) => i.slot === "weapon").length,
        keep: auditedItems.filter((i) => i.slot === "weapon" && i.decision === "KEEP").length,
        sell: auditedItems.filter((i) => i.slot === "weapon" && i.decision === "SELL").length,
      },
      totalInventoryValue: Number(totalInventoryValue.toFixed(2)),
      totalSellCandidatesValue: Number(totalSellCandidatesValue.toFixed(2)),
      totalPerfectRollsValue: Number(totalPerfectRollsValue.toFixed(2)),
      taxRate,
    },
  };
}
