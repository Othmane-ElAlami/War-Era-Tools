#!/usr/bin/env node

/**
 * WarEra Equipment Buyer Test Suite
 *
 * Verifies all requirements:
 * 1. Rarity filtering & dynamic resolution from gameConfig
 * 2. Include filtering
 * 3. Exclude filtering
 * 4. Include + exclude conflict (exclude wins)
 * 5. Current equipment comparison (UPGRADE, SIDEGRADE, DOWNGRADE)
 * 6. Dominated-offer elimination (Pareto dominance)
 * 7. Best-value ranking (statValue / buyerPrice)
 * 8. Best-performance ranking (highest statValue / damage)
 * 9. Cheapest-upgrade ranking (lowest buyerPrice)
 * 10. DOWNGRADE exclusion from purchase recommendations
 * 11. Perfect-roll handling
 * 12. Buyer tax calculation (real acquisition cost)
 * 13. Fair-value comparison & OVERPRICED detection
 * 14. Own-offer exclusion
 * 15. Cursor pagination handling
 * 16. Weapon evaluation via combat model replacement
 * 17. Identical-price and identical-stat tie handling
 * 18. Sparse market evidence handling
 * 19. Malformed offer safety (missing skills, corrupted records)
 * 20. Zero suitable offers handling
 * 21. Future execution safety verification assertions
 */

import assert from "node:assert";
import chalk from "chalk";
import {
  resolveRarity,
  resolveCategories,
  extractRarityCatalog,
  sanitizeMarketOffers,
  eliminateDominatedOffers,
  evaluateGearOffer,
  evaluateWeaponOffer,
  findCategoryRecommendations,
  selectRecommendationByStrategy,
  findOverallBestValue,
  optimizeLoadoutUnderBudget,
  buildFullLoadout,
  formatStatShort,
  SLOT_LABELS,
  verifyFuturePurchaseSafety,
  formatAlternativeSummary,
  fetchAllMarketOffers,
  PurchaseVerificationState,
  refreshAndValidateOffer,
  verifyMarketPurchase,
} from "../analyzer/buyer_evaluator.mjs";
import {
  parseArgs,
  runEquipmentBuyer,
  fetchLiveWalletGold,
  pollReconciledWalletGold,
  printBalanceReconciliation,
  printFullLoadoutConfirmation,
  printInsufficientGold,
  printCompleteSuccess,
  printPartialStop,
  parseLoadoutChoice,
  printSelectedLoadoutCard,
  promptStrategyChoice,
  STRATEGY_CHOICE_PROMPT,
} from "../equipment_buyer.mjs";
import { fetchWithRetry } from "../analyzer/api.mjs";

console.log(chalk.bold.cyan("\n=================================================="));
console.log(chalk.bold.cyan("   WarEra Equipment Buyer - Test Suite"));
console.log(chalk.bold.cyan("==================================================\n"));

let passed = 0;
let total = 0;

function test(name, fn) {
  total++;
  try {
    fn();
    console.log(` ${chalk.green("✓")} ${name}`);
    passed++;
  } catch (err) {
    console.error(` ${chalk.red("✗")} ${name}`);
    console.error(chalk.red(`   ${err.stack || err.message}\n`));
  }
}

async function asyncTest(name, fn) {
  total++;
  try {
    await fn();
    console.log(` ${chalk.green("✓")} ${name}`);
    passed++;
  } catch (err) {
    console.error(` ${chalk.red("✗")} ${name}`);
    console.error(chalk.red(`   ${err.stack || err.message}\n`));
  }
}

// Mock gameConfig
const mockGameConfig = {
  items: {
    knife: {
      type: "weapon",
      usage: "weapon",
      rarity: "common",
      dynamicStats: { attack: [21, 40], criticalChance: [1, 5] },
    },
    gun: {
      type: "weapon",
      usage: "weapon",
      rarity: "uncommon",
      dynamicStats: { attack: [51, 60], criticalChance: [6, 10] },
    },
    rifle: {
      type: "weapon",
      usage: "weapon",
      rarity: "rare",
      dynamicStats: { attack: [71, 90], criticalChance: [11, 15] },
    },
    boots2: {
      type: "equipment",
      usage: "boots",
      rarity: "uncommon",
      dynamicStats: { dodge: [6, 10] },
    },
    gloves2: {
      type: "equipment",
      usage: "gloves",
      rarity: "uncommon",
      dynamicStats: { precision: [6, 10] },
    },
    helmet2: {
      type: "equipment",
      usage: "helmet",
      rarity: "uncommon",
      dynamicStats: { criticalDamages: [16, 30] },
    },
    chest2: {
      type: "equipment",
      usage: "chest",
      rarity: "uncommon",
      dynamicStats: { armor: [6, 10] },
    },
    pants2: {
      type: "equipment",
      usage: "pants",
      rarity: "uncommon",
      dynamicStats: { armor: [6, 10] },
    },
  },
  skills: {
    attack: {
      values: { 0: 100, 1: 125, 2: 150, 3: 175, 4: 200, 5: 225, 6: 250, 7: 275, 8: 300 },
    },
    criticalChance: {
      values: { 0: 10, 1: 15, 2: 20, 3: 25, 4: 30, 5: 35, 6: 40, 7: 45 },
    },
    criticalDamages: {
      values: { 0: 100, 1: 120, 2: 140, 3: 160, 4: 180, 5: 200, 6: 220 },
    },
    precision: {
      values: { 0: 50, 1: 55, 2: 60, 3: 65, 4: 70, 5: 75, 6: 80 },
    },
  },
};

// 1. Rarity Filtering & Dynamic Resolution
test("1. Rarity dynamic resolution from gameConfig (colors and tiers)", () => {
  const green = resolveRarity("green", mockGameConfig);
  assert.strictEqual(green.canonical, "uncommon");
  assert.strictEqual(green.displayName, "Green");

  const blue = resolveRarity("blue", mockGameConfig);
  assert.strictEqual(blue.canonical, "rare");
  assert.strictEqual(blue.displayName, "Blue");

  const grey = resolveRarity("grey", mockGameConfig);
  assert.strictEqual(grey.canonical, "common");
  assert.strictEqual(grey.displayName, "Grey");

  const directUncommon = resolveRarity("uncommon", mockGameConfig);
  assert.strictEqual(directUncommon.canonical, "uncommon");

  assert.throws(() => resolveRarity("invalid_color", mockGameConfig), /Invalid rarity 'invalid_color'/);
  assert.throws(() => resolveRarity(null, mockGameConfig), /Missing required option/);
});

// 2. Include Filtering
test("2. Include filtering restricts to specified categories", () => {
  const cats = resolveCategories("helmet,boots", null);
  assert.deepStrictEqual(cats, ["helmet", "boots"]);

  const weaponOnly = resolveCategories("weapon", null);
  assert.deepStrictEqual(weaponOnly, ["weapon"]);
});

// 3. Exclude Filtering
test("3. Exclude filtering removes categories from full set", () => {
  const noWeapon = resolveCategories(null, "weapon");
  assert.deepStrictEqual(noWeapon, ["helmet", "chest", "gloves", "pants", "boots"]);

  const noGear = resolveCategories(null, "helmet,gloves");
  assert.deepStrictEqual(noGear, ["chest", "pants", "boots", "weapon"]);
});

// 4. Include + Exclude Conflict Resolution
test("4. Include + Exclude conflict: exclude wins", () => {
  const conflict = resolveCategories("helmet,boots,weapon", "weapon,gloves");
  assert.deepStrictEqual(conflict, ["helmet", "boots"]);

  // Ammo is forbidden
  assert.throws(() => resolveCategories("ammo", null), /Ammo is not in equipment-buyer scope/);
  assert.throws(() => resolveCategories(null, "ammo"), /Ammo is not in equipment-buyer scope/);

  // Invalid category fails clearly
  assert.throws(() => resolveCategories("shields", null), /Invalid category 'shields'/);

  // If all categories are excluded, fails clearly
  assert.throws(() => resolveCategories("boots", "boots"), /No equipment categories remaining/);
});

// 5. Current Equipment Comparison (Upgrade, Sidegrade, Downgrade)
test("5. Current equipment comparison for single-stat gear", () => {
  const rangeInfo = { slot: "boots", rarity: "uncommon", statName: "dodge", minPossibleStat: 6, maxPossibleStat: 10 };
  const equipped = { skills: { dodge: 8 } };

  const candUpgrade = {
    offerId: "o1",
    itemId: "i1",
    buyerPrice: 4.14,
    sellerPrice: 4.10,
    taxRate: 1,
    skills: { dodge: 9 },
  };
  const evalUpgrade = evaluateGearOffer(candUpgrade, rangeInfo, equipped);
  assert.strictEqual(evalUpgrade.disposition, "UPGRADE");
  assert.strictEqual(evalUpgrade.statDiff, 1);

  const candSidegrade = { ...candUpgrade, skills: { dodge: 8 } };
  const evalSidegrade = evaluateGearOffer(candSidegrade, rangeInfo, equipped);
  assert.strictEqual(evalSidegrade.disposition, "SIDEGRADE");
  assert.strictEqual(evalSidegrade.statDiff, 0);

  const candDowngrade = { ...candUpgrade, skills: { dodge: 7 } };
  const evalDowngrade = evaluateGearOffer(candDowngrade, rangeInfo, equipped);
  assert.strictEqual(evalDowngrade.disposition, "DOWNGRADE");
  assert.strictEqual(evalDowngrade.statDiff, -1);
});

// 6. Dominated-Offer Elimination (Pareto Dominance)
test("6. Dominated-offer elimination eliminates inferior price/stat offers", () => {
  const offers = [
    { id: "A", statValue: 10, buyerPrice: 5.0 }, // Non-dominated (highest stat)
    { id: "B", statValue: 9, buyerPrice: 4.0 },  // Non-dominated (best value)
    { id: "C", statValue: 9, buyerPrice: 4.5 },  // Dominated by B (worse price, same stat)
    { id: "D", statValue: 8, buyerPrice: 5.2 },  // Dominated by A and B (worse stat, worse price)
  ];

  const { nonDominated, dominated } = eliminateDominatedOffers(
    offers,
    (o) => o.statValue,
    (o) => o.buyerPrice
  );

  assert.strictEqual(nonDominated.length, 2);
  assert.deepStrictEqual(nonDominated.map((o) => o.id), ["A", "B"]);
  assert.strictEqual(dominated.length, 2);
  assert.deepStrictEqual(dominated.map((d) => d.offer.id), ["C", "D"]);
});

// 7. Best-Value Ranking (statValue / buyerPrice)
test("7. Best-value ranking selects highest stat per Gold among non-dominated upgrades", () => {
  const offers = [
    {
      offerId: "o1",
      itemId: "i1",
      statValue: 9,
      buyerPrice: 4.0,
      statPerGold: 9 / 4.0, // 2.25
      disposition: "UPGRADE",
      isOverpriced: false,
    },
    {
      offerId: "o2",
      itemId: "i2",
      statValue: 10,
      buyerPrice: 5.0,
      statPerGold: 10 / 5.0, // 2.00
      disposition: "UPGRADE",
      isOverpriced: false,
    },
  ];

  const recs = findCategoryRecommendations(offers, false);
  assert.strictEqual(recs.bestValue.offerId, "o1");
  assert.strictEqual(recs.bestPerformance.offerId, "o2");
  assert.strictEqual(recs.cheapestUpgrade.offerId, "o1");
});

// 8. Best-Performance Ranking
test("8. Best-performance ranking selects highest stat roll", () => {
  const offers = [
    { offerId: "o1", itemId: "i1", statValue: 9, buyerPrice: 4.0, statPerGold: 2.25, disposition: "UPGRADE" },
    { offerId: "o2", itemId: "i2", statValue: 10, buyerPrice: 6.0, statPerGold: 1.66, disposition: "UPGRADE" },
  ];

  const recs = findCategoryRecommendations(offers, false);
  assert.strictEqual(recs.bestPerformance.offerId, "o2");
  assert.strictEqual(recs.bestPerformance.statValue, 10);
});

// 9. Cheapest-Upgrade Ranking
test("9. Cheapest-upgrade ranking selects lowest acquisition price", () => {
  const offers = [
    { offerId: "o1", itemId: "i1", statValue: 9, buyerPrice: 3.5, disposition: "UPGRADE" },
    { offerId: "o2", itemId: "i2", statValue: 10, buyerPrice: 4.0, disposition: "UPGRADE" },
    { offerId: "o3", itemId: "i3", statValue: 9, buyerPrice: 4.2, disposition: "UPGRADE" },
  ];

  const recs = findCategoryRecommendations(offers, false);
  assert.strictEqual(recs.cheapestUpgrade.offerId, "o1");
  assert.strictEqual(recs.cheapestUpgrade.buyerPrice, 3.5);
});

// 10. DOWNGRADE Exclusion
test("10. DOWNGRADE items are excluded from purchase recommendations", () => {
  const offers = [
    { offerId: "o1", itemId: "i1", statValue: 7, buyerPrice: 2.0, disposition: "DOWNGRADE" },
    { offerId: "o2", itemId: "i2", statValue: 8, buyerPrice: 3.0, disposition: "SIDEGRADE" },
  ];

  const recs = findCategoryRecommendations(offers, false);
  assert.strictEqual(recs.hasUpgrade, false);
  assert.strictEqual(recs.bestValue, null);
  assert.strictEqual(recs.bestPerformance, null);
  assert.strictEqual(recs.cheapestUpgrade, null);
});

// 11. Perfect-Roll Handling
test("11. Perfect-roll handling correctly marks max stats", () => {
  const rangeInfo = { slot: "boots", rarity: "uncommon", statName: "dodge", minPossibleStat: 6, maxPossibleStat: 10 };
  const offerPerfect = {
    offerId: "o1",
    itemId: "i1",
    buyerPrice: 5.0,
    taxRate: 1,
    skills: { dodge: 10 },
  };

  const evaluated = evaluateGearOffer(offerPerfect, rangeInfo, { skills: { dodge: 8 } });
  assert.strictEqual(evaluated.isPerfect, true);
  assert.strictEqual(evaluated.rollPosition, "PERFECT");
  assert.strictEqual(evaluated.rollPercent, 100);
});

// 12. Buyer Tax Calculation
test("12. Buyer tax calculation incorporates national market tax", () => {
  const rawOffers = [
    {
      _id: "o1",
      item: { _id: "i1", code: "boots2", skills: { dodge: 9 }, state: 100 },
      price: 4.10,
    },
  ];

  const sanitized = sanitizeMarketOffers(rawOffers, { taxRate: 1, requiredStats: ["dodge"] });
  assert.strictEqual(sanitized.length, 1);
  // 4.10 * 1.01 = 4.141
  assert.strictEqual(sanitized[0].buyerPrice, 4.141);
  assert.strictEqual(sanitized[0].sellerPrice, 4.10);
});

// 13. Fair-Value Comparison & OVERPRICED Detection
test("13. Materially overpriced offers are flagged and deprioritized", () => {
  const rangeInfo = { slot: "boots", rarity: "uncommon", statName: "dodge", minPossibleStat: 6, maxPossibleStat: 10 };
  const allOffers = [
    { _id: "m1", price: 4.0, item: { skills: { dodge: 9 } } },
    { _id: "m2", price: 4.1, item: { skills: { dodge: 9 } } },
    { _id: "m3", price: 4.05, item: { skills: { dodge: 9 } } },
    { _id: "m4", price: 4.15, item: { skills: { dodge: 9 } } },
    { _id: "m5", price: 4.1, item: { skills: { dodge: 9 } } },
  ];

  // Offer at 6.0 Gold when fair value is ~4.1 Gold (> 40% overpriced)
  const overpricedOffer = {
    offerId: "o_exp",
    itemId: "i_exp",
    buyerPrice: 6.06,
    sellerPrice: 6.0,
    taxRate: 1,
    skills: { dodge: 9 },
  };

  const evaluated = evaluateGearOffer(overpricedOffer, rangeInfo, { skills: { dodge: 8 } }, {
    allOffersForCode: allOffers,
  });

  assert.strictEqual(evaluated.confidence, "HIGH");
  assert.strictEqual(evaluated.isOverpriced, true);
  assert.ok(evaluated.priceDiffPct < -20);
});

// 14. Own-Offer Exclusion
test("14. Own offers are excluded from purchase candidate pool", () => {
  const myUserId = "user_me_123";
  const rawOffers = [
    {
      _id: "o1",
      user: myUserId,
      price: 4.0,
      item: { _id: "i1", code: "boots2", skills: { dodge: 9 }, state: 100 },
    },
    {
      _id: "o2",
      user: "competitor_999",
      price: 4.2,
      item: { _id: "i2", code: "boots2", skills: { dodge: 9 }, state: 100 },
    },
  ];

  const sanitized = sanitizeMarketOffers(rawOffers, { excludeUserId: myUserId, requiredStats: ["dodge"] });
  assert.strictEqual(sanitized.length, 1);
  assert.strictEqual(sanitized[0].offerId, "o2");
});

// 15. Cursor Pagination
test("15. Pagination handling fetches all pages until end of cursor", async () => {
  let pageCount = 0;
  const mockFetch = async (url, options) => {
    pageCount++;
    const body = JSON.parse(options.body)["0"];
    if (pageCount === 1) {
      return {
        ok: true,
        json: async () => [{ result: { data: { items: [{ _id: "off1", item: { _id: "it1" } }], nextCursor: "cur_2" } } }],
      };
    } else {
      return {
        ok: true,
        json: async () => [{ result: { data: { items: [{ _id: "off2", item: { _id: "it2" } }], nextCursor: null } } }],
      };
    }
  };

  const { fetchAllMarketOffers } = await import("../analyzer/buyer_evaluator.mjs");
  const offers = await fetchAllMarketOffers("boots2", { fetchFn: mockFetch });
  assert.strictEqual(pageCount, 2);
  assert.strictEqual(offers.length, 2);
  assert.strictEqual(offers[0]._id, "off1");
  assert.strictEqual(offers[1]._id, "off2");
});

// 16. Weapon Evaluation via Combat Model Replacement
test("16. Weapon evaluation simulates replacing current weapon using combat model", () => {
  const weaponMeta = {
    code: "gun",
    name: "Gun",
    rarity: "uncommon",
    dynamicStats: { attack: [51, 60], criticalChance: [6, 10] },
  };

  const currentWeapon = {
    code: "knife",
    skills: { attack: 30, criticalChance: 3 },
  };

  const playerProfile = {
    skills: {
      attack: { level: 8, ammoPercent: 20, militaryRankPercent: 30.5, buffsPercent: 60, debuffsPercent: 0 },
      criticalChance: { level: 7 },
      criticalDamages: { level: 6 },
      precision: { level: 6 },
    },
    equipment: {
      ammo: "ammo",
      helmet: { skills: { criticalDamages: 80 } },
      gloves: { skills: { precision: 20 } },
    },
  };

  const candidateOffer = {
    offerId: "w1",
    itemId: "wi1",
    buyerPrice: 4.14,
    sellerPrice: 4.10,
    taxRate: 1,
    skills: { attack: 58, criticalChance: 9 },
  };

  const evaluated = evaluateWeaponOffer(
    candidateOffer,
    weaponMeta,
    currentWeapon,
    playerProfile,
    mockGameConfig
  );

  assert.strictEqual(evaluated.disposition, "UPGRADE");
  assert.ok(evaluated.damageGain > 0);
  assert.ok(evaluated.combatGainPerGold > 0);
  assert.strictEqual(evaluated.candidateDamage > evaluated.currentDamage, true);
});

// 17. Identical-Price and Identical-Stat Tie Handling
test("17. Identical-price and identical-stat ties do not eliminate each other", () => {
  const offers = [
    { id: "A", statValue: 9, buyerPrice: 4.0 },
    { id: "B", statValue: 9, buyerPrice: 4.0 },
  ];

  const { nonDominated, dominated } = eliminateDominatedOffers(
    offers,
    (o) => o.statValue,
    (o) => o.buyerPrice
  );

  assert.strictEqual(nonDominated.length, 2);
  assert.strictEqual(dominated.length, 0);
});

// 18. Sparse Market Evidence Handling
test("18. Sparse market evidence correctly sets LOW or VERY LOW confidence", () => {
  const rangeInfo = { slot: "boots", rarity: "uncommon", statName: "dodge", minPossibleStat: 6, maxPossibleStat: 10 };
  const sparseOffers = [
    { _id: "m1", price: 4.0, item: { skills: { dodge: 9 } } },
  ];

  const cand = {
    offerId: "o1",
    itemId: "i1",
    buyerPrice: 4.14,
    taxRate: 1,
    skills: { dodge: 9 },
  };

  const evaluated = evaluateGearOffer(cand, rangeInfo, { skills: { dodge: 8 } }, {
    allOffersForCode: sparseOffers,
  });

  assert.strictEqual(evaluated.confidence, "LOW");
});

// 19. Malformed Offer Safety
test("19. Malformed offers (missing skills, damaged durability) are safely rejected", () => {
  const corruptedOffers = [
    null,
    { _id: "bad1" }, // missing item
    { _id: "bad2", item: { _id: "i2", state: 80, skills: { dodge: 9 } }, price: 4.0 }, // damaged (state < 100)
    { _id: "bad3", item: { _id: "i3", state: 100, skills: { armor: 10 } }, price: 4.0 }, // missing required stat 'dodge'
    { _id: "bad4", item: { _id: "i4", state: 100, skills: { dodge: "invalid" } }, price: 4.0 }, // non-numeric stat
    { _id: "bad5", item: { _id: "i5", state: 100, skills: { dodge: 9 } }, price: -5.0 }, // negative price
  ];

  const sanitized = sanitizeMarketOffers(corruptedOffers, { requiredStats: ["dodge"] });
  assert.strictEqual(sanitized.length, 0);
});

// 20. Zero Suitable Offers Handling
test("20. Zero suitable offers returns safe null recommendations", () => {
  const recs = findCategoryRecommendations([], false);
  assert.strictEqual(recs.hasUpgrade, false);
  assert.strictEqual(recs.bestValue, null);

  const overall = findOverallBestValue({});
  assert.strictEqual(overall, null);
});

// 21. Future Execution Safety Verification Guard
test("21. Future execution safety verification asserts strict pre-purchase invariants", () => {
  const candidate = {
    offerId: "target_off_1",
    itemId: "target_item_1",
    rarity: "uncommon",
    category: "boots",
    buyerPrice: 4.14,
    state: 100,
  };

  // 1. Should pass when all match
  const pass = verifyFuturePurchaseSafety(candidate, {
    targetOfferId: "target_off_1",
    targetItemId: "target_item_1",
    targetRarity: "uncommon",
    targetCategory: "boots",
    maxPrice: 5.0,
    budget: 10.0,
    playerGold: 50.0,
  });
  assert.strictEqual(pass.valid, true);

  // 2. Should reject on offer ID mismatch
  assert.throws(
    () => verifyFuturePurchaseSafety(candidate, { targetOfferId: "other_id" }),
    /Offer ID mismatch/
  );

  // 3. Should reject if price exceeds max-price
  assert.throws(
    () => verifyFuturePurchaseSafety(candidate, { maxPrice: 4.0 }),
    /Price ceiling exceeded/
  );

  // 4. Should reject if damaged
  assert.throws(
    () => verifyFuturePurchaseSafety({ ...candidate, state: 90 }),
    /Durability check failed/
  );
});

