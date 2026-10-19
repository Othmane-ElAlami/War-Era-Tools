/**
 * Equipment Rolls & Item Classification Module
 *
 * Inspects live gameConfig to discover dynamic stat intervals for target equipment slots and qualities.
 * Classifies inventory items into KEEP vs SELL CANDIDATE.
 *
 * CRITICAL RULE: Never mark an item as SELL if statValue === maxPossibleStat.
 */

// Target equipment slots
export const ARMOR_SLOTS = ["helmet", "chest", "gloves", "pants", "boots"];
export const TARGET_SLOTS = ["helmet", "chest", "gloves", "pants", "boots", "weapon"];

// Quality mappings
export const RARITY_MAP = {
  common: { key: "common", codeSuffix: "1", displayName: "Grey", tier: 1 },
  uncommon: { key: "uncommon", codeSuffix: "2", displayName: "Green", tier: 2 },
  rare: { key: "rare", codeSuffix: "3", displayName: "Blue", tier: 3 },
  epic: { key: "epic", codeSuffix: "4", displayName: "Purple", tier: 4 },
  legendary: { key: "legendary", codeSuffix: "5", displayName: "Gold", tier: 5 },
  mythic: { key: "mythic", codeSuffix: "6", displayName: "Red", tier: 6 },
};

// Qualities in scope for automatic resale
export const TARGET_RARITIES = ["common", "uncommon", "rare"];

/**
 * Extract live stat ranges from gameConfig for all target slots and qualities.
 * Returns: {
 *   [slot_quality]: {
 *     slot,
 *     rarity,
 *     qualityName,
 *     itemCode,
 *     statName,
 *     minPossibleStat,
 *     maxPossibleStat,
 *     totalSteps
 *   }
 * }
 */
export function extractEquipmentRanges(gameConfig) {
  const items = gameConfig?.items || {};
  const ranges = {};

  for (const [code, item] of Object.entries(items)) {
    const isEquipment = item.type === "equipment";
    const isWeapon = item.type === "weapon" || item.usage === "weapon";
    if (!isEquipment && !isWeapon) continue;

    const slot = isWeapon ? "weapon" : (item.usage || item.skinSlot);
    const rarity = item.rarity;

    if (!TARGET_SLOTS.includes(slot)) continue;
    if (!TARGET_RARITIES.includes(rarity)) continue;

    const qualityInfo = RARITY_MAP[rarity] || { displayName: rarity };
    const dynamicStats = item.dynamicStats || {};

    if (slot === "weapon") {
      const attackRange = dynamicStats.attack;
      const critRange = dynamicStats.criticalChance;

      if (!Array.isArray(attackRange) || attackRange.length !== 2) {
        throw new Error(`Item ${code} has invalid attack stat range format: ${JSON.stringify(attackRange)}`);
      }
      if (!Array.isArray(critRange) || critRange.length !== 2) {
        throw new Error(`Item ${code} has invalid criticalChance stat range format: ${JSON.stringify(critRange)}`);
      }

      const [minAtk, maxAtk] = attackRange;
      const [minCrit, maxCrit] = critRange;

      const key = `${slot}_${rarity}`;
      ranges[key] = {
        slot: "weapon",
        rarity,
        qualityName: qualityInfo.displayName,
        itemCode: code,
        name: item.name || (code ? code.charAt(0).toUpperCase() + code.slice(1) : "Weapon"),
        statName: "criticalChance",
        minPossibleStat: minCrit,
        maxPossibleStat: maxCrit,
        totalSteps: maxCrit - minCrit + 1,
        minAtk,
        maxAtk,
        minCrit,
        maxCrit,
        attackRange: [minAtk, maxAtk],
        critRange: [minCrit, maxCrit],
        dynamicStats: {
          attack: [minAtk, maxAtk],
          criticalChance: [minCrit, maxCrit],
        },
      };
      continue;
    }

    const statNames = Object.keys(dynamicStats);

    if (statNames.length === 0) {
      throw new Error(`Item ${code} (${slot}, ${rarity}) has no dynamicStats in gameConfig.`);
    }
    if (statNames.length > 1) {
      throw new Error(
        `Item ${code} (${slot}, ${rarity}) has multiple dynamic stats: ${statNames.join(", ")}. Complex item schema detected!`
      );
    }

    const statName = statNames[0];
    const range = dynamicStats[statName];
    if (!Array.isArray(range) || range.length !== 2) {
      throw new Error(`Item ${code} has invalid stat range format: ${JSON.stringify(range)}`);
    }

    const [minPossibleStat, maxPossibleStat] = range;

    const key = `${slot}_${rarity}`;
    ranges[key] = {
      slot,
      rarity,
      qualityName: qualityInfo.displayName,
      itemCode: code,
      statName,
      minPossibleStat,
      maxPossibleStat,
      totalSteps: maxPossibleStat - minPossibleStat + 1,
    };
  }

  // Verify all 18 combinations exist
  for (const slot of TARGET_SLOTS) {
    for (const rarity of TARGET_RARITIES) {
      const key = `${slot}_${rarity}`;
      if (!ranges[key]) {
        throw new Error(`Missing equipment definition for ${slot} (${rarity}) in gameConfig.`);
      }
    }
  }

  return ranges;
}

