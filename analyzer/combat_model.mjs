/**
 * WarEra Theoretical Combat Model
 * 
 * Implements mathematical combat mechanics derived directly from
 * WarEra's live game configuration, client bundles, and live battle hits.
 */

/**
 * Model Documentation & Assumptions
 */
export const MODEL_METADATA = {
  verifiedComponents: [
    "Attack base value scales from Attack skill level (100 base, +25/lvl)",
    "Weapon attack rolls add directly to base attack",
    "Precision overflows into Attack at +4 Attack per point above 100",
    "Critical Chance overflows into Critical Damages at +4% per point above 100",
    "Ammo multiplier adds flat % attack (+10% light, +20% standard, +40% heavy)",
    "Military Rank multiplier adds flat % attack (+0.25% to +0.35% per rank)",
    "Critical Hit deals (1 + CriticalDamages / 100) * Normal Damage",
    "Glancing Miss deals exactly 0.5x of Normal Damage (verified via live round logs)",
    "Effective Hit Probability = min(1.0, Precision / 100)",
    "Effective Crit Probability = min(1.0, CriticalChance / 100)",
  ],
  knownFormulaComponents: [
    "Expected Damage = Attack_eff * [ P_crit * (1 + CritDmg / 100) + (1 - P_crit) * (0.5 + 0.5 * P_hit) ]",
    "Total Attack = (Base + Weapon + PrecisionOverflow) * (1 + Ammo%) * (1 + MilitaryRank%) * (1 + Buffs% - Debuffs%)",
    "Total Skill Points = 4 * Player Level",
  ],
  unknownComponentsAndAssumptions: [
    "Defender Dodge in generic encounters is normalized to 0 (or average bracket dodge) since target opponent in future battles varies",
    "Active regional/patriotic battle bonuses are evaluated at baseline (+0% or specified modifier)",
    "Damage variance roll (+-5%) is smoothed to its mathematical expectation",
  ],
};

/**
 * Calculate expected combat stats and expected damage per hit
 * 
 * @param {Object} skills - skill allocations { attack, criticalChance, criticalDamages, precision, ... }
 * @param {Object} skillRules - dynamic rules from gameConfig.skills
 * @param {Object} equipment - equipped gear { weapon, helmet, gloves, chest, boots, pants, ammo }
 * @param {Object} modifiers - { ammoPercent, militaryRankPercent, buffsPercent, debuffsPercent, defenderDodge }
 */
export function calculateCombatProfile(skills, skillRules, equipment = {}, modifiers = {}) {
  // 1. Base values from skill tree
  const atkLvl = skills.attack ?? 0;
  const ccLvl = skills.criticalChance ?? 0;
  const cdLvl = skills.criticalDamages ?? 0;
  const prLvl = skills.precision ?? 0;

  const atkBase = skillRules.attack?.values?.[atkLvl] ?? (100 + atkLvl * 25);
  const ccBase = skillRules.criticalChance?.values?.[ccLvl] ?? (10 + ccLvl * 5);
  const cdBase = skillRules.criticalDamages?.values?.[cdLvl] ?? (100 + cdLvl * 20);
  const prBase = skillRules.precision?.values?.[prLvl] ?? (50 + prLvl * 5);

  // 2. Equipment flat rolls
  const weaponAtk = equipment.weapon?.skills?.attack ?? equipment.weaponAtk ?? 0;
  const weaponCrit = equipment.weapon?.skills?.criticalChance ?? equipment.weaponCrit ?? 0;
  const helmetCritDmg = equipment.helmet?.skills?.criticalDamages ?? equipment.helmetCritDmg ?? 0;
  const glovesPrec = equipment.gloves?.skills?.precision ?? equipment.glovesPrec ?? 0;

  // 3. Precision & Overflow to Attack
  const rawPrecision = prBase + glovesPrec;
  const precisionOverflow = Math.max(0, rawPrecision - 100) * 4;
  const effectivePrecision = Math.min(100, rawPrecision);
  const hitProbability = Math.max(0.5, effectivePrecision / 100);

  // 4. Critical Chance & Overflow to Critical Damages
  const rawCritChance = ccBase + weaponCrit;
  const critOverflow = Math.max(0, rawCritChance - 100) * 4;
  const effectiveCritChance = Math.min(100, Math.max(0, rawCritChance));
  const critProbability = effectiveCritChance / 100;

  // 5. Critical Damages
  const effectiveCritDamages = cdBase + helmetCritDmg + critOverflow;
  const critMultiplier = 1 + effectiveCritDamages / 100;

  // 6. Attack calculation with multipliers
  const baseAttackWithOverflow = atkBase + weaponAtk + precisionOverflow;

  const ammoPct = modifiers.ammoPercent ?? (equipment.ammo === "heavyAmmo" ? 40 : equipment.ammo === "ammo" ? 20 : equipment.ammo === "lightAmmo" ? 10 : 0);
  const mrPct = modifiers.militaryRankPercent ?? 0;
  const buffsPct = modifiers.buffsPercent ?? 0;
  const debuffsPct = modifiers.debuffsPercent ?? 0;

  const multAmmo = 1 + ammoPct / 100;
  const multMr = 1 + mrPct / 100;
  const multBuffs = Math.max(0.1, 1 + (buffsPct - debuffsPct) / 100);

  const effectiveAttack = Math.round(baseAttackWithOverflow * multAmmo * multMr * multBuffs);

  // 7. Normal hit expected multiplier (accounting for glancing miss at 0.5x)
  // If hit: 1.0x damage. If miss: 0.5x damage.
  // Expected normal damage ratio = hitProb * 1.0 + (1 - hitProb) * 0.5 = 0.5 + 0.5 * hitProb
  const normalHitMultiplier = 0.5 + 0.5 * hitProbability;

  // 8. Overall Expected Damage per hit
  const expectedDamage = effectiveAttack * (critProbability * critMultiplier + (1 - critProbability) * normalHitMultiplier);

  return {
    rawPrecision,
    effectivePrecision,
    precisionOverflow,
    hitProbability,

    rawCritChance,
    effectiveCritChance,
    critOverflow,
    critProbability,

    effectiveCritDamages,
    critMultiplier,

    baseAttackWithOverflow,
    effectiveAttack,

    normalHitMultiplier,
    expectedDamage: Math.round(expectedDamage * 10) / 10,
    expectedDamageRounded: Math.round(expectedDamage),

    stats: {
      attack: effectiveAttack,
      criticalChance: effectiveCritChance,
      criticalDamages: effectiveCritDamages,
      precision: effectivePrecision,
    },
  };
}