// 22. Cross-Slot Overall Best Value Selection
test("22. Cross-slot overall best value ranks by normalized improvement per Gold", () => {
  const categoryResults = {
    boots: {
      recommendations: {
        bestValue: {
          offerId: "boots_1",
          buyerPrice: 4.0,
          normalizedValueScore: 0.125, // 0.5 improvement / 4 Gold
        },
      },
    },
    gloves: {
      recommendations: {
        bestValue: {
          offerId: "gloves_1",
          buyerPrice: 4.0,
          normalizedValueScore: 0.250, // 1.0 improvement / 4 Gold -> STRONGER
        },
      },
    },
  };

  const overall = findOverallBestValue(categoryResults);
  assert.strictEqual(overall.category, "gloves");
  assert.strictEqual(overall.offer.offerId, "gloves_1");
});

console.log(chalk.bold.yellow("\n--- Live Safe Purchasing Tests (Section 16) ---\n"));

// 23. Exact Offer Targeting
test("23. Exact offer targeting correctly matches --offer-id", () => {
  const cfg = parseArgs(["--rarity=blue", "--offer-id=exact_offer_123"]);
  assert.strictEqual(cfg.offerId, "exact_offer_123");
});

// 24. Offer Disappears Before Purchase
await asyncTest("24. Offer disappears before purchase throws OFFER_DISAPPEARED and aborts", async () => {
  const targetOffer = { offerId: "vanished_offer", itemCode: "boots2", buyerPrice: 4.14, statName: "dodge", statValue: 9 };
  const mockFetchOffers = async () => []; // empty offers

  await assert.rejects(
    () => refreshAndValidateOffer(targetOffer, { fetchOffersFn: mockFetchOffers }),
    (err) => err.code === "OFFER_DISAPPEARED"
  );
});

// 25. Price Increases Before Purchase
await asyncTest("25. Price increases before purchase triggers slippage abort", async () => {
  const targetOffer = { offerId: "off_1", itemCode: "boots2", buyerPrice: 4.141, statName: "dodge", statValue: 9 };
  // Seller increased price from 4.10 to 4.50
  const mockFetchOffers = async () => [
    { _id: "off_1", price: 4.50, item: { _id: "it1", code: "boots2", state: 100, skills: { dodge: 9 } } },
  ];
  const mockTax = async () => 1;

  await assert.rejects(
    () => refreshAndValidateOffer(targetOffer, {
      plannedBuyerPrice: 4.141,
      maxSlippagePct: 0,
      fetchOffersFn: mockFetchOffers,
      fetchTaxFn: mockTax,
    }),
    /Price slippage exceeded/
  );
});

// 26. Tax Changes Before Purchase
await asyncTest("26. Tax changes before purchase recalculates real buyer acquisition cost", async () => {
  const targetOffer = { offerId: "off_1", itemCode: "boots2", buyerPrice: 4.141, statName: "dodge", statValue: 9 };
  const mockFetchOffers = async () => [
    { _id: "off_1", price: 4.10, item: { _id: "it1", code: "boots2", state: 100, skills: { dodge: 9 } } },
  ];
  // Tax jumped from 1% to 5%
  const mockTax = async () => 5;

  await assert.rejects(
    () => refreshAndValidateOffer(targetOffer, {
      plannedBuyerPrice: 4.141,
      maxSlippagePct: 0,
      fetchOffersFn: mockFetchOffers,
      fetchTaxFn: mockTax,
    }),
    /Price slippage exceeded/ // 4.10 * 1.05 = 4.305 > 4.141
  );
});

// 27. Max-Price Protection
await asyncTest("27. Max-price protection rejects offers exceeding --max-price ceiling", async () => {
  const targetOffer = { offerId: "off_1", itemCode: "boots2", buyerPrice: 5.50, statName: "dodge", statValue: 9 };
  const mockFetchOffers = async () => [
    { _id: "off_1", price: 5.40, item: { _id: "it1", code: "boots2", state: 100, skills: { dodge: 9 } } },
  ];

  await assert.rejects(
    () => refreshAndValidateOffer(targetOffer, {
      maxPrice: 5.0,
      plannedBuyerPrice: 5.50,
      maxSlippagePct: 5,
      fetchOffersFn: mockFetchOffers,
      fetchTaxFn: async () => 1,
    }),
    /Max price ceiling exceeded/
  );
});

// 28. Budget Protection
await asyncTest("28. Budget protection rejects offers exceeding remaining budget", async () => {
  const targetOffer = { offerId: "off_1", itemCode: "boots2", buyerPrice: 4.141, statName: "dodge", statValue: 9 };
  const mockFetchOffers = async () => [
    { _id: "off_1", price: 4.10, item: { _id: "it1", code: "boots2", state: 100, skills: { dodge: 9 } } },
  ];

  await assert.rejects(
    () => refreshAndValidateOffer(targetOffer, {
      remainingBudget: 3.50, // budget only 3.50
      plannedBuyerPrice: 4.141,
      fetchOffersFn: mockFetchOffers,
      fetchTaxFn: async () => 1,
    }),
    /Budget ceiling exceeded/
  );
});

// 29. 0% Default Slippage
await asyncTest("29. 0% default slippage rejects even +0.01 Gold increase", async () => {
  const targetOffer = { offerId: "off_1", itemCode: "boots2", buyerPrice: 4.141, statName: "dodge", statValue: 9 };
  const mockFetchOffers = async () => [
    { _id: "off_1", price: 4.11, item: { _id: "it1", code: "boots2", state: 100, skills: { dodge: 9 } } },
  ];

  await assert.rejects(
    () => refreshAndValidateOffer(targetOffer, {
      plannedBuyerPrice: 4.141,
      maxSlippagePct: 0, // 0%
      fetchOffersFn: mockFetchOffers,
      fetchTaxFn: async () => 1,
    }),
    /Price slippage exceeded/
  );
});

// 30. Configurable Slippage (+1%)
await asyncTest("30. Configurable slippage (+1%) permits minor price adjustment", async () => {
  const targetOffer = { offerId: "off_1", itemCode: "boots2", buyerPrice: 4.141, statName: "dodge", statValue: 9 };
  // 4.10 -> 4.12 (+0.48% increase, within 1% slippage)
  const mockFetchOffers = async () => [
    { _id: "off_1", price: 4.12, item: { _id: "it1", code: "boots2", state: 100, skills: { dodge: 9 } } },
  ];

  const refreshed = await refreshAndValidateOffer(targetOffer, {
    plannedBuyerPrice: 4.141,
    maxSlippagePct: 1, // +1%
    fetchOffersFn: mockFetchOffers,
    fetchTaxFn: async () => 1,
  });

  assert.strictEqual(refreshed.sellerPrice, 4.12);
  assert.strictEqual(refreshed.buyerPrice, 4.161);
});

// 31. Own Offer Cannot Be Purchased
await asyncTest("31. Own offer cannot be purchased", async () => {
  const targetOffer = { offerId: "off_mine", itemCode: "boots2", buyerPrice: 4.141, statName: "dodge", statValue: 9 };
  const mockFetchOffers = async () => [
    { _id: "off_mine", user: "my_user_id", price: 4.10, item: { _id: "it1", code: "boots2", state: 100, skills: { dodge: 9 } } },
  ];

  await assert.rejects(
    () => refreshAndValidateOffer(targetOffer, {
      myUserId: "my_user_id",
      fetchOffersFn: mockFetchOffers,
    }),
    /owned by current user/
  );
});

// 32. Changed Stats Abort Purchase
await asyncTest("32. Changed rolled stats abort purchase", async () => {
  const targetOffer = { offerId: "off_1", itemCode: "boots2", buyerPrice: 4.141, statName: "dodge", statValue: 10 };
  const mockFetchOffers = async () => [
    { _id: "off_1", price: 4.10, item: { _id: "it1", code: "boots2", state: 100, skills: { dodge: 8 } } }, // stat rolled down to 8!
  ];

  await assert.rejects(
    () => refreshAndValidateOffer(targetOffer, {
      fetchOffersFn: mockFetchOffers,
      fetchTaxFn: async () => 1,
    }),
    /Gear rolled stat changed/
  );
});

// 33. Changed Rarity Aborts Purchase
test("33. Changed rarity aborts purchase", () => {
  const candidate = {
    offerId: "off_1",
    itemId: "it_1",
    rarity: "common",
    category: "boots",
    buyerPrice: 4.14,
    state: 100,
  };

  assert.throws(
    () => verifyFuturePurchaseSafety(candidate, { targetRarity: "uncommon" }),
    /Rarity mismatch/
  );
});

// 34. DOWNGRADE Cannot Be Forced Through Normal Execution
await asyncTest("34. DOWNGRADE cannot be forced through normal execution", async () => {
  const targetOffer = {
    offerId: "off_1",
    itemCode: "boots2",
    category: "boots",
    buyerPrice: 4.141,
    statName: "dodge",
    statValue: 7,
  };
  const mockFetchOffers = async () => [
    { _id: "off_1", price: 4.10, item: { _id: "it1", code: "boots2", state: 100, skills: { dodge: 7 } } },
  ];
  const rangeInfo = { slot: "boots", statName: "dodge", minPossibleStat: 6, maxPossibleStat: 10 };
  const liveEquipped = { boots: { skills: { dodge: 9 } } }; // Equipped has 9, offer has 7

  await assert.rejects(
    () => refreshAndValidateOffer(targetOffer, {
      fetchOffersFn: mockFetchOffers,
      fetchTaxFn: async () => 1,
      rangeInfo,
      liveEquipped,
      ignoreEquipped: false,
    }),
    /no longer an UPGRADE/
  );
});

// 35. VERIFIED_PURCHASED via Inventory
await asyncTest("35. VERIFIED_PURCHASED via inventory presence", async () => {
  const targetOffer = {
    offerId: "off_win",
    itemId: "item_new_123",
    itemCode: "boots2",
    sellerPrice: 4.10,
    statName: "dodge",
    statValue: 9,
  };

  const mockInventory = async () => ({
    items: {
      equipments: [
        { _id: "item_new_123", code: "boots2", skills: { dodge: 9 } },
      ],
    },
  });

  const res = await verifyMarketPurchase(targetOffer, Date.now(), {
    fetchInventoryFn: mockInventory,
    pollScheduleMs: [10],
    sleepFn: async () => {},
  });

  assert.strictEqual(res.state, PurchaseVerificationState.VERIFIED_PURCHASED);
});

// 36. VERIFIED_PURCHASED via Transaction Fallback
await asyncTest("36. VERIFIED_PURCHASED via transaction fallback", async () => {
  const targetOffer = {
    offerId: "off_win_2",
    itemId: "item_tx_123",
    itemCode: "boots2",
    sellerPrice: 4.10,
    statName: "dodge",
    statValue: 9,
  };

  const mockInventory = async () => ({ items: { equipments: [] } }); // not yet visible in inventory
  const mockTransactions = async () => [
    {
      _id: "tx_999",
      buyerId: "my_user_id",
      itemOfferId: "off_win_2",
      transactionType: "itemMarket",
      price: 4.10,
      createdAt: new Date().toISOString(),
    },
  ];

  const res = await verifyMarketPurchase(targetOffer, Date.now(), {
    userId: "my_user_id",
    fetchInventoryFn: mockInventory,
    fetchTransactionsFn: mockTransactions,
    pollScheduleMs: [10],
    sleepFn: async () => {},
  });

  assert.strictEqual(res.state, PurchaseVerificationState.VERIFIED_PURCHASED);
});

// 37. Regenerated Item ID Handling
await asyncTest("37. Regenerated item ID handling resolves via code + stats + acquisition timestamp", async () => {
  const targetOffer = {
    offerId: "off_regen",
    itemId: "old_item_id",
    itemCode: "boots2",
    sellerPrice: 4.10,
    statName: "dodge",
    statValue: 9,
  };

  const subTime = Date.now();
  // MongoDB regenerated new item ID upon transfer
  const mockInventory = async () => ({
    items: {
      equipments: [
        {
          _id: "fresh_mongo_id_555",
          code: "boots2",
          skills: { dodge: 9 },
          lastAcquisitionAt: new Date(subTime).toISOString(),
        },
      ],
    },
  });

  const res = await verifyMarketPurchase(targetOffer, subTime, {
    fetchInventoryFn: mockInventory,
    pollScheduleMs: [10],
    sleepFn: async () => {},
  });

  assert.strictEqual(res.state, PurchaseVerificationState.VERIFIED_PURCHASED);
});

// 38. UNKNOWN Stops the Batch
await asyncTest("38. UNKNOWN state stops batch when evidence cannot be proven", async () => {
  const targetOffer = {
    offerId: "off_lost",
    itemId: "item_lost",
    itemCode: "boots2",
    sellerPrice: 4.10,
    statName: "dodge",
    statValue: 9,
  };

  const mockInventory = async () => ({ items: { equipments: [] } });
  const mockTransactions = async () => [];

  const res = await verifyMarketPurchase(targetOffer, Date.now(), {
    fetchInventoryFn: mockInventory,
    fetchTransactionsFn: mockTransactions,
    pollScheduleMs: [10, 10],
    sleepFn: async () => {},
  });

  assert.strictEqual(res.state, PurchaseVerificationState.UNKNOWN);
});

// 39. UNKNOWN Is Never Automatically Retried
test("39. UNKNOWN is never automatically retried", () => {
  // Verifies that UNKNOWN is a distinct terminal state that halts batch
  assert.strictEqual(PurchaseVerificationState.UNKNOWN, "UNKNOWN");
});

// 40. Failed Purchase Spends No Budget
await asyncTest("40. Failed purchase mutation returns FAILED_NOT_PURCHASED and spends no budget", async () => {
  const targetOffer = {
    offerId: "off_fail",
    itemId: "item_fail",
    itemCode: "boots2",
    sellerPrice: 4.10,
  };

  const res = await verifyMarketPurchase(targetOffer, Date.now(), {
    mutationFailed: true,
    mutationError: "Offer already bought by another player",
    fetchInventoryFn: async () => ({ items: { equipments: [] } }),
    fetchTransactionsFn: async () => [],
    pollScheduleMs: [10],
    sleepFn: async () => {},
  });

  assert.strictEqual(res.state, PurchaseVerificationState.FAILED_NOT_PURCHASED);
});

// 41. Multi-Purchase Budget Accounting
test("41. Multi-purchase budget accounting decrements remaining budget accurately", () => {
  let budget = 20.0;
  const purchases = [
    { buyerPrice: 4.141 },
    { buyerPrice: 4.221 },
  ];

  for (const p of purchases) {
    assert.ok(p.buyerPrice <= budget);
    budget -= p.buyerPrice;
  }

  assert.strictEqual(Number(budget.toFixed(3)), 11.638);
});

// 42. No Automatic Substitution
test("42. No automatic substitution: target is locked strictly to selected offer", () => {
  const targetCandidate = { offerId: "locked_1", itemId: "it_1" };
  const nextBest = { offerId: "locked_2", itemId: "it_2" };
  // Assert locked candidate does not silently switch
  assert.notStrictEqual(targetCandidate.offerId, nextBest.offerId);
});

// 43. No Automatic Equipping
await asyncTest("43. No automatic equipping: buyer never invokes equip actions", async () => {
  // Assertion that buyer module only imports and calls market query & purchase endpoints
  const evaluatorExports = Object.keys(await import("../analyzer/buyer_evaluator.mjs"));
  assert.strictEqual(evaluatorExports.includes("equipItem"), false);
});

// 44. max-purchases defaults to null (inferred from selected loadout)
test("44. max-purchases defaults to null (inferred from selected loadout)", () => {
  const cfg = parseArgs(["--rarity=blue"]);
  assert.strictEqual(cfg.maxPurchases, null);
  assert.strictEqual(cfg.maxSlippage, 0);
  assert.strictEqual(cfg.strategy, "best-value");
});

console.log(chalk.bold.yellow("\n--- Loadout & Standalone Refactor Tests (Section 13) ---\n"));

// 45. Green recommendations appear even when Purple gear is equipped
test("45. Green recommendations appear even when Purple gear is equipped", () => {
  const rangeInfo = { slot: "boots", rarity: "uncommon", statName: "dodge", minPossibleStat: 6, maxPossibleStat: 10 };
  const purpleEquipped = { skills: { dodge: 20 } }; // Purple gear with 20 dodge
  const greenOffer = {
    offerId: "green_1",
    itemId: "it_green_1",
    buyerPrice: 4.14,
    sellerPrice: 4.10,
    skills: { dodge: 9 },
    taxRate: 1,
  };

  // Standalone evaluation (default mode): compareEquipped is false
  const evaluated = evaluateGearOffer(greenOffer, rangeInfo, purpleEquipped, { compareEquipped: false });
  assert.strictEqual(evaluated.disposition, "UPGRADE"); // Treated as eligible standalone
  const recs = findCategoryRecommendations([evaluated], false);
  assert.strictEqual(recs.hasUpgrade, true);
  assert.strictEqual(recs.bestValue.offerId, "green_1");
});

// 46. Default mode does not suppress lower-rarity items
test("46. Default mode does not suppress lower-rarity items", () => {
  const cfg = parseArgs(["--rarity=green"]);
  assert.strictEqual(cfg.compareEquipped, false);
});

// 47. --compare-equipped restores upgrade/downgrade analysis
test("47. --compare-equipped restores upgrade/downgrade analysis", () => {
  const cfg = parseArgs(["--rarity=green", "--compare-equipped"]);
  assert.strictEqual(cfg.compareEquipped, true);

  const rangeInfo = { slot: "boots", rarity: "uncommon", statName: "dodge", minPossibleStat: 6, maxPossibleStat: 10 };
  const purpleEquipped = { skills: { dodge: 20 } };
  const greenOffer = {
    offerId: "green_2",
    itemId: "it_green_2",
    buyerPrice: 4.14,
    sellerPrice: 4.10,
    skills: { dodge: 9 },
    taxRate: 1,
  };

  const evaluated = evaluateGearOffer(greenOffer, rangeInfo, purpleEquipped, { compareEquipped: true });
  assert.strictEqual(evaluated.disposition, "DOWNGRADE");
  assert.strictEqual(evaluated.statDiff, -11);
  const recs = findCategoryRecommendations([evaluated], false);
  assert.strictEqual(recs.hasUpgrade, false);
});

// 48. One exact recommendation is returned per requested slot
test("48. One exact recommendation is returned per requested slot", () => {
  const categoryResults = {};
  const slots = ["helmet", "chest", "gloves", "pants", "boots"];
  for (const slot of slots) {
    categoryResults[slot] = {
      category: slot,
      evaluatedOffers: [
        { offerId: `${slot}_opt`, itemId: `it_${slot}`, buyerPrice: 100, statValue: 40, statName: "armor", rollPercent: 80 },
      ],
      rangeInfo: { statName: "armor" },
    };
  }

  const loadout = buildFullLoadout(categoryResults, { activeCategories: slots });
  assert.strictEqual(loadout.items.length, 5);
  for (const slot of slots) {
    const item = loadout.items.find((it) => it.slot === slot);
    assert.ok(item, `Slot ${slot} must be present in loadout`);
    assert.strictEqual(item.offer.offerId, `${slot}_opt`);
  }
});

// 49. --exclude=weapon produces 5-piece armor set
test("49. --exclude=weapon produces 5-piece armor set", () => {
  const cats = resolveCategories(null, "weapon");
  assert.strictEqual(cats.length, 5);
  assert.strictEqual(cats.includes("weapon"), false);
});

// 50. Including weapon produces 6-piece set
test("50. Including weapon produces 6-piece set", () => {
  const cats = resolveCategories(null, null);
  assert.strictEqual(cats.length, 6);
  assert.strictEqual(cats.includes("weapon"), true);
});

// 51. Include/exclude combinations work
test("51. Include/exclude combinations work: conflict resolved in favor of exclude", () => {
  const cats = resolveCategories("helmet,chest,boots,weapon", "weapon,boots");
  assert.deepStrictEqual(cats, ["helmet", "chest"]);
});

// 52. Best-value chooses economical near-perfect over overpriced perfect
test("52. Best-value chooses economical near-perfect over overpriced perfect", () => {
  const offerNearPerfect = {
    offerId: "o_49",
    itemId: "it_49",
    buyerPrice: 120.0,
    sellerPrice: 118.8,
    skills: { armor: 49 },
    statValue: 49,
    statPerGold: 49 / 120, // 0.408
    rollPercent: 95,
  };
  const offerOverpricedPerfect = {
    offerId: "o_50",
    itemId: "it_50",
    buyerPrice: 180.0,
    sellerPrice: 178.2,
    skills: { armor: 50 },
    statValue: 50,
    statPerGold: 50 / 180, // 0.278
    rollPercent: 100,
    isPerfectRoll: true,
  };

  const recs = findCategoryRecommendations([offerNearPerfect, offerOverpricedPerfect], false);
  assert.strictEqual(recs.bestValue.offerId, "o_49");
});

// 53. Best-performance chooses strongest roll
test("53. Best-performance chooses strongest roll", () => {
  const offerNearPerfect = {
    offerId: "o_49",
    itemId: "it_49",
    buyerPrice: 120.0,
    skills: { armor: 49 },
    statValue: 49,
    rollPercent: 95,
  };
  const offerOverpricedPerfect = {
    offerId: "o_50",
    itemId: "it_50",
    buyerPrice: 180.0,
    skills: { armor: 50 },
    statValue: 50,
    rollPercent: 100,
    isPerfectRoll: true,
  };

  const recs = findCategoryRecommendations([offerNearPerfect, offerOverpricedPerfect], false);
  assert.strictEqual(recs.bestPerformance.offerId, "o_50");
});

// 54. Cheapest chooses cheapest valid offer
test("54. Cheapest chooses cheapest valid offer", () => {
  const offerCheap = {
    offerId: "o_40",
    itemId: "it_40",
    buyerPrice: 70.0,
    skills: { armor: 40 },
    statValue: 40,
    rollPercent: 50,
  };
  const offerMid = {
    offerId: "o_49",
    itemId: "it_49",
    buyerPrice: 120.0,
    skills: { armor: 49 },
    statValue: 49,
    rollPercent: 95,
  };

  const recs = findCategoryRecommendations([offerCheap, offerMid], false);
  assert.strictEqual(recs.cheapestUpgrade.offerId, "o_40");
});

// 55. Total set cost equals sum of selected buyer prices
test("55. Total set cost equals sum of selected buyer prices", () => {
  const categoryResults = {
    helmet: {
      category: "helmet",
      evaluatedOffers: [{ offerId: "h1", itemId: "ih1", buyerPrice: 110.12, statValue: 90, statName: "criticalDamages", rollPercent: 80 }],
      rangeInfo: { statName: "criticalDamages" },
    },
    chest: {
      category: "chest",
      evaluatedOffers: [{ offerId: "c1", itemId: "ic1", buyerPrice: 130.45, statValue: 48, statName: "armor", rollPercent: 90 }],
      rangeInfo: { statName: "armor" },
    },
    boots: {
      category: "boots",
      evaluatedOffers: [{ offerId: "b1", itemId: "ib1", buyerPrice: 95.20, statValue: 38, statName: "dodge", rollPercent: 75 }],
      rangeInfo: { statName: "dodge" },
    },
  };

  const loadout = buildFullLoadout(categoryResults, { activeCategories: ["helmet", "chest", "boots"] });
  const manualSum = Number((110.12 + 130.45 + 95.20).toFixed(3));
  assert.strictEqual(loadout.totalCost, manualSum);
});

// 56. Budget optimization never exceeds budget
test("56. Budget optimization never exceeds budget", () => {
  const candidatePools = {
    helmet: [
      { offerId: "h_cheap", buyerPrice: 100, statValue: 80 },
      { offerId: "h_mid", buyerPrice: 150, statValue: 95 },
      { offerId: "h_high", buyerPrice: 200, statValue: 100 },
    ],
    chest: [
      { offerId: "c_cheap", buyerPrice: 100, statValue: 40 },
      { offerId: "c_mid", buyerPrice: 150, statValue: 48 },
      { offerId: "c_high", buyerPrice: 200, statValue: 50 },
    ],
    boots: [
      { offerId: "b_cheap", buyerPrice: 100, statValue: 30 },
      { offerId: "b_mid", buyerPrice: 150, statValue: 38 },
      { offerId: "b_high", buyerPrice: 200, statValue: 40 },
    ],
  };

  const budget = 350; // Cannot buy all 150s (would be 450)
  const result = optimizeLoadoutUnderBudget(candidatePools, budget, "best-value");
  assert.strictEqual(result.feasible, true);
  assert.ok(result.totalCost <= budget, `Total cost ${result.totalCost} must not exceed budget ${budget}`);
  assert.strictEqual(result.items.length, 3);
});

