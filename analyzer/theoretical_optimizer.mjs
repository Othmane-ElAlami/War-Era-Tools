/**
 * WarEra Theoretical Skill & Damage Optimizer
 * 
 * Determines the mathematically optimal skill allocation for any player level
 * using exact enumeration over legal game states.
 * 
 * Supports:
 * - per-hit: Mathematical expected damage per single attack.
 * - sustained: Mathematical expected damage over configurable play horizons (hours/days).
 * - weekly: Mathematical expected damage over 7 days (168 hours).
 */

import { calculateCombatProfile } from "./combat_model.mjs";
import { maxPointsForLevel, parseSkillRules } from "./skills.mjs";
import { percentile, median } from "./statistics.mjs";
import { calculateSustainProfile, simulateSustainedCombat } from "./sustain_model.mjs";

/**
 * Generate standardized equipment profiles
 */
export function getStandardizedEquipment(profileType = "average", targetLevel = 40, samplePlayers = [], myEquipment = null) {
  if (profileType === "none") {
    return {
      weaponAtk: 0,
      weaponCrit: 0,
      helmetCritDmg: 0,
      glovesPrec: 0,
      ammo: "none",
      ammoPercent: 0,
      militaryRankPercent: Math.min(32, Math.round(targetLevel * 0.65 * 10) / 10),
    };
  }

  if (profileType === "my" && myEquipment) {
    const ammoCode = typeof myEquipment.ammo === "string" ? myEquipment.ammo : myEquipment.ammo?.code || "none";
    const ammoPct = ammoCode === "heavyAmmo" ? 40 : ammoCode === "ammo" ? 20 : ammoCode === "lightAmmo" ? 10 : 0;
    return {
      weaponAtk: myEquipment.weapon?.skills?.attack ?? 0,
      weaponCrit: myEquipment.weapon?.skills?.criticalChance ?? 0,
      helmetCritDmg: myEquipment.helmet?.skills?.criticalDamages ?? 0,
      glovesPrec: myEquipment.gloves?.skills?.precision ?? 0,
      ammo: ammoCode,
      ammoPercent: ammoPct,
      militaryRankPercent: Math.min(32, Math.round(targetLevel * 0.65 * 10) / 10),
    };
  }

  // Extract from sample players if available
  const weaponAtks = samplePlayers.map((p) => p.equipment?.weapon?.skills?.attack).filter((n) => typeof n === "number");
  const weaponCrits = samplePlayers.map((p) => p.equipment?.weapon?.skills?.criticalChance).filter((n) => typeof n === "number");
  const helmetCrits = samplePlayers.map((p) => p.equipment?.helmet?.skills?.criticalDamages).filter((n) => typeof n === "number");
  const glovesPrecs = samplePlayers.map((p) => p.equipment?.gloves?.skills?.precision).filter((n) => typeof n === "number");

  const useBest = profileType === "best";
  const statFn = useBest ? (arr, def) => (arr.length > 0 ? Math.round(percentile(arr, 90)) : def) : (arr, def) => (arr.length > 0 ? Math.round(median(arr)) : def);

  // Fallback defaults based on level tier if sample is small
  const defaultWeaponAtk = targetLevel >= 45 ? 130 : targetLevel >= 35 ? 115 : targetLevel >= 25 ? 70 : 35;
  const defaultWeaponCrit = targetLevel >= 45 ? 20 : targetLevel >= 35 ? 18 : targetLevel >= 25 ? 12 : 5;
  const defaultHelmetCrit = targetLevel >= 45 ? 95 : targetLevel >= 35 ? 80 : targetLevel >= 25 ? 40 : 20;
  const defaultGlovesPrec = targetLevel >= 35 ? 24 : targetLevel >= 25 ? 12 : 6;

  return {
    weaponAtk: statFn(weaponAtks, defaultWeaponAtk),
    weaponCrit: statFn(weaponCrits, defaultWeaponCrit),
    helmetCritDmg: statFn(helmetCrits, defaultHelmetCrit),
    glovesPrec: statFn(glovesPrecs, defaultGlovesPrec),
    ammo: "lightAmmo",
    ammoPercent: 10,
    militaryRankPercent: Math.min(32, Math.round(targetLevel * 0.65 * 10) / 10),
  };
}

