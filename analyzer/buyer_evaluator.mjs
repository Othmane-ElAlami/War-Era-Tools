/**
 * WarEra Equipment Buyer Evaluator Module
 *
 * Core engine for discovering, filtering, evaluating, and ranking live market
 * equipment offers to identify the Best Value gear and weapons.
 */

import { fetchWithRetry, getCookieHeader, sleep } from "./api.mjs";
import { USER_ID, resolveUserId } from "../config.mjs";
import { calculateCombatProfile } from "./combat_model.mjs";
import { calculateRollPosition } from "./equipment_rolls.mjs";
import {
  gatherComparables,
  filterOutliers,
  calculateConfidence,
  fetchMarketTaxRate,
  formatWarEraNumber,
} from "./market_pricing.mjs";

const DEFAULT_HEADERS = {
  "content-type": "application/json",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0",
};

const API_BASE = "https://api6.warera.io/trpc";

export const SUPPORTED_CATEGORIES = [
  "helmet",
  "chest",
  "gloves",
  "pants",
  "boots",
  "weapon",
];

export const RARITY_COLOR_MAP = {
  grey: "common",
  gray: "common",
  common: "common",
  green: "uncommon",
  uncommon: "uncommon",
  blue: "rare",
  rare: "rare",
  purple: "epic",
  epic: "epic",
  gold: "legendary",
  yellow: "legendary",
  legendary: "legendary",
  red: "mythic",
  mythic: "mythic",
};

export const REVERSE_RARITY_COLOR_MAP = {
  common: "Grey",
  uncommon: "Green",
  rare: "Blue",
  epic: "Purple",
  legendary: "Gold",
  mythic: "Red",
};

/**
 * Resolve input rarity string dynamically from live gameConfig.
 */
export function resolveRarity(rarityInput, gameConfig) {
  if (!rarityInput || typeof rarityInput !== "string") {
    throw new Error(
      "Missing required option: --rarity=<rarity> (e.g. --rarity=green, --rarity=blue)"
    );
  }

  const normalized = rarityInput.toLowerCase().trim();
  const canonical = RARITY_COLOR_MAP[normalized] || normalized;

  // Discover all rarities currently present in gameConfig.items
  const items = gameConfig?.items || {};
  const discoveredRarities = new Set();
  for (const item of Object.values(items)) {
    if (item.rarity) {
      discoveredRarities.add(item.rarity.toLowerCase());
    }
  }

  if (discoveredRarities.size === 0) {
    // Fallback known rarities if gameConfig is minimal
    ["common", "uncommon", "rare", "epic", "legendary", "mythic"].forEach((r) =>
      discoveredRarities.add(r)
    );
  }

  if (!discoveredRarities.has(canonical)) {
    const validDisplay = [...discoveredRarities].map(
      (r) => `${r} (${REVERSE_RARITY_COLOR_MAP[r] || r})`
    );
    throw new Error(
      `Invalid rarity '${rarityInput}'. Valid rarities in gameConfig: ${validDisplay.join(
        ", "
      )}`
    );
  }

  return {
    canonical,
    displayName: REVERSE_RARITY_COLOR_MAP[canonical] || canonical,
  };
}

/**
 * Resolve participating equipment categories using include & exclude sets.
 * Rules:
 * - include narrows the allowed category set.
 * - exclude removes categories from that set.
 * - exclude wins if the same category appears in both.
 * - ammo is NOT equipment-buyer scope.
 * - invalid categories must fail clearly.
 * - if no include/exclude is provided, analyze all supported gear + weapons.
 */
export function resolveCategories(includeStr = null, excludeStr = null) {
  const parseList = (str) =>
    str
      ? str
          .split(",")
          .map((s) => s.toLowerCase().trim())
          .filter(Boolean)
      : [];

  const includes = parseList(includeStr);
  const excludes = parseList(excludeStr);

  // Check for ammo or invalid categories
  for (const cat of [...includes, ...excludes]) {
    if (cat === "ammo") {
      throw new Error(
        "Invalid category 'ammo'. Ammo is not in equipment-buyer scope."
      );
    }
    if (!SUPPORTED_CATEGORIES.includes(cat)) {
      throw new Error(
        `Invalid category '${cat}'. Supported categories: ${SUPPORTED_CATEGORIES.join(
          ", "
        )}`
      );
    }
  }

  let selected = includes.length > 0 ? [...new Set(includes)] : [...SUPPORTED_CATEGORIES];

  if (excludes.length > 0) {
    const excludeSet = new Set(excludes);
    selected = selected.filter((cat) => !excludeSet.has(cat));
  }

  if (selected.length === 0) {
    throw new Error(
      "No equipment categories remaining after applying include and exclude filters."
    );
  }

  return selected;
}

/**
 * Dynamically extract equipment & weapon metadata from gameConfig for a specific rarity.
 */
export function extractRarityCatalog(gameConfig, targetRarity) {
  const items = gameConfig?.items || {};
  const catalog = {
    gear: {}, // slot -> { itemCode, statName, minPossibleStat, maxPossibleStat, rarity }
    weapons: [], // [{ code, name, rarity, dynamicStats }]
  };

  for (const [code, item] of Object.entries(items)) {
    const rarity = item.rarity?.toLowerCase();
    if (rarity !== targetRarity.toLowerCase()) continue;

    const slot = item.usage || item.skinSlot;
    const type = item.type;

    if (type === "weapon" || slot === "weapon") {
      catalog.weapons.push({
        code,
        name: item.name || code,
        skinSlot: item.skinSlot || code,
        rarity,
        dynamicStats: item.dynamicStats || {},
      });
    } else if (type === "equipment" && SUPPORTED_CATEGORIES.includes(slot)) {
      const dynamicStats = item.dynamicStats || {};
      const statNames = Object.keys(dynamicStats);
      if (statNames.length > 0) {
        const statName = statNames[0];
        const range = dynamicStats[statName];
        if (Array.isArray(range) && range.length === 2) {
          catalog.gear[slot] = {
            itemCode: code,
            slot,
            rarity,
            statName,
            minPossibleStat: range[0],
            maxPossibleStat: range[1],
          };
        }
      }
    }
  }

  return catalog;
}

/**
 * Fetch all active market offers for an itemCode using cursor pagination.
 * Paginates until the API returns no more results (nextCursor === null).
 * The API returns 12 items per page sorted by price ascending.
 * Options:
 * - maxPages (default Infinity — paginate until API exhaustion; safety cap: 500 pages / 6000 items)
 * - excludeUserId: excludes own offers
 * - cookieHeader: optional cookies
 * - fetchFn: optional fetch mock
 */