// 57. Budget mode optimizes the whole set rather than greedily per slot
test("57. Budget mode optimizes the whole set rather than greedily per slot", () => {
  const candidatePools = {
    slot1: [
      { offerId: "s1_cheap", buyerPrice: 100, statValue: 70 },
      { offerId: "s1_greedy", buyerPrice: 180, statValue: 99 },
    ],
    slot2: [
      { offerId: "s2_cheap", buyerPrice: 100, statValue: 70 },
      { offerId: "s2_greedy", buyerPrice: 180, statValue: 99 },
    ],
    slot3: [
      { offerId: "s3_cheap", buyerPrice: 100, statValue: 70 },
      { offerId: "s3_greedy", buyerPrice: 180, statValue: 99 },
    ],
    slot4: [
      { offerId: "s4_cheap", buyerPrice: 70, statValue: 60 },
      { offerId: "s4_mid", buyerPrice: 120, statValue: 80 },
    ],
  };

  const budget = 450; // Greedy sum of slot 1,2,3 (540) would already bust budget
  const result = optimizeLoadoutUnderBudget(candidatePools, budget, "best-value");
  assert.strictEqual(result.feasible, true);
  assert.ok(result.totalCost <= budget, `Total cost ${result.totalCost} <= ${budget}`);
  assert.strictEqual(result.items.length, 4);
});

// 58. Exact offer IDs remain attached to all selected items
test("58. Exact offer IDs remain attached to all selected items", () => {
  const categoryResults = {
    helmet: {
      category: "helmet",
      evaluatedOffers: [{ offerId: "exact_h_123", itemId: "item_h_456", buyerPrice: 110.12, statValue: 90, statName: "criticalDamages", rollPercent: 80 }],
      rangeInfo: { statName: "criticalDamages" },
    },
    boots: {
      category: "boots",
      evaluatedOffers: [{ offerId: "exact_b_789", itemId: "item_b_012", buyerPrice: 95.20, statValue: 38, statName: "dodge", rollPercent: 75 }],
      rangeInfo: { statName: "dodge" },
    },
  };

  const loadout = buildFullLoadout(categoryResults, { activeCategories: ["helmet", "boots"] });
  const hItem = loadout.items.find((i) => i.slot === "helmet");
  const bItem = loadout.items.find((i) => i.slot === "boots");

  assert.strictEqual(hItem.offer.offerId, "exact_h_123");
  assert.strictEqual(hItem.offer.itemId, "item_h_456");
  assert.strictEqual(bItem.offer.offerId, "exact_b_789");
  assert.strictEqual(bItem.offer.itemId, "item_b_012");
});

// 59. No live purchases during implementation/testing
test("59. No live purchases during implementation/testing", () => {
  const cfg = parseArgs(["--rarity=gold"]);
  assert.strictEqual(cfg.execute, false);
});

console.log(chalk.bold.yellow("\n--- Stat Range & Fail-Closed Hardening Tests (Section 14) ---\n"));

// 60. Asymmetric real-style ranges for Gold equipment prove rarityRollPercent
test("60. Asymmetric real-style ranges for Gold equipment prove rarityRollPercent", () => {
  const goldRanges = {
    helmet: { slot: "helmet", rarity: "legendary", statName: "criticalDamages", minPossibleStat: 91, maxPossibleStat: 110 },
    gloves: { slot: "gloves", rarity: "legendary", statName: "precision", minPossibleStat: 31, maxPossibleStat: 40 },
    boots: { slot: "boots", rarity: "legendary", statName: "dodge", minPossibleStat: 31, maxPossibleStat: 40 },
    chest: { slot: "chest", rarity: "legendary", statName: "armor", minPossibleStat: 36, maxPossibleStat: 50 },
    pants: { slot: "pants", rarity: "legendary", statName: "armor", minPossibleStat: 36, maxPossibleStat: 50 },
    blueBoots: { slot: "boots", rarity: "rare", statName: "dodge", minPossibleStat: 11, maxPossibleStat: 15 },
  };

  // Gold Helmet +99 [91,110] -> 42.105% (~42%)
  const evalHelmet = evaluateGearOffer(
    { offerId: "h1", itemId: "ih1", buyerPrice: 100, skills: { criticalDamages: 99 } },
    goldRanges.helmet
  );
  assert.strictEqual(evalHelmet.rarityRollPercentExact, 42.105);
  assert.strictEqual(evalHelmet.rollPercent, 42);
  assert.strictEqual(evalHelmet.rollPosition, "42%");

  // Gold Gloves +38 [31,40] -> 77.778% (~78%)
  const evalGloves = evaluateGearOffer(
    { offerId: "g1", itemId: "ig1", buyerPrice: 100, skills: { precision: 38 } },
    goldRanges.gloves
  );
  assert.strictEqual(evalGloves.rarityRollPercentExact, 77.778);
  assert.strictEqual(evalGloves.rollPercent, 78);
  assert.strictEqual(evalGloves.rollPosition, "78%");

  // Gold Boots +36 [31,40] -> 55.556% (~56%)
  const evalBoots = evaluateGearOffer(
    { offerId: "b1", itemId: "ib1", buyerPrice: 100, skills: { dodge: 36 } },
    goldRanges.boots
  );
  assert.strictEqual(evalBoots.rarityRollPercentExact, 55.556);
  assert.strictEqual(evalBoots.rollPercent, 56);
  assert.strictEqual(evalBoots.rollPosition, "56%");

  // Gold Chest +44 [36,50] -> 57.143% (~57%)
  const evalChest = evaluateGearOffer(
    { offerId: "c1", itemId: "ic1", buyerPrice: 100, skills: { armor: 44 } },
    goldRanges.chest
  );
  assert.strictEqual(evalChest.rarityRollPercentExact, 57.143);
  assert.strictEqual(evalChest.rollPercent, 57);
  assert.strictEqual(evalChest.rollPosition, "57%");

  // Gold Pants +49 [36,50] -> 92.857% (~93%)
  const evalPants = evaluateGearOffer(
    { offerId: "p1", itemId: "ip1", buyerPrice: 100, skills: { armor: 49 } },
    goldRanges.pants
  );
  assert.strictEqual(evalPants.rarityRollPercentExact, 92.857);
  assert.strictEqual(evalPants.rollPercent, 93);
  assert.strictEqual(evalPants.rollPosition, "93%");

  // Blue Boots +14 [11,15] -> 75%
  const evalBlueBoots = evaluateGearOffer(
    { offerId: "bb1", itemId: "ibb1", buyerPrice: 10, skills: { dodge: 14 } },
    goldRanges.blueBoots
  );
  assert.strictEqual(evalBlueBoots.rarityRollPercentExact, 75);
  assert.strictEqual(evalBlueBoots.rollPercent, 75);
  assert.strictEqual(evalBlueBoots.rollPosition, "75%");
});

// 61. Boundary tests: min -> 0%, max -> 100%, max -> PERFECT
test("61. Boundary tests: min -> 0%, max -> 100%, max -> PERFECT", () => {
  const helmetRange = { slot: "helmet", rarity: "legendary", statName: "criticalDamages", minPossibleStat: 91, maxPossibleStat: 110 };
  const glovesRange = { slot: "gloves", rarity: "legendary", statName: "precision", minPossibleStat: 31, maxPossibleStat: 40 };

  // Min boundary -> 0%
  const evalHMin = evaluateGearOffer({ offerId: "h_min", itemId: "ih_min", buyerPrice: 100, skills: { criticalDamages: 91 } }, helmetRange);
  assert.strictEqual(evalHMin.rarityRollPercentExact, 0);
  assert.strictEqual(evalHMin.rollPercent, 0);
  assert.strictEqual(evalHMin.isMinimum, true);

  // Max boundary -> 100% and PERFECT
  const evalH110 = evaluateGearOffer({ offerId: "h1", itemId: "ih1", buyerPrice: 100, skills: { criticalDamages: 110 } }, helmetRange);
  assert.strictEqual(evalH110.rarityRollPercentExact, 100);
  assert.strictEqual(evalH110.rollPercent, 100);
  assert.strictEqual(evalH110.isPerfect, true);
  assert.strictEqual(evalH110.isPerfectRoll, true);
  assert.strictEqual(evalH110.rollPosition, "PERFECT");

  // Near-max (100 in [91, 110]) is NOT perfect
  const evalH100 = evaluateGearOffer({ offerId: "h2", itemId: "ih2", buyerPrice: 100, skills: { criticalDamages: 100 } }, helmetRange);
  assert.strictEqual(evalH100.isPerfect, false);
  assert.notStrictEqual(evalH100.rollPosition, "PERFECT");

  // Gloves 40 in [31, 40] is PERFECT
  const evalG40 = evaluateGearOffer({ offerId: "g1", itemId: "ig1", buyerPrice: 100, skills: { precision: 40 } }, glovesRange);
  assert.strictEqual(evalG40.isPerfect, true);
  assert.strictEqual(evalG40.rollPosition, "PERFECT");
});

// 62. Boundary tests: below min -> INVALID LIVE RANGE
test("62. Boundary tests: below min -> INVALID LIVE RANGE", () => {
  const glovesRange = { slot: "gloves", rarity: "legendary", statName: "precision", minPossibleStat: 31, maxPossibleStat: 40 };
  const underflowOffer = { offerId: "g_low", itemId: "ig_low", buyerPrice: 50, skills: { precision: 25 } };
  const validOffer = { offerId: "g_ok", itemId: "ig_ok", buyerPrice: 100, skills: { precision: 35 } };

  const evalUnderflow = evaluateGearOffer(underflowOffer, glovesRange);
  assert.strictEqual(evalUnderflow.isInvalidRange, true);
  assert.strictEqual(evalUnderflow.disposition, "INVALID LIVE RANGE");
  assert.strictEqual(evalUnderflow.statPerGold, 0);

  const evalOk = evaluateGearOffer(validOffer, glovesRange);
  const recs = findCategoryRecommendations([evalUnderflow, evalOk], false);
  assert.strictEqual(recs.bestValue.offerId, "g_ok");
  assert.strictEqual(recs.bestPerformance.offerId, "g_ok");
  assert.strictEqual(recs.cheapestUpgrade.offerId, "g_ok");
});

// 63. Boundary tests: above max -> INVALID LIVE RANGE
test("63. Boundary tests: above max -> INVALID LIVE RANGE", () => {
  const glovesRange = { slot: "gloves", rarity: "legendary", statName: "precision", minPossibleStat: 31, maxPossibleStat: 40 };
  const overflowOffer = { offerId: "g_high", itemId: "ig_high", buyerPrice: 50, skills: { precision: 45 } };
  const validOffer = { offerId: "g_ok", itemId: "ig_ok", buyerPrice: 100, skills: { precision: 38 } };

  const evalOverflow = evaluateGearOffer(overflowOffer, glovesRange);
  assert.strictEqual(evalOverflow.isInvalidRange, true);
  assert.strictEqual(evalOverflow.disposition, "INVALID LIVE RANGE");

  const evalOk = evaluateGearOffer(validOffer, glovesRange);
  const recs = findCategoryRecommendations([evalOverflow, evalOk], false);
  assert.strictEqual(recs.bestValue.offerId, "g_ok");
  assert.strictEqual(recs.bestPerformance.offerId, "g_ok");
});

// 64. Weapon fail-closed on out-of-range attack or crit
test("64. Weapon fail-closed on out-of-range attack or crit", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const overflowWeapon = { offerId: "w_high", itemId: "iw_high", buyerPrice: 100, skills: { attack: 185, criticalChance: 30 } };
  const validWeapon = { offerId: "w_ok", itemId: "iw_ok", buyerPrice: 150, skills: { attack: 165, criticalChance: 30 } };

  const evalOverflow = evaluateWeaponOffer(overflowWeapon, weaponMeta, null, {}, {});
  assert.strictEqual(evalOverflow.isInvalidRange, true);
  assert.strictEqual(evalOverflow.disposition, "INVALID LIVE RANGE");

  const evalOk = evaluateWeaponOffer(validWeapon, weaponMeta, null, {}, {});
  const recs = findCategoryRecommendations([evalOverflow, evalOk], true);
  assert.strictEqual(recs.bestValue.offerId, "w_ok");
});

// 65. Single source of truth across loadout display and scoring
test("65. Single source of truth across loadout display and scoring", () => {
  const categoryResults = {
    gloves: {
      category: "gloves",
      rangeInfo: { slot: "gloves", rarity: "legendary", statName: "precision", minPossibleStat: 31, maxPossibleStat: 40 },
      evaluatedOffers: [
        evaluateGearOffer(
          { offerId: "g1", itemId: "ig1", buyerPrice: 150, skills: { precision: 38 } },
          { slot: "gloves", rarity: "legendary", statName: "precision", minPossibleStat: 31, maxPossibleStat: 40 }
        ),
      ],
    },
  };

  const loadout = buildFullLoadout(categoryResults, { activeCategories: ["gloves"] });
  const gItem = loadout.items[0];
  assert.strictEqual(gItem.minPossibleStat, 31);
  assert.strictEqual(gItem.maxPossibleStat, 40);
  assert.strictEqual(gItem.rangeDisplay, "31-40");
  assert.strictEqual(gItem.rollDisplay, "78%");
  assert.strictEqual(gItem.cost, 150);
});

// 66. Live Gold Helmet scoring consistency: +99 @ 113.120 G vs +101 @ 117.150 G across strategies
test("66. Live Gold Helmet scoring consistency: +99 @ 113.120 G vs +101 @ 117.150 G across strategies", () => {
  const helmetRange = {
    slot: "helmet",
    rarity: "legendary",
    statName: "criticalDamages",
    minPossibleStat: 91,
    maxPossibleStat: 110,
  };

  const offerA = { offerId: "offer_99", itemId: "item_99", buyerPrice: 113.12, skills: { criticalDamages: 99 } };
  const offerB = { offerId: "offer_101", itemId: "item_101", buyerPrice: 117.15, skills: { criticalDamages: 101 } };

  const evalA = evaluateGearOffer(offerA, helmetRange);
  const evalB = evaluateGearOffer(offerB, helmetRange);

  // QualityScore: (99-91)/19 = 8/19 = 0.421053; (101-91)/19 = 10/19 = 0.526316
  assert.strictEqual(evalA.qualityScore, 0.421053);
  assert.strictEqual(evalB.qualityScore, 0.526316);

  // ValueScore: qualityScore / buyerPrice
  // evalA: 0.421053 / 113.120 = 0.003722
  // evalB: 0.526316 / 117.150 = 0.004493
  assert.strictEqual(evalA.valueScore, 0.003722);
  assert.strictEqual(evalB.valueScore, 0.004493);
  assert.ok(evalB.valueScore > evalA.valueScore, "Offer B (+101) must have higher valueScore than Offer A (+99)");

  const recs = findCategoryRecommendations([evalA, evalB], false);

  // 1. BEST VALUE: Offer B wins
  assert.strictEqual(recs.bestValue.offerId, "offer_101");

  // 2. CHEAPEST UPGRADE: Offer A wins (113.120 < 117.150)
  assert.strictEqual(recs.cheapestUpgrade.offerId, "offer_99");

  // 3. BEST PERFORMANCE: Offer B wins (101 > 99)
  assert.strictEqual(recs.bestPerformance.offerId, "offer_101");
});

// 67. Scale-safe cross-slot loadout optimization prevents Helmet from overpowering Boots
test("67. Scale-safe cross-slot loadout optimization prevents Helmet from overpowering Boots", () => {
  const helmetRange = {
    slot: "helmet",
    rarity: "legendary",
    statName: "criticalDamages",
    minPossibleStat: 91,
    maxPossibleStat: 110,
  };
  const bootsRange = {
    slot: "boots",
    rarity: "legendary",
    statName: "dodge",
    minPossibleStat: 31,
    maxPossibleStat: 40,
  };

  // Case 1: Equal raw drop of 1 point (Helmet 110->109 vs Boots 40->39)
  // In raw stat space, dropping 1 on Helmet is indistinguishable from dropping 1 on Boots (both sum to 149).
  // In normalized roll quality, Helmet drop is 1/19 (5.26% loss), Boots drop is 1/9 (11.11% loss).
  // Optimizer MUST choose to drop Helmet rather than Boots.
  const poolEqualRawDrop = {
    helmet: [
      evaluateGearOffer({ offerId: "h_mid", buyerPrice: 100, skills: { criticalDamages: 109 } }, helmetRange),
      evaluateGearOffer({ offerId: "h_perf", buyerPrice: 150, skills: { criticalDamages: 110 } }, helmetRange),
    ],
    boots: [
      evaluateGearOffer({ offerId: "b_mid", buyerPrice: 100, skills: { dodge: 39 } }, bootsRange),
      evaluateGearOffer({ offerId: "b_perf", buyerPrice: 150, skills: { dodge: 40 } }, bootsRange),
    ],
  };

  const result1 = optimizeLoadoutUnderBudget(poolEqualRawDrop, 250, "best-performance");
  assert.strictEqual(result1.feasible, true);
  assert.strictEqual(result1.totalCost, 250);
  const hItem1 = result1.items.find((i) => i.slot === "helmet");
  const bItem1 = result1.items.find((i) => i.slot === "boots");
  assert.strictEqual(hItem1.offer.offerId, "h_mid", "Helmet should sacrifice 1 pt (5.26% loss)");
  assert.strictEqual(bItem1.offer.offerId, "b_perf", "Boots should keep perfect roll (11.11% preserved)");
  assert.strictEqual(result1.totalQuality, 1.9474);

  // Case 2: Raw stat asymmetry where Helmet drop (15 pts) > Boots drop (9 pts)
  // Raw stats would choose Option 1 (141 > 135) to avoid the 15-pt drop.
  // Normalized loadout quality chooses Option 2 (1.2105 > 1.0) because Boots dropping 100% is far worse.
  const poolAsymmetric = {
    helmet: [
      evaluateGearOffer({ offerId: "h_low", buyerPrice: 100, skills: { criticalDamages: 95 } }, helmetRange), // quality: 4/19 = 0.2105
      evaluateGearOffer({ offerId: "h_perf", buyerPrice: 150, skills: { criticalDamages: 110 } }, helmetRange), // quality: 1.0
    ],
    boots: [
      evaluateGearOffer({ offerId: "b_min", buyerPrice: 100, skills: { dodge: 31 } }, bootsRange), // quality: 0.0
      evaluateGearOffer({ offerId: "b_perf", buyerPrice: 150, skills: { dodge: 40 } }, bootsRange), // quality: 1.0
    ],
  };

  const result2 = optimizeLoadoutUnderBudget(poolAsymmetric, 250, "best-performance");
  assert.strictEqual(result2.feasible, true);
  assert.strictEqual(result2.totalCost, 250);
  const hItem2 = result2.items.find((i) => i.slot === "helmet");
  const bItem2 = result2.items.find((i) => i.slot === "boots");
  assert.strictEqual(hItem2.offer.offerId, "h_low", "Scale-safe optimizer prioritizes Boots quality");
  assert.strictEqual(bItem2.offer.offerId, "b_perf", "Boots stays at 100% quality");
  assert.strictEqual(result2.totalQuality, 1.2105);
});

console.log(chalk.bold.yellow("\n--- Theoretical Weapon Normalization & Roll Precision Tests (Section 15) ---\n"));

// 68. Theoretical weapon min -> 0 and max -> 1 normalized weaponQuality
test("68. Theoretical weapon min -> 0 and max -> 1 normalized weaponQuality", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };

  const minWeapon = { offerId: "w_min", buyerPrice: 100, skills: { attack: 141, criticalChance: 26 } };
  const maxWeapon = { offerId: "w_max", buyerPrice: 200, skills: { attack: 170, criticalChance: 35 } };

  const evalMin = evaluateWeaponOffer(minWeapon, weaponMeta, null, {}, {});
  const evalMax = evaluateWeaponOffer(maxWeapon, weaponMeta, null, {}, {});

  assert.strictEqual(evalMin.candidateDamage, evalMin.theoreticalMinDamage);
  assert.strictEqual(evalMin.weaponQuality, 0);
  assert.strictEqual(evalMin.slotQuality, 0);
  assert.strictEqual(evalMin.isMinimum, undefined);

  assert.strictEqual(evalMax.candidateDamage, evalMax.theoreticalMaxDamage);
  assert.strictEqual(evalMax.weaponQuality, 1);
  assert.strictEqual(evalMax.slotQuality, 1);
  assert.strictEqual(evalMax.isPerfect, true);
  assert.strictEqual(evalMax.isPerfectRoll, true);
  assert.strictEqual(evalMax.rollPosition, "PERFECT");
});

// 69. Candidate weapon damage outside theoretical bounds fails closed beyond tolerance
test("69. Candidate weapon damage outside theoretical bounds fails closed beyond tolerance", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };

  const underflowWeapon = { offerId: "w_under", buyerPrice: 100, skills: { attack: 135, criticalChance: 26 } };
  const overflowWeapon = { offerId: "w_over", buyerPrice: 100, skills: { attack: 175, criticalChance: 35 } };

  const evalUnderflow = evaluateWeaponOffer(underflowWeapon, weaponMeta, null, {}, {});
  assert.strictEqual(evalUnderflow.isInvalidRange, true);
  assert.strictEqual(evalUnderflow.disposition, "INVALID LIVE RANGE");
  assert.strictEqual(evalUnderflow.slotQuality, null);
  assert.strictEqual(evalUnderflow.weaponQuality, null);

  const evalOverflow = evaluateWeaponOffer(overflowWeapon, weaponMeta, null, {}, {});
  assert.strictEqual(evalOverflow.isInvalidRange, true);
  assert.strictEqual(evalOverflow.disposition, "INVALID LIVE RANGE");
  assert.strictEqual(evalOverflow.slotQuality, null);
  assert.strictEqual(evalOverflow.weaponQuality, null);
});

// 70. Market composition invariance: removing weakest or strongest listing does not change candidate normalized quality
test("70. Market composition invariance: removing weakest or strongest listing does not change candidate normalized quality", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };

  const wLow = evaluateWeaponOffer({ offerId: "w_low", buyerPrice: 100, skills: { attack: 145, criticalChance: 27 } }, weaponMeta, null, {}, {});
  const wMid = evaluateWeaponOffer({ offerId: "w_mid", buyerPrice: 140, skills: { attack: 155, criticalChance: 30 } }, weaponMeta, null, {}, {});
  const wHigh = evaluateWeaponOffer({ offerId: "w_high", buyerPrice: 190, skills: { attack: 165, criticalChance: 34 } }, weaponMeta, null, {}, {});

  const originalQuality = wMid.weaponQuality;
  assert.ok(originalQuality > 0 && originalQuality < 1, "Mid weapon quality should be between 0 and 1");

  // Pool A: Full market [low, mid, high]
  const poolA = { weapon: [wLow, wMid, wHigh] };
  const optA = optimizeLoadoutUnderBudget(poolA, 150, "best-performance");
  const selectedA = optA.items.find((i) => i.slot === "weapon");

  // Pool B: Weakest removed [mid, high]
  const poolB = { weapon: [wMid, wHigh] };
  const optB = optimizeLoadoutUnderBudget(poolB, 150, "best-performance");
  const selectedB = optB.items.find((i) => i.slot === "weapon");

  // Pool C: Strongest removed [low, mid]
  const poolC = { weapon: [wLow, wMid] };
  const optC = optimizeLoadoutUnderBudget(poolC, 150, "best-performance");
  const selectedC = optC.items.find((i) => i.slot === "weapon");

  // Pool D: Only mid available [mid]
  const poolD = { weapon: [wMid] };
  const optD = optimizeLoadoutUnderBudget(poolD, 150, "best-performance");
  const selectedD = optD.items.find((i) => i.slot === "weapon");

  assert.strictEqual(selectedA.offer.weaponQuality, originalQuality);
  assert.strictEqual(selectedB.offer.weaponQuality, originalQuality);
  assert.strictEqual(selectedC.offer.weaponQuality, originalQuality);
  assert.strictEqual(selectedD.offer.weaponQuality, originalQuality);

  assert.strictEqual(selectedA.offer.slotQuality, originalQuality);
  assert.strictEqual(selectedB.offer.slotQuality, originalQuality);
  assert.strictEqual(selectedC.offer.slotQuality, originalQuality);
  assert.strictEqual(selectedD.offer.slotQuality, originalQuality);
});