/**
 * Pure combat skill enumeration (Damage Per Hit)
 * 
 * @param {number} targetLevel - player level
 * @param {number} budget - skill points available for combat
 * @param {Object} equipment - standardized or custom equipment profile
 * @param {Object} skillRules - parsed rules from gameConfig.skills
 */
function optimizePureCombatSkills(targetLevel, budget, equipment, skillRules) {
  const maxCc = targetLevel >= (skillRules?.criticalChance?.unlockAtLevel ?? 5) ? 10 : 0;
  const maxCd = targetLevel >= (skillRules?.criticalDamages?.unlockAtLevel ?? 10) ? 10 : 0;
  const maxAtk = targetLevel >= (skillRules?.attack?.unlockAtLevel ?? 1) ? 10 : 0;
  const maxPr = targetLevel >= (skillRules?.precision?.unlockAtLevel ?? 1) ? 10 : 0;

  const costAtk = skillRules?.attack?.totalCosts || {};
  const costCc = skillRules?.criticalChance?.totalCosts || {};
  const costCd = skillRules?.criticalDamages?.totalCosts || {};
  const costPr = skillRules?.precision?.totalCosts || {};

  let bestExpectedDamage = -1;
  let bestAllocation = { attack: 0, criticalChance: 0, criticalDamages: 0, precision: 0 };
  let bestProfile = null;
  let bestSpent = 0;
  let totalEvaluated = 0;

  for (let atk = 0; atk <= maxAtk; atk++) {
    const cAtk = costAtk[atk] ?? (atk * (atk + 1)) / 2;
    if (cAtk > budget) continue;

    for (let cc = 0; cc <= maxCc; cc++) {
      const cCc = costCc[cc] ?? (cc * (cc + 1)) / 2;
      if (cAtk + cCc > budget) continue;

      for (let cd = 0; cd <= maxCd; cd++) {
        const cCd = costCd[cd] ?? (cd * (cd + 1)) / 2;
        if (cAtk + cCc + cCd > budget) continue;

        for (let pr = 0; pr <= maxPr; pr++) {
          const cPr = costPr[pr] ?? (pr * (pr + 1)) / 2;
          const totalSpent = cAtk + cCc + cCd + cPr;
          if (totalSpent > budget) continue;

          totalEvaluated++;

          const profile = calculateCombatProfile(
            { attack: atk, criticalChance: cc, criticalDamages: cd, precision: pr },
            skillRules,
            equipment,
            equipment
          );

          if (profile.expectedDamage > bestExpectedDamage) {
            bestExpectedDamage = profile.expectedDamage;
            bestAllocation = { attack: atk, criticalChance: cc, criticalDamages: cd, precision: pr };
            bestProfile = profile;
            bestSpent = totalSpent;
          }
        }
      }
    }
  }

  return {
    bestAllocation,
    bestProfile,
    bestSpent,
    bestExpectedDamage,
    totalEvaluated,
  };
}

/**
 * Perform exact enumeration to find the mathematically optimal skill allocation
 * 
 * @param {number} targetLevel - player level
 * @param {number} budget - available skill points (default 4 * targetLevel)
 * @param {Object} equipment - standardized or custom equipment profile
 * @param {Object} skillRules - parsed rules from gameConfig.skills
 * @param {string} objective - 'per-hit' | 'sustained' | 'weekly' | 'damage'
 * @param {Object} sustainOptions - options passed to calculateSustainProfile (hours, days, bread, activity)
 */
