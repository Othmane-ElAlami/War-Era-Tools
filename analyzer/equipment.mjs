/**
 * Equipment, weapon, ammo analysis and stat priority solver
 */

import { median, mean, percentile, spearmanCorrelation, correlationEvidence, frequencyMap } from "./statistics.mjs";

/**
 * Dynamically parse equipment, weapon, and ammo metadata from live gameConfig
 */
export function parseEquipmentCatalog(gameConfig) {
  const items = gameConfig?.items || {};
  const catalog = {
    slots: new Set(),
    itemsBySlot: {},
    itemsByCode: {},
    weapons: {},
    ammo: {},
  };

  for (const [code, item] of Object.entries(items)) {
    const slot = item.usage || item.type;
    catalog.itemsByCode[code] = item;

    if (slot === "weapon") {
      catalog.slots.add("weapon");
      catalog.weapons[code] = item;
      if (!catalog.itemsBySlot["weapon"]) catalog.itemsBySlot["weapon"] = [];
      catalog.itemsBySlot["weapon"].push(item);
    } else if (slot === "ammo" || code.toLowerCase().includes("ammo")) {
      catalog.slots.add("ammo");
      catalog.ammo[code] = item;
      if (!catalog.itemsBySlot["ammo"]) catalog.itemsBySlot["ammo"] = [];
      catalog.itemsBySlot["ammo"].push(item);
    } else if (item.type === "equipment") {
      catalog.slots.add(slot);
      if (!catalog.itemsBySlot[slot]) catalog.itemsBySlot[slot] = [];
      catalog.itemsBySlot[slot].push(item);
    }
  }

  return catalog;
}

/**
 * Analyze equipment allocations and rolls across player sample
 */
export function analyzeEquipment(players, gameConfig) {
  if (!players || players.length === 0) {
    return {
      slotAnalysis: {},
      statPriorities: [],
      statCorrelations: {},
      ammoAnalysis: {},
    };
  }

  const catalog = parseEquipmentCatalog(gameConfig);
  const damages = players.map((p) => p.weeklyDamage);
  const slots = ["weapon", "ammo", "helmet", "chest", "boots", "gloves", "pants"];

  const slotAnalysis = {};
  const statValues = {}; // statName -> array of numbers across players

  // Collect equipped stats per player
  for (const slot of slots) {
    const codes = [];
    const statsForSlot = {};

    for (const p of players) {
      const eqItem = p.equipment?.[slot];
      if (eqItem) {
        const itemCode = typeof eqItem === "string" ? eqItem : eqItem.code || "unknown";
        codes.push(itemCode);
        if (eqItem.skills && typeof eqItem.skills === "object") {
          for (const [statName, val] of Object.entries(eqItem.skills)) {
            if (!statsForSlot[statName]) statsForSlot[statName] = [];
            statsForSlot[statName].push(Number(val) || 0);

            if (!statValues[statName]) statValues[statName] = [];
            statValues[statName].push(Number(val) || 0);
          }
        } else if (slot === "ammo" && catalog.ammo[itemCode]?.flatStats) {
          const flat = catalog.ammo[itemCode].flatStats;
          for (const [statName, val] of Object.entries(flat)) {
            if (!statsForSlot[statName]) statsForSlot[statName] = [];
            statsForSlot[statName].push(Number(val) || 0);
          }
        }
      } else {
        codes.push("none");
      }
    }

    // Item code frequency
    const codeFreq = frequencyMap(codes);

    // Most popular item code
    const sortedCodes = Object.entries(codeFreq).sort((a, b) => b[1].count - a[1].count);
    const topCode = sortedCodes[0]?.[0] !== "none" ? sortedCodes[0] : sortedCodes[1] || sortedCodes[0];

    // Compute stat benchmarks for this slot
    const slotStats = {};
    for (const [statName, vals] of Object.entries(statsForSlot)) {
      if (vals.length > 0) {
        const corr = spearmanCorrelation(vals, damages.slice(0, vals.length));
        slotStats[statName] = {
          median: Math.round(median(vals)),
          p75: Math.round(percentile(vals, 75)),
          max: Math.max(...vals),
          correlation: corr,
          evidence: correlationEvidence(corr),
        };
      }
    }

    // Preferred characteristics
    slotAnalysis[slot] = {
      slot,
      popularItems: sortedCodes.map(([code, info]) => ({
        code,
        count: info.count,
        pct: info.pct,
        catalogItem: catalog.itemsByCode[code] || null,
      })),
      recommendedItem: topCode ? topCode[0] : "none",
      stats: slotStats,
    };
  }

  // Analyze Ammo specifically
  const ammoCodes = players.map((p) => p.equipment?.ammo?.code || "none");
  const ammoFreq = frequencyMap(ammoCodes);
  const ammoAnalysis = {
    distribution: Object.entries(ammoFreq).map(([code, info]) => ({
      code,
      count: info.count,
      pct: info.pct,
      boost: catalog.ammo[code]?.flatStats?.percentAttack || 0,
    })),
  };

  // Stat Priorities: overall correlation of each combat stat with weekly damage
  const statCorrelations = {};
  for (const [statName, vals] of Object.entries(statValues)) {
    if (vals.length >= 3) {
      const corr = spearmanCorrelation(vals, damages.slice(0, vals.length));
      statCorrelations[statName] = {
        name: statName,
        correlation: corr,
        evidence: correlationEvidence(corr),
        medianRoll: Math.round(median(vals)),
      };
    }
  }

  // Also include correlations with total combat stats from player profiles
  const combatStats = ["attack", "criticalChance", "criticalDamages", "armor", "precision", "dodge"];
  for (const statName of combatStats) {
    const totals = players.map((p) => p.skills?.[statName]?.total ?? 0);
    const corr = spearmanCorrelation(totals, damages);
    if (!statCorrelations[statName] || Math.abs(corr) > Math.abs(statCorrelations[statName].correlation)) {
      statCorrelations[statName] = {
        name: statName,
        correlation: corr,
        evidence: correlationEvidence(corr),
        medianTotal: Math.round(median(totals)),
      };
    }
  }

  const statPriorities = Object.values(statCorrelations).sort(
    (a, b) => Math.abs(b.correlation) - Math.abs(a.correlation)
  );

  return {
    slotAnalysis,
    statPriorities,
    statCorrelations,
    ammoAnalysis,
  };
}