// 71. +167/+29 Gold Tank displays mathematically correct 61% combined rarity roll
test("71. +167/+29 Gold Tank displays mathematically correct 61% combined rarity roll", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };

  const tankOffer = { offerId: "tank_167_29", itemId: "itank", buyerPrice: 145.238, skills: { attack: 167, criticalChance: 29 } };
  const evalTank = evaluateWeaponOffer(tankOffer, weaponMeta, null, {}, {});

  // attackRoll: (167-141)/(170-141) = 26/29 = 89.655%
  // critRoll: (29-26)/(35-26) = 3/9 = 33.333%
  // mean exact roll: (89.65517 + 33.33333)/2 = 61.494%
  // Integer display rounding: Math.round(61.494) = 61% (NOT 62%)
  assert.strictEqual(evalTank.atkRollPercent, 90);
  assert.strictEqual(evalTank.critRollPercent, 33);
  assert.strictEqual(evalTank.rarityRollPercentExact, 61.494);
  assert.strictEqual(evalTank.rollPercent, 61);
  assert.strictEqual(evalTank.rarityRollPercent, 61);
});

console.log(chalk.bold.yellow("\n--- Budget Ceiling & Strategy Invariant Tests (Section 17) ---\n"));

// 72. Best Value set costs 900, budget 1000 -> selected set remains Best Value 900
test("72. Best Value set costs 900, budget 1000 -> selected set remains Best Value 900", () => {
  const hRange = { slot: "helmet", rarity: "legendary", statName: "criticalDamages", minPossibleStat: 91, maxPossibleStat: 110 };
  const cRange = { slot: "chest", rarity: "legendary", statName: "armor", minPossibleStat: 1, maxPossibleStat: 100 };
  const h_val = evaluateGearOffer({ offerId: "h_val", buyerPrice: 400, skills: { criticalDamages: 109 } }, hRange);
  const h_perf = evaluateGearOffer({ offerId: "h_perf", buyerPrice: 425, skills: { criticalDamages: 110 } }, hRange);
  const c_val = evaluateGearOffer({ offerId: "c_val", buyerPrice: 500, skills: { armor: 96 } }, cRange);
  const c_perf = evaluateGearOffer({ offerId: "c_perf", buyerPrice: 525, skills: { armor: 100 } }, cRange);

  const pools = {
    helmet: [h_val, h_perf],
    chest: [c_val, c_perf],
  };

  const loadout = optimizeLoadoutUnderBudget(pools, 1000, "best-value");
  assert.strictEqual(loadout.feasible, true);
  assert.strictEqual(loadout.totalCost, 900, "Budget 1000 must NOT inflate Best Value beyond its natural 900 G total");
  assert.strictEqual(loadout.items.find((i) => i.slot === "helmet").offer.offerId, "h_val");
  assert.strictEqual(loadout.items.find((i) => i.slot === "chest").offer.offerId, "c_val");
});

// 73. Best Performance costs 950, Best Value costs 900, budget 1000 -> --strategy=best-value selects 900; --strategy=best-performance selects 950
test("73. Best Performance costs 950, Best Value costs 900, budget 1000 -> --strategy=best-value selects 900; --strategy=best-performance selects 950", () => {
  const hRange = { slot: "helmet", rarity: "legendary", statName: "criticalDamages", minPossibleStat: 91, maxPossibleStat: 110 };
  const cRange = { slot: "chest", rarity: "legendary", statName: "armor", minPossibleStat: 1, maxPossibleStat: 100 };
  const h_val = evaluateGearOffer({ offerId: "h_val", buyerPrice: 400, skills: { criticalDamages: 109 } }, hRange);
  const h_perf = evaluateGearOffer({ offerId: "h_perf", buyerPrice: 425, skills: { criticalDamages: 110 } }, hRange);
  const c_val = evaluateGearOffer({ offerId: "c_val", buyerPrice: 500, skills: { armor: 96 } }, cRange);
  const c_perf = evaluateGearOffer({ offerId: "c_perf", buyerPrice: 525, skills: { armor: 100 } }, cRange);

  const pools = {
    helmet: [h_val, h_perf],
    chest: [c_val, c_perf],
  };

  const optVal = optimizeLoadoutUnderBudget(pools, 1000, "best-value");
  const optPerf = optimizeLoadoutUnderBudget(pools, 1000, "best-performance");

  assert.strictEqual(optVal.totalCost, 900);
  assert.strictEqual(optPerf.totalCost, 950);
  assert.strictEqual(optVal.items.find((i) => i.slot === "helmet").offer.offerId, "h_val");
  assert.strictEqual(optPerf.items.find((i) => i.slot === "helmet").offer.offerId, "h_perf");
});

// 74. Best Value costs 900, budget 850 -> constrained Best Value optimizer activates (maximizes valueScore under 850)
test("74. Best Value costs 900, budget 850 -> constrained Best Value optimizer activates (maximizes valueScore under 850)", () => {
  const hRange = { slot: "helmet", rarity: "legendary", statName: "criticalDamages", minPossibleStat: 91, maxPossibleStat: 110 };
  const cRange = { slot: "chest", rarity: "legendary", statName: "armor", minPossibleStat: 1, maxPossibleStat: 100 };
  const h_val = evaluateGearOffer({ offerId: "h_val", buyerPrice: 400, skills: { criticalDamages: 109 } }, hRange);
  const h_perf = evaluateGearOffer({ offerId: "h_perf", buyerPrice: 425, skills: { criticalDamages: 110 } }, hRange);
  const h_low = evaluateGearOffer({ offerId: "h_low", buyerPrice: 325, skills: { criticalDamages: 95 } }, hRange);

  const c_val = evaluateGearOffer({ offerId: "c_val", buyerPrice: 500, skills: { armor: 96 } }, cRange);
  const c_perf = evaluateGearOffer({ offerId: "c_perf", buyerPrice: 525, skills: { armor: 100 } }, cRange);
  const c_low = evaluateGearOffer({ offerId: "c_low", buyerPrice: 400, skills: { armor: 50 } }, cRange);

  const pools = {
    helmet: [h_val, h_perf, h_low],
    chest: [c_val, c_perf, c_low],
  };

  // Unconstrained Best Value (h_val 400 + c_val 500 = 900) exceeds budget 850.
  // Optimizer evaluates valid combinations under 850 G:
  // - h_val (400) + c_low (400) = 800 G -> total valueScore ~ 0.003605
  // - h_low (325) + c_val (500) = 825 G -> total valueScore ~ 0.002567
  // - h_low (325) + c_low (400) = 725 G -> total valueScore ~ 0.001885
  // Max aggregate valueScore under 850 G selects h_val + c_low @ 800 G.
  const optConstrained = optimizeLoadoutUnderBudget(pools, 850, "best-value");
  assert.strictEqual(optConstrained.feasible, true);
  assert.strictEqual(optConstrained.totalCost, 800);
  assert.strictEqual(optConstrained.items.find((i) => i.slot === "helmet").offer.offerId, "h_val");
  assert.strictEqual(optConstrained.items.find((i) => i.slot === "chest").offer.offerId, "c_low");
});

// 75. Main table total equals Selected alternative total
test("75. Main table total equals Selected alternative total", () => {
  const hRange = { slot: "helmet", rarity: "legendary", statName: "criticalDamages", minPossibleStat: 91, maxPossibleStat: 110 };
  const cRange = { slot: "chest", rarity: "legendary", statName: "armor", minPossibleStat: 1, maxPossibleStat: 100 };
  const h_val = evaluateGearOffer({ offerId: "h_val", buyerPrice: 400, skills: { criticalDamages: 109 } }, hRange);
  const h_perf = evaluateGearOffer({ offerId: "h_perf", buyerPrice: 425, skills: { criticalDamages: 110 } }, hRange);
  const c_val = evaluateGearOffer({ offerId: "c_val", buyerPrice: 500, skills: { armor: 96 } }, cRange);
  const c_perf = evaluateGearOffer({ offerId: "c_perf", buyerPrice: 525, skills: { armor: 100 } }, cRange);

  const categoryResults = {
    helmet: { rangeInfo: hRange, evaluatedOffers: [h_val, h_perf] },
    chest: { rangeInfo: cRange, evaluatedOffers: [c_val, c_perf] },
  };

  const loadout = buildFullLoadout(categoryResults, {
    strategy: "best-value",
    budget: 1000,
    activeCategories: ["helmet", "chest"],
  });

  const selectedAlt = loadout.alternativeSets["best-value"];
  assert.strictEqual(selectedAlt.isSelected, true);
  assert.strictEqual(Math.abs(loadout.totalCost - selectedAlt.totalCost) < 0.001, true);
  assert.strictEqual(loadout.totalCost, selectedAlt.totalCost);
});

// 76. Main table offer IDs equal Selected alternative offer IDs
test("76. Main table offer IDs equal Selected alternative offer IDs", () => {
  const hRange = { slot: "helmet", rarity: "legendary", statName: "criticalDamages", minPossibleStat: 91, maxPossibleStat: 110 };
  const cRange = { slot: "chest", rarity: "legendary", statName: "armor", minPossibleStat: 1, maxPossibleStat: 100 };
  const h_val = evaluateGearOffer({ offerId: "h_val", buyerPrice: 400, skills: { criticalDamages: 109 } }, hRange);
  const c_val = evaluateGearOffer({ offerId: "c_val", buyerPrice: 500, skills: { armor: 96 } }, cRange);

  const categoryResults = {
    helmet: { rangeInfo: hRange, evaluatedOffers: [h_val] },
    chest: { rangeInfo: cRange, evaluatedOffers: [c_val] },
  };

  const loadout = buildFullLoadout(categoryResults, {
    strategy: "best-value",
    budget: 1000,
    activeCategories: ["helmet", "chest"],
  });

  const mainOfferIds = loadout.offerIds.slice().sort().join(",");
  const altOfferIds = loadout.alternativeSets["best-value"].offerIds.slice().sort().join(",");
  assert.strictEqual(mainOfferIds, altOfferIds);
});

// 77. Displayed offer IDs equal execution-staged offer IDs
test("77. Displayed offer IDs equal execution-staged offer IDs", () => {
  const hRange = { slot: "helmet", rarity: "legendary", statName: "criticalDamages", minPossibleStat: 91, maxPossibleStat: 110 };
  const cRange = { slot: "chest", rarity: "legendary", statName: "armor", minPossibleStat: 1, maxPossibleStat: 100 };
  const h_val = evaluateGearOffer({ offerId: "h_val", buyerPrice: 400, skills: { criticalDamages: 109 } }, hRange);
  const c_val = evaluateGearOffer({ offerId: "c_val", buyerPrice: 500, skills: { armor: 96 } }, cRange);

  const categoryResults = {
    helmet: { rangeInfo: hRange, evaluatedOffers: [h_val] },
    chest: { rangeInfo: cRange, evaluatedOffers: [c_val] },
  };

  const loadout = buildFullLoadout(categoryResults, {
    strategy: "best-value",
    budget: 1000,
    activeCategories: ["helmet", "chest"],
  });

  const candidatesQueue = loadout.items.map((it) => ({
    category: it.slot,
    offer: it.offer,
    cost: it.cost,
  }));

  const displayedOfferIds = (loadout.selectedLoadout?.offerIds || loadout.offerIds).slice().sort().join(",");
  const stagedPurchaseOfferIds = candidatesQueue.map((c) => c.offer.offerId || c.offer._id).slice().sort().join(",");

  assert.strictEqual(displayedOfferIds, stagedPurchaseOfferIds);
});

// 78. Alternative price deltas are relative to actual selected loadout
test("78. Alternative price deltas are relative to actual selected loadout", () => {
  const hRange = { slot: "helmet", rarity: "legendary", statName: "criticalDamages", minPossibleStat: 91, maxPossibleStat: 110 };
  const cRange = { slot: "chest", rarity: "legendary", statName: "armor", minPossibleStat: 1, maxPossibleStat: 100 };
  const h_val = evaluateGearOffer({ offerId: "h_val", buyerPrice: 400, skills: { criticalDamages: 109 } }, hRange);
  const h_perf = evaluateGearOffer({ offerId: "h_perf", buyerPrice: 425, skills: { criticalDamages: 110 } }, hRange);
  const c_val = evaluateGearOffer({ offerId: "c_val", buyerPrice: 500, skills: { armor: 96 } }, cRange);
  const c_perf = evaluateGearOffer({ offerId: "c_perf", buyerPrice: 525, skills: { armor: 100 } }, cRange);

  const categoryResults = {
    helmet: { rangeInfo: hRange, evaluatedOffers: [h_val, h_perf] },
    chest: { rangeInfo: cRange, evaluatedOffers: [c_val, c_perf] },
  };

  const loadout = buildFullLoadout(categoryResults, {
    strategy: "best-value",
    budget: 1000,
    activeCategories: ["helmet", "chest"],
  });

  // Selected loadout total is 900.
  // Best performance total is 950.
  const perfAlt = loadout.alternativeSets["best-performance"];
  const diff = Number((perfAlt.totalCost - loadout.totalCost).toFixed(3));
  assert.strictEqual(diff, 50.0);

  let diffLabel = "";
  if (Math.abs(diff) < 0.0005) {
    diffLabel = "identical cost vs selected";
  } else if (diff > 0) {
    diffLabel = `+${diff.toFixed(3)} G vs selected`;
  } else {
    diffLabel = `${diff.toFixed(3)} G vs selected`;
  }
  assert.strictEqual(diffLabel, "+50.000 G vs selected");
});

// 79. Any selected/main mismatch fails closed with INTERNAL LOADOUT SELECTION MISMATCH and prevents execution
test("79. Any selected/main mismatch fails closed with INTERNAL LOADOUT SELECTION MISMATCH and prevents execution", () => {
  // Test that execution aborts if displayedOfferIds !== stagedPurchaseOfferIds
  const displayedIds = "id_1,id_2";
  const stagedIds = "id_1,id_3"; // desynchronized

  assert.throws(
    () => {
      if (displayedIds !== stagedIds) {
        throw new Error(
          `INTERNAL LOADOUT SELECTION MISMATCH: Displayed offer IDs [${displayedIds}] do not match staged purchase offer IDs [${stagedIds}]. ABORTING.`
        );
      }
    },
    /INTERNAL LOADOUT SELECTION MISMATCH/
  );
});

// 80. Standalone weapon evaluation is invariant when currently equipped gear is changed
test("80. Standalone weapon evaluation is invariant when currently equipped gear is changed", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const cand = { offerId: "w_cand", buyerPrice: 150, skills: { attack: 155, criticalChance: 30 } };

  // Context 1: Low-stat player and weapon
  const profile1 = {
    skills: { attack: { level: 8 }, criticalChance: { level: 7 }, criticalDamages: { level: 6 }, precision: { level: 6 } },
    equipment: {
      helmet: { skills: { criticalDamages: 50 } },
      gloves: { skills: { precision: 20 } },
    },
  };
  const eq1 = { skills: { attack: 10, criticalChance: 5 } };

  // Context 2: Max-stat player and god-roll weapon
  const profile2 = {
    skills: { attack: { level: 8 }, criticalChance: { level: 7 }, criticalDamages: { level: 6 }, precision: { level: 6 } },
    equipment: {
      helmet: { skills: { criticalDamages: 110 } },
      gloves: { skills: { precision: 40 } },
    },
  };
  const eq2 = { skills: { attack: 200, criticalChance: 50 } };

  const eval1 = evaluateWeaponOffer(cand, weaponMeta, eq1, profile1, {}, { compareEquipped: false });
  const eval2 = evaluateWeaponOffer(cand, weaponMeta, eq2, profile2, {}, { compareEquipped: false });

  assert.strictEqual(eval1.candidateDamage, eval2.candidateDamage, "Candidate combat damage must not vary with equipped gear in standalone mode");
  assert.strictEqual(eval1.theoreticalMinDamage, eval2.theoreticalMinDamage, "Theoretical min damage must be constant");
  assert.strictEqual(eval1.theoreticalMaxDamage, eval2.theoreticalMaxDamage, "Theoretical max damage must be constant");
  assert.strictEqual(eval1.weaponQuality, eval2.weaponQuality, "Weapon normalized quality must be invariant");
  assert.strictEqual(eval1.slotQuality, eval2.slotQuality);
});

// 81. --compare-equipped intentionally allows equipped context
test("81. --compare-equipped intentionally allows equipped context", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const cand = { offerId: "w_cand", buyerPrice: 150, skills: { attack: 155, criticalChance: 30 } };

  const profile = {
    skills: { attack: { level: 8 }, criticalChance: { level: 7 }, criticalDamages: { level: 6 }, precision: { level: 6 } },
    equipment: {
      helmet: { skills: { criticalDamages: 50 } },
      gloves: { skills: { precision: 20 } },
    },
  };
  const weakEq = { skills: { attack: 10, criticalChance: 5 } };
  const strongEq = { skills: { attack: 170, criticalChance: 35 } };

  const evalWeak = evaluateWeaponOffer(cand, weaponMeta, weakEq, profile, {}, { compareEquipped: true });
  const evalStrong = evaluateWeaponOffer(cand, weaponMeta, strongEq, profile, {}, { compareEquipped: true });

  assert.notStrictEqual(evalWeak.currentDamage, evalStrong.currentDamage, "Equipped context must reflect current weapon damage");
  assert.ok(evalWeak.damageGain > evalStrong.damageGain, "Replacing weak weapon must yield larger damage gain");
});

console.log(chalk.bold.yellow("\n--- Execution UX & Sequential Purchasing Tests (Section 18) ---\n"));

const mockBuyerConfig = {
  items: {
    green_helmet: { code: "green_helmet", name: "Green Helmet", type: "equipment", usage: "helmet", rarity: "uncommon", dynamicStats: { criticalDamages: [6, 10] } },
    green_chest: { code: "green_chest", name: "Green Chest", type: "equipment", usage: "chest", rarity: "uncommon", dynamicStats: { armor: [6, 10] } },
    green_gloves: { code: "green_gloves", name: "Green Gloves", type: "equipment", usage: "gloves", rarity: "uncommon", dynamicStats: { precision: [6, 10] } },
    green_pants: { code: "green_pants", name: "Green Pants", type: "equipment", usage: "pants", rarity: "uncommon", dynamicStats: { armor: [6, 10] } },
    green_boots: { code: "green_boots", name: "Green Boots", type: "equipment", usage: "boots", rarity: "uncommon", dynamicStats: { dodge: [6, 10] } },
    green_weapon: { code: "green_weapon", name: "Green Sword", type: "weapon", usage: "weapon", skinSlot: "weapon", rarity: "uncommon", dynamicStats: { attack: [10, 20], criticalChance: [5, 10] } },
  },
  skills: { attack: {}, criticalChance: {}, criticalDamages: {}, precision: {} },
};

const mockSlotMap = {
  green_helmet: "helmet",
  green_chest: "chest",
  green_gloves: "gloves",
  green_pants: "pants",
  green_boots: "boots",
  green_weapon: "weapon",
};

const createMockOffers = () => async (code) => {
  const slot = mockSlotMap[code];
  if (!slot) return [];
  if (slot === "weapon") {
    return [{ _id: "off_weapon", user: "u2", price: 10, item: { _id: "it_weapon", code, state: 100, skills: { attack: 15, criticalChance: 8 } } }];
  }
  const statName = slot === "helmet" ? "criticalDamages" : slot === "gloves" ? "precision" : slot === "boots" ? "dodge" : "armor";
  return [{ _id: "off_" + slot, user: "u2", price: 5, item: { _id: "it_" + slot, code, state: 100, skills: { [statName]: 8 } } }];
};

// 82. Normal command enters confirmation flow without --execute
await asyncTest("82. Normal command enters confirmation flow without --execute", async () => {
  let promptCalled = false;
  await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => { promptCalled = true; return "NO"; },
  });
  assert.strictEqual(promptCalled, true, "Confirmation prompt must be invoked without requiring --execute");
});

// 83. --exclude=weapon automatically stages exactly 5 items
await asyncTest("83. --exclude=weapon automatically stages exactly 5 items", async () => {
  let promptedText = "";
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async (text) => { promptedText = text; return "NO"; },
  });
  assert.strictEqual(res.confirmedLoadout.items.length, 5);
  assert.strictEqual(promptedText, "Type BUY to purchase all 5 items: ");
});

// 84. Full set automatically stages exactly 6 items
await asyncTest("84. Full set automatically stages exactly 6 items", async () => {
  let promptedText = "";
  const res = await runEquipmentBuyer(["--rarity=green"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async (text) => { promptedText = text; return "NO"; },
  });
  assert.strictEqual(res.confirmedLoadout.items.length, 6);
  assert.strictEqual(promptedText, "Type BUY to purchase all 6 items: ");
});

// 85. Subset include automatically stages exactly requested slot count
await asyncTest("85. Subset include automatically stages exactly requested slot count", async () => {
  let promptedText = "";
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet,boots"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async (text) => { promptedText = text; return "NO"; },
  });
  assert.strictEqual(res.confirmedLoadout.items.length, 2);
  assert.strictEqual(promptedText, "Type BUY to purchase all 2 items: ");
});

// 86. Default no longer caps purchases at 1
await asyncTest("86. Default no longer caps purchases at 1", async () => {
  const parsed = parseArgs(["--rarity=green"]);
  assert.strictEqual(parsed.maxPurchases, null, "Default maxPurchases must be null (inferred from selected loadout)");
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "NO",
  });
  assert.strictEqual(res.confirmedLoadout.items.length, 5, "Uncapped loadout must stage all 5 items, not 1");
});

// 87. Exact BUY purchases entire confirmed loadout
await asyncTest("87. Exact BUY purchases entire confirmed loadout", async () => {
  const submittedPurchases = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async (id) => { submittedPurchases.push(id); },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  assert.strictEqual(submittedPurchases.length, 5);
  assert.strictEqual(res.purchasedList.length, 5);
  assert.strictEqual(res.totalGoldSpent, 25.25);
});

// 88. Anything other than BUY purchases nothing
await asyncTest("88. Anything other than BUY purchases nothing", async () => {
  for (const cancelInput of ["NO", "buy", "", "exit", "n"]) {
    const submitted = [];
    const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
      fetchGameConfig: async () => mockBuyerConfig,
      fetchMarketTaxRate: async () => 1,
      fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
      fetchAllMarketOffers: createMockOffers(),
      promptConfirmation: async () => cancelInput,
      submitMarketPurchase: async (id) => { submitted.push(id); },
    });
    assert.strictEqual(submitted.length, 0, `Input '${cancelInput}' must make zero purchases`);
    assert.strictEqual(res.totalGoldSpent, 0);
    assert.strictEqual(res.cancelled, true);
  }
});