export async function fetchAllMarketOffers(itemCode, options = {}) {
  const { maxPages = 500, excludeUserId = null, cookieHeader = getCookieHeader(), fetchFn = fetchWithRetry, timeoutMs } = options;
  const allOffers = [];
  let cursor = undefined;

  for (let p = 0; p < maxPages; p++) {
    const body = {
      itemCode,
      limit: 50,
      direction: "forward",
      ...(cursor ? { cursor } : {}),
    };

    const res = await fetchFn(`${API_BASE}/itemOffer.getItemOffers?batch=1`, {
      method: "POST",
      headers: {
        ...DEFAULT_HEADERS,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
      body: JSON.stringify({ "0": body }),
      ...(timeoutMs ? { timeoutMs } : {}),
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

  return allOffers;
}

/**
 * Sanitize and validate raw market offers.
 * Excludes:
 * - my own offers
 * - invalid offers (missing IDs, non-positive price)
 * - damaged / unusable items (state < 100)
 * - malformed stat records
 */
export function sanitizeMarketOffers(rawOffers = [], options = {}) {
  const { excludeUserId = null, requiredStats = [], taxRate = 1 } = options;
  const validOffers = [];

  for (const off of rawOffers) {
    if (!off || !off._id || !off.item || !off.item._id) continue;

    // Exclude own offers
    const sellerId = typeof off.user === "object" ? off.user?._id : off.user;
    if (excludeUserId && sellerId === excludeUserId) {
      continue;
    }

    const price = Number(off.price);
    if (isNaN(price) || price <= 0) continue;

    // Check durability
    const state = off.item.state !== undefined ? off.item.state : 100;
    if (state < 100) continue;

    // Check required stats
    const skills = off.item.skills || {};
    let hasMalformedStats = false;
    for (const st of requiredStats) {
      const val = Number(skills[st]);
      if (val === undefined || isNaN(val)) {
        hasMalformedStats = true;
        break;
      }
    }
    if (hasMalformedStats) continue;

    const buyerPrice = Number((price * (1 + taxRate / 100)).toFixed(3));

    validOffers.push({
      offerId: off._id,
      itemId: off.item._id,
      itemCode: off.itemCode || off.item.code,
      sellerId,
      countryId: off.country,
      sellerPrice: price,
      buyerPrice,
      taxRate,
      state,
      maxState: off.item.maxState ?? 100,
      skills: { ...skills },
      createdAt: off.createdAt,
      rawOffer: off,
    });
  }

  return validOffers;
}

/**
 * Eliminate dominated offers (Pareto frontier).
 * For two offers A and B in the same category:
 * Offer A dominates B if:
 * utility(A) >= utility(B) AND cost(A) <= cost(B)
 * AND (utility(A) > utility(B) OR cost(A) < cost(B))
 *
 * If utility and cost are identical, neither dominates the other (both are non-dominated candidates).
 */
export function eliminateDominatedOffers(offers, utilityFn, costFn = (o) => o.buyerPrice) {
  if (!offers || offers.length === 0) return { nonDominated: [], dominated: [] };

  const nonDominated = [];
  const dominated = [];

  for (let i = 0; i < offers.length; i++) {
    const cand = offers[i];
    const uCand = utilityFn(cand);
    const cCand = costFn(cand);

    let isDominated = false;
    let dominatedBy = null;

    for (let j = 0; j < offers.length; j++) {
      if (i === j) continue;
      const other = offers[j];
      const uOther = utilityFn(other);
      const cOther = costFn(other);

      const betterOrEqualUtility = uOther >= uCand;
      const cheaperOrEqualCost = cOther <= cCand;
      const strictlyBetter = uOther > uCand || cOther < cCand;

      if (betterOrEqualUtility && cheaperOrEqualCost && strictlyBetter) {
        isDominated = true;
        dominatedBy = other;
        break;
      }
    }

    if (isDominated) {
      dominated.push({ offer: cand, dominatedBy });
    } else {
      nonDominated.push(cand);
    }
  }

  return { nonDominated, dominated };
}

/**
 * Evaluate a single-stat armor equipment offer.
 */
export function evaluateGearOffer(offer, rangeInfo, equippedItem = null, options = {}) {
  const { allOffersForCode = [], excludeUserId = null } = options;
  const { statName, minPossibleStat, maxPossibleStat, slot, rarity } = rangeInfo;
  const statValue = Number(offer.skills[statName]) || 0;

  // FAIL CLOSED: If a market item's rolled stat falls outside discovered live range,
  // DO NOT clamp it, DO NOT normalize it, DO NOT score it.
  // Mark INVALID LIVE RANGE and exclude it from recommendations.
  const isInvalidRange =
    minPossibleStat !== undefined &&
    maxPossibleStat !== undefined &&
    (statValue < minPossibleStat || statValue > maxPossibleStat);

  if (isInvalidRange) {
    return {
      ...offer,
      category: slot,
      slot,
      rarity,
      statName,
      statValue,
      minPossibleStat,
      maxPossibleStat,
      rangeStr: `${minPossibleStat}-${maxPossibleStat}`,
      isInvalidRange: true,
      disposition: "INVALID LIVE RANGE",
      rollPosition: "INVALID LIVE RANGE",
      rollPercent: null,
      isPerfect: false,
      isPerfectRoll: false,
      isMinimum: false,
      statPerGold: 0,
      goldPerStat: Infinity,
      statDiff: 0,
      normalizedImprovement: 0,
      normalizedValueScore: 0,
      fairSellerPrice: null,
      fairBuyerPrice: offer.buyerPrice,
      priceDiffPct: 0,
      isOverpriced: false,
      confidence: "LOW",
    };
  }

  // 1. Roll Position & Roll Percent (Single Source of Truth)
  // rarityRollPercent = ((statValue - minPossibleStat) / (maxPossibleStat - minPossibleStat)) * 100
  // absoluteMaxRatio = statValue / maxPossibleStat
  const isPerfect = maxPossibleStat !== undefined && statValue === maxPossibleStat;
  const isMinimum = minPossibleStat !== undefined && statValue === minPossibleStat;
  const rollPos = calculateRollPosition(statValue, minPossibleStat, maxPossibleStat);
  const rarityRollPercent = rollPos.percent;
  const rarityRollPercentExact = rollPos.exactPercent;
  const absoluteMaxRatio = maxPossibleStat > 0 ? Number((statValue / maxPossibleStat).toFixed(4)) : 0;
  const rollPercent = rarityRollPercent;
  const rollPosition = rollPos.label;

  // 2. Value metrics
  // Canonical Best Value qualityScore and valueScore (Requirement 1):
  // qualityScore = (statValue - minPossibleStat) / (maxPossibleStat - minPossibleStat)
  // valueScore = qualityScore / buyerPrice
  const rangeSpan = (maxPossibleStat !== undefined && minPossibleStat !== undefined)
    ? maxPossibleStat - minPossibleStat
    : 0;
  const qualityScore = rangeSpan > 0
    ? Number(((statValue - minPossibleStat) / rangeSpan).toFixed(6))
    : 1.0;
  const valueScore = Number((qualityScore / offer.buyerPrice).toFixed(6));
  const statPerGold = Number((statValue / offer.buyerPrice).toFixed(3));
  const goldPerStat = Number((offer.buyerPrice / statValue).toFixed(3));

  // 3. Current equipment comparison
  const compareEquipped =
    options.compareEquipped !== undefined
      ? Boolean(options.compareEquipped)
      : Boolean(equippedItem);
  const equippedStat = compareEquipped ? (Number(equippedItem?.skills?.[statName]) || 0) : 0;
  let disposition = "UPGRADE";
  let statDiff = statValue - equippedStat;

  if (compareEquipped) {
    if (statValue > equippedStat) {
      disposition = "UPGRADE";
    } else if (statValue === equippedStat) {
      disposition = "SIDEGRADE";
    } else {
      disposition = "DOWNGRADE";
    }
  } else {
    disposition = "UPGRADE";
  }

  // 4. Normalized improvement for cross-slot comparison
  // Formula: (candidateStat - equippedStat) / (maxPossibleStat - equippedStat) / buyerPrice
  let normalizedImprovement = 0;
  if (statDiff > 0) {
    const maxGain = Math.max(1, maxPossibleStat - equippedStat);
    normalizedImprovement = statDiff / maxGain;
  }
  const normalizedValueScore = Number((normalizedImprovement / offer.buyerPrice).toFixed(5));

  // 5. Market Fairness Check (reusing market comparables & robust fair value)
  const { exact, near, secondary } = gatherComparables(allOffersForCode, statName, statValue, {
    excludeUserId,
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

  let fairSellerPrice = null;
  if (exactAnalysis.legitimate.length > 0) {
    fairSellerPrice = exactAnalysis.medianPrice;
  } else if (nearAnalysis.legitimate.length > 0) {
    fairSellerPrice = nearAnalysis.medianPrice;
  } else if (secondaryAnalysis.legitimate.length > 0) {
    fairSellerPrice = secondaryAnalysis.medianPrice;
  } else {
    fairSellerPrice = offer.sellerPrice ?? offer.buyerPrice ?? 1.0;
  }

  fairSellerPrice = Number(Number(fairSellerPrice || 1.0).toFixed(2));
  const taxRate = offer.taxRate ?? 1;
  const fairBuyerPrice = Number((fairSellerPrice * (1 + taxRate / 100)).toFixed(3));

  // Discount vs fair value: positive = discount (cheaper than fair), negative = premium (more expensive)
  const priceDiffPct = fairBuyerPrice > 0
    ? Number((((fairBuyerPrice - offer.buyerPrice) / fairBuyerPrice) * 100).toFixed(1))
    : 0;

  // Materially overpriced guard: buyer price is > 18% above fair buyer price with MODERATE or HIGH confidence
  const isOverpriced =
    fairBuyerPrice > 0 &&
    offer.buyerPrice > fairBuyerPrice * 1.18 &&
    (confidence === "HIGH" || confidence === "MODERATE");

  return {
    ...offer,
    category: slot,
    slot,
    rarity,
    statName,
    statValue,
    minPossibleStat,
    maxPossibleStat,
    rangeStr: `${minPossibleStat}-${maxPossibleStat}`,
    rollPosition,
    rollPercent,
    rarityRollPercent,
    rarityRollPercentExact,
    absoluteMaxRatio,
    intervalPercent: rollPos.percent,
    isPerfect,
    isPerfectRoll: isPerfect,
    isMinimum,
    qualityScore,
    valueScore,
    slotQuality: qualityScore,
    statPerGold,
    goldPerStat,
    equippedStat,
    statDiff,
    disposition,
    normalizedImprovement,
    normalizedValueScore,
    fairSellerPrice,
    fairBuyerPrice,
    priceDiffPct,
    isOverpriced,
    confidence,
    comparablesCount: {
      exact: exactAnalysis.legitimate.length,
      near: nearAnalysis.legitimate.length,
      secondary: secondaryAnalysis.legitimate.length,
    },
  };
}

/**
 * Evaluate a weapon offer using the live combat model.
 */
export function evaluateWeaponOffer(
  offer,
  weaponMeta,
  currentEquippedWeapon = null,
  playerProfile = null,
  gameConfig = null,
  options = {}
) {
  const { allOffersForCode = [], excludeUserId = null } = options;
  const attack = Number(offer.skills.attack) || 0;
  const crit = Number(offer.skills.criticalChance) || 0;

  const dynamicStats = weaponMeta?.dynamicStats || {};
  const [minAtk, maxAtk] = dynamicStats.attack || [0, attack];
  const [minCrit, maxCrit] = dynamicStats.criticalChance || [0, crit];

  // FAIL CLOSED: If a weapon's rolled attack or criticalChance falls outside discovered live range,
  // DO NOT clamp it, DO NOT normalize it, DO NOT score it.
  // Mark INVALID LIVE RANGE and exclude it from recommendations.
  const isInvalidRange =
    attack < minAtk || attack > maxAtk || crit < minCrit || crit > maxCrit;

  if (isInvalidRange) {
    return {
      ...offer,
      category: "weapon",
      slot: "weapon",
      rarity: weaponMeta.rarity,
      weaponType: weaponMeta.code,
      weaponName: weaponMeta.name,
      attack,
      criticalChance: crit,
      minAtk,
      maxAtk,
      minCrit,
      maxCrit,
      rangeStr: `${minAtk}-${maxAtk} / ${minCrit}-${maxCrit}`,
      isInvalidRange: true,
      disposition: "INVALID LIVE RANGE",
      rollPosition: "INVALID LIVE RANGE",
      rollPercent: null,
      isPerfect: false,
      isPerfectRoll: false,
      currentDamage: 0,
      candidateDamage: 0,
      theoreticalMinDamage: null,
      theoreticalMaxDamage: null,
      minTierDamage: null,
      maxTierDamage: null,
      weaponQuality: null,
      slotQuality: null,
      damageGain: 0,
      combatGainPerGold: 0,
      damagePerGold: 0,
      normalizedImprovement: 0,
      normalizedValueScore: 0,
      fairSellerPrice: null,
      fairBuyerPrice: offer.buyerPrice,
      priceDiffPct: 0,
      isOverpriced: false,
      confidence: "LOW",
    };
  }

  // Roll positions (Single Source of Truth)
  // Normalize each dynamic stat using its OWN live [min, max] interval via calculateRollPosition.
  // Display-level combined weapon roll percent is the mean of the individually normalized roll positions.
  const isPerfect = attack === maxAtk && crit === maxCrit;
  const atkRoll = calculateRollPosition(attack, minAtk, maxAtk);
  const critRoll = calculateRollPosition(crit, minCrit, maxCrit);
  const exactAverageRollPercent = Number(((atkRoll.exactPercent + critRoll.exactPercent) / 2).toFixed(3));
  const averageRollPercent = Math.round((atkRoll.exactPercent + critRoll.exactPercent) / 2);
  const absoluteMaxRatio = {
    attack: maxAtk > 0 ? Number((attack / maxAtk).toFixed(4)) : 0,
    crit: maxCrit > 0 ? Number((crit / maxCrit).toFixed(4)) : 0,
  };

  // Calculate baseline & candidate combat output
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

  const compareEquipped = Boolean(options.compareEquipped);
  const effectiveEquippedWeapon = compareEquipped ? currentEquippedWeapon : null;

  // Documented neutral equipment context for standalone weapon comparison (compareEquipped === false)
  // Keeps player persistent context (skills, military rank, permanent modifiers, ammo) constant,
  // but ensures equipped weapon and armor stats (helmet crit dmg, gloves precision) do NOT leak into standalone shopping mode.
  const equippedGear = {
    weaponAtk: effectiveEquippedWeapon?.skills?.attack ?? 0,
    weaponCrit: effectiveEquippedWeapon?.skills?.criticalChance ?? 0,
    helmetCritDmg: compareEquipped ? (playerProfile?.equipment?.helmet?.skills?.criticalDamages ?? 0) : 0,
    glovesPrec: compareEquipped ? (playerProfile?.equipment?.gloves?.skills?.precision ?? 0) : 0,
    ammo: playerProfile?.equipment?.ammo || "ammo",
  };

  const skillRules = gameConfig?.skills || {};

  // 1. Current weapon combat output
  const currentCombat = calculateCombatProfile(skillsAlloc, skillRules, equippedGear, modifiers);
  const currentDamage = currentCombat.expectedDamageRounded;

  // 2. Candidate weapon combat output
  const candidateGear = {
    ...equippedGear,
    weaponAtk: attack,
    weaponCrit: crit,
  };
  const candidateCombat = calculateCombatProfile(skillsAlloc, skillRules, candidateGear, modifiers);
  const candidateDamage = candidateCombat.expectedDamageRounded;

  // 3. Max possible weapon roll in this tier combat output (Theoretical MAX)
  const maxTierGear = {
    ...equippedGear,
    weaponAtk: maxAtk,
    weaponCrit: maxCrit,
  };
  const maxTierCombat = calculateCombatProfile(skillsAlloc, skillRules, maxTierGear, modifiers);
  const theoreticalMaxDamage = maxTierCombat.expectedDamageRounded;

  // 4. Min possible weapon roll in this tier combat output (Theoretical MIN)
  const minTierGear = {
    ...equippedGear,
    weaponAtk: minAtk,
    weaponCrit: minCrit,
  };
  const minTierCombat = calculateCombatProfile(skillsAlloc, skillRules, minTierGear, modifiers);
  const theoreticalMinDamage = minTierCombat.expectedDamageRounded;
  const minTierDamage = theoreticalMinDamage;
  const maxTierDamage = theoreticalMaxDamage;

  // Fail closed if candidate damage falls outside theoretical bounds beyond numerical tolerance
  const isOutOfDamageBounds =
    candidateDamage < theoreticalMinDamage - 1e-6 || candidateDamage > theoreticalMaxDamage + 1e-6;

  if (isOutOfDamageBounds) {
    return {
      ...offer,
      category: "weapon",
      slot: "weapon",
      rarity: weaponMeta.rarity,
      weaponType: weaponMeta.code,
      weaponName: weaponMeta.name,
      attack,
      criticalChance: crit,
      minAtk,
      maxAtk,
      minCrit,
      maxCrit,
      theoreticalMinDamage,
      theoreticalMaxDamage,
      minTierDamage: theoreticalMinDamage,
      maxTierDamage: theoreticalMaxDamage,
      rangeStr: `${minAtk}-${maxAtk} / ${minCrit}-${maxCrit}`,
      isInvalidRange: true,
      disposition: "INVALID LIVE RANGE",
      rollPosition: "INVALID LIVE RANGE",
      rollPercent: null,
      isPerfect: false,
      isPerfectRoll: false,
      currentDamage,
      candidateDamage,
      weaponQuality: null,
      slotQuality: null,
      qualityScore: 0,
      damageGain: 0,
      combatGainPerGold: 0,
      damagePerGold: 0,
      fairSellerPrice: null,
      fairBuyerPrice: offer.buyerPrice,
      priceDiffPct: 0,
      isOverpriced: false,
      confidence: "LOW",
    };
  }

  const atkSpan = maxAtk - minAtk;
  const weaponAttackQuality = atkSpan > 0
    ? Math.max(0, Math.min(1, Number(((attack - minAtk) / atkSpan).toFixed(6))))
    : 1.0;
  const attackValueScore = offer.buyerPrice > 0
    ? Number((attack / offer.buyerPrice).toFixed(6))
    : 0;

  const weaponQualitySpan = theoreticalMaxDamage - theoreticalMinDamage;
  const legacyWeaponQuality = weaponQualitySpan > 0
    ? Number(((candidateDamage - theoreticalMinDamage) / weaponQualitySpan).toFixed(6))
    : 1.0;
  const slotQuality = weaponAttackQuality;

  // Combat Deltas (maintained for informational / combat-model profiling)
  const damageGain = candidateDamage - currentDamage;
  const combatGainPerGold = Number((damageGain / offer.buyerPrice).toFixed(3));
  const damagePerGold = Number((candidateDamage / offer.buyerPrice).toFixed(2));

  let disposition = "UPGRADE";
  if (compareEquipped) {
    if (damageGain > 0) {
      disposition = "UPGRADE";
    } else if (damageGain === 0) {
      disposition = "SIDEGRADE";
    } else {
      disposition = "DOWNGRADE";
    }
  } else {
    disposition = "UPGRADE";
  }

  // Normalized combat improvement
  let normalizedImprovement = 0;
  if (damageGain > 0) {
    const maxPossibleGain = Math.max(1, maxTierDamage - currentDamage);
    normalizedImprovement = damageGain / maxPossibleGain;
  }
  const normalizedValueScore = Number((normalizedImprovement / offer.buyerPrice).toFixed(5));

  // Market Fairness Check for weapons (using weapon code legitimate offers)
  const compPrices = allOffersForCode
    .filter((o) => {
      const u = typeof o.user === "object" ? o.user?._id : o.user;
      return !excludeUserId || u !== excludeUserId;
    })
    .map((o) => Number(o.price))
    .filter((p) => p > 0);

  const compAnalysis = filterOutliers(compPrices);
  const confidence = compAnalysis.legitimate.length >= 8
    ? "HIGH"
    : compAnalysis.legitimate.length >= 3
    ? "MODERATE"
    : compAnalysis.legitimate.length >= 1
    ? "LOW"
    : "VERY LOW";

  const fairSellerPrice = compAnalysis.medianPrice || offer.sellerPrice || offer.buyerPrice || 1.0;
  const taxRate = offer.taxRate ?? 1;
  const fairBuyerPrice = Number((fairSellerPrice * (1 + taxRate / 100)).toFixed(3));

  const priceDiffPct = fairBuyerPrice > 0
    ? Number((((fairBuyerPrice - offer.buyerPrice) / fairBuyerPrice) * 100).toFixed(1))
    : 0;

  const isOverpriced =
    fairBuyerPrice > 0 &&
    offer.buyerPrice > fairBuyerPrice * 1.25 &&
    (confidence === "HIGH" || confidence === "MODERATE");

  return {
    ...offer,
    category: "weapon",
    slot: "weapon",
    rarity: weaponMeta.rarity,
    weaponType: weaponMeta.code,
    weaponName: weaponMeta.name,
    attack,
    criticalChance: crit,
    minAtk,
    maxAtk,
    minCrit,
    maxCrit,
    atkRoll: atkRoll.label,
    critRoll: critRoll.label,
    atkRollPercent: atkRoll.percent,
    critRollPercent: critRoll.percent,
    rollPercent: averageRollPercent,
    rarityRollPercent: averageRollPercent,
    rarityRollPercentExact: exactAverageRollPercent,
    absoluteMaxRatio,
    isPerfect,
    isPerfectRoll: isPerfect,
    rollPosition: isPerfect ? "PERFECT" : `${averageRollPercent}%`,
    currentDamage,
    candidateDamage,
    theoreticalMinDamage,
    theoreticalMaxDamage,
    minTierDamage: theoreticalMinDamage,
    maxTierDamage: theoreticalMaxDamage,
    weaponQuality: slotQuality,
    weaponAttackQuality,
    qualityScore: slotQuality,
    slotQuality,
    attackValueScore,
    valueScore: attackValueScore,
    damageGain,
    combatGainPerGold,
    damagePerGold,
    disposition,
    normalizedImprovement,
    normalizedValueScore,
    fairSellerPrice,
    fairBuyerPrice,
    priceDiffPct,
    isOverpriced,
    confidence,
    comparablesCount: {
      exact: compAnalysis.legitimate.length,
      near: 0,
      secondary: 0,
    },
  };
}

/**
 * Select the 3 key recommendations for a category:
 * - BEST VALUE
 * - BEST PERFORMANCE
 * - CHEAPEST UPGRADE
 *
 * Rules:
 * - DOWNGRADE items must NOT be selected as recommendations.
 * - Dominated offers can NEVER be Best Value.
 * - If an offer is materially overpriced, do not recommend as Best Value unless no reasonable alternatives exist.
 * - Returns null if no worthwhile upgrade exists.
 */
export function findCategoryRecommendations(evaluatedOffers = [], isWeapon = false) {
  if (!evaluatedOffers || evaluatedOffers.length === 0) {
    return {
      bestValue: null,
      bestPerformance: null,
      cheapestUpgrade: null,
      hasUpgrade: false,
    };
  }

  // Filter to eligible candidates (DOWNGRADE, SIDEGRADE, and INVALID LIVE RANGE are excluded from purchase recommendations)
  const upgrades = evaluatedOffers.filter(
    (o) =>
      !o.isInvalidRange &&
      o.disposition !== "INVALID LIVE RANGE" &&
      (!o.disposition || o.disposition === "UPGRADE" || o.disposition === "STANDALONE")
  );

  if (upgrades.length === 0) {
    return {
      bestValue: null,
      bestPerformance: null,
      cheapestUpgrade: null,
      hasUpgrade: false,
    };
  }

  let highestMarketCrit = null;
  let weaponUpgrades = upgrades;
  if (isWeapon) {
    highestMarketCrit = Math.max(
      ...upgrades.map((o) => o.criticalChance ?? o.skills?.criticalChance ?? 0)
    );
    weaponUpgrades = upgrades.filter(
      (o) => (o.criticalChance ?? o.skills?.criticalChance ?? 0) === highestMarketCrit
    );
    if (weaponUpgrades.length === 0) {
      return {
        bestValue: null,
        bestPerformance: null,
        cheapestUpgrade: null,
        highestMarketCrit,
        hasUpgrade: false,
      };
    }
  }

  // 1. Eliminate dominated offers among upgrades
  const utilityFn = isWeapon
    ? (o) => o.attack ?? o.skills?.attack ?? 0
    : (o) => o.statValue;
  const poolToPrune = isWeapon ? weaponUpgrades : upgrades;
  const { nonDominated } = eliminateDominatedOffers(poolToPrune, utilityFn, (o) => o.buyerPrice);

  const candidatePool = nonDominated.length > 0 ? nonDominated : poolToPrune;

  // 2. BEST VALUE
  // Among non-dominated offers:
  // First prefer non-overpriced offers if available
  const nonOverpriced = candidatePool.filter((o) => !o.isOverpriced);
  const bestValuePool = nonOverpriced.length > 0 ? nonOverpriced : candidatePool;

  const sortedForValue = [...bestValuePool].sort((a, b) => {
    if (isWeapon) {
      const getAtkVal = (o) => {
        if (o.attackValueScore !== undefined) return o.attackValueScore;
        const atk = o.attack ?? o.skills?.attack ?? 0;
        return o.buyerPrice > 0 ? atk / o.buyerPrice : 0;
      };
      const valA = getAtkVal(a);
      const valB = getAtkVal(b);
      if (Math.abs(valB - valA) > 1e-9) {
        return valB - valA;
      }
      // Tie breaker 1: higher Attack
      const atkA = a.attack ?? a.skills?.attack ?? 0;
      const atkB = b.attack ?? b.skills?.attack ?? 0;
      if (atkB !== atkA) {
        return atkB - atkA;
      }
      // Tie breaker 2: lower buyerPrice
      if (a.buyerPrice !== b.buyerPrice) {
        return a.buyerPrice - b.buyerPrice;
      }
      // Tie breaker 3: deterministic offer ID
      return String(a.offerId || a._id || "").localeCompare(String(b.offerId || b._id || ""));
    } else {
      // Check if every valid offer in pool has qualityScore === 0
      const allZeroQuality = bestValuePool.every((o) => {
        const q = o.qualityScore !== undefined ? o.qualityScore : (o.rollPercent === 0 ? 0 : null);
        return q === 0;
      });

      if (allZeroQuality) {
        // If every valid offer has qualityScore === 0:
        // choose the cheapest valid non-dominated offer.
        if (a.buyerPrice !== b.buyerPrice) {
          return a.buyerPrice - b.buyerPrice;
        }
        if (b.statValue !== a.statValue) {
          return b.statValue - a.statValue;
        }
        return String(a.offerId || "").localeCompare(String(b.offerId || ""));
      }

      // Canonical Best Value for single-stat gear (Requirement 1):
      // valueScore = qualityScore / buyerPrice
      const valA = a.valueScore ?? (a.qualityScore !== undefined ? a.qualityScore / a.buyerPrice : a.statPerGold ?? (a.statValue / a.buyerPrice));
      const valB = b.valueScore ?? (b.qualityScore !== undefined ? b.qualityScore / b.buyerPrice : b.statPerGold ?? (b.statValue / b.buyerPrice));

      if (Math.abs(valB - valA) > 1e-9) {
        return valB - valA;
      }

      // Tie breakers (Requirement 1):
      // 1. higher qualityScore
      const qA = a.qualityScore ?? (a.rollPercent !== undefined ? a.rollPercent / 100 : 0);
      const qB = b.qualityScore ?? (b.rollPercent !== undefined ? b.rollPercent / 100 : 0);
      if (Math.abs(qB - qA) > 1e-9) {
        return qB - qA;
      }

      // 2. lower buyerPrice
      if (a.buyerPrice !== b.buyerPrice) {
        return a.buyerPrice - b.buyerPrice;
      }

      // 3. higher raw statValue
      if (b.statValue !== a.statValue) {
        return b.statValue - a.statValue;
      }

      // 4. deterministic offer ID
      return String(a.offerId || "").localeCompare(String(b.offerId || ""));
    }
  });
  const bestValue = sortedForValue[0] || null;

  // 3. BEST PERFORMANCE
  // Highest raw Attack among max-Crit weapons / highest raw statValue among armor upgrades.
  // Tiebreak: lowest price, deterministic offer ID.
  const perfPool = isWeapon ? weaponUpgrades : upgrades;
  const sortedForPerf = [...perfPool].sort((a, b) => {
    if (isWeapon) {
      const atkA = a.attack ?? a.skills?.attack ?? 0;
      const atkB = b.attack ?? b.skills?.attack ?? 0;
      if (atkB !== atkA) {
        return atkB - atkA;
      }
      if (a.buyerPrice !== b.buyerPrice) {
        return a.buyerPrice - b.buyerPrice;
      }
      return String(a.offerId || a._id || "").localeCompare(String(b.offerId || b._id || ""));
    } else {
      if (b.statValue !== a.statValue) {
        return b.statValue - a.statValue;
      }
      if (a.buyerPrice !== b.buyerPrice) {
        return a.buyerPrice - b.buyerPrice;
      }
      return String(a.offerId || "").localeCompare(String(b.offerId || ""));
    }
  });
  const bestPerformance = sortedForPerf[0] || null;

  // 4. CHEAPEST UPGRADE
  // Lowest buyerPrice among max-Crit weapons / all armor upgrades.
  // Tiebreak: higher raw attack/stat, deterministic offer ID.
  const cheapPool = isWeapon ? weaponUpgrades : upgrades;
  const sortedForCheapest = [...cheapPool].sort((a, b) => {
    if (a.buyerPrice !== b.buyerPrice) {
      return a.buyerPrice - b.buyerPrice;
    }
    if (isWeapon) {
      const atkA = a.attack ?? a.skills?.attack ?? 0;
      const atkB = b.attack ?? b.skills?.attack ?? 0;
      if (atkB !== atkA) {
        return atkB - atkA;
      }
      return String(a.offerId || a._id || "").localeCompare(String(b.offerId || b._id || ""));
    }
    if (b.statValue !== a.statValue) {
      return b.statValue - a.statValue;
    }
    return String(a.offerId || "").localeCompare(String(b.offerId || ""));
  });
  const cheapestUpgrade = sortedForCheapest[0] || null;

  return {
    bestValue,
    bestPerformance,
    cheapestUpgrade,
    highestMarketCrit: isWeapon ? highestMarketCrit : undefined,
    hasUpgrade: true,
  };
}

/**
 * Select specific recommendation from category results based on strategy:
 * 'best-value' | 'best-performance' | 'cheapest-upgrade'
 */
export function selectRecommendationByStrategy(recommendations, strategy = "best-value") {
  if (!recommendations || recommendations.hasUpgrade === false) return null;
  const s = (strategy || "best-value").toLowerCase().trim();
  if (s === "best-performance" || s === "performance") {
    return recommendations.bestPerformance || recommendations.bestValue || null;
  }
  if (s === "cheapest-upgrade" || s === "cheapest") {
    return recommendations.cheapestUpgrade || recommendations.bestValue || null;
  }
  return recommendations.bestValue || null;
}

/**
 * Determine the overall Best Purchase across all analyzed categories under the active strategy.
 */
export function findOverallBestValue(categoryResults = {}, strategy = "best-value") {
  const candidates = [];

  for (const [category, res] of Object.entries(categoryResults)) {
    const chosen = selectRecommendationByStrategy(res?.recommendations, strategy);
    if (chosen) {
      candidates.push({
        category,
        offer: chosen,
        strategy,
        normalizedValueScore: chosen.normalizedValueScore || 0,
      });
    }
  }

  if (candidates.length === 0) return null;

  const s = (strategy || "best-value").toLowerCase().trim();
  if (s === "best-performance" || s === "performance") {
    // Rank by combat output / roll percentage
    candidates.sort((a, b) => {
      if (a.offer.category === "weapon" && b.offer.category === "weapon") {
        return (b.offer.attack || 0) - (a.offer.attack || 0);
      }
      return (b.offer.rollPercent || 0) - (a.offer.rollPercent || 0);
    });
  } else if (s === "cheapest-upgrade" || s === "cheapest") {
    // Rank by lowest buyer price
    candidates.sort((a, b) => a.offer.buyerPrice - b.offer.buyerPrice);
  } else {
    // Default best-value: normalizedValueScore descending
    candidates.sort((a, b) => b.normalizedValueScore - a.normalizedValueScore);
  }

  return candidates[0];
}

export const SLOT_LABELS = {
  helmet: "Helmet",
  chest: "Chest",
  gloves: "Gloves",
  pants: "Pants",
  boots: "Boots",
  weapon: "Weapon",
};

/**
 * Format stat name to compact display label.
 */
export function formatStatShort(statName) {
  switch (statName) {
    case "criticalDamages":
      return "CritDmg";
    case "armor":
      return "Armor";
    case "precision":
      return "Precision";
    case "dodge":
      return "Dodge";
    case "attack":
      return "Attack";
    case "criticalChance":
      return "Crit";
    default:
      return statName || "";
  }
}

/**
 * Helper to ensure candidates have normalized slotQuality in [0, 1] and valueScore.
 */
function ensureCandidateSlotQuality(offer, slot, pool) {
  let slotQuality = offer.slotQuality;
  if (slotQuality === undefined) {
    if (slot === "weapon") {
      if (offer.weaponAttackQuality !== undefined) {
        slotQuality = offer.weaponAttackQuality;
      } else if (offer.minAtk !== undefined && offer.maxAtk !== undefined) {
        const span = offer.maxAtk - offer.minAtk;
        const atk = offer.attack ?? offer.skills?.attack ?? 0;
        slotQuality = span > 0 ? (atk - offer.minAtk) / span : 1.0;
      } else if (offer.weaponQuality !== undefined) {
        slotQuality = offer.weaponQuality;
      } else {
        slotQuality = 0;
      }
    } else if (offer.qualityScore !== undefined) {
      slotQuality = offer.qualityScore;
    } else if (offer.minPossibleStat !== undefined && offer.maxPossibleStat !== undefined) {
      const span = offer.maxPossibleStat - offer.minPossibleStat;
      slotQuality = span > 0 ? (offer.statValue - offer.minPossibleStat) / span : 1.0;
    } else if (offer.rollPercent !== undefined) {
      slotQuality = offer.rollPercent / 100;
    } else {
      const stats = pool.map((o) => o.statValue || 0);
      const minS = Math.min(...stats);
      const maxS = Math.max(...stats);
      slotQuality = maxS > minS ? ((offer.statValue || 0) - minS) / (maxS - minS) : 1.0;
    }
  }
  slotQuality = Math.max(0, Math.min(1, Number(slotQuality)));
  offer.slotQuality = Number(slotQuality.toFixed(6));
  if (slot === "weapon") {
    offer.weaponQuality = offer.slotQuality;
    offer.weaponAttackQuality = offer.slotQuality;
  }

  if (offer.valueScore === undefined) {
    if (slot === "weapon") {
      const atk = offer.attack ?? offer.skills?.attack ?? 0;
      offer.valueScore = offer.attackValueScore ?? (offer.buyerPrice > 0 ? Number((atk / offer.buyerPrice).toFixed(6)) : 0);
    } else {
      offer.valueScore = offer.buyerPrice > 0 ? Number((offer.slotQuality / offer.buyerPrice).toFixed(6)) : 0;
    }
  }

  return offer;
}

/**
 * Compare two candidate combos for deterministic offer ordering.
 */
function compareOfferCombos(comboA, comboB) {
  for (let i = 0; i < comboA.length; i++) {
    const idA = String(comboA[i].offer?.offerId || "");
    const idB = String(comboB[i].offer?.offerId || "");
    const cmp = idA.localeCompare(idB);
    if (cmp !== 0) return cmp;
  }
  return 0;
}

/**
 * Optimize a complete loadout across requested slots subject to a total budget.
 * Uses branch-and-bound pruning across non-dominated candidate shortlists.
 *
 * Invariant: Never sums raw unlike stats across slots.
 * Optimizes whole-set loadout quality: maximize sum(slotQuality) in [0, 1] per slot subject to sum(buyerPrice) <= budget.
 * Tie breakers:
 * 1. higher total normalized quality
 * 2. lower total buyer price
 * 3. higher aggregate market discount
 * 4. deterministic offer ordering
 *
 * @param {Object} candidatePoolsBySlot - { [slot]: Array<Offer> }
 * @param {number|null} budget - Max Gold to spend across the entire set (null if unconstrained)
/**
 * Helper to format a complete loadout combination result.
 */
function formatLoadoutResult(combo, minTotalCost, slotCount) {
  let totalCost = 0;
  let totalStats = 0;
  let totalQuality = 0;
  let totalDiscount = 0;
  let totalValueScore = 0;
  const items = combo.map(({ slot, offer }) => {
    totalCost += offer.buyerPrice;
    totalQuality += (offer.slotQuality || 0);
    totalValueScore += (offer.valueScore || 0);
    const fairP = offer.fairBuyerPrice || offer.buyerPrice;
    totalDiscount += (fairP - offer.buyerPrice);
    if (slot !== "weapon") {
      totalStats += (offer.statValue || 0);
    }
    return {
      slot,
      offer,
      cost: offer.buyerPrice,
    };
  });

  totalCost = Number(totalCost.toFixed(3));
  totalQuality = Number(totalQuality.toFixed(4));
  totalDiscount = Number(totalDiscount.toFixed(3));
  totalValueScore = Number(totalValueScore.toFixed(6));
  const maxPossibleQuality = slotCount;
  const avgQualityPercent = maxPossibleQuality > 0
    ? Number(((totalQuality / maxPossibleQuality) * 100).toFixed(1))
    : 0;

  return {
    feasible: true,
    minRequiredBudget: minTotalCost,
    items,
    totalCost,
    totalStats,
    totalQuality,
    totalDiscount,
    totalValueScore,
    maxPossibleQuality,
    avgQualityPercent,
  };
}

/**
 * Optimize a complete loadout across requested slots subject to a total budget.
 * Uses branch-and-bound pruning across non-dominated candidate shortlists.
 *
 * Invariant: Never sums raw unlike stats across slots.
 *
 * Budget Semantics:
 * --budget is a CEILING, NOT a spending target.
 * 1. Build the requested strategy's normal unconstrained loadout.
 * 2. If its total cost <= budget: RETURN IT UNCHANGED.
 * 3. Only invoke constrained optimization if unconstrained cost exceeds budget.
 *
 * Strategy-Aware Constrained Objectives (when unconstrained cost > budget):
 * - BEST VALUE: maximize aggregate per-slot valueScore subject to sum(cost) <= budget.
 *   Tie breakers: higher total loadout quality -> lower total cost -> larger aggregate discount -> deterministic offer IDs.
 * - BEST PERFORMANCE: maximize total normalized slot quality subject to sum(cost) <= budget.
 *   Tie breakers: lower total cost -> larger aggregate discount -> deterministic offer IDs.
 * - CHEAPEST: choose cheapest valid complete set.
 *
 * @param {Object} candidatePoolsBySlot - { [slot]: Array<Offer> }
 * @param {number|null} budget - Max Gold to spend across the entire set (null if unconstrained)
 * @param {string} strategy - 'best-value' | 'best-performance' | 'cheapest'
 * @returns {Object} { feasible, minRequiredBudget, items, totalCost, totalStats, totalQuality, maxPossibleQuality, avgQualityPercent }
 */
export function optimizeLoadoutUnderBudget(candidatePoolsBySlot, budget = null, strategy = "best-value") {
  const slots = Object.keys(candidatePoolsBySlot).filter(
    (s) => candidatePoolsBySlot[s] && candidatePoolsBySlot[s].length > 0
  );

  if (slots.length === 0) {
    return {
      feasible: false,
      minRequiredBudget: 0,
      items: [],
      totalCost: 0,
      totalStats: 0,
      totalQuality: 0,
      maxPossibleQuality: 0,
      avgQualityPercent: 0,
    };
  }

  // Ensure candidates in each slot are normalized, non-dominated, and sorted by price ascending
  const slotCandidates = {};
  let minTotalCost = 0;

  for (const slot of slots) {
    const rawList = candidatePoolsBySlot[slot];
    for (const cand of rawList) {
      ensureCandidateSlotQuality(cand, slot, rawList);
    }
    const isWep = slot === "weapon";
    const utilityFn = isWep ? (o) => (o.attack ?? o.skills?.attack ?? 0) : (o) => o.statValue || 0;
    const { nonDominated } = eliminateDominatedOffers(rawList, utilityFn, (o) => o.buyerPrice);
    const pool = (nonDominated.length > 0 ? nonDominated : rawList).slice();
    pool.sort((a, b) => a.buyerPrice - b.buyerPrice);
    slotCandidates[slot] = pool;
    minTotalCost += pool[0].buyerPrice;
  }

  minTotalCost = Number(minTotalCost.toFixed(3));

  // Feasibility check: budget cannot afford even the cheapest possible set
  if (budget !== null && budget !== undefined && budget < minTotalCost - 1e-6) {
    return {
      feasible: false,
      minRequiredBudget: minTotalCost,
      items: null,
      totalCost: 0,
      totalStats: 0,
      totalQuality: 0,
      maxPossibleQuality: slots.length,
      avgQualityPercent: 0,
    };
  }

  const strat = (strategy || "best-value").toLowerCase().trim();

  // Helper to build the unconstrained loadout for a strategy
  function buildUnconstrained(targetStrat) {
    const combo = [];
    for (const slot of slots) {
      const candidates = slotCandidates[slot];
      const isWep = slot === "weapon";

      if (targetStrat === "best-performance" || targetStrat === "performance") {
        const sorted = [...candidates].sort((a, b) => {
          const statA = isWep ? (a.attack ?? a.skills?.attack ?? 0) : (a.statValue || 0);
          const statB = isWep ? (b.attack ?? b.skills?.attack ?? 0) : (b.statValue || 0);
          if (statB !== statA) return statB - statA;
          if (a.buyerPrice !== b.buyerPrice) return a.buyerPrice - b.buyerPrice;
          return String(a.offerId || a._id || "").localeCompare(String(b.offerId || b._id || ""));
        });
        combo.push({ slot, offer: sorted[0] });
      } else if (targetStrat === "cheapest" || targetStrat === "cheapest-upgrade") {
        const sorted = [...candidates].sort((a, b) => {
          if (a.buyerPrice !== b.buyerPrice) return a.buyerPrice - b.buyerPrice;
          const statA = isWep ? (a.attack ?? a.skills?.attack ?? 0) : (a.statValue || 0);
          const statB = isWep ? (b.attack ?? b.skills?.attack ?? 0) : (b.statValue || 0);
          if (statB !== statA) return statB - statA;
          return String(a.offerId || a._id || "").localeCompare(String(b.offerId || b._id || ""));
        });
        combo.push({ slot, offer: sorted[0] });
      } else {
        // Default best-value:
        const sorted = [...candidates].sort((a, b) => {
          if (isWep) {
            const valA = a.attackValueScore ?? (a.buyerPrice > 0 ? (a.attack ?? a.skills?.attack ?? 0) / a.buyerPrice : 0);
            const valB = b.attackValueScore ?? (b.buyerPrice > 0 ? (b.attack ?? b.skills?.attack ?? 0) / b.buyerPrice : 0);
            if (Math.abs(valB - valA) > 1e-9) {
              return valB - valA;
            }
            const atkA = a.attack ?? a.skills?.attack ?? 0;
            const atkB = b.attack ?? b.skills?.attack ?? 0;
            if (atkB !== atkA) return atkB - atkA;
            if (a.buyerPrice !== b.buyerPrice) return a.buyerPrice - b.buyerPrice;
            return String(a.offerId || a._id || "").localeCompare(String(b.offerId || b._id || ""));
          } else {
            const allZero = candidates.every((o) => o.slotQuality === 0);
            if (allZero) {
              if (a.buyerPrice !== b.buyerPrice) return a.buyerPrice - b.buyerPrice;
              if (b.statValue !== a.statValue) return b.statValue - a.statValue;
              return String(a.offerId || "").localeCompare(String(b.offerId || ""));
            }
            if (Math.abs(b.valueScore - a.valueScore) > 1e-9) return b.valueScore - a.valueScore;
            if (Math.abs(b.slotQuality - a.slotQuality) > 1e-9) return b.slotQuality - a.slotQuality;
            if (a.buyerPrice !== b.buyerPrice) return a.buyerPrice - b.buyerPrice;
            if (b.statValue !== a.statValue) return b.statValue - a.statValue;
            return String(a.offerId || "").localeCompare(String(b.offerId || ""));
          }
        });
        combo.push({ slot, offer: sorted[0] });
      }
    }
    return combo;
  }

  // 1. Build normal unconstrained loadout
  const unconstrainedCombo = buildUnconstrained(strat);
  const unconstrainedCost = Number(unconstrainedCombo.reduce((sum, it) => sum + it.offer.buyerPrice, 0).toFixed(3));

  // 2. Budget is a ceiling, NOT a spending target:
  // If unconstrained loadout cost <= budget, RETURN IT UNCHANGED!
  if (budget === null || budget === undefined || unconstrainedCost <= budget + 1e-6) {
    return formatLoadoutResult(unconstrainedCombo, minTotalCost, slots.length);
  }

  // 3. Constrained optimization (unconstrained loadout exceeds budget):
  let bestCombo = null;

  if (strat === "cheapest" || strat === "cheapest-upgrade") {
    // Cheapest set under budget
    bestCombo = slots.map((slot) => ({ slot, offer: slotCandidates[slot][0] }));
  } else if (strat === "best-performance" || strat === "performance") {
    // Constrained BEST PERFORMANCE:
    // Maximize total normalized slot quality under budget.
    // Tie breakers: lower total cost -> larger aggregate discount -> deterministic offer IDs
    const minRemainingCost = [];
    const maxRemainingQuality = [];
    for (let i = slots.length - 1; i >= 0; i--) {
      const slot = slots[i];
      const cheapestP = slotCandidates[slot][0].buyerPrice;
      minRemainingCost[i] = cheapestP + (minRemainingCost[i + 1] || 0);

      const maxQ = Math.max(...slotCandidates[slot].map((c) => c.slotQuality || 0));
      maxRemainingQuality[i] = maxQ + (maxRemainingQuality[i + 1] || 0);
    }

    let bestQuality = -Infinity;
    let bestCost = Infinity;
    let bestDiscount = -Infinity;

    function searchPerf(slotIdx, currentCost, currentQuality, currentDiscount, currentCombo) {
      if (currentCost + (minRemainingCost[slotIdx] || 0) > budget + 1e-6) return;
      if (bestCombo && currentQuality + (maxRemainingQuality[slotIdx] || 0) < bestQuality - 1e-6) return;

      if (slotIdx === slots.length) {
        let update = false;
        if (!bestCombo) {
          update = true;
        } else if (currentQuality > bestQuality + 1e-6) {
          update = true;
        } else if (Math.abs(currentQuality - bestQuality) <= 1e-6) {
          if (currentCost < bestCost - 1e-6) {
            update = true;
          } else if (Math.abs(currentCost - bestCost) <= 1e-6) {
            if (currentDiscount > bestDiscount + 1e-6) {
              update = true;
            } else if (Math.abs(currentDiscount - bestDiscount) <= 1e-6) {
              if (compareOfferCombos(currentCombo, bestCombo) < 0) {
                update = true;
              }
            }
          }
        }

        if (update) {
          bestQuality = currentQuality;
          bestCost = currentCost;
          bestDiscount = currentDiscount;
          bestCombo = [...currentCombo];
        }
        return;
      }

      const slot = slots[slotIdx];
      for (const cand of slotCandidates[slot]) {
        const p = cand.buyerPrice;
        const q = cand.slotQuality || 0;
        const fairP = cand.fairBuyerPrice || cand.buyerPrice;
        const disc = fairP - cand.buyerPrice;

        currentCombo.push({ slot, offer: cand });
        searchPerf(slotIdx + 1, currentCost + p, currentQuality + q, currentDiscount + disc, currentCombo);
        currentCombo.pop();
      }
    }

    searchPerf(0, 0, 0, 0, []);
  } else {
    // Constrained BEST VALUE:
    // Maximize aggregate per-slot valueScore:
    // gear: qualityScore / buyerPrice
    // weapon: combatGainPerGold (or weaponQuality / buyerPrice)
    // subject to: totalBuyerPrice <= budget
    // Tie breakers:
    // 1. higher total normalized loadout quality (totalQuality)
    // 2. lower total cost
    // 3. larger aggregate market discount
    // 4. deterministic offer IDs
    const minRemainingCost = [];
    const maxRemainingValueScore = [];
    for (let i = slots.length - 1; i >= 0; i--) {
      const slot = slots[i];
      const cheapestP = slotCandidates[slot][0].buyerPrice;
      minRemainingCost[i] = cheapestP + (minRemainingCost[i + 1] || 0);

      const maxV = Math.max(...slotCandidates[slot].map((c) => c.valueScore || 0));
      maxRemainingValueScore[i] = maxV + (maxRemainingValueScore[i + 1] || 0);
    }

    let bestValueScore = -Infinity;
    let bestQuality = -Infinity;
    let bestCost = Infinity;
    let bestDiscount = -Infinity;

    function searchVal(slotIdx, currentCost, currentValueScore, currentQuality, currentDiscount, currentCombo) {
      if (currentCost + (minRemainingCost[slotIdx] || 0) > budget + 1e-6) return;
      if (bestCombo && currentValueScore + (maxRemainingValueScore[slotIdx] || 0) < bestValueScore - 1e-9) return;

      if (slotIdx === slots.length) {
        let update = false;
        if (!bestCombo) {
          update = true;
        } else if (currentValueScore > bestValueScore + 1e-9) {
          update = true;
        } else if (Math.abs(currentValueScore - bestValueScore) <= 1e-9) {
          // Tie breaker 1: higher total normalized loadout quality
          if (currentQuality > bestQuality + 1e-6) {
            update = true;
          } else if (Math.abs(currentQuality - bestQuality) <= 1e-6) {
            // Tie breaker 2: lower total cost
            if (currentCost < bestCost - 1e-6) {
              update = true;
            } else if (Math.abs(currentCost - bestCost) <= 1e-6) {
              // Tie breaker 3: larger aggregate market discount
              if (currentDiscount > bestDiscount + 1e-6) {
                update = true;
              } else if (Math.abs(currentDiscount - bestDiscount) <= 1e-6) {
                // Tie breaker 4: deterministic offer IDs
                if (compareOfferCombos(currentCombo, bestCombo) < 0) {
                  update = true;
                }
              }
            }
          }
        }

        if (update) {
          bestValueScore = currentValueScore;
          bestQuality = currentQuality;
          bestCost = currentCost;
          bestDiscount = currentDiscount;
          bestCombo = [...currentCombo];
        }
        return;
      }

      const slot = slots[slotIdx];
      for (const cand of slotCandidates[slot]) {
        const p = cand.buyerPrice;
        const v = cand.valueScore || 0;
        const q = cand.slotQuality || 0;
        const fairP = cand.fairBuyerPrice || cand.buyerPrice;
        const disc = fairP - cand.buyerPrice;

        currentCombo.push({ slot, offer: cand });
        searchVal(slotIdx + 1, currentCost + p, currentValueScore + v, currentQuality + q, currentDiscount + disc, currentCombo);
        currentCombo.pop();
      }
    }

    searchVal(0, 0, 0, 0, 0, []);
  }

  if (!bestCombo) {
    return {
      feasible: false,
      minRequiredBudget: minTotalCost,
      items: null,
      totalCost: 0,
      totalStats: 0,
      totalQuality: 0,
      maxPossibleQuality: slots.length,
      avgQualityPercent: 0,
    };
  }

  return formatLoadoutResult(bestCombo, minTotalCost, slots.length);
}

const STRATEGY_DISPLAY_NAMES = {
  "best-value": "BEST VALUE",
  "best-performance": "BEST PERFORMANCE",
  "cheapest": "CHEAPEST",
};

export function normalizeStrategyKey(s) {
  const k = (s || "best-value").toLowerCase().trim();
  if (k === "best-performance" || k === "performance") return "best-performance";
  if (k === "cheapest" || k === "cheapest-upgrade") return "cheapest";
  return "best-value";
}

/**
 * Build one complete, coherent shopping loadout across all requested slots.
 * Computes the selected loadout under the chosen strategy and budget, plus
 * alternative sets for comparison.
 *
 * Strict Invariant:
 * The selected strategy, main table, total cost, offer IDs, and Alternative Loadouts
 * (Selected) marker MUST describe the exact same set.
 */
/**
 * Helper to format raw combo items ({ slot, offer }) into fully populated loadout items.
 */
export function formatLoadoutItems(comboItems, categoryResults, compareEquipped = false) {
  let totalMarketValue = 0;
  const items = (comboItems || []).map(({ slot, offer }) => {
    const res = categoryResults[slot] || {};
    const rangeInfo = res.rangeInfo || {};
    const fairBuyerPrice = offer.fairBuyerPrice || offer.buyerPrice;
    totalMarketValue += fairBuyerPrice;

    let statDisplay = "";
    let rollDisplay = "";
    let rangeDisplay = "";
    if (slot === "weapon") {
      statDisplay = `+${offer.attack || 0} Atk / +${offer.criticalChance || 0}% Crit`;
      rangeDisplay = `${offer.minAtk || 0}-${offer.maxAtk || 0} / ${offer.minCrit || 0}-${offer.maxCrit || 0}`;
      const isPerfectAtk = offer.maxAtk !== undefined && offer.attack === offer.maxAtk;
      const isPerfectCrit = offer.maxCrit !== undefined && offer.criticalChance === offer.maxCrit;
      const atkRollStr = isPerfectAtk ? "PERFECT" : `${offer.atkRollPercent ?? 0}%`;
      const critStr = isPerfectCrit ? "PERFECT / MAX MARKET" : "MAX MARKET";
      rollDisplay = `Atk Roll ${atkRollStr} | Crit ${critStr}`;
    } else {
      const shortName = formatStatShort(offer.statName || rangeInfo.statName);
      statDisplay = `+${offer.statValue} ${shortName}`;
      const minBound = offer.minPossibleStat ?? rangeInfo.minPossibleStat;
      const maxBound = offer.maxPossibleStat ?? rangeInfo.maxPossibleStat;
      rangeDisplay = minBound !== undefined && maxBound !== undefined ? `${minBound}-${maxBound}` : "";
      rollDisplay = offer.isPerfectRoll ? "PERFECT" : `${offer.rollPercent || 0}%`;
    }

    return {
      slot,
      slotLabel: SLOT_LABELS[slot] || slot,
      offer,
      statDisplay,
      rangeDisplay,
      rollDisplay,
      cost: offer.buyerPrice,
      sellerPrice: offer.sellerPrice,
      taxRate: offer.taxRate,
      fairBuyerPrice,
      discount: Number((fairBuyerPrice - offer.buyerPrice).toFixed(3)),
      confidence: offer.confidence,
      isOverpriced: offer.isOverpriced,
      compareEquipped,
      disposition: offer.disposition,
      statDiff: offer.statDiff,
      equippedStat: offer.equippedStat,
      minPossibleStat: offer.minPossibleStat ?? rangeInfo.minPossibleStat,
      maxPossibleStat: offer.maxPossibleStat ?? rangeInfo.maxPossibleStat,
    };
  });

  return { items, totalMarketValue: Number(totalMarketValue.toFixed(3)) };
}

export function buildFullLoadout(categoryResults = {}, options = {}) {
  const {
    strategy = "best-value",
    budget = null,
    activeCategories = [],
    rarity = "common",
    rarityDisplayName = "Grey",
    compareEquipped = false,
  } = options;

  const validSlots = activeCategories.filter(
    (cat) => categoryResults[cat] && categoryResults[cat].evaluatedOffers?.length > 0
  );

  // Extract candidate pools per slot
  const candidatePoolsBySlot = {};
  for (const slot of validSlots) {
    const res = categoryResults[slot];
    const isWep = slot === "weapon";
    let offers = (res.evaluatedOffers || []).slice();
    if (isWep) {
      // Filter strictly to highestMarketCrit offers
      const validWeps = offers.filter(
        (o) => !o.isInvalidRange && o.disposition !== "INVALID LIVE RANGE"
      );
      if (validWeps.length > 0) {
        const highestCrit = Math.max(
          ...validWeps.map((o) => o.criticalChance ?? o.skills?.criticalChance ?? 0)
        );
        offers = validWeps.filter(
          (o) => (o.criticalChance ?? o.skills?.criticalChance ?? 0) === highestCrit
        );
      }
    }
    const utilityFn = isWep
      ? (o) => o.attack ?? o.skills?.attack ?? 0
      : (o) => o.statValue || 0;
    const { nonDominated } = eliminateDominatedOffers(offers, utilityFn, (o) => o.buyerPrice);
    candidatePoolsBySlot[slot] = nonDominated.length > 0 ? nonDominated : offers;
  }

  const normStrategy = normalizeStrategyKey(strategy);

  // 1. Optimize selected strategy under budget (or unconstrained)
  const selectedResult = optimizeLoadoutUnderBudget(candidatePoolsBySlot, budget, normStrategy);

  if (!selectedResult.feasible) {
    return {
      feasible: false,
      rarity,
      rarityDisplayName,
      strategy: normStrategy,
      budget,
      minRequiredBudget: selectedResult.minRequiredBudget,
      items: [],
      totalCost: 0,
      totalMarketValue: 0,
      totalDiscount: 0,
      totalStats: 0,
      totalQuality: 0,
      maxPossibleQuality: validSlots.length,
      avgQualityPercent: 0,
      offersSelected: 0,
      offerIds: [],
      alternativeSets: {},
    };
  }

  // 2. Format items in selected loadout
  const { items, totalMarketValue } = formatLoadoutItems(selectedResult.items, categoryResults, compareEquipped);
  const totalCost = selectedResult.totalCost;
  const totalDiscount = Number((totalMarketValue - totalCost).toFixed(3));
  const selectedOfferIds = items.map((it) => it.offer.offerId || it.offer._id);

  // Explicit selectedLoadout object
  const selectedLoadout = {
    feasible: true,
    rarity,
    rarityDisplayName,
    strategy: normStrategy,
    strategyDisplayName: STRATEGY_DISPLAY_NAMES[normStrategy] || normStrategy,
    budget,
    items,
    totalCost,
    totalMarketValue,
    totalDiscount,
    totalStats: selectedResult.totalStats,
    totalQuality: selectedResult.totalQuality,
    maxPossibleQuality: selectedResult.maxPossibleQuality,
    avgQualityPercent: selectedResult.avgQualityPercent,
    offersSelected: items.length,
    offerIds: selectedOfferIds,
  };

  // 3. Compute Alternative Sets under active budget ceiling
  const alternativeSets = {};
  const allStrategies = ["best-value", "best-performance", "cheapest"];

  for (const sKey of allStrategies) {
    if (sKey === normStrategy) {
      // For the active strategy, the alternative entry is selectedLoadout itself
      alternativeSets[sKey] = {
        name: STRATEGY_DISPLAY_NAMES[sKey],
        strategyKey: sKey,
        feasible: true,
        totalCost: selectedLoadout.totalCost,
        totalStats: selectedLoadout.totalStats,
        totalQuality: selectedLoadout.totalQuality,
        avgQualityPercent: selectedLoadout.avgQualityPercent,
        items: selectedLoadout.items,
        offerIds: [...selectedLoadout.offerIds],
        isSelected: true,
        loadout: selectedLoadout,
      };
    } else {
      const altOpt = optimizeLoadoutUnderBudget(candidatePoolsBySlot, budget, sKey);
      if (altOpt.feasible && altOpt.items) {
        const { items: altItems, totalMarketValue: altMktVal } = formatLoadoutItems(
          altOpt.items,
          categoryResults,
          compareEquipped
        );
        const altCost = altOpt.totalCost;
        const altDisc = Number((altMktVal - altCost).toFixed(3));
        const altOfferIds = altItems.map((it) => it.offer.offerId || it.offer._id);
        const altLoadoutObj = {
          feasible: true,
          rarity,
          rarityDisplayName,
          strategy: sKey,
          strategyDisplayName: STRATEGY_DISPLAY_NAMES[sKey] || sKey,
          budget,
          items: altItems,
          totalCost: altCost,
          totalMarketValue: altMktVal,
          totalDiscount: altDisc,
          totalStats: altOpt.totalStats,
          totalQuality: altOpt.totalQuality,
          maxPossibleQuality: altOpt.maxPossibleQuality,
          avgQualityPercent: altOpt.avgQualityPercent,
          offersSelected: altItems.length,
          offerIds: altOfferIds,
        };
        alternativeSets[sKey] = {
          name: STRATEGY_DISPLAY_NAMES[sKey],
          strategyKey: sKey,
          feasible: true,
          totalCost: altCost,
          totalStats: altOpt.totalStats,
          totalQuality: altOpt.totalQuality,
          avgQualityPercent: altOpt.avgQualityPercent,
          items: altItems,
          offerIds: altOfferIds,
          isSelected: false,
          loadout: altLoadoutObj,
        };
      } else {
        alternativeSets[sKey] = {
          name: STRATEGY_DISPLAY_NAMES[sKey],
          strategyKey: sKey,
          feasible: false,
          totalCost: 0,
          totalStats: 0,
          totalQuality: 0,
          avgQualityPercent: 0,
          items: [],
          offerIds: [],
          isSelected: false,
          loadout: null,
        };
      }
    }
  }

  // 4. Strict Invariant Assertions
  // Assertion 1: Exactly ONE alternative entry says isSelected === true
  const selectedAlts = Object.values(alternativeSets).filter((a) => a.isSelected);
  if (selectedAlts.length !== 1) {
    throw new Error(
      `INTERNAL LOADOUT SELECTION MISMATCH: Expected exactly 1 alternative marked (Selected), got ${selectedAlts.length}.`
    );
  }
  const selectedAlternative = selectedAlts[0];

  // Assertion 2: selectedAlternative.totalCost === selectedLoadout.totalCost within currency precision (0.001 G)
  if (Math.abs(selectedAlternative.totalCost - selectedLoadout.totalCost) > 0.001) {
    throw new Error(
      `INTERNAL LOADOUT SELECTION MISMATCH: Selected alternative total cost (${selectedAlternative.totalCost}) does not match selected loadout total cost (${selectedLoadout.totalCost}).`
    );
  }

  // Assertion 3: exact ordered/set equality of offer IDs
  const altIds = selectedAlternative.offerIds.slice().sort().join(",");
  const mainIds = selectedLoadout.offerIds.slice().sort().join(",");
  if (altIds !== mainIds) {
    throw new Error(
      `INTERNAL LOADOUT SELECTION MISMATCH: Selected alternative offer IDs [${altIds}] do not match selected loadout offer IDs [${mainIds}].`
    );
  }

  // Assertion 4: Unconstrained Best Performance MUST select raw market maximum for gear slots (Section 4)
  if (!budget && alternativeSets["best-performance"]?.feasible) {
    for (const it of alternativeSets["best-performance"].items) {
      if (it.slot !== "weapon" && categoryResults[it.slot]?.rawMarketMaxStat !== undefined && categoryResults[it.slot]?.rawMarketMaxStat !== null) {
        const expectedMax = categoryResults[it.slot].rawMarketMaxStat;
        const actualStat = it.offer.statValue;
        if (actualStat !== expectedMax) {
          throw new Error(
            `BEST PERFORMANCE INVARIANT VIOLATION: Slot ${it.slot} selected stat +${actualStat}, but raw market max is +${expectedMax}.`
          );
        }
      }
    }
  }

  for (const alt of Object.values(alternativeSets)) {
    if (alt.feasible) {
      alt.summary = formatAlternativeSummary(alt, selectedLoadout);
    }
  }

  return {
    ...selectedLoadout,
    selectedLoadout,
    alternativeSets,
  };
}

/**
 * Format alternative summary explanation comparing an alternative loadout against the selected loadout.
 * Determines whether exact offer IDs match, format the market-max stats summary, and format comparison diffs.
 */
export function formatAlternativeSummary(alt, loadout) {
  if (!alt || !loadout) return null;
  const selectedOfferIdSet = new Set(loadout.offerIds || []);
  const isExactSameOffers =
    Boolean(alt.offerIds && alt.offerIds.length > 0) &&
    alt.offerIds.length === (loadout.offerIds || []).length &&
    alt.offerIds.every((id) => selectedOfferIdSet.has(id));

  const slotStatsSummary = (alt.items || []).map((it) => {
    const sLabel = it.slot ? (it.slot.charAt(0).toUpperCase() + it.slot.slice(1)) : (it.slotLabel || "");
    if (it.slot === "weapon") {
      const atk = it.offer?.attack ?? it.offer?.skills?.attack ?? 0;
      const crit = it.offer?.criticalChance ?? it.offer?.skills?.criticalChance ?? 0;
      return `${sLabel} +${atk} Atk/+${crit}% Crit`;
    }
    return `${sLabel} +${it.offer?.statValue || 0}`;
  }).join(", ");

  const refStrategyName = loadout.strategyDisplayName || "selected";
  const count = alt.items?.length || 0;
  const countWord = count === 1 ? "offer" : "offers";

  if (isExactSameOffers) {
    return {
      isExactSameOffers: true,
      statsSummary: `Market-max stats: ${slotStatsSummary}`,
      comparisonSummary: `Same ${count} ${countWord} as ${refStrategyName}`,
    };
  }

  const costDiff = Number((alt.totalCost - loadout.totalCost).toFixed(3));
  let costDiffStr = "";
  if (costDiff > 0) {
    costDiffStr = `+${costDiff.toFixed(3)} G vs ${refStrategyName}`;
  } else if (costDiff < 0) {
    costDiffStr = `${costDiff.toFixed(3)} G vs ${refStrategyName}`;
  } else {
    costDiffStr = `identical cost vs ${refStrategyName}`;
  }
  const qualityStr = alt.avgQualityPercent !== undefined ? `${alt.avgQualityPercent}% avg roll` : "";
  const diffDetails = [qualityStr, costDiffStr].filter(Boolean).join(", ");

  return {
    isExactSameOffers: false,
    statsSummary: slotStatsSummary,
    comparisonSummary: diffDetails,
  };
}

/**
 * Purchase verification states.
 */
export const PurchaseVerificationState = {
  VERIFIED_PURCHASED: "VERIFIED_PURCHASED",
  FAILED_NOT_PURCHASED: "FAILED_NOT_PURCHASED",
  UNKNOWN: "UNKNOWN",
};

/**
 * Submit live market purchase mutation via tRPC itemOffer.buyItem.
 */
export async function submitMarketPurchase(offerId, options = {}) {
  const cookieHeader = options.cookieHeader ?? getCookieHeader();
  const fetchFn = options.fetchFn ?? fetchWithRetry;
  const apiBase = options.apiBase ?? API_BASE;

  if (!cookieHeader) {
    throw new Error("Session cookies not found in cookies.json. Please log in first.");
  }

  const res = await fetchFn(`${apiBase}/itemOffer.buyItem?batch=1`, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, cookie: cookieHeader },
    body: JSON.stringify({
      "0": {
        itemOfferId: offerId,
      },
    }),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Market purchase request failed (HTTP ${res.status}): ${errorText}`);
  }

  const json = await res.json();
  if (json[0]?.error) {
    throw new Error(`Server returned error purchasing offer: ${JSON.stringify(json[0].error)}`);
  }

  return json[0]?.result?.data;
}

/**
 * Fetch recent transactions for a user.
 */
export async function fetchUserRecentTransactions(userId, options = {}) {
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
  return json[0]?.result?.data?.items || [];
}

/**
 * Fetch live inventory for a user.
 */
export async function fetchUserInventory(userId, options = {}) {
  const cookieHeader = options.cookieHeader ?? getCookieHeader();
  const fetchFn = options.fetchFn ?? fetchWithRetry;
  const apiBase = options.apiBase ?? API_BASE;

  const res = await fetchFn(`${apiBase}/inventory.getById?batch=1`, {
    method: "POST",
    headers: { ...DEFAULT_HEADERS, ...(cookieHeader ? { cookie: cookieHeader } : {}) },
    body: JSON.stringify({
      "0": { userId },
    }),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch inventory (HTTP ${res.status})`);
  }

  const json = await res.json();
  return json[0]?.result?.data || {};
}

/**
 * Fresh Pre-Purchase Refresh and Validation.
 * Freezes and re-evaluates the exact target offer immediately before mutation.
 */
export async function refreshAndValidateOffer(targetOffer, options = {}) {
  const {
    myUserId = resolveUserId(options.myUserId),
    plannedBuyerPrice = targetOffer?.buyerPrice,
    maxSlippagePct = 0,
    maxPrice = null,
    remainingBudget = null,
    ignoreEquipped = false,
    fetchOffersFn = fetchAllMarketOffers,
    fetchTaxFn = fetchMarketTaxRate,
    rangeInfo = null,
    weaponMeta = null,
    liveEquipped = null,
    playerProfile = null,
    gameConfig = null,
  } = options;

  if (!targetOffer || !targetOffer.offerId) {
    throw new Error("Invalid target offer for refresh and validation.");
  }

  // 1. Re-fetch active offers for exact itemCode
  const freshRawOffers = await fetchOffersFn(targetOffer.itemCode, {
    excludeUserId: null,
  });

  const freshMatch = freshRawOffers.find(
    (o) => o._id === targetOffer.offerId
  );

  if (!freshMatch) {
    const err = new Error("Offer no longer available on the market. Purchase aborted.");
    err.code = "OFFER_DISAPPEARED";
    throw err;
  }

  // 2. Assert seller is not me and seller identity unchanged
  const sellerId = typeof freshMatch.user === "object" ? freshMatch.user?._id : freshMatch.user;
  if (myUserId && sellerId === myUserId) {
    throw new Error(`Offer #${targetOffer.offerId} is owned by current user. Cannot purchase own offer.`);
  }
  const originalSellerId = typeof targetOffer.user === "object"
    ? targetOffer.user?._id
    : (targetOffer.sellerId || targetOffer.user);
  if (originalSellerId && sellerId && String(sellerId) !== String(originalSellerId)) {
    throw new Error(
      `Seller mismatch: expected seller '${originalSellerId}', found '${sellerId}'. Offer identity changed. ABORTING.`
    );
  }

  // 3. Assert exact IDs, code, rarity, category match
  if (freshMatch._id !== targetOffer.offerId) {
    throw new Error(`Offer ID mismatch: expected '${targetOffer.offerId}', found '${freshMatch._id}'.`);
  }

  const freshItemId = freshMatch.item?._id;
  if (targetOffer.itemId && freshItemId !== targetOffer.itemId) {
    throw new Error(`Item ID mismatch: expected '${targetOffer.itemId}', found '${freshItemId}'.`);
  }

  const freshItemCode = freshMatch.itemCode || freshMatch.item?.code;
  if (freshItemCode !== targetOffer.itemCode) {
    throw new Error(`ItemCode mismatch: expected '${targetOffer.itemCode}', found '${freshItemCode}'.`);
  }

  if (targetOffer.rarity && freshMatch.rarity && freshMatch.rarity !== targetOffer.rarity) {
    throw new Error(`Rarity mismatch: expected '${targetOffer.rarity}', found '${freshMatch.rarity}'.`);
  }

  if (targetOffer.category && freshMatch.category && freshMatch.category !== targetOffer.category) {
    throw new Error(`Category mismatch: expected '${targetOffer.category}', found '${freshMatch.category}'.`);
  }

  // 4. Assert durability state >= 100
  const freshState = freshMatch.item?.state !== undefined ? freshMatch.item.state : 100;
  if (freshState < 100) {
    throw new Error(`Durability check failed: state ${freshState} < 100 (damaged / untradable).`);
  }

  // 5. Assert rolled stats are unchanged
  const freshSkills = freshMatch.item?.skills || {};
  if (targetOffer.category === "weapon") {
    const atk = Number(freshSkills.attack);
    const cc = Number(freshSkills.criticalChance);
    if (atk !== targetOffer.attack || cc !== targetOffer.criticalChance) {
      throw new Error(
        `Weapon rolled stats changed: expected +${targetOffer.attack}A/+${targetOffer.criticalChance}C, found +${atk}A/+${cc}C.`
      );
    }
  } else {
    const statVal = Number(freshSkills[targetOffer.statName]);
    if (statVal !== targetOffer.statValue) {
      throw new Error(
        `Gear rolled stat changed: expected +${targetOffer.statValue} ${targetOffer.statName}, found +${statVal}.`
      );
    }
  }

  // 6. Assert price is positive and fetch fresh tax
  const freshSellerPrice = Number(freshMatch.price);
  if (isNaN(freshSellerPrice) || freshSellerPrice <= 0) {
    throw new Error(`Invalid price: ${freshSellerPrice} Gold.`);
  }

  const freshTaxRate = await fetchTaxFn();
  const freshBuyerPrice = Number((freshSellerPrice * (1 + freshTaxRate / 100)).toFixed(3));

  // 7. Slippage Protection (default 0%)
  const maxAllowedBySlippage = Number((plannedBuyerPrice * (1 + maxSlippagePct / 100)).toFixed(3));
  if (freshBuyerPrice > maxAllowedBySlippage) {
    throw new Error(
      `Price slippage exceeded: fresh buyer price ${freshBuyerPrice.toFixed(3)} Gold > allowed ${maxAllowedBySlippage.toFixed(3)} Gold (max slippage ${maxSlippagePct}%). ABORTING.`
    );
  }

  // 8. Max Price ceiling
  if (maxPrice !== null && freshBuyerPrice > maxPrice) {
    throw new Error(
      `Max price ceiling exceeded: fresh buyer price ${freshBuyerPrice.toFixed(3)} Gold > max-price ${maxPrice.toFixed(3)} Gold. ABORTING.`
    );
  }

  // 9. Budget ceiling
  if (remainingBudget !== null && freshBuyerPrice > remainingBudget) {
    throw new Error(
      `Budget ceiling exceeded: fresh buyer price ${freshBuyerPrice.toFixed(3)} Gold > remaining budget ${remainingBudget.toFixed(3)} Gold. ABORTING.`
    );
  }

  // 10. Re-assert upgrade status unless ignoreEquipped
  if (!ignoreEquipped) {
    if (targetOffer.category === "weapon" && gameConfig) {
      const evaluated = evaluateWeaponOffer(
        {
          ...targetOffer,
          sellerPrice: freshSellerPrice,
          buyerPrice: freshBuyerPrice,
          taxRate: freshTaxRate,
          skills: freshSkills,
        },
        weaponMeta || { code: targetOffer.itemCode, name: targetOffer.itemCode, rarity: targetOffer.rarity },
        liveEquipped?.weapon || null,
        playerProfile,
        gameConfig,
        { allOffersForCode: freshRawOffers, excludeUserId: myUserId }
      );
      if (evaluated.disposition !== "UPGRADE") {
        throw new Error(
          `Offer is no longer an UPGRADE against currently equipped weapon (${evaluated.disposition}). ABORTING.`
        );
      }
    } else if (rangeInfo) {
      const evaluated = evaluateGearOffer(
        {
          ...targetOffer,
          sellerPrice: freshSellerPrice,
          buyerPrice: freshBuyerPrice,
          taxRate: freshTaxRate,
          skills: freshSkills,
        },
        rangeInfo,
        liveEquipped?.[targetOffer.category] || null,
        { allOffersForCode: freshRawOffers, excludeUserId: myUserId }
      );
      if (evaluated.disposition !== "UPGRADE") {
        throw new Error(
          `Offer is no longer an UPGRADE against currently equipped gear (${evaluated.disposition}). ABORTING.`
        );
      }
    }
  }

  return {
    ...targetOffer,
    sellerPrice: freshSellerPrice,
    buyerPrice: freshBuyerPrice,
    taxRate: freshTaxRate,
    state: freshState,
    skills: freshSkills,
    rawOffer: freshMatch,
  };
}

/**
 * Post-Purchase Strict Verification with Bounded Polling.
 * Checks inventory and transaction history to prove execution outcome.
 */
export async function verifyMarketPurchase(targetOffer, submissionTime, options = {}) {
  const {
    userId = resolveUserId(options.userId),
    mutationFailed = false,
    mutationError = null,
    pollScheduleMs = [500, 1000, 1500, 2500],
    fetchInventoryFn,
    fetchTransactionsFn,
    sleepFn = sleep,
  } = options;

  const targetItemId = targetOffer.itemId;
  const itemCode = targetOffer.itemCode;
  const expectedSellerPrice = targetOffer.sellerPrice;
  const statName = targetOffer.statName;
  const statValue = targetOffer.statValue;
  const attack = targetOffer.attack;
  const criticalChance = targetOffer.criticalChance;
  const isWeapon = targetOffer.category === "weapon";

  const checkInventory = async () => {
    if (!fetchInventoryFn) return null;
    const invData = await fetchInventoryFn(userId);
    const equipments =
      invData?.items?.equipments ||
      invData?.inv?.items?.equipments ||
      [];

    // Priority 1: Exact original item ID match
    if (targetItemId) {
      const exact = equipments.find((eq) => eq._id === targetItemId);
      if (exact) {
        return { matched: true, item: exact, method: "INVENTORY_EXACT_ID" };
      }
    }

    // Priority 2: Regenerated ID fallback (itemCode + exact rolled stats + acquisition timestamp)
    const recentCandidates = equipments.filter((eq) => {
      if (eq.code !== itemCode) return false;
      const acqTime = eq.lastAcquisitionAt ? new Date(eq.lastAcquisitionAt).getTime() : 0;
      if (acqTime < submissionTime - 5000) return false;

      if (isWeapon) {
        return (
          Number(eq.skills?.attack) === Number(attack) &&
          Number(eq.skills?.criticalChance) === Number(criticalChance)
        );
      } else {
        return Number(eq.skills?.[statName]) === Number(statValue);
      }
    });

    if (recentCandidates.length > 0) {
      return { matched: true, item: recentCandidates[0], method: "INVENTORY_STATS_TIMESTAMP" };
    }

    return null;
  };

  const checkTransactions = async () => {
    if (!fetchTransactionsFn) return null;
    const txs = await fetchTransactionsFn(userId);
    const eligible = (txs || []).filter((tx) => {
      if (!tx || !tx._id) return false;
      if (tx.buyerId !== userId) return false;
      const tType = tx.transactionType || "";
      if (tType !== "itemMarket" && !tType.includes("Market")) return false;

      const txPrice = Number(tx.money ?? tx.price);
      if (Math.abs(txPrice - expectedSellerPrice) > 0.01) return false;
      return true;
    });

    // Priority 1: Exact offerId
    const p1 = eligible.find(
      (tx) =>
        tx.itemOfferId === targetOffer.offerId ||
        tx.offerId === targetOffer.offerId ||
        tx._id === targetOffer.offerId
    );
    if (p1) {
      return { matched: true, transaction: p1, method: "TRANSACTION_OFFER_ID" };
    }

    // Priority 2: Exact item ID
    if (targetItemId) {
      const p2 = eligible.find(
        (tx) => tx.item?._id === targetItemId || tx.itemId === targetItemId
      );
      if (p2) {
        return { matched: true, transaction: p2, method: "TRANSACTION_ITEM_ID" };
      }
    }

    // Priority 3: itemCode + exact stats + price + timestamp window
    for (const tx of eligible) {
      const code = tx.itemCode || tx.item?.code;
      if (code !== itemCode) continue;
      const txTime = new Date(tx.createdAt).getTime();
      if (Math.abs(txTime - submissionTime) > 60000) continue;

      if (isWeapon) {
        if (
          Number(tx.item?.skills?.attack) === Number(attack) &&
          Number(tx.item?.skills?.criticalChance) === Number(criticalChance)
        ) {
          return { matched: true, transaction: tx, method: "TRANSACTION_STATS_PRICE" };
        }
      } else {
        if (Number(tx.item?.skills?.[statName]) === Number(statValue)) {
          return { matched: true, transaction: tx, method: "TRANSACTION_STATS_PRICE" };
        }
      }
    }

    return null;
  };

  // Immediate check if mutation failed before polling
  if (mutationFailed) {
    try {
      const invMatch = await checkInventory();
      const txMatch = await checkTransactions();
      if (!invMatch && !txMatch) {
        return {
          state: PurchaseVerificationState.FAILED_NOT_PURCHASED,
          reason: mutationError || "Purchase mutation rejected and item was not transferred.",
        };
      }
    } catch {
      // Fall through to polling
    }
  }

  // Bounded Polling Loop
  for (let attempt = 0; attempt < pollScheduleMs.length; attempt++) {
    const delay = pollScheduleMs[attempt];
    if (delay > 0) {
      await sleepFn(delay);
    }

    try {
      const invMatch = await checkInventory();
      if (invMatch) {
        return {
          state: PurchaseVerificationState.VERIFIED_PURCHASED,
          evidence: invMatch,
          attempts: attempt + 1,
        };
      }

      const txMatch = await checkTransactions();
      if (txMatch) {
        return {
          state: PurchaseVerificationState.VERIFIED_PURCHASED,
          evidence: txMatch,
          attempts: attempt + 1,
        };
      }
    } catch {
      // Allow transient retry during backoff
    }
  }

  if (mutationFailed) {
    return {
      state: PurchaseVerificationState.FAILED_NOT_PURCHASED,
      reason: mutationError || "Purchase mutation failed and no item was received.",
    };
  }

  // Critical UNKNOWN State
  return {
    state: PurchaseVerificationState.UNKNOWN,
    reason: `Post-purchase verification unconfirmed after ${pollScheduleMs.length} retries. Item not found in inventory and no transaction was recorded.`,
  };
}

/**
 * Future Execution Safety Verification Guard.
 * Strict assertions to verify offer qualification before purchase.
 */
export function verifyFuturePurchaseSafety(candidateOffer, options = {}) {
  const {
    targetOfferId = null,
    targetItemId = null,
    targetRarity = null,
    targetCategory = null,
    maxPrice = null,
    budget = null,
    playerGold = null,
  } = options;

  if (!candidateOffer) {
    throw new Error("No candidate offer provided for safety verification.");
  }

  // Exact offer ID check
  if (targetOfferId && candidateOffer.offerId !== targetOfferId) {
    throw new Error(
      `Offer ID mismatch: expected '${targetOfferId}', found '${candidateOffer.offerId}'. ABORTING.`
    );
  }

  // Exact item ID check
  if (targetItemId && candidateOffer.itemId !== targetItemId) {
    throw new Error(
      `Item ID mismatch: expected '${targetItemId}', found '${candidateOffer.itemId}'. ABORTING.`
    );
  }

  // Target rarity check
  if (targetRarity && candidateOffer.rarity?.toLowerCase() !== targetRarity.toLowerCase()) {
    throw new Error(
      `Rarity mismatch: expected '${targetRarity}', offer is '${candidateOffer.rarity}'. ABORTING.`
    );
  }

  // Target category check
  if (targetCategory && candidateOffer.category?.toLowerCase() !== targetCategory.toLowerCase()) {
    throw new Error(
      `Category mismatch: expected '${targetCategory}', offer is '${candidateOffer.category}'. ABORTING.`
    );
  }

  // Durability check
  if (candidateOffer.state < 100) {
    throw new Error(
      `Durability check failed: state ${candidateOffer.state} < 100 (damaged / untradable). ABORTING.`
    );
  }

  // Price ceiling check
  if (maxPrice !== null && candidateOffer.buyerPrice > maxPrice) {
    throw new Error(
      `Price ceiling exceeded: buyer price ${candidateOffer.buyerPrice} Gold > max-price ${maxPrice} Gold. ABORTING.`
    );
  }

  // Budget check
  if (budget !== null && candidateOffer.buyerPrice > budget) {
    throw new Error(
      `Budget ceiling exceeded: buyer price ${candidateOffer.buyerPrice} Gold > budget ${budget} Gold. ABORTING.`
    );
  }

  // Player gold check
  if (playerGold !== null && candidateOffer.buyerPrice > playerGold) {
    throw new Error(
      `Insufficient funds: buyer price ${candidateOffer.buyerPrice} Gold > available Gold ${playerGold}. ABORTING.`
    );
  }

  return {
    valid: true,
    offerId: candidateOffer.offerId,
    itemId: candidateOffer.itemId,
    buyerPrice: candidateOffer.buyerPrice,
  };
}