export function optimizeTheoreticalSkills(
  targetLevel,
  budget = null,
  equipment = {},
  skillRules = null,
  objective = "damage",
  sustainOptions = {}
) {
  if (budget === null) {
    budget = maxPointsForLevel(targetLevel);
  }

  const isSustainedObjective = objective === "sustained" || objective === "weekly";

  // 1. If objective is pure per-hit damage:
  if (!isSustainedObjective) {
    const res = optimizePureCombatSkills(targetLevel, budget, equipment, skillRules);
    const sustainProfile = simulateSustainedCombat(0, 0, { ...sustainOptions, objective });
    const hits = sustainProfile.totalHits;
    const totalDmg = Math.round(res.bestExpectedDamage * hits);

    return {
      targetLevel,
      budget,
      spentBudget: res.bestSpent,
      remainingBudget: budget - res.bestSpent,
      totalEvaluated: res.totalEvaluated,
      bestAllocation: {
        ...res.bestAllocation,
        health: 0,
        hunger: 0,
      },
      expectedDamage: res.bestProfile ? res.bestProfile.expectedDamageRounded : 0,
      expectedDamageExact: res.bestProfile ? res.bestProfile.expectedDamage : 0,
      combatProfile: res.bestProfile,
      totalHits: hits,
      expectedTotalDamage: totalDmg,
      sustainProfile,
      objective: "per-hit",
      equipmentUsed: equipment,
    };
  }

  // 2. Sustained / Weekly Objective:
  // Optimize joint allocation across Sustain (Health, Hunger) and Combat (Attack, Crit, CritDmg, Precision)
  const maxH = targetLevel >= (skillRules?.health?.unlockAtLevel ?? 5) ? 10 : 0;
  const maxU = targetLevel >= (skillRules?.hunger?.unlockAtLevel ?? 10) ? 10 : 0;

  const costH = skillRules?.health?.totalCosts || {};
  const costU = skillRules?.hunger?.totalCosts || {};

  let bestTotalDamage = -1;
  let bestAllocation = null;
  let bestCombatProfile = null;
  let bestSustainProfile = null;
  let bestSpent = 0;
  let totalEvaluated = 0;

  for (let h = 0; h <= maxH; h++) {
    const cH = costH[h] ?? (h * (h + 1)) / 2;
    if (cH > budget) continue;

    for (let u = 0; u <= maxU; u++) {
      const cU = costU[u] ?? (u * (u + 1)) / 2;
      const sustainCost = cH + cU;
      if (sustainCost > budget) continue;

      const combatBudget = budget - sustainCost;
      const combatOpt = optimizePureCombatSkills(targetLevel, combatBudget, equipment, skillRules);
      totalEvaluated += combatOpt.totalEvaluated;

      const effectiveObj = sustainOptions.objective || objective;
      const sustainProfile = simulateSustainedCombat(h, u, { ...sustainOptions, objective: effectiveObj });
      const hits = sustainProfile.actualPossibleHits ?? sustainProfile.totalHits;
      const totalDmg = combatOpt.bestExpectedDamage * hits;

      if (totalDmg > bestTotalDamage) {
        bestTotalDamage = totalDmg;
        bestAllocation = {
          ...combatOpt.bestAllocation,
          health: h,
          hunger: u,
        };
        bestCombatProfile = combatOpt.bestProfile;
        bestSustainProfile = sustainProfile;
        bestSpent = sustainCost + combatOpt.bestSpent;
      }
    }
  }

  return {
    targetLevel,
    budget,
    spentBudget: bestSpent,
    remainingBudget: budget - bestSpent,
    totalEvaluated,
    bestAllocation: bestAllocation || { attack: 0, criticalChance: 0, criticalDamages: 0, precision: 0, health: 0, hunger: 0 },
    expectedDamage: bestCombatProfile ? bestCombatProfile.expectedDamageRounded : 0,
    expectedDamageExact: bestCombatProfile ? bestCombatProfile.expectedDamage : 0,
    combatProfile: bestCombatProfile,
    totalHits: bestSustainProfile ? bestSustainProfile.totalHits : 0,
    expectedTotalDamage: Math.round(bestTotalDamage),
    expectedTotalDamageExact: bestTotalDamage,
    sustainProfile: bestSustainProfile,
    objective,
    equipmentUsed: equipment,
  };
}

/**
 * Calculate marginal ROI for spending the next points from a given allocation (Per-Hit)
 */
export function calculateMarginalROI(currentAllocation, equipment, skillRules, targetLevel) {
  const currentSkills = {
    attack: currentAllocation.attack ?? 0,
    criticalChance: currentAllocation.criticalChance ?? 0,
    criticalDamages: currentAllocation.criticalDamages ?? 0,
    precision: currentAllocation.precision ?? 0,
  };

  const baseProfile = calculateCombatProfile(currentSkills, skillRules, equipment, equipment);
  const baseDamage = Math.max(1, baseProfile.expectedDamage);

  const combatSkills = ["attack", "criticalChance", "criticalDamages", "precision"];
  const candidateUpgrades = [];

  for (const skillName of combatSkills) {
    const currentLvl = currentSkills[skillName] ?? 0;
    const rule = skillRules[skillName];
    const maxLvl = rule?.maxLevel ?? 10;
    const unlockReq = rule?.unlocks?.[currentLvl + 1] ?? rule?.unlockAtLevel ?? 1;

    if (currentLvl >= maxLvl || targetLevel < unlockReq) continue;

    const nextLvl = currentLvl + 1;
    const pointCost = rule?.costs?.[nextLvl] ?? nextLvl;

    const simSkills = { ...currentSkills, [skillName]: nextLvl };
    const simProfile = calculateCombatProfile(simSkills, skillRules, equipment, equipment);
    const simDamage = simProfile.expectedDamage;

    const absoluteGain = Math.round((simDamage - baseDamage) * 10) / 10;
    const percentGain = Math.round(((simDamage - baseDamage) / baseDamage) * 1000) / 10;
    const roi = Math.round((percentGain / pointCost) * 100) / 100;

    candidateUpgrades.push({
      skillName,
      category: "combat",
      currentLevel: currentLvl,
      nextLevel: nextLvl,
      pointCost,
      absoluteGain,
      percentGain,
      roi,
      newExpectedDamage: simProfile.expectedDamageRounded,
    });
  }

  // Sort by ROI descending
  candidateUpgrades.sort((a, b) => b.roi - a.roi);
  return candidateUpgrades;
}