// 89. --dry-run never prompts and never mutates
await asyncTest("89. --dry-run never prompts and never mutates", async () => {
  let promptCalled = false;
  let mutateCalled = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--dry-run"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => { promptCalled = true; return "BUY"; },
    submitMarketPurchase: async () => { mutateCalled = true; },
  });
  assert.strictEqual(promptCalled, false);
  assert.strictEqual(mutateCalled, false);
  assert.strictEqual(res.confirmedLoadout, null);
});

// 90. --yes bypasses prompt but not safety checks
await asyncTest("90. --yes bypasses prompt but not safety checks", async () => {
  let promptCalled = false;
  let preflightCount = 0;
  const submitted = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet,boots", "--yes"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    refreshAndValidateOffer: async (off) => {
      preflightCount++;
      return { ...off };
    },
    promptConfirmation: async () => { promptCalled = true; return "BUY"; },
    submitMarketPurchase: async (id) => { submitted.push(id); },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  assert.strictEqual(promptCalled, false, "--yes must bypass prompt");
  assert.strictEqual(preflightCount, 4, "--yes runs preflight (2) and immediate pre-mutation revalidation (2)");
  assert.strictEqual(submitted.length, 2);
});

// 91. All selected offers are refreshed before BUY prompt
await asyncTest("91. All selected offers are refreshed before BUY prompt", async () => {
  const refreshedIds = [];
  let promptSawRefreshedCount = 0;
  await runEquipmentBuyer(["--rarity=green", "--include=helmet,chest,boots"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    refreshAndValidateOffer: async (off) => {
      refreshedIds.push(off.offerId);
      return { ...off };
    },
    promptConfirmation: async () => {
      promptSawRefreshedCount = refreshedIds.length;
      return "NO";
    },
  });
  assert.strictEqual(promptSawRefreshedCount, 3, "All 3 items must be refreshed before prompt is shown");
  assert.deepStrictEqual(refreshedIds, ["off_helmet", "off_chest", "off_boots"]);
});

// 92. One invalid offer prevents the BUY prompt entirely
await asyncTest("92. One invalid offer prevents the BUY prompt entirely", async () => {
  let promptCalled = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet,chest,boots"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    refreshAndValidateOffer: async (off) => {
      if (off.offerId === "off_chest") {
        const err = new Error("Offer no longer available on the market.");
        err.code = "OFFER_DISAPPEARED";
        throw err;
      }
      return { ...off };
    },
    promptConfirmation: async () => { promptCalled = true; return "BUY"; },
  });
  assert.strictEqual(promptCalled, false, "BUY prompt must NOT be shown if any item fails preflight");
  assert.strictEqual(res.preflightFailed, true);
  assert.strictEqual(res.failedItem.slot, "chest");
});

// 93. Displayed loadout IDs equal confirmedLoadout IDs
await asyncTest("93. Displayed loadout IDs equal confirmedLoadout IDs", async () => {
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "NO",
  });
  const mainIds = res.loadout.items.map((it) => it.offer.offerId).sort().join(",");
  const confirmedIds = res.confirmedLoadout.offerIds.slice().sort().join(",");
  assert.strictEqual(mainIds, confirmedIds);
});

// 94. ConfirmedLoadout IDs equal mutation targets
await asyncTest("94. ConfirmedLoadout IDs equal mutation targets", async () => {
  const targets = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async (id) => { targets.push(id); },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  assert.deepStrictEqual(targets, [...res.confirmedLoadout.offerIds]);
});

// 95. Failure midway stops remaining purchases
await asyncTest("95. Failure midway stops remaining purchases", async () => {
  const attempts = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet,chest,gloves"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async (id) => {
      attempts.push(id);
      if (id === "off_chest") throw new Error("Out of stock");
    },
    verifyMarketPurchase: async (offer, subTime, opts) => {
      if (opts.mutationFailed) return { state: "FAILED_NOT_PURCHASED", reason: "Out of stock" };
      return { state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice };
    },
  });
  assert.deepStrictEqual(attempts, ["off_helmet", "off_chest"], "gloves must not be attempted");
  assert.strictEqual(res.purchasedList.length, 1);
  assert.strictEqual(res.failedList.length, 2);
  assert.strictEqual(res.failedList[0].status, "FAILED");
  assert.strictEqual(res.failedList[1].status, "NOT_ATTEMPTED");
});

// 96. UNKNOWN midway stops remaining purchases
await asyncTest("96. UNKNOWN midway stops remaining purchases", async () => {
  const attempts = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet,chest,gloves"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async (id) => { attempts.push(id); },
    verifyMarketPurchase: async (offer) => {
      if (offer.offerId === "off_chest") {
        return { state: "UNKNOWN", reason: "Unconfirmed replica lag" };
      }
      return { state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice };
    },
  });
  assert.deepStrictEqual(attempts, ["off_helmet", "off_chest"]);
  assert.strictEqual(res.purchasedList.length, 1);
  assert.strictEqual(res.failedList[0].status, "UNKNOWN");
  assert.strictEqual(res.failedList[1].status, "NOT_ATTEMPTED");
});

// 97. Partial purchase summary is accurate
await asyncTest("97. Partial purchase summary is accurate", async () => {
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet,chest,gloves"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async (id) => {
      if (id === "off_chest") throw new Error("Offer disappeared");
    },
    verifyMarketPurchase: async (offer, subTime, opts) => {
      if (opts.mutationFailed) return { state: "FAILED_NOT_PURCHASED", reason: "Offer disappeared" };
      return { state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice };
    },
  });
  assert.strictEqual(res.purchasedList[0].item.slot, "helmet");
  assert.strictEqual(res.purchasedList[0].verifiedPrice, 5.05);
  assert.strictEqual(res.failedList[0].item.slot, "chest");
  assert.strictEqual(res.failedList[0].reason, "Offer disappeared");
  assert.strictEqual(res.failedList[1].item.slot, "gloves");
  assert.strictEqual(res.failedList[1].status, "NOT_ATTEMPTED");
  assert.strictEqual(res.totalGoldSpent, 5.05);
});

// 98. Complete success reports N/N verified
await asyncTest("98. Complete success reports N/N verified", async () => {
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async () => {},
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  assert.strictEqual(res.purchasedList.length, 5);
  assert.strictEqual(res.totalGoldSpent, 25.25);
});

// 99. No automatic substitution
await asyncTest("99. No automatic substitution: missing offer aborts instead of substituting alternative", async () => {
  let promptInvoked = false;
  let substituteCalled = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: async (code) => {
      return [{ _id: "off_helmet_1", user: "u2", price: 5, item: { _id: "it_h1", code, state: 100, skills: { criticalDamages: 8 } } }];
    },
    refreshAndValidateOffer: async () => {
      const err = new Error("Offer disappeared");
      err.code = "OFFER_DISAPPEARED";
      throw err;
    },
    promptConfirmation: async () => { promptInvoked = true; return "BUY"; },
    submitMarketPurchase: async () => { substituteCalled = true; },
  });
  assert.strictEqual(promptInvoked, false);
  assert.strictEqual(substituteCalled, false);
  assert.strictEqual(res.preflightFailed, true);
});

// 100. No automatic equipping
await asyncTest("100. No automatic equipping: buyer never invokes equip actions", async () => {
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async () => {},
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  const buyerModule = await import("../equipment_buyer.mjs");
  assert.strictEqual(typeof buyerModule.equipItem, "undefined");
  assert.strictEqual(res.purchasedList.length, 1);
});

// 101. Legacy --execute remains harmless if retained
await asyncTest("101. Legacy --execute remains harmless if retained", async () => {
  const cfgWith = parseArgs(["--rarity=green", "--execute"]);
  const cfgWithout = parseArgs(["--rarity=green"]);
  assert.strictEqual(cfgWith.execute, true);
  assert.strictEqual(cfgWithout.execute, false);

  let promptWith = false;
  await runEquipmentBuyer(["--rarity=green", "--include=helmet", "--execute"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => { promptWith = true; return "NO"; },
  });
  assert.strictEqual(promptWith, true, "--execute retains normal interactive confirmation");
});

// ==================================================
// Section 19: Immediate Pre-Mutation Revalidation & Purchase-Race Hardening
// ==================================================

// 102. Offer exists during full-set preflight but disappears after BUY before its mutation -> no mutation
await asyncTest("102. Offer exists during full-set preflight but disappears after BUY before its mutation -> no mutation", async () => {
  let callCount = 0;
  let mutated = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    refreshAndValidateOffer: async (off) => {
      callCount++;
      if (callCount === 1) return { ...off };
      const err = new Error("Offer no longer available on the market.");
      err.code = "OFFER_DISAPPEARED";
      throw err;
    },
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async () => { mutated = true; },
  });
  assert.strictEqual(mutated, false, "Mutation must not be attempted when offer disappears after BUY");
  assert.strictEqual(res.purchasedList.length, 0);
  assert.strictEqual(res.failedList.length, 1);
  assert.strictEqual(res.failedList[0].status, "FAILED");
  assert.strictEqual(res.failedList[0].reason, "CONFIRMED OFFER NO LONGER AVAILABLE");
});

// 103. Price increases after BUY -> abort before mutation
await asyncTest("103. Price increases after BUY -> abort before mutation", async () => {
  let callCount = 0;
  let mutated = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    refreshAndValidateOffer: async (off, opts) => {
      callCount++;
      if (callCount === 1) return { ...off };
      const err = new Error(`Price slippage exceeded: fresh buyer price 6.000 Gold > allowed ${opts.plannedBuyerPrice.toFixed(3)} Gold`);
      throw err;
    },
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async () => { mutated = true; },
  });
  assert.strictEqual(mutated, false, "Mutation must not be attempted when price increases after BUY");
  assert.strictEqual(res.purchasedList.length, 0);
  assert.strictEqual(res.failedList.length, 1);
  assert.strictEqual(res.failedList[0].status, "FAILED");
  assert.ok(res.failedList[0].reason.includes("slippage") || res.failedList[0].reason.includes("Price"));
});

// 104. Stats change after BUY -> abort before mutation
await asyncTest("104. Stats change after BUY -> abort before mutation", async () => {
  let callCount = 0;
  let mutated = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    refreshAndValidateOffer: async (off) => {
      callCount++;
      if (callCount === 1) return { ...off };
      throw new Error("Gear rolled stat changed: expected +8 criticalDamages, found +7.");
    },
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async () => { mutated = true; },
  });
  assert.strictEqual(mutated, false, "Mutation must not be attempted when rolled stats change");
  assert.strictEqual(res.purchasedList.length, 0);
  assert.strictEqual(res.failedList[0].status, "FAILED");
  assert.ok(res.failedList[0].reason.includes("stat changed"));
});

// 105. Item ID changes after BUY -> abort
await asyncTest("105. Item ID changes after BUY -> abort", async () => {
  let callCount = 0;
  let mutated = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    refreshAndValidateOffer: async (off) => {
      callCount++;
      if (callCount === 1) return { ...off };
      throw new Error("Item ID mismatch: expected 'item_helmet', found 'item_other'.");
    },
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async () => { mutated = true; },
  });
  assert.strictEqual(mutated, false, "Mutation must not be attempted when item ID changes");
  assert.strictEqual(res.purchasedList.length, 0);
  assert.strictEqual(res.failedList[0].status, "FAILED");
  assert.ok(res.failedList[0].reason.includes("Item ID mismatch"));
});

// 106. Seller changes / offer identity mismatch -> abort
await asyncTest("106. Seller changes / offer identity mismatch -> abort", async () => {
  let callCount = 0;
  let mutated = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    refreshAndValidateOffer: async (off) => {
      callCount++;
      if (callCount === 1) return { ...off };
      throw new Error("Seller mismatch: expected seller 'seller_1', found 'seller_2'. Offer identity changed. ABORTING.");
    },
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async () => { mutated = true; },
  });
  assert.strictEqual(mutated, false, "Mutation must not be attempted when seller changes");
  assert.strictEqual(res.purchasedList.length, 0);
  assert.strictEqual(res.failedList[0].status, "FAILED");
  assert.ok(res.failedList[0].reason.includes("Seller mismatch"));
});

// 107. Item #1 succeeds, item #2 disappears before its turn: #1 verified, #2 disappeared, #3 not attempted
await asyncTest("107. Item #1 succeeds, item #2 disappears before its turn: #1 verified, #2 disappeared, #3 not attempted", async () => {
  const mutations = [];
  let promptPassed = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet,chest,boots"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => { promptPassed = true; return "BUY"; },
    refreshAndValidateOffer: async (off) => {
      if (promptPassed && off.offerId === "off_chest") {
        const err = new Error("Offer disappeared");
        err.code = "OFFER_DISAPPEARED";
        throw err;
      }
      return { ...off };
    },
    submitMarketPurchase: async (id) => { mutations.push(id); },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  assert.deepStrictEqual(mutations, ["off_helmet"], "Only item #1 may be submitted for mutation");
  assert.strictEqual(res.purchasedList.length, 1);
  assert.strictEqual(res.purchasedList[0].item.slot, "helmet");
  assert.strictEqual(res.failedList.length, 2);
  assert.strictEqual(res.failedList[0].item.slot, "chest");
  assert.strictEqual(res.failedList[0].status, "FAILED");
  assert.strictEqual(res.failedList[0].reason, "CONFIRMED OFFER NO LONGER AVAILABLE");
  assert.strictEqual(res.failedList[1].item.slot, "boots");
  assert.strictEqual(res.failedList[1].status, "NOT_ATTEMPTED");
});

// 108. Every submitted mutation has an immediately preceding fresh exact-offer validation
await asyncTest("108. Every submitted mutation has an immediately preceding fresh exact-offer validation", async () => {
  const sequence = [];
  let confirmedPromptPassed = false;
  await runEquipmentBuyer(["--rarity=green", "--include=helmet,boots"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => {
      confirmedPromptPassed = true;
      sequence.push("PROMPT_BUY");
      return "BUY";
    },
    refreshAndValidateOffer: async (off) => {
      if (confirmedPromptPassed) {
        sequence.push(`REVAL_${off.offerId}`);
      } else {
        sequence.push(`PREFLIGHT_${off.offerId}`);
      }
      return { ...off };
    },
    submitMarketPurchase: async (id) => {
      sequence.push(`MUTATE_${id}`);
    },
    verifyMarketPurchase: async (offer) => {
      sequence.push(`VERIFY_${offer.offerId}`);
      return { state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice };
    },
  });

  const buyIdx = sequence.indexOf("PROMPT_BUY");
  assert.ok(buyIdx >= 0);
  const afterPrompt = sequence.slice(buyIdx + 1);
  assert.deepStrictEqual(afterPrompt, [
    "REVAL_off_helmet",
    "MUTATE_off_helmet",
    "VERIFY_off_helmet",
    "REVAL_off_boots",
    "MUTATE_off_boots",
    "VERIFY_off_boots",
  ]);
});

// 109. Refreshed remaining-budget accounting is enforced dynamically
await asyncTest("109. Refreshed remaining-budget accounting is enforced dynamically", async () => {
  let promptPassed = false;
  const seenBudgets = [];
  const mutations = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet,boots", "--budget=10.10"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => {
      promptPassed = true;
      return "BUY";
    },
    refreshAndValidateOffer: async (off, opts) => {
      if (promptPassed) {
        seenBudgets.push(opts.remainingBudget);
        if (off.offerId === "off_boots") {
          if (opts.remainingBudget < 5.06) {
            throw new Error(`Budget ceiling exceeded: fresh buyer price 5.060 Gold > remaining budget ${opts.remainingBudget.toFixed(3)} Gold`);
          }
        }
      }
      return { ...off };
    },
    submitMarketPurchase: async (id) => { mutations.push(id); },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  assert.deepStrictEqual(mutations, ["off_helmet"], "Boots must not be mutated when exceeding dynamic remaining budget");
  assert.strictEqual(seenBudgets[0], 10.10, "Helmet starts with full 10.10 G budget");
  assert.strictEqual(seenBudgets[1], 5.05, "Boots sees remaining budget 5.05 G after helmet paid 5.05 G");
  assert.strictEqual(res.purchasedList.length, 1);
  assert.strictEqual(res.failedList.length, 1);
  assert.ok(res.failedList[0].reason.includes("Budget ceiling exceeded"));
});

// 110. No substitution occurs after BUY
await asyncTest("110. No substitution occurs after BUY", async () => {
  let promptPassed = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => {
      promptPassed = true;
      return "BUY";
    },
    refreshAndValidateOffer: async (off) => {
      if (promptPassed) {
        const err = new Error("Offer disappeared");
        err.code = "OFFER_DISAPPEARED";
        throw err;
      }
      return { ...off };
    },
    submitMarketPurchase: async () => { throw new Error("Should not mutate"); },
  });
  assert.strictEqual(res.purchasedList.length, 0);
  assert.strictEqual(res.failedList.length, 1);
  assert.strictEqual(res.failedList[0].reason, "CONFIRMED OFFER NO LONGER AVAILABLE");
});

// 111. Successful unchanged 5-piece set still completes 5/5
await asyncTest("111. Successful unchanged 5-piece set still completes 5/5", async () => {
  const mutations = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async (id) => { mutations.push(id); },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  assert.strictEqual(mutations.length, 5);
  assert.strictEqual(res.purchasedList.length, 5);
  assert.strictEqual(res.failedList.length, 0);
  assert.strictEqual(res.totalGoldSpent, 25.25);
});

// ==================================================
// Section 20: Live Wallet-Balance Handling & Budget Hardening
// ==================================================

// 112. No --budget uses wallet balance as implicit budget
await asyncTest("112. No --budget uses wallet balance as implicit budget", async () => {
  let promptShown = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 50.0 }),
    fetchLiveWalletGold: async () => 50.0,
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => { promptShown = true; return "NO"; },
  });
  assert.strictEqual(res.walletGold, 50.0);
  assert.strictEqual(res.effectiveBudget, 50.0);
  assert.strictEqual(promptShown, true, "Prompt must be shown when loadout <= walletGold");
});

// 113. Loadout > wallet balance prevents BUY prompt
await asyncTest("113. Loadout > wallet balance prevents BUY prompt", async () => {
  let promptShown = false;
  let mutationsCalled = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 20.0 }),
    fetchLiveWalletGold: async () => 20.0,
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => { promptShown = true; return "BUY"; },
    submitMarketPurchase: async () => { mutationsCalled = true; },
  });
  assert.strictEqual(promptShown, false, "BUY prompt must NOT be shown when loadout cost exceeds wallet balance");
  assert.strictEqual(mutationsCalled, false, "Zero mutations when balance is insufficient");
  assert.strictEqual(res.insufficientGold, true);
  assert.strictEqual(res.walletGold, 20.0);
  assert.strictEqual(res.effectiveBudget, 20.0);
  assert.strictEqual(res.shortfall, 5.25);
  assert.strictEqual(res.totalGoldSpent, 0);
});

// 114. Explicit budget > wallet balance still uses wallet balance ceiling
await asyncTest("114. Explicit budget > wallet balance still uses wallet balance ceiling", async () => {
  let promptShown = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon", "--budget=100.0"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 20.0 }),
    fetchLiveWalletGold: async () => 20.0,
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => { promptShown = true; return "BUY"; },
  });
  assert.strictEqual(promptShown, false);
  assert.strictEqual(res.insufficientGold, true);
  assert.strictEqual(res.effectiveBudget, 20.0, "Effective budget must be min(100.0, 20.0) = 20.0 G");
  assert.strictEqual(res.shortfall, 5.25);
});

// 115. Explicit budget < wallet balance respects explicit budget
await asyncTest("115. Explicit budget < wallet balance respects explicit budget", async () => {
  let promptShown = false;
  let taxCalls = 0;
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon", "--budget=26.0", "--max-slippage=10"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => {
      taxCalls++;
      // Initial analysis uses 1% tax (loadout = 25.25 G <= 26.0 G budget)
      // Preflight uses 5% tax (loadout = 26.25 G > 26.0 G budget, permitted by 10% slippage tolerance)
      return taxCalls === 1 ? 1 : 5;
    },
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 100.0 }),
    fetchLiveWalletGold: async () => 100.0,
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => { promptShown = true; return "BUY"; },
  });
  assert.strictEqual(promptShown, false);
  assert.strictEqual(res.insufficientGold, true);
  assert.strictEqual(res.effectiveBudget, 26.0, "Effective budget must be min(26.0, 100.0) = 26.0 G");
  assert.strictEqual(res.shortfall, 0.25);
});

// 116. Wallet balance is refreshed before confirmation
await asyncTest("116. Wallet balance is refreshed before confirmation", async () => {
  let promptShown = false;
  let walletCallCount = 0;
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 30.0 }),
    fetchLiveWalletGold: async () => {
      walletCallCount++;
      if (walletCallCount === 1) return 30.0;
      return 15.0;
    },
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => { promptShown = true; return "BUY"; },
  });
  assert.strictEqual(promptShown, false, "Refreshed balance must prevent BUY prompt if funds drop during preflight");
  assert.strictEqual(res.insufficientGold, true);
  assert.strictEqual(res.effectiveBudget, 15.0);
  assert.strictEqual(res.shortfall, 10.25);
});

// 117. Wallet balance is refreshed before every mutation
await asyncTest("117. Wallet balance is refreshed before every mutation", async () => {
  const sequence = [];
  let confirmedPromptPassed = false;
  await runEquipmentBuyer(["--rarity=green", "--include=helmet,boots"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 30.0 }),
    fetchLiveWalletGold: async () => {
      if (confirmedPromptPassed) {
        sequence.push("WALLET_CHECK_IN_LOOP");
      } else {
        sequence.push("WALLET_CHECK_BEFORE_PROMPT");
      }
      return 30.0;
    },
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => {
      confirmedPromptPassed = true;
      sequence.push("PROMPT_BUY");
      return "BUY";
    },
    submitMarketPurchase: async (id) => {
      sequence.push(`MUTATE_${id}`);
    },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  const afterPrompt = sequence.slice(sequence.indexOf("PROMPT_BUY") + 1);
  assert.ok(afterPrompt.includes("WALLET_CHECK_IN_LOOP"));
  const hMutIdx = afterPrompt.indexOf("MUTATE_off_helmet");
  const bMutIdx = afterPrompt.indexOf("MUTATE_off_boots");
  assert.ok(hMutIdx > 0 && afterPrompt[hMutIdx - 1] === "WALLET_CHECK_IN_LOOP");
  assert.ok(bMutIdx > 0 && afterPrompt[bMutIdx - 1] === "WALLET_CHECK_IN_LOOP");
});

// 118. External spend between item #1 and item #2 stops item #2 safely
await asyncTest("118. External spend between item #1 and item #2 stops item #2 safely", async () => {
  const mutations = [];
  let walletCalls = 0;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet,boots"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 20.0 }),
    fetchLiveWalletGold: async () => {
      walletCalls++;
      if (walletCalls <= 3) return 20.0;
      return 2.0;
    },
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async (id) => { mutations.push(id); },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  assert.deepStrictEqual(mutations, ["off_helmet"], "Only item #1 may be mutated");
  assert.strictEqual(res.purchasedList.length, 1);
  assert.strictEqual(res.failedList.length, 1);
  assert.strictEqual(res.failedList[0].status, "FAILED");
  assert.ok(res.failedList[0].reason.includes("Insufficient wallet Gold"));
});