/**
 * Calculate discrete roll position inside the possible interval.
 * Returns a human-friendly string and numerical percentage.
 */
export function calculateRollPosition(statValue, minPossible, maxPossible) {
  if (statValue === maxPossible) {
    return {
      label: "PERFECT",
      percent: 100,
      exactPercent: 100,
      isPerfect: true,
      isMinimum: statValue === minPossible,
    };
  }
  if (statValue <= minPossible) {
    return {
      label: "Minimum",
      percent: 0,
      exactPercent: 0,
      isPerfect: false,
      isMinimum: true,
    };
  }

  const range = maxPossible - minPossible;
  const currentStep = statValue - minPossible;
  const rawPct = range > 0 ? (currentStep / range) * 100 : 0;
  const pct = Math.round(rawPct);
  const exactPercent = Number(rawPct.toFixed(3));

  return {
    label: `${pct}%`,
    percent: pct,
    exactPercent,
    isPerfect: false,
    isMinimum: false,
  };
}

/**
 * Classify all inventory equipment items.
 *
 * @param {Array} inventoryEquipments - Array of equipment items from inventory.getById
 * @param {Object} equippedItems - Object from inventory.equippedItems
 * @param {Array|Set} listedItemIds - Active offer item IDs
 * @param {Object} statRanges - Output of extractEquipmentRanges(gameConfig)
 * @returns {Array} List of classified item records
 */