/**
 * Calculate marginal ROI for spending the next points in SUSTAINED combat
 * Ranks both combat skills (higher damage/hit) and sustain skills (more hits) by Total Damage ROI.
 */
export function calculateSustainedMarginalROI(currentAllocation, equipment, skillRules, targetLevel, sustainOptions = {}) {
  const combatSkills = {
    attack: currentAllocation.attack ?? 0,
    criticalChance: currentAllocation.criticalChance ?? 0,
    criticalDamages: currentAllocation.criticalDamages ?? 0,
    precision: currentAllocation.precision ?? 0,
  };
  const healthLvl = currentAllocation.health ?? 0;
  const hungerLvl = currentAllocation.hunger ?? 0;

  const baseCombat = calculateCombatProfile(combatSkills, skillRules, equipment, equipment);
  const baseSustain = simulateSustainedCombat(healthLvl, hungerLvl, sustainOptions);
  const baseTotalDamage = Math.max(1, baseCombat.expectedDamage * baseSustain.totalHits);

  const candidateUpgrades = [];

  // 1. Test Combat Skills upgrades (+dmg/hit, same hits)
  for (const s of ["attack", "criticalChance", "criticalDamages", "precision"]) {
    const curLvl = combatSkills[s] ?? 0;
    const rule = skillRules[s];
    const maxLvl = rule?.maxLevel ?? 10;
    const unlockReq = rule?.unlocks?.[curLvl + 1] ?? rule?.unlockAtLevel ?? 1;
    if (curLvl >= maxLvl || targetLevel < unlockReq) continue;

    const nextLvl = curLvl + 1;
    const pointCost = rule?.costs?.[nextLvl] ?? nextLvl;
    const simCombatSkills = { ...combatSkills, [s]: nextLvl };
    const simCombat = calculateCombatProfile(simCombatSkills, skillRules, equipment, equipment);
    const simTotalDmg = simCombat.expectedDamage * baseSustain.totalHits;

    const absGain = Math.round(simTotalDmg - baseTotalDamage);
    const pctGain = Math.round(((simTotalDmg - baseTotalDamage) / baseTotalDamage) * 1000) / 10;
    const roi = Math.round((pctGain / pointCost) * 100) / 100;

    candidateUpgrades.push({
      skillName: s,
      category: "combat",
      currentLevel: curLvl,
      nextLevel: nextLvl,
      pointCost,
      absoluteGain: absGain,
      percentGain: pctGain,
      roi,
      perHitGain: Math.round((simCombat.expectedDamage - baseCombat.expectedDamage) * 10) / 10,
      hitGain: 0,
      newTotalDamage: Math.round(simTotalDmg),
    });
  }

  // 2. Test Sustain Skills upgrades (same dmg/hit, +hits)
  // Health
  const ruleH = skillRules.health;
  if (healthLvl < (ruleH?.maxLevel ?? 10) && targetLevel >= (ruleH?.unlockAtLevel ?? 5)) {
    const nextH = healthLvl + 1;
    const costH = ruleH?.costs?.[nextH] ?? nextH;
    const simSustain = simulateSustainedCombat(nextH, hungerLvl, sustainOptions);
    const simTotalDmg = baseCombat.expectedDamage * simSustain.totalHits;

    const absGain = Math.round(simTotalDmg - baseTotalDamage);
    const pctGain = Math.round(((simTotalDmg - baseTotalDamage) / baseTotalDamage) * 1000) / 10;
    const roi = Math.round((pctGain / costH) * 100) / 100;

    candidateUpgrades.push({
      skillName: "health",
      category: "sustain",
      currentLevel: healthLvl,
      nextLevel: nextH,
      pointCost: costH,
      absoluteGain: absGain,
      percentGain: pctGain,
      roi,
      perHitGain: 0,
      hitGain: simSustain.totalHits - baseSustain.totalHits,
      newTotalDamage: Math.round(simTotalDmg),
    });
  }

  // Hunger
  const ruleU = skillRules.hunger;
  if (hungerLvl < (ruleU?.maxLevel ?? 10) && targetLevel >= (ruleU?.unlockAtLevel ?? 10)) {
    const nextU = hungerLvl + 1;
    const costU = ruleU?.costs?.[nextU] ?? nextU;
    const simSustain = simulateSustainedCombat(healthLvl, nextU, sustainOptions);
    const simTotalDmg = baseCombat.expectedDamage * simSustain.totalHits;

    const absGain = Math.round(simTotalDmg - baseTotalDamage);
    const pctGain = Math.round(((simTotalDmg - baseTotalDamage) / baseTotalDamage) * 1000) / 10;
    const roi = Math.round((pctGain / costU) * 100) / 100;

    candidateUpgrades.push({
      skillName: "hunger",
      category: "sustain",
      currentLevel: hungerLvl,
      nextLevel: nextU,
      pointCost: costU,
      absoluteGain: absGain,
      percentGain: pctGain,
      roi,
      perHitGain: 0,
      hitGain: simSustain.totalHits - baseSustain.totalHits,
      newTotalDamage: Math.round(simTotalDmg),
    });
  }

  // Sort by Total Damage ROI descending
  candidateUpgrades.sort((a, b) => b.roi - a.roi);
  return candidateUpgrades;
}