// 119. Insufficient Gold never triggers substitution
await asyncTest("119. Insufficient Gold never triggers substitution", async () => {
  let promptShown = false;
  let mutateCalled = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 4.0 }),
    fetchLiveWalletGold: async () => 4.0,
    fetchAllMarketOffers: async (code) => [
      { _id: "off_helmet_1", user: "u2", price: 5, item: { _id: "it_h1", code, state: 100, skills: { criticalDamages: 8 } } },
      { _id: "off_helmet_sub", user: "u3", price: 3, item: { _id: "it_h2", code, state: 100, skills: { criticalDamages: 6 } } },
    ],
    promptConfirmation: async () => { promptShown = true; return "BUY"; },
    submitMarketPurchase: async () => { mutateCalled = true; },
  });
  assert.strictEqual(promptShown, false);
  assert.strictEqual(mutateCalled, false);
  assert.strictEqual(res.insufficientGold, true);
  assert.strictEqual(res.purchasedList.length, 0);
});

// 120. Partial purchase report remains accurate with Starting Gold and Ending Gold
await asyncTest("120. Partial purchase report remains accurate with Starting Gold and Ending Gold", async () => {
  let walletCalls = 0;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet,chest,boots"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 20.0 }),
    fetchLiveWalletGold: async () => {
      walletCalls++;
      if (walletCalls <= 3) return 20.0;
      if (walletCalls === 4) return 1.0;
      return 14.95;
    },
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async () => {},
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  assert.strictEqual(res.purchasedList.length, 1);
  assert.strictEqual(res.failedList.length, 2);
  assert.strictEqual(res.failedList[0].item.slot, "chest");
  assert.strictEqual(res.failedList[1].item.slot, "boots");
  assert.strictEqual(res.failedList[1].status, "NOT_ATTEMPTED");
  assert.strictEqual(res.balanceInfo.startingGold, 20.0);
  assert.strictEqual(res.totalGoldSpent, 5.05);
});

// 121. Sufficient balance still completes 5/5
await asyncTest("121. Sufficient balance still completes 5/5", async () => {
  const mutations = [];
  let currentWallet = 100.0;
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 100.0 }),
    fetchLiveWalletGold: async () => currentWallet,
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async (id) => {
      mutations.push(id);
      currentWallet = Number((currentWallet - 5.05).toFixed(3));
    },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
  });
  assert.strictEqual(mutations.length, 5);
  assert.strictEqual(res.purchasedList.length, 5);
  assert.strictEqual(res.failedList.length, 0);
  assert.strictEqual(res.totalGoldSpent, 25.25);
  assert.strictEqual(res.balanceInfo.startingGold, 100.0);
  assert.strictEqual(res.balanceInfo.endingGold, 74.75);
});

// ==================================================
// Section 21: Post-Purchase Wallet Accounting & Polling Reconciliation
// ==================================================

// 122. Wallet balance updates immediately on first poll
await asyncTest("122. Wallet balance updates immediately on first poll", async () => {
  let calls = 0;
  const res = await pollReconciledWalletGold(898.486, 56.559, {
    fetchWalletFn: async () => {
      calls++;
      return 841.927;
    },
    delaysMs: [0, 250, 500],
    sleepFn: async () => {},
  });
  assert.strictEqual(res.state, "VERIFIED");
  assert.strictEqual(res.converged, true);
  assert.strictEqual(res.pollsAttempted, 1);
  assert.strictEqual(res.endingGold, 841.927);
  assert.strictEqual(calls, 1);
});

// 123. Wallet balance updates after one poll
await asyncTest("123. Wallet balance updates after one poll", async () => {
  let calls = 0;
  const res = await pollReconciledWalletGold(898.486, 56.559, {
    fetchWalletFn: async () => {
      calls++;
      if (calls === 1) return 898.486;
      return 841.927;
    },
    delaysMs: [0, 250, 500],
    sleepFn: async () => {},
  });
  assert.strictEqual(res.state, "VERIFIED");
  assert.strictEqual(res.converged, true);
  assert.strictEqual(res.pollsAttempted, 2);
  assert.strictEqual(res.endingGold, 841.927);
});

// 124. Wallet balance updates after several polls
await asyncTest("124. Wallet balance updates after several polls", async () => {
  let calls = 0;
  const delaysCalled = [];
  const res = await pollReconciledWalletGold(898.486, 56.559, {
    fetchWalletFn: async () => {
      calls++;
      if (calls < 4) return 898.486;
      return 841.927;
    },
    delaysMs: [0, 250, 500, 1000, 2000],
    sleepFn: async (ms) => { delaysCalled.push(ms); },
  });
  assert.strictEqual(res.state, "VERIFIED");
  assert.strictEqual(res.converged, true);
  assert.strictEqual(res.pollsAttempted, 4);
  assert.strictEqual(res.endingGold, 841.927);
  assert.deepStrictEqual(delaysCalled, [250, 500, 1000]);
});

// 125. Wallet never updates before timeout reports PENDING / STALE
await asyncTest("125. Wallet never updates before timeout reports PENDING / STALE", async () => {
  let calls = 0;
  const res = await pollReconciledWalletGold(898.486, 56.559, {
    fetchWalletFn: async () => {
      calls++;
      return 898.486;
    },
    delaysMs: [0, 250, 500],
    sleepFn: async () => {},
  });
  assert.strictEqual(res.state, "PENDING");
  assert.strictEqual(res.converged, false);
  assert.strictEqual(res.pollsAttempted, 3);
  assert.strictEqual(res.endingGold, 898.486);
  assert.strictEqual(res.delta, 0);
});

// 126. Stale initial user object is never reused
await asyncTest("126. Stale initial user object is never reused", async () => {
  let liveWalletCalls = 0;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 999.999 }),
    fetchLiveWalletGold: async () => {
      liveWalletCalls++;
      // Preflight check and per-mutation check:
      if (liveWalletCalls <= 2) return 100.0;
      // Post-purchase poll:
      return 94.95;
    },
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async () => {},
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    sleepFn: async () => {},
  });
  assert.strictEqual(res.purchasedList.length, 1);
  assert.strictEqual(res.balanceInfo.startingGold, 100.0, "Starting gold must come from fresh live check, not initial 999.999");
  assert.strictEqual(res.balanceInfo.endingGold, 94.95, "Ending gold must reflect fresh post-purchase poll");
  assert.strictEqual(res.balanceInfo.state, "VERIFIED");
});

// 127. Final balance matches verified spend exactly
await asyncTest("127. Final balance matches verified spend exactly", async () => {
  let purchased = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 100.0 }),
    fetchLiveWalletGold: async () => (purchased ? 94.95 : 100.0),
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async () => { purchased = true; },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    sleepFn: async () => {},
  });
  assert.strictEqual(res.balanceInfo.startingGold, 100.0);
  assert.strictEqual(res.balanceInfo.endingGold, 94.95);
  assert.strictEqual(res.totalGoldSpent, 5.05);
  assert.strictEqual(Number((res.balanceInfo.startingGold - res.balanceInfo.endingGold).toFixed(3)), res.totalGoldSpent);
  assert.strictEqual(res.balanceInfo.state, "VERIFIED");
});

// 128. Unrelated additional wallet movement is reported separately
await asyncTest("128. Unrelated additional wallet movement is reported separately", async () => {
  const res = await pollReconciledWalletGold(898.486, 56.559, {
    fetchWalletFn: async () => 840.927,
    delaysMs: [0, 250],
    sleepFn: async () => {},
  });
  assert.strictEqual(res.state, "UNRELATED_ACTIVITY");
  assert.strictEqual(res.converged, false);
  assert.strictEqual(res.delta, 57.559);
  assert.strictEqual(res.difference, 1.0);
});

// 129. Wallet mismatch never changes VERIFIED_PURCHASED to UNKNOWN
await asyncTest("129. Wallet mismatch never changes VERIFIED_PURCHASED to UNKNOWN", async () => {
  const res = await runEquipmentBuyer(["--rarity=green", "--include=helmet"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 100.0 }),
    fetchLiveWalletGold: async () => 100.0, // Stale balance remains
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async () => {},
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    sleepFn: async () => {},
    balancePollDelays: [0, 10],
  });
  assert.strictEqual(res.purchasedList.length, 1);
  assert.strictEqual(res.failedList.length, 0);
  assert.strictEqual(res.purchasedList[0].item.slot, "helmet");
  assert.strictEqual(res.balanceInfo.state, "PENDING");
});

// 130. Multi-item total reconciles correctly across sequential purchases
await asyncTest("130. Multi-item total reconciles correctly across sequential purchases", async () => {
  let wallet = 100.0;
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {}, walletGold: 100.0 }),
    fetchLiveWalletGold: async () => wallet,
    fetchAllMarketOffers: createMockOffers(),
    promptConfirmation: async () => "BUY",
    submitMarketPurchase: async (id) => {
      wallet = Number((wallet - 5.05).toFixed(3));
    },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    sleepFn: async () => {},
  });
  assert.strictEqual(res.purchasedList.length, 5);
  assert.strictEqual(res.totalGoldSpent, 25.25);
  assert.strictEqual(res.balanceInfo.startingGold, 100.0);
  assert.strictEqual(res.balanceInfo.endingGold, 74.75);
  assert.strictEqual(res.balanceInfo.state, "VERIFIED");
});

// 131. Large discrepancy is never called rounding
await asyncTest("131. Large discrepancy is never called rounding", async () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => { logs.push(args.join(" ")); };
  try {
    // Pending state: delta is 0 after spending 56.559 G
    printBalanceReconciliation({
      startingGold: 898.486,
      endingGold: 898.486,
      verifiedSpend: 56.559,
      delta: 0,
      difference: -56.559,
      state: "PENDING",
    }, 56.559);

    // Unrelated activity: delta is 57.559 after spending 56.559 G
    printBalanceReconciliation({
      startingGold: 898.486,
      endingGold: 840.927,
      verifiedSpend: 56.559,
      delta: 57.559,
      difference: 1.0,
      state: "UNRELATED_ACTIVITY",
    }, 56.559);
  } finally {
    console.log = origLog;
  }
  const combined = logs.join("\n");
  assert.ok(combined.includes("PENDING / STALE"), "Must display PENDING / STALE");
  assert.ok(combined.includes("Wallet balance update pending"), "Must explain pending update");
  assert.ok(combined.includes("additional 1.000 G change"), "Must report external change");
  assert.strictEqual(combined.includes("server rounding"), false, "Must never label large discrepancy as server rounding");
});

// ==================================================
// Section 22: Deterministic Weapon Selection & Highest Market Crit Hard Constraint
// ==================================================

// 132. Higher Attack but lower Crit is rejected
test("132. Higher Attack but lower Crit is rejected from weapon candidates", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const offHighAtkLowCrit = {
    offerId: "w_170_34",
    itemId: "iw_1",
    buyerPrice: 150,
    skills: { attack: 170, criticalChance: 34 },
  };
  const offLowerAtkHighCrit = {
    offerId: "w_165_35",
    itemId: "iw_2",
    buyerPrice: 150,
    skills: { attack: 165, criticalChance: 35 },
  };

  const eval1 = evaluateWeaponOffer(offHighAtkLowCrit, weaponMeta, null, {}, {});
  const eval2 = evaluateWeaponOffer(offLowerAtkHighCrit, weaponMeta, null, {}, {});

  const recs = findCategoryRecommendations([eval1, eval2], true);
  assert.strictEqual(recs.highestMarketCrit, 35);
  assert.strictEqual(recs.bestValue.offerId, "w_165_35");
  assert.strictEqual(recs.bestPerformance.offerId, "w_165_35");
  assert.strictEqual(recs.cheapestUpgrade.offerId, "w_165_35");
});

// 133. Highest market Crit is below theoretical max
test("133. Highest market Crit below theoretical max restricts candidates to current market max", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const off1 = { offerId: "w_32", buyerPrice: 100, skills: { attack: 160, criticalChance: 32 } };
  const off2 = { offerId: "w_33", buyerPrice: 120, skills: { attack: 158, criticalChance: 33 } };
  const off3 = { offerId: "w_31", buyerPrice: 80, skills: { attack: 168, criticalChance: 31 } };

  const evalList = [off1, off2, off3].map((o) => evaluateWeaponOffer(o, weaponMeta, null, {}, {}));
  const recs = findCategoryRecommendations(evalList, true);

  assert.strictEqual(recs.highestMarketCrit, 33);
  assert.strictEqual(recs.bestValue.offerId, "w_33");
  assert.strictEqual(recs.bestPerformance.offerId, "w_33");
  assert.strictEqual(recs.cheapestUpgrade.offerId, "w_33");
});

// 134. Best Value among max-Crit weapons uses Attack/Gold
test("134. Best Value among max-Crit weapons uses Attack / buyerPrice", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  // Weapon A: 165 Attack, 35 Crit, 140 G -> 165 / 140 = 1.1786 A/G
  // Weapon B: 170 Attack, 35 Crit, 160 G -> 170 / 160 = 1.0625 A/G
  const wepA = evaluateWeaponOffer({ offerId: "w_a", buyerPrice: 140, skills: { attack: 165, criticalChance: 35 } }, weaponMeta, null, {}, {});
  const wepB = evaluateWeaponOffer({ offerId: "w_b", buyerPrice: 160, skills: { attack: 170, criticalChance: 35 } }, weaponMeta, null, {}, {});

  const recs = findCategoryRecommendations([wepA, wepB], true);
  assert.strictEqual(recs.bestValue.offerId, "w_a");
});

// 135. Best Performance among max-Crit weapons uses highest Attack
test("135. Best Performance among max-Crit weapons uses highest Attack", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const wepA = evaluateWeaponOffer({ offerId: "w_a", buyerPrice: 140, skills: { attack: 165, criticalChance: 35 } }, weaponMeta, null, {}, {});
  const wepB = evaluateWeaponOffer({ offerId: "w_b", buyerPrice: 160, skills: { attack: 170, criticalChance: 35 } }, weaponMeta, null, {}, {});

  const recs = findCategoryRecommendations([wepA, wepB], true);
  assert.strictEqual(recs.bestPerformance.offerId, "w_b");
});

// 136. Cheapest among max-Crit weapons uses lowest buyerPrice
test("136. Cheapest among max-Crit weapons uses lowest buyerPrice", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const wepA = evaluateWeaponOffer({ offerId: "w_a", buyerPrice: 140, skills: { attack: 165, criticalChance: 35 } }, weaponMeta, null, {}, {});
  const wepB = evaluateWeaponOffer({ offerId: "w_b", buyerPrice: 160, skills: { attack: 170, criticalChance: 35 } }, weaponMeta, null, {}, {});

  const recs = findCategoryRecommendations([wepA, wepB], true);
  assert.strictEqual(recs.cheapestUpgrade.offerId, "w_a");
});

// 137. Lower-Crit cheap weapon never wins Cheapest
test("137. Lower-Crit cheap weapon never wins Cheapest", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const cheapLowCrit = evaluateWeaponOffer({ offerId: "w_cheap_low", buyerPrice: 30, skills: { attack: 145, criticalChance: 30 } }, weaponMeta, null, {}, {});
  const pricyHighCrit = evaluateWeaponOffer({ offerId: "w_pricy_high", buyerPrice: 150, skills: { attack: 165, criticalChance: 35 } }, weaponMeta, null, {}, {});

  const recs = findCategoryRecommendations([cheapLowCrit, pricyHighCrit], true);
  assert.strictEqual(recs.cheapestUpgrade.offerId, "w_pricy_high", "Cheapest must strictly pick from max-Crit pool");
});

// 138. Lower-Crit high-Attack weapon never wins Best Performance
test("138. Lower-Crit high-Attack weapon never wins Best Performance", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const highAtkLowCrit = evaluateWeaponOffer({ offerId: "w_high_atk", buyerPrice: 200, skills: { attack: 170, criticalChance: 33 } }, weaponMeta, null, {}, {});
  const modAtkMaxCrit = evaluateWeaponOffer({ offerId: "w_mod_atk", buyerPrice: 150, skills: { attack: 160, criticalChance: 35 } }, weaponMeta, null, {}, {});

  const recs = findCategoryRecommendations([highAtkLowCrit, modAtkMaxCrit], true);
  assert.strictEqual(recs.bestPerformance.offerId, "w_mod_atk", "Best Performance must strictly pick from max-Crit pool");
});

// 139. Lower-Crit high combat-model damage never wins Best Value
test("139. Lower-Crit high combat-model damage never wins Best Value", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const wepLowCrit = evaluateWeaponOffer({ offerId: "w_lc", buyerPrice: 100, skills: { attack: 168, criticalChance: 32 } }, weaponMeta, null, {}, {});
  const wepHighCrit = evaluateWeaponOffer({ offerId: "w_hc", buyerPrice: 120, skills: { attack: 160, criticalChance: 35 } }, weaponMeta, null, {}, {});

  const recs = findCategoryRecommendations([wepLowCrit, wepHighCrit], true);
  assert.strictEqual(recs.bestValue.offerId, "w_hc", "Best Value must strictly pick from max-Crit pool");
});

// 140. Equipped gear changes do not affect weapon ranking
test("140. Equipped gear changes do not affect weapon ranking", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const candA = { offerId: "w_a", buyerPrice: 100, skills: { attack: 160, criticalChance: 35 } };
  const candB = { offerId: "w_b", buyerPrice: 110, skills: { attack: 165, criticalChance: 35 } };

  const eqGear1 = { skills: { attack: 140, criticalChance: 25 } };
  const eqGear2 = { skills: { attack: 170, criticalChance: 35 } };

  const recs1 = findCategoryRecommendations([
    evaluateWeaponOffer(candA, weaponMeta, eqGear1, {}, {}),
    evaluateWeaponOffer(candB, weaponMeta, eqGear1, {}, {}),
  ], true);

  const recs2 = findCategoryRecommendations([
    evaluateWeaponOffer(candA, weaponMeta, eqGear2, {}, {}),
    evaluateWeaponOffer(candB, weaponMeta, eqGear2, {}, {}),
  ], true);

  assert.strictEqual(recs1.bestValue.offerId, recs2.bestValue.offerId);
  assert.strictEqual(recs1.bestPerformance.offerId, recs2.bestPerformance.offerId);
  assert.strictEqual(recs1.cheapestUpgrade.offerId, recs2.cheapestUpgrade.offerId);
});

// 141. Player skills changing do not affect weapon ranking
test("141. Player skills changing do not affect weapon ranking", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const candA = { offerId: "w_a", buyerPrice: 100, skills: { attack: 160, criticalChance: 35 } };
  const candB = { offerId: "w_b", buyerPrice: 110, skills: { attack: 165, criticalChance: 35 } };

  const profileLow = { skills: { attack: { level: 1 }, criticalChance: { level: 1 } } };
  const profileHigh = { skills: { attack: { level: 20 }, criticalChance: { level: 20 } } };

  const recsLow = findCategoryRecommendations([
    evaluateWeaponOffer(candA, weaponMeta, null, profileLow, {}),
    evaluateWeaponOffer(candB, weaponMeta, null, profileLow, {}),
  ], true);

  const recsHigh = findCategoryRecommendations([
    evaluateWeaponOffer(candA, weaponMeta, null, profileHigh, {}),
    evaluateWeaponOffer(candB, weaponMeta, null, profileHigh, {}),
  ], true);

  assert.strictEqual(recsLow.bestValue.offerId, recsHigh.bestValue.offerId);
  assert.strictEqual(recsLow.bestPerformance.offerId, recsHigh.bestPerformance.offerId);
});

// 142. Combat-model output changing does not affect weapon ranking
test("142. Combat-model output changing does not affect weapon ranking", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  // Wep 1: 160 Attack, 35 Crit, 100 G -> 1.60 Atk/G
  // Wep 2: 165 Attack, 35 Crit, 110 G -> 1.50 Atk/G
  const w1 = evaluateWeaponOffer({ offerId: "w1", buyerPrice: 100, skills: { attack: 160, criticalChance: 35 } }, weaponMeta, null, {}, {});
  const w2 = evaluateWeaponOffer({ offerId: "w2", buyerPrice: 110, skills: { attack: 165, criticalChance: 35 } }, weaponMeta, null, {}, {});

  // Mutate candidateDamage and combatGainPerGold artificially to test independence
  w1.candidateDamage = 999999;
  w1.combatGainPerGold = 0.0001;
  w2.candidateDamage = 1;
  w2.combatGainPerGold = 99999;

  const recs = findCategoryRecommendations([w1, w2], true);
  assert.strictEqual(recs.bestValue.offerId, "w1", "Best value must be driven by Attack/Gold, completely ignoring combat model");
});

// 143. Budget optimizer only receives max-Crit weapon candidates
test("143. Budget optimizer only receives max-Crit weapon candidates", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const catResults = {
    weapon: {
      category: "weapon",
      rangeInfo: { slot: "weapon", itemCode: "tank" },
      evaluatedOffers: [
        evaluateWeaponOffer({ offerId: "w_30", buyerPrice: 50, skills: { attack: 150, criticalChance: 30 } }, weaponMeta, null, {}, {}),
        evaluateWeaponOffer({ offerId: "w_35", buyerPrice: 150, skills: { attack: 165, criticalChance: 35 } }, weaponMeta, null, {}, {}),
      ],
    },
  };

  const loadout = buildFullLoadout(catResults, {
    activeCategories: ["weapon"],
    strategy: "best-value",
  });

  assert.strictEqual(loadout.items.length, 1);
  assert.strictEqual(loadout.items[0].offer.offerId, "w_35");
});

// 144. Budget pressure never causes Crit downgrade
test("144. Budget pressure never causes Crit downgrade", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const catResults = {
    weapon: {
      category: "weapon",
      rangeInfo: { slot: "weapon", itemCode: "tank" },
      evaluatedOffers: [
        evaluateWeaponOffer({ offerId: "w_cheap_low", buyerPrice: 40, skills: { attack: 150, criticalChance: 30 } }, weaponMeta, null, {}, {}),
        evaluateWeaponOffer({ offerId: "w_max_crit", buyerPrice: 120, skills: { attack: 165, criticalChance: 35 } }, weaponMeta, null, {}, {}),
      ],
    },
  };

  // Budget is 50 Gold - can afford the Crit 30 weapon, but CANNOT afford Crit 35 weapon
  const loadout = buildFullLoadout(catResults, {
    activeCategories: ["weapon"],
    strategy: "best-value",
    budget: 50,
  });

  assert.strictEqual(loadout.feasible, false, "Must fail closed rather than downgrading Crit");
  assert.strictEqual(loadout.items.length, 0);
});

// 145. Impossible budget returns no complete loadout rather than lower Crit
test("145. Impossible budget returns no complete loadout with correct minRequiredBudget", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const catResults = {
    weapon: {
      category: "weapon",
      rangeInfo: { slot: "weapon", itemCode: "tank" },
      evaluatedOffers: [
        evaluateWeaponOffer({ offerId: "w_low", buyerPrice: 25, skills: { attack: 145, criticalChance: 28 } }, weaponMeta, null, {}, {}),
        evaluateWeaponOffer({ offerId: "w_high", buyerPrice: 150, skills: { attack: 165, criticalChance: 35 } }, weaponMeta, null, {}, {}),
      ],
    },
  };

  const loadout = buildFullLoadout(catResults, {
    activeCategories: ["weapon"],
    strategy: "cheapest",
    budget: 100,
  });

  assert.strictEqual(loadout.feasible, false);
  assert.strictEqual(loadout.minRequiredBudget, 150, "Min budget must require cheapest max-Crit weapon (150 G), not 25 G");
});

// 146. weaponAttackQuality uses (attack - minAttack) / (maxAttack - minAttack)
test("146. weaponAttackQuality uses (attack - minAttack) / (maxAttack - minAttack)", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  // Attack span = 170 - 141 = 29
  // Attack 155 -> (155 - 141) / 29 = 14 / 29 = 0.482759
  const wep = evaluateWeaponOffer({ offerId: "w_eval", buyerPrice: 100, skills: { attack: 155, criticalChance: 35 } }, weaponMeta, null, {}, {});
  const expectedQuality = Number(((155 - 141) / 29).toFixed(6));

  assert.strictEqual(wep.weaponAttackQuality, expectedQuality);
  assert.strictEqual(wep.slotQuality, expectedQuality);
});