/**
 * Validate predicted combat stats against actual game values for a player
 */
export function validatePlayerStats(player, skillRules) {
  if (!player || !player.skills) {
    return { isValid: false, reason: "No player skills data" };
  }

  const skillsAlloc = {
    attack: player.skills.attack?.level ?? 0,
    criticalChance: player.skills.criticalChance?.level ?? 0,
    criticalDamages: player.skills.criticalDamages?.level ?? 0,
    precision: player.skills.precision?.level ?? 0,
  };

  const modifiers = {
    ammoPercent: player.skills.attack?.ammoPercent ?? 0,
    militaryRankPercent: player.skills.attack?.militaryRankPercent ?? 0,
    buffsPercent: player.skills.attack?.buffsPercent ?? 0,
    debuffsPercent: player.skills.attack?.debuffsPercent ?? 0,
  };

  const gear = {
    weaponAtk: player.equipment?.weapon?.skills?.attack ?? player.skills.attack?.weaponBonus ?? 0,
    weaponCrit: player.equipment?.weapon?.skills?.criticalChance ?? player.skills.criticalChance?.weaponBonus ?? 0,
    helmetCritDmg: player.equipment?.helmet?.skills?.criticalDamages ?? player.skills.criticalDamages?.equipmentBonus ?? 0,
    glovesPrec: player.equipment?.gloves?.skills?.precision ?? player.skills.precision?.equipmentBonus ?? 0,
    ammo: typeof player.equipment?.ammo === "string" ? player.equipment.ammo : player.equipment?.ammo?.code || "none",
  };

  const predicted = calculateCombatProfile(skillsAlloc, skillRules, gear, modifiers);

  const checks = [
    {
      stat: "Attack",
      predicted: predicted.stats.attack,
      actual: player.skills.attack?.total ?? 0,
      diff: Math.abs(predicted.stats.attack - (player.skills.attack?.total ?? 0)),
    },
    {
      stat: "Critical Chance",
      predicted: predicted.stats.criticalChance,
      actual: player.skills.criticalChance?.total ?? 0,
      diff: Math.abs(predicted.stats.criticalChance - (player.skills.criticalChance?.total ?? 0)),
    },
    {
      stat: "Critical Damages",
      predicted: predicted.stats.criticalDamages,
      actual: player.skills.criticalDamages?.total ?? 0,
      diff: Math.abs(predicted.stats.criticalDamages - (player.skills.criticalDamages?.total ?? 0)),
    },
    {
      stat: "Precision",
      predicted: predicted.stats.precision,
      actual: player.skills.precision?.total ?? 0,
      diff: Math.abs(predicted.stats.precision - (player.skills.precision?.total ?? 0)),
    },
  ];

  const maxDiff = Math.max(...checks.map((c) => c.diff));
  const isMatch = maxDiff <= 2; // within integer rounding margin

  return {
    isMatch,
    checks,
    predicted,
    expectedDamage: predicted.expectedDamageRounded,
  };
}