/**
 * 3-Way Build Comparison:
 * PER-HIT OPTIMUM vs. SUSTAINED OPTIMUM vs. LEADERBOARD META
 * 
 * Evaluates all 3 builds under identical equipment and sustain conditions.
 */
export function compareThreeWay(
  perHitBuild,
  sustainedBuild,
  empiricalBuild,
  targetLevel,
  equipment = {},
  skillRules = null,
  sustainOptions = {}
) {
  // 1. Profile for Per-Hit Optimum
  const perHitCombat = perHitBuild.combatProfile;
  const perHitDmgPerHit = perHitBuild.expectedDamageExact;
  const perHitSustain = simulateSustainedCombat(0, 0, sustainOptions);
  const perHitHits = perHitSustain.actualPossibleHits ?? perHitSustain.totalHits;
  const perHitTotalDmg = Math.round(perHitDmgPerHit * perHitHits);

  // 2. Profile for Sustained Optimum
  const susCombat = sustainedBuild.combatProfile;
  const susDmgPerHit = sustainedBuild.expectedDamageExact;
  const susSustain = sustainedBuild.sustainProfile;
  const susHits = susSustain.actualPossibleHits ?? susSustain.totalHits;
  const susTotalDmg = sustainedBuild.expectedTotalDamage;

  // 3. Profile for Leaderboard Meta
  const empCombatSkills = {
    attack: Math.round(Number(empiricalBuild?.attack ?? 0)),
    criticalChance: Math.round(Number(empiricalBuild?.criticalChance ?? 0)),
    criticalDamages: Math.round(Number(empiricalBuild?.criticalDamages ?? 0)),
    precision: Math.round(Number(empiricalBuild?.precision ?? 0)),
  };
  const empCombat = calculateCombatProfile(empCombatSkills, skillRules, equipment, equipment);
  const empDmgPerHit = empCombat.expectedDamage;
  const empHealthLvl = Math.round(Number(empiricalBuild?.health ?? 0));
  const empHungerLvl = Math.round(Number(empiricalBuild?.hunger ?? 0));
  const empSustain = simulateSustainedCombat(empHealthLvl, empHungerLvl, sustainOptions);
  const empHits = empSustain.actualPossibleHits ?? empSustain.totalHits;
  const empTotalDmg = Math.round(empDmgPerHit * empHits);

  // Table of all skill distributions
  const allSkillKeys = ["attack", "criticalChance", "criticalDamages", "precision", "health", "hunger", "energy"];
  const skillComparison = [];
  let sumDiffSusVsMeta = 0;
  let totalSusPts = 0;
  let totalMetaPts = 0;

  for (const s of allSkillKeys) {
    const pVal = perHitBuild.bestAllocation?.[s] ?? 0;
    const sVal = sustainedBuild.bestAllocation?.[s] ?? 0;
    const mVal = Math.round(Number(empiricalBuild?.[s] ?? 0));

    totalSusPts += sVal;
    totalMetaPts += mVal;
    sumDiffSusVsMeta += Math.abs(sVal - mVal);

    skillComparison.push({
      skillName: s,
      perHit: pVal,
      sustained: sVal,
      meta: mVal,
      deltaSusVsMeta: sVal - mVal,
      deltaSusVsPerHit: sVal - pVal,
    });
  }

  const totalPoints = totalSusPts + totalMetaPts;
  const agreementPct = totalPoints > 0 ? Math.max(0, Math.round((1 - sumDiffSusVsMeta / totalPoints) * 100)) : 100;

  // Relative damage comparisons
  const sustainedVsPerHitPct = Math.round(((susTotalDmg - perHitTotalDmg) / perHitTotalDmg) * 1000) / 10;
  const sustainedVsMetaPct = empTotalDmg > 0 ? Math.round(((susTotalDmg - empTotalDmg) / empTotalDmg) * 1000) / 10 : 0;

  // Analytical observations
  const observations = [];
  
  if (sustainedVsPerHitPct > 0) {
    observations.push(
      `Sustained Optimum outperforms Per-Hit Optimum by +${sustainedVsPerHitPct}% total damage over ${susSustain.durationHours}h (+${susHits - perHitHits} extra attacks).`
    );
  }

  if (agreementPct >= 75) {
    observations.push(
      `Leaderboard Meta strongly reflects sustained damage optimization (${agreementPct}% agreement). Top players have empirically discovered that Health (${empHealthLvl}) and Hunger (${empHungerLvl}) generate high attack volume.`
    );
  } else {
    observations.push(
      `Leaderboard Meta diverts points from pure combat throughput (${agreementPct}% agreement) into non-combat utility or defensive margins.`
    );
  }

  const metaEnergy = Math.round(Number(empiricalBuild?.energy ?? 0));
  if (metaEnergy > 0) {
    observations.push(
      `Top players invest ~${metaEnergy} pts into Energy for economy/work/training. While useless for battle throughput (combat costs 0 Energy), it fuels the player's broader account economy.`
    );
  }

  const precDiff = (empiricalBuild?.precision ?? 0) - (sustainedBuild.bestAllocation?.precision ?? 0);
  if (precDiff >= 2) {
    observations.push(
      `Leaderboard players favor +${precDiff} extra Precision over the mathematical optimum to guarantee 100% hit rate against varied defensive stats or suboptimal gear.`
    );
  }

  // Compare Unlimited battle availability vs Realistic battle availability
  let availabilityComparison = null;
  if (susSustain.isRealisticSim) {
    const unlSustain = calculateSustainProfile(
      sustainedBuild.bestAllocation?.health || 0,
      sustainedBuild.bestAllocation?.hunger || 0,
      { ...sustainOptions, battleAvailability: "unlimited" }
    );
    const unlTotalDmg = Math.round(susDmgPerHit * unlSustain.totalHits);
    availabilityComparison = {
      schedule: susSustain.schedule,
      unlimitedHits: unlSustain.totalHits,
      unlimitedTotalDamage: unlTotalDmg,
      realisticHits: susHits,
      realisticTotalDamage: susTotalDmg,
      battleWindowLossHits: susSustain.battleWindowLoss,
      hpWastedAtCap: susSustain.hpRegenWastedAtCap,
      damageLostToWindows: Math.max(0, unlTotalDmg - susTotalDmg),
    };

    observations.push(
      `Under ${susSustain.schedule.label}, ${susSustain.hpRegenWastedAtCap} HP regen is wasted while capped at Max Health during lulls, losing ${susSustain.battleWindowLoss} hits (-${Math.round((availabilityComparison.damageLostToWindows / Math.max(1, unlTotalDmg)) * 1000) / 10}% damage vs 24/7 unlimited availability).`
    );
  }

  // Multi-scenario availability projections for assumption modeling & insufficient telemetry
  const scenarioProjections = [
    { scenario: "25% Availability (Conservative)", pct: "25%" },
    { scenario: "50% Availability (Moderate)", pct: "50%" },
    { scenario: "75% Availability (High Activity)", pct: "75%" },
    { scenario: "Unlimited (Ideal 24/7 Combat)", pct: "unlimited" },
  ].map(sc => {
    const sim = simulateSustainedCombat(
      sustainedBuild.bestAllocation?.health || 0,
      sustainedBuild.bestAllocation?.hunger || 0,
      { ...sustainOptions, battleAvailability: sc.pct }
    );
    const hits = sim.actualPossibleHits ?? sim.totalHits;
    return {
      scenario: sc.scenario,
      pct: sc.pct,
      hits,
      totalDamage: Math.round(susDmgPerHit * hits),
      hpWastedAtCap: sim.hpRegenWastedAtCap,
    };
  });

  return {
    agreementPct,
    sustainedVsPerHitPct,
    sustainedVsMetaPct,
    skillComparison,
    availabilityComparison,
    scenarioProjections,
    summary: {
      perHit: {
        name: "Per-Hit Optimum",
        dmgPerHit: perHitBuild.expectedDamage,
        resourceHits: perHitSustain.resourceLimitedHits ?? perHitHits,
        battleWindowCapacity: perHitSustain.battleWindowCapacity ?? perHitHits,
        totalHits: perHitHits,
        totalDamage: perHitTotalDmg,
        breads: perHitSustain.breadsConsumed,
        wastedHealth: perHitSustain.hpRegenWastedAtCap || perHitSustain.healthWasted,
        windowLoss: perHitSustain.battleWindowLoss || 0,
        efficiency: perHitSustain.resourceEfficiencyPercent,
      },
      sustained: {
        name: "Sustained Optimum",
        dmgPerHit: sustainedBuild.expectedDamage,
        resourceHits: susSustain.resourceLimitedHits ?? susHits,
        battleWindowCapacity: susSustain.battleWindowCapacity ?? susHits,
        totalHits: susHits,
        totalDamage: susTotalDmg,
        breads: susSustain.breadsConsumed,
        wastedHealth: susSustain.hpRegenWastedAtCap || susSustain.healthWasted,
        windowLoss: susSustain.battleWindowLoss || 0,
        efficiency: susSustain.resourceEfficiencyPercent,
      },
      meta: {
        name: "Leaderboard Meta",
        dmgPerHit: empCombat.expectedDamageRounded,
        resourceHits: empSustain.resourceLimitedHits ?? empHits,
        battleWindowCapacity: empSustain.battleWindowCapacity ?? empHits,
        totalHits: empHits,
        totalDamage: empTotalDmg,
        breads: empSustain.breadsConsumed,
        wastedHealth: empSustain.hpRegenWastedAtCap || empSustain.healthWasted,
        windowLoss: empSustain.battleWindowLoss || 0,
        efficiency: empSustain.resourceEfficiencyPercent,
      },
    },
    observations,
  };
}