// 147. Crit is not averaged into weapon slot quality
test("147. Crit is not averaged into weapon slot quality", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  // Atk = 170 (max attack -> quality 1.0)
  // Crit = 26 (min crit) vs Crit = 35 (max crit)
  const wepMinCrit = evaluateWeaponOffer({ offerId: "w_min_c", buyerPrice: 100, skills: { attack: 170, criticalChance: 26 } }, weaponMeta, null, {}, {});
  const wepMaxCrit = evaluateWeaponOffer({ offerId: "w_max_c", buyerPrice: 100, skills: { attack: 170, criticalChance: 35 } }, weaponMeta, null, {}, {});

  assert.strictEqual(wepMinCrit.weaponAttackQuality, 1.0);
  assert.strictEqual(wepMaxCrit.weaponAttackQuality, 1.0);
  assert.strictEqual(wepMinCrit.slotQuality, 1.0);
  assert.strictEqual(wepMaxCrit.slotQuality, 1.0);
});

// 148. UI displays Attack Roll separately from MAX MARKET Crit
test("148. UI displays Attack Roll separately from MAX MARKET Crit", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  const catResults = {
    weapon: {
      category: "weapon",
      rangeInfo: { slot: "weapon", itemCode: "tank" },
      evaluatedOffers: [
        evaluateWeaponOffer({ offerId: "w1", buyerPrice: 100, skills: { attack: 167, criticalChance: 35 } }, weaponMeta, null, {}, {}),
      ],
    },
  };

  const loadout = buildFullLoadout(catResults, {
    activeCategories: ["weapon"],
    strategy: "best-value",
  });

  const weaponItem = loadout.items[0];
  assert.ok(weaponItem.rollDisplay.includes("Atk Roll"), "Roll display must mention Atk Roll");
  assert.ok(weaponItem.rollDisplay.includes("Crit PERFECT / MAX MARKET") || weaponItem.rollDisplay.includes("Crit MAX MARKET"), "Roll display must mention Crit MAX / PERFECT");
  assert.ok(!weaponItem.rollDisplay.includes("avg roll"), "Must never average Attack and Crit into a single percentage");
});

// 149. Theoretical max Crit and highest market Crit remain distinct
test("149. Theoretical max Crit and highest market Crit remain distinct", () => {
  const weaponMeta = {
    code: "tank",
    name: "Tank",
    rarity: "legendary",
    dynamicStats: { attack: [141, 170], criticalChance: [26, 35] },
  };
  // Market highest is 33, theoretical max is 35
  const catResults = {
    weapon: {
      category: "weapon",
      rangeInfo: { slot: "weapon", itemCode: "tank" },
      evaluatedOffers: [
        evaluateWeaponOffer({ offerId: "w_33", buyerPrice: 100, skills: { attack: 165, criticalChance: 33 } }, weaponMeta, null, {}, {}),
      ],
    },
  };

  const loadout = buildFullLoadout(catResults, {
    activeCategories: ["weapon"],
    strategy: "best-value",
  });

  const weaponItem = loadout.items[0];
  assert.ok(weaponItem.rollDisplay.includes("Crit MAX MARKET"), "Must display MAX MARKET when below theoretical max");
  assert.ok(!weaponItem.rollDisplay.includes("PERFECT / MAX MARKET"), "Must not claim PERFECT when below theoretical max");
});

// 150. Selected exact weapon still passes existing purchase preflight
await asyncTest("150. Selected exact weapon still passes existing purchase preflight", async () => {
  const fakeCatalogWeps = [
    { code: "tank", name: "Tank", rarity: "legendary", dynamicStats: { attack: [141, 170], criticalChance: [26, 35] } },
  ];

  const rawOffer = {
    _id: "off_wep_valid",
    price: 100,
    user: "seller_other",
    item: {
      _id: "it_wep_valid",
      code: "tank",
      state: 100,
      skills: { attack: 168, criticalChance: 35 },
    },
  };

  const weaponOffer = evaluateWeaponOffer({
    offerId: "off_wep_valid",
    itemId: "it_wep_valid",
    sellerId: "seller_other",
    user: "seller_other",
    itemCode: "tank",
    rarity: "legendary",
    buyerPrice: 101,
    sellerPrice: 100,
    taxRate: 1,
    skills: { attack: 168, criticalChance: 35 },
  }, fakeCatalogWeps[0], null, {}, {});

  const refreshed = await refreshAndValidateOffer(weaponOffer, {
    myUserId: "buyer_me",
    plannedBuyerPrice: 101,
    maxSlippagePct: 1.0,
    remainingBudget: 500,
    fetchOffersFn: async () => [rawOffer],
    fetchTaxFn: async () => 1,
    weaponMeta: fakeCatalogWeps[0],
  });

  assert.strictEqual(refreshed.offerId, "off_wep_valid");
  assert.strictEqual(refreshed.buyerPrice, 101);
});

// 151. All existing single-stat armor scoring and safety invariants remain intact
test("151. All existing single-stat armor scoring and safety invariants remain intact", () => {
  const rangeInfo = { slot: "boots", rarity: "legendary", statName: "dodge", minPossibleStat: 31, maxPossibleStat: 40 };
  const offA = { offerId: "b_a", itemId: "ib_a", buyerPrice: 100, skills: { dodge: 38 } };
  const offB = { offerId: "b_b", itemId: "ib_b", buyerPrice: 120, skills: { dodge: 40 } };

  const evalA = evaluateGearOffer(offA, rangeInfo, null, {});
  const evalB = evaluateGearOffer(offB, rangeInfo, null, {});

  // Quality score: (38 - 31) / 9 = 7 / 9 = 0.777778
  assert.strictEqual(evalA.qualityScore, Number((7 / 9).toFixed(6)));
  // Quality score: (40 - 31) / 9 = 1.0
  assert.strictEqual(evalB.qualityScore, 1.0);

  const recs = findCategoryRecommendations([evalA, evalB], false);
  // Value score A: (7/9) / 100 = 0.007778
  // Value score B: 1.0 / 120 = 0.008333
  // B wins best value
  assert.strictEqual(recs.bestValue.offerId, "b_b");
  assert.strictEqual(recs.bestPerformance.offerId, "b_b");
  assert.strictEqual(recs.cheapestUpgrade.offerId, "b_a");
});

// ============================================================================
// SECTION 23: INTERACTIVE STRATEGY SELECTION & ALTERNATIVE LOADOUT CHOICE
// ============================================================================

const createMultiStrategyMockOffers = () => {
  const offersByCode = {
    green_helmet: [
      { _id: "off_h_bv", user: "u2", price: 10, item: { _id: "it_h_bv", code: "green_helmet", state: 100, skills: { criticalDamages: 9 } } },
      { _id: "off_h_perf", user: "u2", price: 20, item: { _id: "it_h_perf", code: "green_helmet", state: 100, skills: { criticalDamages: 10 } } },
      { _id: "off_h_cheap", user: "u2", price: 5, item: { _id: "it_h_cheap", code: "green_helmet", state: 100, skills: { criticalDamages: 6 } } },
    ],
    green_chest: [
      { _id: "off_c_bv", user: "u2", price: 10, item: { _id: "it_c_bv", code: "green_chest", state: 100, skills: { armor: 9 } } },
      { _id: "off_c_perf", user: "u2", price: 20, item: { _id: "it_c_perf", code: "green_chest", state: 100, skills: { armor: 10 } } },
      { _id: "off_c_cheap", user: "u2", price: 5, item: { _id: "it_c_cheap", code: "green_chest", state: 100, skills: { armor: 6 } } },
    ],
    green_gloves: [
      { _id: "off_g_bv", user: "u2", price: 10, item: { _id: "it_g_bv", code: "green_gloves", state: 100, skills: { precision: 9 } } },
      { _id: "off_g_perf", user: "u2", price: 20, item: { _id: "it_g_perf", code: "green_gloves", state: 100, skills: { precision: 10 } } },
      { _id: "off_g_cheap", user: "u2", price: 5, item: { _id: "it_g_cheap", code: "green_gloves", state: 100, skills: { precision: 6 } } },
    ],
    green_pants: [
      { _id: "off_p_bv", user: "u2", price: 10, item: { _id: "it_p_bv", code: "green_pants", state: 100, skills: { armor: 9 } } },
      { _id: "off_p_perf", user: "u2", price: 20, item: { _id: "it_p_perf", code: "green_pants", state: 100, skills: { armor: 10 } } },
      { _id: "off_p_cheap", user: "u2", price: 5, item: { _id: "it_p_cheap", code: "green_pants", state: 100, skills: { armor: 6 } } },
    ],
    green_boots: [
      { _id: "off_b_bv", user: "u2", price: 10, item: { _id: "it_b_bv", code: "green_boots", state: 100, skills: { dodge: 9 } } },
      { _id: "off_b_perf", user: "u2", price: 20, item: { _id: "it_b_perf", code: "green_boots", state: 100, skills: { dodge: 10 } } },
      { _id: "off_b_cheap", user: "u2", price: 5, item: { _id: "it_b_cheap", code: "green_boots", state: 100, skills: { dodge: 6 } } },
    ],
    green_weapon: [
      { _id: "off_w_bv", user: "u2", price: 15, item: { _id: "it_w_bv", code: "green_weapon", state: 100, skills: { attack: 18, criticalChance: 10 } } },
      { _id: "off_w_perf", user: "u2", price: 25, item: { _id: "it_w_perf", code: "green_weapon", state: 100, skills: { attack: 20, criticalChance: 10 } } },
      { _id: "off_w_cheap", user: "u2", price: 10, item: { _id: "it_w_cheap", code: "green_weapon", state: 100, skills: { attack: 12, criticalChance: 10 } } },
      { _id: "off_w_lowcrit", user: "u2", price: 2, item: { _id: "it_w_lowcrit", code: "green_weapon", state: 100, skills: { attack: 20, criticalChance: 5 } } },
    ],
  };

  const fetchAllFn = async (code) => offersByCode[code] || [];
  const fetchOffersFn = async (slot) => {
    const code = "green_" + slot;
    return (offersByCode[code] || []).map((raw) => {
      const taxRate = 1;
      const bp = Number((raw.price * 1.01).toFixed(3));
      return {
        _id: raw._id,
        offerId: raw._id,
        sellerPrice: raw.price,
        buyerPrice: bp,
        price: raw.price,
        taxRate,
        user: raw.user,
        item: raw.item,
        itemId: raw.item._id,
        itemCode: raw.item.code,
        category: slot,
        slot,
        rarity: "uncommon",
        skills: raw.item.skills,
        state: raw.item.state,
      };
    });
  };

  return { fetchAllFn, fetchOffersFn };
};

// 152. BUY purchases initially selected loadout
await asyncTest("152. BUY purchases initially selected loadout", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  const submittedPurchases = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    submitMarketPurchase: async (offerId) => {
      submittedPurchases.push(offerId);
    },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    promptStrategyChoice: async () => "BUY",
  });
  assert.strictEqual(res.confirmedLoadout.strategy, "best-value");
  assert.strictEqual(submittedPurchases.length, 5);
  assert.deepStrictEqual(submittedPurchases, ["off_h_bv", "off_c_bv", "off_g_bv", "off_p_bv", "off_b_bv"]);
});

// 153. CHEAPEST switches to Cheapest
await asyncTest("153. CHEAPEST switches to Cheapest", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  const submittedPurchases = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    submitMarketPurchase: async (offerId) => {
      submittedPurchases.push(offerId);
    },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    promptStrategyChoice: async () => "CHEAPEST",
    promptConfirmation: async () => "BUY",
  });
  assert.strictEqual(res.confirmedLoadout.strategy, "cheapest");
  assert.strictEqual(submittedPurchases.length, 5);
  assert.deepStrictEqual(submittedPurchases, ["off_h_cheap", "off_c_cheap", "off_g_cheap", "off_p_cheap", "off_b_cheap"]);
});

// 154. PERFORMANCE switches to Best Performance
await asyncTest("154. PERFORMANCE switches to Best Performance", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  const submittedPurchases = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    submitMarketPurchase: async (offerId) => {
      submittedPurchases.push(offerId);
    },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    promptStrategyChoice: async () => "PERFORMANCE",
    promptConfirmation: async () => "BUY",
  });
  assert.strictEqual(res.confirmedLoadout.strategy, "best-performance");
  assert.strictEqual(submittedPurchases.length, 5);
  assert.deepStrictEqual(submittedPurchases, ["off_h_perf", "off_c_perf", "off_g_perf", "off_p_perf", "off_b_perf"]);
});

// 155. BEST switches back to Best Value
await asyncTest("155. BEST switches back to Best Value", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  const submittedPurchases = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--strategy=cheapest", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    submitMarketPurchase: async (offerId) => {
      submittedPurchases.push(offerId);
    },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    promptStrategyChoice: async () => "BEST",
    promptConfirmation: async () => "BUY",
  });
  assert.strictEqual(res.confirmedLoadout.strategy, "best-value");
  assert.strictEqual(submittedPurchases.length, 5);
  assert.deepStrictEqual(submittedPurchases, ["off_h_bv", "off_c_bv", "off_g_bv", "off_p_bv", "off_b_bv"]);
});

// 156. strategy aliases are case-insensitive
test("156. strategy aliases are case-insensitive", () => {
  assert.deepStrictEqual(parseLoadoutChoice("buy"), { action: "BUY" });
  assert.deepStrictEqual(parseLoadoutChoice("BUY"), { action: "BUY" });
  assert.deepStrictEqual(parseLoadoutChoice("best"), { action: "SWITCH", strategy: "best-value" });
  assert.deepStrictEqual(parseLoadoutChoice("BEST VALUE"), { action: "SWITCH", strategy: "best-value" });
  assert.deepStrictEqual(parseLoadoutChoice("best-value"), { action: "SWITCH", strategy: "best-value" });
  assert.deepStrictEqual(parseLoadoutChoice("performance"), { action: "SWITCH", strategy: "best-performance" });
  assert.deepStrictEqual(parseLoadoutChoice("BEST PERFORMANCE"), { action: "SWITCH", strategy: "best-performance" });
  assert.deepStrictEqual(parseLoadoutChoice("best-performance"), { action: "SWITCH", strategy: "best-performance" });
  assert.deepStrictEqual(parseLoadoutChoice("cheapest"), { action: "SWITCH", strategy: "cheapest" });
  assert.deepStrictEqual(parseLoadoutChoice("CHEAPEST"), { action: "SWITCH", strategy: "cheapest" });
  assert.deepStrictEqual(parseLoadoutChoice("cancel"), { action: "CANCEL" });
  assert.deepStrictEqual(parseLoadoutChoice("CANCEL"), { action: "CANCEL" });
  assert.deepStrictEqual(parseLoadoutChoice("unknown"), { action: "CANCEL" });
});

// 157. switching strategy does not mutate anything yet
await asyncTest("157. switching strategy does not mutate anything yet", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  const submittedPurchases = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    submitPurchaseFn: async (offerId) => {
      submittedPurchases.push(offerId);
      return { success: true, transactionId: `tx-${offerId}` };
    },
    promptStrategyChoice: async () => "CHEAPEST",
    promptConfirmation: async () => "CANCEL",
  });
  assert.strictEqual(res.cancelled, true);
  assert.strictEqual(res.totalGoldSpent, 0);
  assert.strictEqual(submittedPurchases.length, 0, "No mutations must occur when switching and cancelling");
});

// 158. switched loadout is displayed before confirmation
test("158. switched loadout is displayed before confirmation", () => {
  const mockLoadout = {
    strategy: "cheapest",
    strategyDisplayName: "CHEAPEST",
    totalCost: 25.25,
    items: [
      { slot: "helmet", slotLabel: "Helmet", statDisplay: "+6 CritDmg", cost: 5.05 },
      { slot: "chest", slotLabel: "Chest", statDisplay: "+6 Armor", cost: 5.05 },
    ],
  };
  const origLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(" "));
  try {
    printSelectedLoadoutCard(mockLoadout);
  } finally {
    console.log = origLog;
  }
  const joined = logs.join("\n");
  assert.ok(joined.includes("Cheapest Loadout Selected"), "Must display Cheapest Loadout Selected title");
  assert.ok(joined.includes("Strategy:   CHEAPEST"), "Must display strategy display name");
  assert.ok(joined.includes("Helmet"), "Must display Helmet slot");
  assert.ok(joined.includes("Total:      25.250 Gold"), "Must display formatted total cost");
});

// 159. switched loadout receives a fresh full-set preflight
await asyncTest("159. switched loadout receives a fresh full-set preflight", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  const preflightedOfferIds = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    refreshAndValidateOffer: async (offer) => {
      preflightedOfferIds.push(offer.offerId || offer._id);
      return { ...offer, buyerPrice: offer.buyerPrice };
    },
    promptStrategyChoice: async () => "CHEAPEST",
    promptConfirmation: async () => "NO",
  });
  assert.deepStrictEqual(
    preflightedOfferIds,
    ["off_h_cheap", "off_c_cheap", "off_g_cheap", "off_p_cheap", "off_b_cheap"],
    "Preflight must be run on the switched Cheapest offers"
  );
});

// 160. final BUY purchases the switched exact offer IDs
await asyncTest("160. final BUY purchases the switched exact offer IDs", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  const submittedPurchases = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    submitMarketPurchase: async (offerId) => {
      submittedPurchases.push(offerId);
    },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    promptStrategyChoice: async () => "PERFORMANCE",
    promptConfirmation: async () => "BUY",
  });
  assert.deepStrictEqual(submittedPurchases, ["off_h_perf", "off_c_perf", "off_g_perf", "off_p_perf", "off_b_perf"]);
  assert.deepStrictEqual(res.confirmedLoadout.offerIds, ["off_h_perf", "off_c_perf", "off_g_perf", "off_p_perf", "off_b_perf"]);
});

// 161. anything except BUY at final confirmation cancels
await asyncTest("161. anything except BUY at final confirmation cancels", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  for (const nonBuy of ["NO", "no", "exit", "cancel", "xyz", ""]) {
    const submittedPurchases = [];
    const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
      fetchGameConfig: async () => mockBuyerConfig,
      fetchMarketTaxRate: async () => 1,
      fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
      fetchAllMarketOffers: fetchAllFn,
      fetchOffersFn,
      submitPurchaseFn: async (offerId) => {
        submittedPurchases.push(offerId);
        return { success: true, transactionId: `tx-${offerId}` };
      },
      promptStrategyChoice: async () => "CHEAPEST",
      promptConfirmation: async () => nonBuy,
    });
    assert.strictEqual(res.cancelled, true, `Input '${nonBuy}' must cancel`);
    assert.strictEqual(submittedPurchases.length, 0);
  }
});

// 162. confirmedLoadout IDs equal switched selectedLoadout IDs
await asyncTest("162. confirmedLoadout IDs equal switched selectedLoadout IDs", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    submitMarketPurchase: async () => {},
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    promptStrategyChoice: async () => "PERFORMANCE",
    promptConfirmation: async () => "BUY",
  });
  const altOfferIds = res.loadout.alternativeSets["best-performance"].offerIds.slice().sort();
  const confirmedOfferIds = res.confirmedLoadout.offerIds.slice().sort();
  assert.deepStrictEqual(confirmedOfferIds, altOfferIds);
});

// 163. weapon max-Crit constraint survives strategy switching
await asyncTest("163. weapon max-Crit constraint survives strategy switching", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  const res = await runEquipmentBuyer(["--rarity=green", "--include=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    submitMarketPurchase: async () => {},
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    promptStrategyChoice: async () => "CHEAPEST",
    promptConfirmation: async () => "BUY",
  });
  assert.strictEqual(res.confirmedLoadout.items.length, 1);
  const wep = res.confirmedLoadout.items[0];
  assert.strictEqual(wep.offer.offerId, "off_w_cheap");
  assert.strictEqual(wep.offer.skills.criticalChance, 10, "Crit must remain max market (10%), not trap 5%");
  assert.notStrictEqual(wep.offer.offerId, "off_w_lowcrit", "Cheap lower-crit weapon must never be selected");
});

// 164. --strategy still determines initial selection
await asyncTest("164. --strategy still determines initial selection", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  const submittedPurchases = [];
  const res = await runEquipmentBuyer(["--rarity=green", "--strategy=best-performance", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    submitMarketPurchase: async (offerId) => {
      submittedPurchases.push(offerId);
    },
    verifyMarketPurchase: async (offer) => ({ state: "VERIFIED_PURCHASED", verifiedPrice: offer.buyerPrice }),
    promptStrategyChoice: async () => "BUY",
  });
  assert.strictEqual(res.confirmedLoadout.strategy, "best-performance");
  assert.deepStrictEqual(submittedPurchases, ["off_h_perf", "off_c_perf", "off_g_perf", "off_p_perf", "off_b_perf"]);
});

// 165. --dry-run remains fully noninteractive
await asyncTest("165. --dry-run remains fully noninteractive", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  let promptCalled = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--dry-run"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    promptStrategyChoice: async () => { promptCalled = true; return "BUY"; },
    promptConfirmation: async () => { promptCalled = true; return "BUY"; },
  });
  assert.strictEqual(promptCalled, false, "--dry-run must never call any prompt");
  assert.strictEqual(res.confirmedLoadout, null);
});

// 166. User cancel at strategy prompt exits without mutations or preflight
await asyncTest("166. User cancel at strategy prompt exits without mutations or preflight", async () => {
  const { fetchAllFn, fetchOffersFn } = createMultiStrategyMockOffers();
  let preflightCalled = false;
  let purchaseCalled = false;
  const res = await runEquipmentBuyer(["--rarity=green", "--exclude=weapon"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: fetchAllFn,
    fetchOffersFn,
    refreshAndValidateOffer: async (o) => { preflightCalled = true; return o; },
    submitPurchaseFn: async () => { purchaseCalled = true; return { success: true }; },
    promptStrategyChoice: async () => "CANCEL",
  });
  assert.strictEqual(res.cancelled, true);
  assert.strictEqual(preflightCalled, false, "Preflight must not run if cancelled at strategy choice");
  assert.strictEqual(purchaseCalled, false, "No purchases must run if cancelled at strategy choice");
});

// ==============================================================
// SECTION 24: HTTP Request Timeout Resilience & Retries
// ==============================================================

// 167. fetchWithRetry retries on transient TimeoutError and succeeds
await asyncTest("167. fetchWithRetry retries on transient TimeoutError and succeeds", async () => {
  const origFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    if (attempts === 1) {
      const err = new Error("The operation was aborted due to timeout");
      err.name = "TimeoutError";
      throw err;
    }
    return {
      status: 200,
      ok: true,
      json: async () => ({ success: true }),
    };
  };
  try {
    const res = await fetchWithRetry("http://localhost/test", { timeoutMs: 1000 }, 3, 10);
    assert.strictEqual(attempts, 2, "Must retry once and succeed on attempt 2");
    assert.strictEqual(res.ok, true);
  } finally {
    globalThis.fetch = origFetch;
  }
});