export function classifyInventoryItems(
  inventoryEquipments = [],
  equippedItems = {},
  listedItemIds = new Set(),
  statRanges = {},
  gameConfig = {}
) {
  const itemsCfg = gameConfig?.items || {};

  // Build equipped IDs set
  const equippedIds = new Set();
  if (equippedItems && typeof equippedItems === "object") {
    for (const [slot, eq] of Object.entries(equippedItems)) {
      if (eq && typeof eq === "object" && eq._id) {
        equippedIds.add(eq._id);
      }
    }
  }

  const activeListedIds = listedItemIds instanceof Set ? listedItemIds : new Set(listedItemIds);

  const classified = [];

  for (const item of inventoryEquipments) {
    const cfg = itemsCfg[item.code];
    if (!cfg) continue;

    const isWeapon = cfg.type === "weapon" || cfg.usage === "weapon";
    const slot = isWeapon ? "weapon" : (cfg.usage || cfg.skinSlot || cfg.type);
    const rarity = cfg.rarity;

    // Filter to target scope
    if (!TARGET_SLOTS.includes(slot)) continue;
    if (!TARGET_RARITIES.includes(rarity)) continue;

    const rangeKey = `${slot}_${rarity}`;
    const rangeInfo = statRanges[rangeKey];
    if (!rangeInfo) continue;

    const isEquipped = equippedIds.has(item._id);
    const isListed = activeListedIds.has(item._id);
    const state = item.state !== undefined ? item.state : 100;
    const isTradable = state >= 100; // Only full durability items can be listed

    if (slot === "weapon") {
      const rawAtk = item.skills?.attack;
      const rawCrit = item.skills?.criticalChance;
      const hasAtk = rawAtk !== undefined && rawAtk !== null;
      const hasCrit = rawCrit !== undefined && rawCrit !== null;
      const attack = Number(rawAtk);
      const crit = Number(rawCrit);

      const minAtk = rangeInfo.minAtk ?? rangeInfo.dynamicStats?.attack?.[0];
      const maxAtk = rangeInfo.maxAtk ?? rangeInfo.dynamicStats?.attack?.[1];
      const minCrit = rangeInfo.minCrit ?? rangeInfo.dynamicStats?.criticalChance?.[0];
      const maxCrit = rangeInfo.maxCrit ?? rangeInfo.dynamicStats?.criticalChance?.[1];

      const isMissingStats = !hasAtk || !hasCrit || isNaN(attack) || isNaN(crit);
      const isOutOfRange =
        !isMissingStats &&
        (attack < minAtk || attack > maxAtk || crit < minCrit || crit > maxCrit);

      if (isMissingStats || isOutOfRange) {
        // Fail closed on malformed or out-of-range stats
        const reason = isMissingStats
          ? "MALFORMED STATS (MISSING ATTACK OR CRIT)"
          : `INVALID LIVE STAT RANGE (Atk: ${attack} [${minAtk}-${maxAtk}], Crit: ${crit} [${minCrit}-${maxCrit}])`;

        classified.push({
          itemId: item._id,
          code: item.code,
          slot: "weapon",
          quality: rangeInfo.qualityName,
          rarityKey: rarity,
          name: rangeInfo.name || cfg.name || (item.code ? item.code.charAt(0).toUpperCase() + item.code.slice(1) : "Weapon"),
          relevantStat: "criticalChance",
          statValue: isNaN(crit) ? 0 : crit,
          minPossibleStat: minCrit,
          maxPossibleStat: maxCrit,
          rollPosition: "INVALID",
          rollPercent: 0,
          isPerfectRoll: false,
          isPerfectWeapon: false,
          isMaxCrit: false,
          attack: isNaN(attack) ? 0 : attack,
          criticalChance: isNaN(crit) ? 0 : crit,
          minAtk,
          maxAtk,
          minCrit,
          maxCrit,
          state,
          equipped: isEquipped,
          tradable: isTradable,
          listed: isListed,
          decision: "KEEP",
          decisionReason: reason,
        });
        continue;
      }

      const atkRoll = calculateRollPosition(attack, minAtk, maxAtk);
      const critRoll = calculateRollPosition(crit, minCrit, maxCrit);
      const isPerfectWeapon = attack === maxAtk && crit === maxCrit;
      const isMaxCrit = crit === maxCrit;
      const isPerfectRoll = isMaxCrit; // Critical safety invariant: max crit is protected, keep all

      let decision = "KEEP";
      let decisionReason = "";

      if (isEquipped) {
        decision = "KEEP";
        decisionReason = "EQUIPPED";
      } else if (isListed) {
        decision = "KEEP";
        decisionReason = "ALREADY LISTED";
      } else if (!isTradable) {
        decision = "KEEP";
        decisionReason = "DAMAGED / NOT TRADABLE";
      } else if (isPerfectWeapon) {
        decision = "KEEP";
        decisionReason = "Perfect weapon";
      } else if (isMaxCrit) {
        decision = "KEEP";
        decisionReason = "Maximum Critical Chance";
      } else {
        decision = "SELL";
        decisionReason = `Crit below theoretical maximum (+${maxCrit})`;
      }

      classified.push({
        itemId: item._id,
        code: item.code,
        slot: "weapon",
        quality: rangeInfo.qualityName,
        rarityKey: rarity,
        name: rangeInfo.name || cfg.name || (item.code ? item.code.charAt(0).toUpperCase() + item.code.slice(1) : "Weapon"),
        relevantStat: "criticalChance",
        statValue: crit,
        minPossibleStat: minCrit,
        maxPossibleStat: maxCrit,
        rollPosition: critRoll.label,
        rollPercent: critRoll.percent,
        isPerfectRoll,
        isPerfectWeapon,
        isMaxCrit,
        attack,
        criticalChance: crit,
        minAtk,
        maxAtk,
        minCrit,
        maxCrit,
        atkRollPosition: atkRoll.label,
        atkRollPercent: atkRoll.percent,
        critRollPosition: critRoll.label,
        critRollPercent: critRoll.percent,
        state,
        equipped: isEquipped,
        tradable: isTradable,
        listed: isListed,
        decision,
        decisionReason,
      });
      continue;
    }

    const { statName, minPossibleStat, maxPossibleStat, qualityName } = rangeInfo;
    const statValue = Number(item.skills?.[statName]) || 0;
    const isPerfectRoll = statValue === maxPossibleStat;

    const rollPosition = calculateRollPosition(statValue, minPossibleStat, maxPossibleStat);

    let decision = "KEEP";
    let decisionReason = "";

    if (isEquipped) {
      decision = "KEEP";
      decisionReason = "EQUIPPED";
    } else if (isListed) {
      decision = "KEEP";
      decisionReason = "ALREADY LISTED";
    } else if (!isTradable) {
      decision = "KEEP";
      decisionReason = "DAMAGED / NOT TRADABLE";
    } else if (isPerfectRoll) {
      decision = "KEEP";
      decisionReason = "PERFECT ROLL";
    } else {
      decision = "SELL";
      decisionReason = "SUB-MAX ROLL";
    }

    const statMin = minPossibleStat;
    const statMax = maxPossibleStat;
    const statQuality = statMax > statMin ? (statValue - statMin) / (statMax - statMin) : 0;

    classified.push({
      itemId: item._id,
      code: item.code,
      slot,
      quality: qualityName,
      rarityKey: rarity,
      relevantStat: statName,
      statValue,
      minPossibleStat,
      maxPossibleStat,
      statMin,
      statMax,
      statQuality,
      rollPosition: rollPosition.label,
      rollPercent: rollPosition.percent,
      isPerfectRoll,
      state,
      equipped: isEquipped,
      tradable: isTradable,
      listed: isListed,
      decision,
      decisionReason,
    });
  }

  return classified;
}