/**
 * Compare Theoretical Optimum vs Empirical Leaderboard Build (legacy 2-way wrapper)
 */
export function compareTheoryVsLeaderboard(theoreticalBuild, empiricalBuild, targetLevel) {
  const combatSkills = ["attack", "criticalChance", "criticalDamages", "precision"];
  const allSkills = new Set([...combatSkills, ...Object.keys(empiricalBuild || {})]);

  const comparison = [];
  let totalTheoryPoints = 0;
  let totalEmpiricalPoints = 0;
  let sumAbsDiff = 0;

  for (const s of allSkills) {
    const tVal = theoreticalBuild[s] ?? 0;
    const eVal = Math.round(Number(empiricalBuild[s] ?? 0));
    const diff = tVal - eVal;

    totalTheoryPoints += tVal;
    totalEmpiricalPoints += eVal;
    sumAbsDiff += Math.abs(diff);

    comparison.push({
      skillName: s,
      theory: tVal,
      empirical: eVal,
      diff,
      isCombatCore: combatSkills.includes(s),
    });
  }

  comparison.sort((a, b) => {
    if (a.isCombatCore !== b.isCombatCore) return a.isCombatCore ? -1 : 1;
    return Math.abs(b.diff) - Math.abs(a.diff);
  });

  const totalPoints = totalTheoryPoints + totalEmpiricalPoints;
  const agreementPct = totalPoints > 0 ? Math.max(0, Math.round((1 - sumAbsDiff / totalPoints) * 100)) : 100;

  const observations = [];
  const sustainPoints = (empiricalBuild.health || 0) + (empiricalBuild.hunger || 0) + (empiricalBuild.energy || 0);
  if (sustainPoints >= 5) {
    observations.push(
      `Leaderboard players invest ${sustainPoints} skill levels into sustain (Health/Hunger/Energy) to enable more combat hits per week, whereas pure Theory concentrates 100% of points into per-hit damage.`
    );
  }

  return {
    agreementPct,
    comparison,
    observations,
  };
}