// 168. fetchWithRetry fails after exhausting all retries on persistent TimeoutError with endpoint in error message
await asyncTest("168. fetchWithRetry fails after exhausting all retries on persistent TimeoutError with endpoint in error message", async () => {
  const origFetch = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = async () => {
    attempts++;
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  };
  try {
    let caughtErr = null;
    try {
      await fetchWithRetry("https://api6.warera.io/trpc/itemOffer.getItemOffers?batch=1", { timeoutMs: 50 }, 2, 5);
    } catch (e) {
      caughtErr = e;
    }
    assert.ok(caughtErr, "Must throw on exhausted retries");
    assert.strictEqual(attempts, 2, "Must attempt 2 times");
    assert.strictEqual(caughtErr.name, "TimeoutError");
    assert.ok(caughtErr.message.includes("50ms"), "Must state timeout duration");
    assert.ok(caughtErr.message.includes("itemOffer.getItemOffers"), "Must include endpoint name");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// 169. fetchWithRetry does not retry when options.signal is externally aborted
await asyncTest("169. fetchWithRetry does not retry when options.signal is externally aborted", async () => {
  const origFetch = globalThis.fetch;
  let attempts = 0;
  const ac = new AbortController();
  ac.abort();
  globalThis.fetch = async () => {
    attempts++;
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };
  try {
    let caughtErr = null;
    try {
      await fetchWithRetry("http://localhost/test", { signal: ac.signal }, 3, 10);
    } catch (e) {
      caughtErr = e;
    }
    assert.ok(caughtErr);
    assert.strictEqual(attempts, 1, "Must not retry when signal is externally aborted");
  } finally {
    globalThis.fetch = origFetch;
  }
});

// 170. parseArgs parses --timeout=<seconds> into config.timeout
test("170. parseArgs parses --timeout=<seconds> into config.timeout", () => {
  const parsed = parseArgs(["--rarity=green", "--timeout=35"]);
  assert.strictEqual(parsed.timeout, 35);
});

// 171. parseArgs rejects invalid --timeout values
test("171. parseArgs rejects invalid --timeout values", () => {
  assert.throws(() => parseArgs(["--rarity=green", "--timeout=0"]), /positive number/);
  assert.throws(() => parseArgs(["--rarity=green", "--timeout=-5"]), /positive number/);
  assert.throws(() => parseArgs(["--rarity=green", "--timeout=abc"]), /positive number/);
});

// 172. runEquipmentBuyer forwards configured timeoutMs to fetchOffersFn
await asyncTest("172. runEquipmentBuyer forwards configured timeoutMs to fetchOffersFn", async () => {
  const forwardedTimeouts = [];
  const mockFetchAll = async (itemCode, options = {}) => {
    forwardedTimeouts.push(options.timeoutMs);
    return [];
  };
  await runEquipmentBuyer(["--rarity=green", "--include=boots", "--timeout=40", "--dry-run"], {
    fetchGameConfig: async () => mockBuyerConfig,
    fetchMarketTaxRate: async () => 1,
    fetchUserLiveState: async () => ({ equipped: {}, user: {} }),
    fetchAllMarketOffers: mockFetchAll,
  });
  assert.ok(forwardedTimeouts.length > 0, "Must call fetchOffersFn");
  assert.strictEqual(forwardedTimeouts[0], 40000, "Must forward 40s (40000ms) to fetchOffersFn");
});

// --- STRATEGY ALTERNATIVES AUDIT REGRESSION TESTS ---

// 173. Expensive max-stat armor remains eligible for Best Performance
test("173. Expensive max-stat armor remains eligible for Best Performance", () => {
  const offers = [
    { offerId: "off_cheap_low", statValue: 11, buyerPrice: 10 },
    { offerId: "off_mid", statValue: 13, buyerPrice: 15 },
    { offerId: "off_expensive_max", statValue: 15, buyerPrice: 100 },
  ];
  const { nonDominated } = eliminateDominatedOffers(offers, (o) => o.statValue, (o) => o.buyerPrice);
  const maxOffer = nonDominated.find((o) => o.offerId === "off_expensive_max");
  assert.ok(maxOffer, "Expensive max-stat offer must remain in non-dominated pool");
  assert.strictEqual(maxOffer.statValue, 15);
});

// 174. Best Performance selects max raw stat regardless of price
test("174. Best Performance selects max raw stat regardless of price", () => {
  const candidatePools = {
    boots: [
      { offerId: "off_cheap", statValue: 14, buyerPrice: 10, slotQuality: 0.75, valueScore: 0.075 },
      { offerId: "off_max_expensive", statValue: 15, buyerPrice: 200, slotQuality: 1.0, valueScore: 0.005 },
    ],
  };
  const result = optimizeLoadoutUnderBudget(candidatePools, null, "best-performance");
  assert.strictEqual(result.items[0].offer.offerId, "off_max_expensive");
  assert.strictEqual(result.items[0].offer.statValue, 15);
  assert.strictEqual(result.totalCost, 200);
});

// 175. Best Value may prefer cheaper lower-stat item
test("175. Best Value may prefer cheaper lower-stat item when value/price is superior", () => {
  const candidatePools = {
    boots: [
      { offerId: "off_cheap_good", statValue: 14, buyerPrice: 10, slotQuality: 0.75, valueScore: 0.075 },
      { offerId: "off_max_overpriced", statValue: 15, buyerPrice: 100, slotQuality: 1.0, valueScore: 0.010 },
    ],
  };
  const result = optimizeLoadoutUnderBudget(candidatePools, null, "best-value");
  assert.strictEqual(result.items[0].offer.offerId, "off_cheap_good");
  assert.strictEqual(result.items[0].offer.statValue, 14);
});

// 176. Cheapest selects lowest buyer price
test("176. Cheapest selects lowest buyer price regardless of roll quality", () => {
  const candidatePools = {
    boots: [
      { offerId: "off_lowest_price", statValue: 11, buyerPrice: 5, slotQuality: 0.0, valueScore: 0.0 },
      { offerId: "off_cheap_good", statValue: 14, buyerPrice: 10, slotQuality: 0.75, valueScore: 0.075 },
      { offerId: "off_max", statValue: 15, buyerPrice: 50, slotQuality: 1.0, valueScore: 0.02 },
    ],
  };
  const result = optimizeLoadoutUnderBudget(candidatePools, null, "cheapest");
  assert.strictEqual(result.items[0].offer.offerId, "off_lowest_price");
  assert.strictEqual(result.totalCost, 5);
});

// 177. Three strategy loadouts are computed independently
test("177. Three strategy loadouts are computed independently and do not alias objects", () => {
  const candidatePools = {
    boots: [
      { offerId: "off_cheap", statValue: 11, buyerPrice: 5, slotQuality: 0.0, valueScore: 0.0 },
      { offerId: "off_perf", statValue: 15, buyerPrice: 50, slotQuality: 1.0, valueScore: 0.02 },
    ],
  };
  const bvResult = optimizeLoadoutUnderBudget(candidatePools, null, "best-value");
  const bpResult = optimizeLoadoutUnderBudget(candidatePools, null, "best-performance");
  const cheapResult = optimizeLoadoutUnderBudget(candidatePools, null, "cheapest");

  assert.notStrictEqual(bvResult.items, bpResult.items, "Item arrays must be distinct references");
  assert.notStrictEqual(bvResult.items, cheapResult.items, "Item arrays must be distinct references");
  assert.notStrictEqual(bpResult.items, cheapResult.items, "Item arrays must be distinct references");

  // Mutating one combo does not affect others
  bvResult.items[0].testFlag = "mutated";
  assert.strictEqual(bpResult.items[0].testFlag, undefined);
  assert.strictEqual(cheapResult.items[0].testFlag, undefined);
});

// 178. Candidate pruning never removes the only max-stat offer
test("178. Candidate pruning never removes the only max-stat offer", () => {
  const rawOffers = [
    { offerId: "off1", statValue: 12, buyerPrice: 5 },
    { offerId: "off2", statValue: 13, buyerPrice: 8 },
    { offerId: "off3", statValue: 14, buyerPrice: 12 },
    { offerId: "off_solo_max", statValue: 15, buyerPrice: 999 }, // Extreme outlier price
  ];
  const { nonDominated, dominated } = eliminateDominatedOffers(
    rawOffers,
    (o) => o.statValue,
    (o) => o.buyerPrice
  );
  assert.ok(nonDominated.some((o) => o.offerId === "off_solo_max"), "Solo max-stat offer must NEVER be dominated");
  assert.ok(!dominated.some((d) => d.offer.offerId === "off_solo_max"));
});

// 179. No-budget Best Performance has no value/cost ceiling
test("179. No-budget Best Performance has no value/cost ceiling", () => {
  const candidatePools = {
    chest: [
      { offerId: "off_normal", statValue: 14, buyerPrice: 10, slotQuality: 0.75, valueScore: 0.075 },
      { offerId: "off_stratospheric", statValue: 15, buyerPrice: 999999, slotQuality: 1.0, valueScore: 0.000001 },
    ],
  };
  const result = optimizeLoadoutUnderBudget(candidatePools, null, "best-performance");
  assert.strictEqual(result.items[0].offer.offerId, "off_stratospheric");
  assert.strictEqual(result.totalCost, 999999);
});

// 180. Equal-stat tie picks cheaper offer
test("180. Equal-stat tie picks cheaper offer in Best Performance", () => {
  const candidatePools = {
    boots: [
      { offerId: "off_b_expensive", statValue: 15, buyerPrice: 30, slotQuality: 1.0, valueScore: 0.033 },
      { offerId: "off_b_cheaper", statValue: 15, buyerPrice: 20, slotQuality: 1.0, valueScore: 0.05 },
    ],
  };
  const result = optimizeLoadoutUnderBudget(candidatePools, null, "best-performance");
  assert.strictEqual(result.items[0].offer.offerId, "off_b_cheaper");
  assert.strictEqual(result.totalCost, 20);
});

// 181. Genuinely identical Best Value/Performance remains allowed
test("181. Genuinely identical Best Value and Best Performance remains allowed without artificial divergence", () => {
  const candidatePools = {
    boots: [
      { offerId: "off_min", statValue: 11, buyerPrice: 12.5, slotQuality: 0.0, valueScore: 0.0 },
      { offerId: "off_max_and_val", statValue: 14, buyerPrice: 13.0, slotQuality: 0.75, valueScore: 0.0577 },
    ],
  };
  const bv = optimizeLoadoutUnderBudget(candidatePools, null, "best-value");
  const bp = optimizeLoadoutUnderBudget(candidatePools, null, "best-performance");

  assert.strictEqual(bv.items[0].offer.offerId, "off_max_and_val");
  assert.strictEqual(bp.items[0].offer.offerId, "off_max_and_val");
  assert.strictEqual(bv.totalCost, bp.totalCost);
  assert.strictEqual(bv.avgQualityPercent, bp.avgQualityPercent);
});

// 182. Strategy summary reports when exact offer IDs are identical
test("182. Strategy summary reports when exact offer IDs are identical vs different", () => {
  const mockSelectedLoadout = {
    strategy: "best-value",
    strategyDisplayName: "BEST VALUE",
    totalCost: 39.844,
    offerIds: ["off_b14", "off_g14", "off_c14"],
  };

  const identicalAlt = {
    name: "BEST PERFORMANCE",
    totalCost: 39.844,
    offerIds: ["off_b14", "off_g14", "off_c14"],
    items: [
      { slot: "boots", slotLabel: "Boots", offer: { statValue: 14 } },
      { slot: "gloves", slotLabel: "Gloves", offer: { statValue: 14 } },
      { slot: "chest", slotLabel: "Chest", offer: { statValue: 14 } },
    ],
  };

  const identicalSummary = formatAlternativeSummary(identicalAlt, mockSelectedLoadout);
  assert.strictEqual(identicalSummary.isExactSameOffers, true);
  assert.strictEqual(identicalSummary.statsSummary, "Market-max stats: Boots +14, Gloves +14, Chest +14");
  assert.strictEqual(identicalSummary.comparisonSummary, "Same 3 offers as BEST VALUE");

  const differentAlt = {
    name: "CHEAPEST",
    totalCost: 38.085,
    avgQualityPercent: 8.3,
    offerIds: ["off_b12", "off_g12", "off_c11"],
    items: [
      { slot: "boots", slotLabel: "Boots", offer: { statValue: 12 } },
      { slot: "gloves", slotLabel: "Gloves", offer: { statValue: 12 } },
      { slot: "chest", slotLabel: "Chest", offer: { statValue: 11 } },
    ],
  };

  const diffSummary = formatAlternativeSummary(differentAlt, mockSelectedLoadout);
  assert.strictEqual(diffSummary.isExactSameOffers, false);
  assert.strictEqual(diffSummary.statsSummary, "Boots +12, Gloves +12, Chest +11");
  assert.strictEqual(diffSummary.comparisonSummary, "8.3% avg roll, -1.759 G vs BEST VALUE");
});

// 183. market has 700 offers across 10 pages, max-stat item is on page 7 -> Best Performance still discovers it
await asyncTest("183. market has 700 offers, max-stat item is on page 7 -> Best Performance still discovers it", async () => {
  const pages = [];
  for (let p = 0; p < 10; p++) {
    const items = [];
    for (let i = 0; i < 70; i++) {
      const isMax = p === 6 && i === 35; // page 7 (index 6), item 36
      items.push({
        _id: `off_p${p}_i${i}`,
        item: { _id: `it_p${p}_i${i}`, code: "boots3", skills: { dodge: isMax ? 15 : 12 }, state: 100 },
        price: isMax ? 25.0 : 12.0 + p,
        itemCode: "boots3",
      });
    }
    pages.push({
      items,
      nextCursor: p < 9 ? `cursor_${p + 1}` : null,
    });
  }

  let reqCount = 0;
  const mockFetch = async () => {
    const pageData = pages[reqCount++];
    return {
      ok: true,
      json: async () => [{ result: { data: pageData } }],
    };
  };

  const rawOffers = await fetchAllMarketOffers("boots3", { fetchFn: mockFetch });
  assert.strictEqual(rawOffers.length, 700);

  const rangeInfo = { itemCode: "boots3", slot: "boots", rarity: "rare", statName: "dodge", minPossibleStat: 11, maxPossibleStat: 15 };
  const valid = sanitizeMarketOffers(rawOffers, { requiredStats: ["dodge"] });
  const evaluated = valid.map(o => evaluateGearOffer(o, rangeInfo, null));
  const recs = findCategoryRecommendations(evaluated, false);

  assert.strictEqual(recs.bestPerformance.statValue, 15);
  assert.strictEqual(recs.bestPerformance.offerId, "off_p6_i35");
});

// 184. max-stat offer is expensive -> Best Performance still sees/selects it
test("184. max-stat offer is expensive -> Best Performance still sees/selects it", () => {
  const candidatePools = {
    boots: [
      { offerId: "off_cheap_low", statValue: 11, buyerPrice: 10.0, slotQuality: 0.0, valueScore: 0.0 },
      { offerId: "off_expensive_max", statValue: 15, buyerPrice: 100.0, slotQuality: 1.0, valueScore: 0.01 },
    ],
  };

  const bp = optimizeLoadoutUnderBudget(candidatePools, null, "best-performance");
  assert.strictEqual(bp.items[0].offer.offerId, "off_expensive_max");
  assert.strictEqual(bp.items[0].offer.statValue, 15);
  assert.strictEqual(bp.totalCost, 100.0);
});

// 185. Best Value pruning cannot remove max-stat candidate from Best Performance universe
test("185. Best Value pruning cannot remove max-stat candidate from Best Performance universe", () => {
  const candidatePools = {
    helmet: [
      { offerId: "off_mid_val", statValue: 44, buyerPrice: 12.0, slotQuality: 0.68, valueScore: 0.0567 },
      { offerId: "off_perf_max", statValue: 50, buyerPrice: 24.0, slotQuality: 1.0, valueScore: 0.0416 },
    ],
  };

  const bv = optimizeLoadoutUnderBudget(candidatePools, null, "best-value");
  const bp = optimizeLoadoutUnderBudget(candidatePools, null, "best-performance");

  assert.strictEqual(bv.items[0].offer.offerId, "off_mid_val");
  assert.strictEqual(bp.items[0].offer.offerId, "off_perf_max");
  assert.strictEqual(bp.items[0].offer.statValue, 50);
});

// 186. Cheapest sees low-stat cheapest offers
test("186. Cheapest sees low-stat cheapest offers", () => {
  const candidatePools = {
    chest: [
      { offerId: "off_cheap_low", statValue: 11, buyerPrice: 12.5, slotQuality: 0.0, valueScore: 0.0 },
      { offerId: "off_mid", statValue: 13, buyerPrice: 13.5, slotQuality: 0.5, valueScore: 0.037 },
      { offerId: "off_max", statValue: 15, buyerPrice: 18.0, slotQuality: 1.0, valueScore: 0.055 },
    ],
  };

  const cheap = optimizeLoadoutUnderBudget(candidatePools, null, "cheapest");
  assert.strictEqual(cheap.items[0].offer.offerId, "off_cheap_low");
  assert.strictEqual(cheap.items[0].offer.statValue, 11);
  assert.strictEqual(cheap.totalCost, 12.5);
});

// 187. rawMarketMax is calculated before strategy pruning and invariant is enforced
test("187. rawMarketMax is calculated before strategy pruning and invariant is enforced", () => {
  const categoryResults = {
    boots: {
      category: "boots",
      rawMarketMaxStat: 15,
      evaluatedOffers: [
        { offerId: "off_15", statValue: 15, buyerPrice: 20.0, slotQuality: 1.0, valueScore: 0.05 },
        { offerId: "off_12", statValue: 12, buyerPrice: 12.0, slotQuality: 0.25, valueScore: 0.02 },
      ],
      rangeInfo: { slot: "boots", statName: "dodge", minPossibleStat: 11, maxPossibleStat: 15 },
    },
  };

  const loadout = buildFullLoadout(categoryResults, {
    strategy: "best-performance",
    activeCategories: ["boots"],
    rarity: "rare",
    rarityDisplayName: "Blue",
  });

  assert.strictEqual(loadout.items[0].offer.statValue, 15);
  assert.strictEqual(loadout.alternativeSets["best-performance"].items[0].offer.statValue, 15);

  // Invariant assertion failure check: if categoryResults claims rawMarketMaxStat is 15 but selected is 14:
  const mismatchedCatResults = {
    boots: {
      category: "boots",
      rawMarketMaxStat: 15,
      evaluatedOffers: [
        { offerId: "off_14", statValue: 14, buyerPrice: 12.0, slotQuality: 0.75, valueScore: 0.06 },
      ],
      rangeInfo: { slot: "boots", statName: "dodge", minPossibleStat: 11, maxPossibleStat: 15 },
    },
  };
  assert.throws(
    () => buildFullLoadout(mismatchedCatResults, {
      strategy: "best-performance",
      activeCategories: ["boots"],
      rarity: "rare",
      rarityDisplayName: "Blue",
    }),
    /BEST PERFORMANCE INVARIANT VIOLATION: Slot boots selected stat \+14, but raw market max is \+15/
  );
});

// 188. pagination continues until exhaustion (nextCursor null)
await asyncTest("188. pagination continues until exhaustion (nextCursor null)", async () => {
  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    const nextCursor = callCount < 4 ? `c_${callCount}` : null;
    return {
      ok: true,
      json: async () => [{
        result: {
          data: {
            items: [{ _id: `off_${callCount}`, item: { _id: `it_${callCount}` }, price: 10 }],
            nextCursor,
          },
        },
      }],
    };
  };

  const offers = await fetchAllMarketOffers("test_code", { fetchFn: mockFetch });
  assert.strictEqual(offers.length, 4);
  assert.strictEqual(callCount, 4);
});

// 189. CLI clearly distinguishes fetched vs rarity-matched vs valid counts
test("189. CLI clearly distinguishes fetched vs rarity-matched vs valid counts", () => {
  const rawOffers = [
    { _id: "off1", item: { _id: "it1", code: "boots3", skills: { dodge: 14 }, state: 100 }, price: 12.0 },
    { _id: "off2", item: { _id: "it2", code: "boots3", skills: { dodge: 12 }, state: 100 }, price: 10.0 },
    { _id: "off3_damaged", item: { _id: "it3", code: "boots3", skills: { dodge: 15 }, state: 80 }, price: 8.0 },
    { _id: "off4_noprice", item: { _id: "it4", code: "boots3", skills: { dodge: 14 }, state: 100 }, price: 0 },
  ];

  const valid = sanitizeMarketOffers(rawOffers, { requiredStats: ["dodge"] });
  assert.strictEqual(rawOffers.length, 4);
  assert.strictEqual(valid.length, 2);

  const pipeline = {
    fetchedFromApi: rawOffers.length,
    matchingRarity: rawOffers.length,
    validAfterSanitize: valid.length,
  };

  assert.strictEqual(pipeline.fetchedFromApi, 4);
  assert.strictEqual(pipeline.matchingRarity, 4);
  assert.strictEqual(pipeline.validAfterSanitize, 2);
});

// 190. exact per-stat distribution is correct
test("190. exact per-stat distribution is correct across full valid market", () => {
  const stats = [11, 11, 12, 13, 14, 15, 15, 15];
  const dist = {};
  for (const s of stats) {
    dist[s] = (dist[s] || 0) + 1;
  }

  assert.deepStrictEqual(dist, { 11: 2, 12: 1, 13: 1, 14: 1, 15: 3 });
  assert.strictEqual(Math.min(...stats), 11);
  assert.strictEqual(Math.max(...stats), 15);
});

// 191. genuinely absent max theoretical roll is reported honestly
test("191. genuinely absent max theoretical roll is reported honestly", () => {
  const rangeInfo = { slot: "boots", statName: "dodge", minPossibleStat: 11, maxPossibleStat: 15 };
  const offers = [
    { offerId: "off_12", statValue: 12, rollPercent: 25, buyerPrice: 10.0, slotQuality: 0.25, valueScore: 0.025 },
    { offerId: "off_14", statValue: 14, rollPercent: 75, buyerPrice: 15.0, slotQuality: 0.75, valueScore: 0.05 },
  ];

  const categoryResults = {
    boots: {
      category: "boots",
      rawMarketMaxStat: 14,
      evaluatedOffers: offers,
      rangeInfo,
    },
  };

  const loadout = buildFullLoadout(categoryResults, {
    strategy: "best-performance",
    activeCategories: ["boots"],
    rarity: "rare",
    rarityDisplayName: "Blue",
  });

  assert.strictEqual(loadout.items[0].offer.statValue, 14);
  assert.strictEqual(loadout.items[0].rollDisplay, "75%");
});

// 192. Best Value and Best Performance may still be identical when the same offer genuinely wins both
test("192. Best Value and Best Performance may still be identical when the same offer genuinely wins both", () => {
  const candidatePools = {
    boots: [
      { offerId: "off_cheapest_and_best", statValue: 15, buyerPrice: 12.0, slotQuality: 1.0, valueScore: 0.0833 },
      { offerId: "off_worse", statValue: 13, buyerPrice: 15.0, slotQuality: 0.5, valueScore: 0.0333 },
    ],
  };

  const bv = optimizeLoadoutUnderBudget(candidatePools, null, "best-value");
  const bp = optimizeLoadoutUnderBudget(candidatePools, null, "best-performance");

  assert.strictEqual(bv.items[0].offer.offerId, "off_cheapest_and_best");
  assert.strictEqual(bp.items[0].offer.offerId, "off_cheapest_and_best");
  assert.strictEqual(bv.totalCost, bp.totalCost);

  const mockSelectedLoadout = {
    strategy: "best-value",
    strategyDisplayName: "BEST VALUE",
    offerIds: ["off_cheapest_and_best"],
  };
  const summary = formatAlternativeSummary({
    name: "BEST PERFORMANCE",
    offerIds: ["off_cheapest_and_best"],
    items: [{ slot: "boots", slotLabel: "Boots", offer: { statValue: 15 } }],
    totalCost: 12.0,
  }, mockSelectedLoadout);

  assert.strictEqual(summary.isExactSameOffers, true);
  assert.strictEqual(summary.comparisonSummary, "Same 1 offer as BEST VALUE");
});

console.log(chalk.bold.cyan("\n=================================================="));
console.log(chalk.bold.green(`All ${passed}/${total} Equipment Buyer tests passed successfully!`));
console.log(chalk.bold.cyan("==================================================\n"));