/**
 * Format weapon inspection block matching exact specification:
 * - Weapon
 * - [Quality] [Name]
 * - Attack: +XX [min-max] YY%
 * - Crit:   +XX [min-max] YY%
 * - Decision: KEEP / SELL
 * - Reason: ...
 */
export function formatWeaponInspection(item) {
  const isPerfect = item.isPerfectWeapon || (item.attack === item.maxAtk && item.criticalChance === item.maxCrit);
  const isMaxCrit = item.isMaxCrit || (item.criticalChance === item.maxCrit);
  const displayName = item.name ? (item.name.charAt(0).toUpperCase() + item.name.slice(1)) : (item.code || "Weapon");

  const lines = [
    "Weapon",
    `${item.quality} ${displayName}`,
  ];

  if (isPerfect) {
    lines.push(`Attack: +${item.attack} MAX`);
    lines.push(`Crit:   +${item.criticalChance} MAX`);
    lines.push(`Decision: KEEP`);
    lines.push(`Reason: Perfect weapon`);
  } else if (isMaxCrit) {
    const atkPct = item.atkRollPercent !== undefined ? item.atkRollPercent : calculateRollPosition(item.attack, item.minAtk, item.maxAtk).percent;
    lines.push(`Attack: +${item.attack} [${item.minAtk}-${item.maxAtk}] ${atkPct}%`);
    lines.push(`Crit:   +${item.criticalChance} [${item.minCrit}-${item.maxCrit}] 100%`);
    lines.push(`Decision: KEEP`);
    lines.push(`Reason: Maximum Critical Chance`);
  } else {
    const atkPct = item.atkRollPercent !== undefined ? item.atkRollPercent : calculateRollPosition(item.attack, item.minAtk, item.maxAtk).percent;
    const critPct = item.critRollPercent !== undefined ? item.critRollPercent : calculateRollPosition(item.criticalChance, item.minCrit, item.maxCrit).percent;
    lines.push(`Attack: +${item.attack} [${item.minAtk}-${item.maxAtk}] ${atkPct}%`);
    lines.push(`Crit:   +${item.criticalChance} [${item.minCrit}-${item.maxCrit}] ${critPct}%`);
    lines.push(`Decision: SELL`);
    lines.push(`Reason: Crit below theoretical maximum (+${item.maxCrit})`);
  }

  return lines.join("\n");
}