/**
 * Evaluate my build using the theoretical & sustained model
 */
export function evaluateMyBuildTheoretical(myUnified, gameConfig, samplePlayers = [], options = {}) {
  const skillRules = parseSkillRules(gameConfig);
  const myLevel = myUnified.leveling?.level || myUnified.level || 40;
  const objective = options.objective || "damage";
  const isSustained = objective === "sustained" || objective === "weekly";

  const mySkills = {
    attack: myUnified.skills?.attack?.level ?? 0,
    criticalChance: myUnified.skills?.criticalChance?.level ?? 0,
    criticalDamages: myUnified.skills?.criticalDamages?.level ?? 0,
    precision: myUnified.skills?.precision?.level ?? 0,
    health: myUnified.skills?.health?.level ?? 0,
    hunger: myUnified.skills?.hunger?.level ?? 0,
  };

  // 1. My current expected damage with my actual gear
  const myGear = getStandardizedEquipment("my", myLevel, samplePlayers, myUnified.equipment);
  const myProfile = calculateCombatProfile(mySkills, skillRules, myGear, myGear);
  const mySustain = simulateSustainedCombat(mySkills.health, mySkills.hunger, { ...options, objective });
  const myTotalDamage = Math.round(myProfile.expectedDamage * mySustain.totalHits);

  // 2. Theoretical optimum for my level with my SAME gear
  const theoretical = optimizeTheoreticalSkills(myLevel, null, myGear, skillRules, objective, options);

  // 3. Efficiency %
  let currentMetric = myProfile.expectedDamage;
  let optimalMetric = theoretical.expectedDamageExact;
  if (isSustained) {
    currentMetric = myTotalDamage;
    optimalMetric = theoretical.expectedTotalDamageExact || theoretical.expectedTotalDamage;
  }
  const efficiencyPct = Math.min(100, Math.round((currentMetric / Math.max(1, optimalMetric)) * 1000) / 10);

  // 4. Marginal ROI for next point upgrades
  const nextUpgrades = isSustained
    ? calculateSustainedMarginalROI(mySkills, myGear, skillRules, myLevel, options)
    : calculateMarginalROI(mySkills, myGear, skillRules, myLevel);

  // 5. Identify wasted/suboptimal allocations in non-combat skills
  const wastedPoints = [];
  const nonCombatSkills = ["companies", "entrepreneurship", "production", "management", "energy", "lootChance"];
  for (const s of nonCombatSkills) {
    const lvl = myUnified.skills?.[s]?.level ?? 0;
    if (lvl > 0) {
      const cost = skillRules[s]?.totalCosts?.[lvl] ?? (lvl * (lvl + 1)) / 2;
      wastedPoints.push({
        skillName: s,
        level: lvl,
        spentPoints: cost,
        alternative: isSustained ? "Could be redirected to Attack/Crit or Health/Hunger for weekly combat damage" : "Could be redirected to Attack/Crit for per-hit damage",
      });
    }
  }

  // 6. Respec recommendation: diff between mySkills and theoretical.bestAllocation
  const respecDiff = [];
  for (const [s, optLvl] of Object.entries(theoretical.bestAllocation)) {
    const myLvl = mySkills[s] ?? 0;
    if (optLvl !== myLvl) {
      respecDiff.push({
        skillName: s,
        current: myLvl,
        target: optLvl,
        delta: optLvl - myLvl,
      });
    }
  }

  return {
    level: myLevel,
    objective,
    currentDamage: myProfile.expectedDamageRounded,
    optimalDamage: theoretical.expectedDamage,
    currentTotalDamage: myTotalDamage,
    optimalTotalDamage: theoretical.expectedTotalDamage,
    currentHits: mySustain.totalHits,
    optimalHits: theoretical.totalHits,
    efficiencyPct,
    myProfile,
    mySustain,
    theoretical,
    nextUpgrades,
    wastedPoints,
    respecDiff,
  };
}
