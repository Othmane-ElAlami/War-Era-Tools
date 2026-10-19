/**
 * Core optimization engine for WarEra builds and skills
 */

import { fetchMe } from "./api.mjs";
import { getGameConfig, getAllCachedPlayers, collectTopPlayers, buildUnifiedPlayerRecord } from "./collector.mjs";
import { parseSkillRules, analyzeSkills, maxPointsForLevel } from "./skills.mjs";
import { parseEquipmentCatalog, analyzeEquipment } from "./equipment.mjs";
import { median, percentile, detectOutliers } from "./statistics.mjs";
import {
  getStandardizedEquipment,
  optimizeTheoreticalSkills,
  calculateMarginalROI,
  calculateSustainedMarginalROI,
  compareTheoryVsLeaderboard,
  compareThreeWay,
  evaluateMyBuildTheoretical,
} from "./theoretical_optimizer.mjs";
import { validatePlayerStats, MODEL_METADATA } from "./combat_model.mjs";
import { scanLiveQualifyingBattles } from "./battle_windows.mjs";
import { loadTelemetrySamplesSync, calculateObservedAvailability, resolveTelemetryContext } from "./battle_telemetry.mjs";

/**
 * Determine confidence rating from sample size and level spread
 */
function getConfidenceRating(exactCount, totalCount, isExpanded) {
  if (!isExpanded) {
    if (exactCount >= 10) return "HIGH";
    if (exactCount >= 5) return "MODERATE";
    return "LOW";
  }
  if (totalCount >= 15) return "MODERATE";
  return "LOW";
}

/**
 * Filter players by target level with adaptive expansion if necessary
 */
export function groupPlayersByLevel(allPlayers, targetLevel, minTargetSample = 8) {
  const exact = allPlayers.filter((p) => p.level === targetLevel);
  if (exact.length >= minTargetSample) {
    return {
      sample: exact,
      exactCount: exact.length,
      isExpanded: false,
      bracket: [targetLevel, targetLevel],
      confidence: "HIGH",
    };
  }

  // Expand ± 1
  const span1 = allPlayers.filter(
    (p) => p.level >= targetLevel - 1 && p.level <= targetLevel + 1
  );
  if (span1.length >= minTargetSample || targetLevel <= 2) {
    return {
      sample: span1,
      exactCount: exact.length,
      isExpanded: true,
      bracket: [Math.max(1, targetLevel - 1), targetLevel + 1],
      confidence: getConfidenceRating(exact.length, span1.length, true),
    };
  }

  // Expand ± 2
  const span2 = allPlayers.filter(
    (p) => p.level >= targetLevel - 2 && p.level <= targetLevel + 2
  );
  return {
    sample: span2.length > 0 ? span2 : exact,
    exactCount: exact.length,
    isExpanded: true,
    bracket: [Math.max(1, targetLevel - 2), targetLevel + 2],
    confidence: "LOW",
  };
}

/**
 * Analyze a specific player level
 */
export async function analyzeLevel(targetLevel, allPlayers = null, gameConfig = null, options = {}) {
  if (!gameConfig) {
    gameConfig = await getGameConfig();
  }
  if (!allPlayers || allPlayers.length === 0) {
    allPlayers = getAllCachedPlayers();
    if (allPlayers.length < 50) {
      allPlayers = await collectTopPlayers(200);
    }
  }

  const skillRules = parseSkillRules(gameConfig);
  const equipCatalog = parseEquipmentCatalog(gameConfig);

  // Group by level
  const { sample, exactCount, isExpanded, bracket, confidence } = groupPlayersByLevel(
    allPlayers,
    targetLevel
  );

  if (!sample || sample.length === 0) {
    return {
      level: targetLevel,
      sampleSize: 0,
      exactCount: 0,
      confidence: "NONE",
      error: `No players found for level ${targetLevel} or adjacent brackets. Try collecting more ranking players.`,
    };
  }

  // Outlier detection for weekly damage
  const { normal, outliers } = detectOutliers(sample, (p) => p.weeklyDamage, 2.0);
  const medianDmgAll = Math.round(median(sample.map((p) => p.weeklyDamage)));
  const medianDmgNormal = Math.round(median(normal.map((p) => p.weeklyDamage)));

  // Perform Skill Analysis
  const skillAnalysis = analyzeSkills(sample, targetLevel, skillRules);

  // Perform Equipment Analysis
  const equipAnalysis = analyzeEquipment(sample, gameConfig);

  // Calculate Combat Stat Benchmarks (median and top decile)
  const combatStatKeys = [
    "attack",
    "criticalChance",
    "criticalDamages",
    "armor",
    "precision",
    "dodge",
    "health",
  ];
  const statBenchmarks = {};
  for (const k of combatStatKeys) {
    const vals = sample.map((p) => p.skills?.[k]?.total ?? 0);
    statBenchmarks[k] = {
      median: Math.round(median(vals)),
      p90: Math.round(percentile(vals, 90)),
      max: Math.max(...vals),
    };
  }

  // Representative top players
  const sortedSample = [...sample].sort((a, b) => (b.weeklyDamage || 0) - (a.weeklyDamage || 0));
  const representativeTopPlayers = sortedSample.slice(0, 5).map((p) => ({
    name: p.name,
    level: p.level,
    rank: p.rank,
    weeklyDamage: p.weeklyDamage,
    weapon: p.equipment?.weapon?.code || "none",
    ammo: p.equipment?.ammo?.code || "none",
    keySkills: {
      attack: p.skills?.attack?.level ?? 0,
      crit: p.skills?.criticalChance?.level ?? 0,
      critDmg: p.skills?.criticalDamages?.level ?? 0,
      precision: p.skills?.precision?.level ?? 0,
    },
  }));

  // Identify Archetype
  let archetype = "Balanced Combatant";
  const attackStat = statBenchmarks.attack?.median || 0;
  const critStat = statBenchmarks.criticalChance?.median || 0;
  const armorStat = statBenchmarks.armor?.median || 0;
  if (critStat >= 40 && attackStat >= 300) {
    archetype = "High-Crit Damage Dealer";
  } else if (attackStat > 500) {
    archetype = "Heavy Pure Attack";
  } else if (armorStat >= 50) {
    archetype = "Armored Frontliner";
  }

  // Theoretical Optimization
  const gearProfile = options?.gearProfile || "average";
  const objective = options?.objective || "damage";
  const isSustainedObjective = objective === "sustained" || objective === "weekly";
  const standardGear = getStandardizedEquipment(gearProfile, targetLevel, sample);

  // Load telemetry metrics if needed
  const context = options?.context || (options?.countryId || options?.muId ? { countryId: options.countryId, muId: options.muId } : null);
  const telemetrySamples = options?.telemetrySamples || loadTelemetrySamplesSync({ context });
  const telemetryMetrics = options?.telemetryMetrics || calculateObservedAvailability(telemetrySamples, { context });
  const enrichedOptions = {
    ...options,
    context,
    telemetrySamples,
    telemetryMetrics,
  };

  // 1. Pure Per-Hit Theoretical Optimization
  const perHitTheoretical = optimizeTheoreticalSkills(
    targetLevel,
    null,
    standardGear,
    skillRules,
    "per-hit",
    enrichedOptions
  );

  // 2. Sustained Theoretical Optimization (Resource-constrained)
  const sustainedObjective = (objective === "weekly" || options?.objective === "weekly") ? "weekly" : "sustained";
  const sustainedTheoretical = optimizeTheoreticalSkills(
    targetLevel,
    null,
    standardGear,
    skillRules,
    sustainedObjective,
    enrichedOptions
  );

  // Active theoretical based on requested objective
  const theoretical = isSustainedObjective ? sustainedTheoretical : perHitTheoretical;

  // 3. 3-Way Comparison: Per-Hit Optimum vs. Sustained Optimum vs. Leaderboard Meta
  const empiricalAllocation = skillAnalysis.recommendedBuild || {};
  const threeWayComparison = compareThreeWay(
    perHitTheoretical,
    sustainedTheoretical,
    empiricalAllocation,
    targetLevel,
    standardGear,
    skillRules,
    enrichedOptions
  );

  // Legacy 2-way comparison for backwards compatibility
  const theoryVsLeaderboard = compareTheoryVsLeaderboard(
    theoretical.bestAllocation,
    empiricalAllocation,
    targetLevel
  );

  // Marginal ROI for next point upgrades from theoretical build
  const marginalROI = isSustainedObjective
    ? calculateSustainedMarginalROI(
        theoretical.bestAllocation,
        standardGear,
        skillRules,
        targetLevel,
        options
      )
    : calculateMarginalROI(
        theoretical.bestAllocation,
        standardGear,
        skillRules,
        targetLevel
      );

  return {
    level: targetLevel,
    sampleSize: sample.length,
    exactCount,
    isExpanded,
    bracket,
    confidence,
    archetype,
    outliersCount: outliers.length,
    damageBenchmarks: {
      median: medianDmgAll,
      medianFiltered: medianDmgNormal,
      p90: Math.round(percentile(sample.map((p) => p.weeklyDamage), 90)),
    },
    statBenchmarks,
    skillAnalysis,
    equipAnalysis,
    representativeTopPlayers,
    theoretical,
    perHitTheoretical,
    sustainedTheoretical,
    threeWayComparison,
    theoryVsLeaderboard,
    marginalROI,
  };
}

/**
 * Scan and analyze a range of levels
 */
export async function analyzeRange(minLevel, maxLevel, allPlayers = null, gameConfig = null) {
  if (!gameConfig) gameConfig = await getGameConfig();
  if (!allPlayers) allPlayers = getAllCachedPlayers();

  const results = [];
  for (let lvl = minLevel; lvl <= maxLevel; lvl++) {
    const analysis = await analyzeLevel(lvl, allPlayers, gameConfig);
    results.push(analysis);
  }
  return results;
}

/**
 * Dynamically fetch the current player's profile and compare against their level's benchmark
 */
export async function analyzeMyBuild(options = {}) {
  const gameConfig = await getGameConfig();
  const skillRules = parseSkillRules(gameConfig);

  // Fetch me from session
  const meData = await fetchMe();
  const myUnified = buildUnifiedPlayerRecord(
    { user: meData.user._id, value: 0, rank: null },
    meData.user,
    meData.equipment
  );

  const myLevel = myUnified.level;

  // Resolve player country & MU context
  const myCountry = myUnified.citizenship || myUnified.country || meData.user.citizenship || meData.user.country;
  const myMu = myUnified.militaryUnit || myUnified.mu || meData.user.militaryUnit || meData.user.mu;

  // Scan live qualifying battles where country and MU orders agree
  let liveBattleData = null;
  try {
    liveBattleData = await scanLiveQualifyingBattles(myCountry, myMu);
  } catch {
    // Non-fatal if offline
  }

  const context = options.context || (options.telemetryContext ? resolveTelemetryContext(options.telemetryContext, { countryId: myCountry, muId: myMu }) : { countryId: myCountry, muId: myMu });
  const telemetrySamples = options.telemetrySamples || loadTelemetrySamplesSync({ context });
  const telemetryMetrics = options.telemetryMetrics || calculateObservedAvailability(telemetrySamples, { context });

  const enrichedOptions = {
    ...options,
    context,
    liveBattleData,
    countryId: myCountry,
    muId: myMu,
    telemetrySamples,
    telemetryMetrics,
  };

  // Make sure we have a player sample
  let allPlayers = getAllCachedPlayers();
  if (allPlayers.length < 50) {
    allPlayers = await collectTopPlayers(200);
  }

  // Analyze optimal build for my level
  const optimal = await analyzeLevel(myLevel, allPlayers, gameConfig, enrichedOptions);

  // Compare skills
  const skillComparison = [];
  let matchingSkillPoints = 0;
  let totalComparedPoints = 0;

  for (const [skillName, optimalLvl] of Object.entries(optimal.skillAnalysis?.recommendedBuild || {})) {
    const myLvl = myUnified.skills?.[skillName]?.level ?? 0;
    const diff = optimalLvl - myLvl;
    const rule = skillRules[skillName];
    const isUnlocked = myLevel >= (rule?.unlockAtLevel ?? 1);

    if (isUnlocked && (optimalLvl > 0 || myLvl > 0)) {
      skillComparison.push({
        name: skillName,
        mine: myLvl,
        optimal: optimalLvl,
        diff,
        priority: optimal.skillAnalysis.skillStats[skillName]?.priorityScore || 0,
      });

      totalComparedPoints += optimalLvl;
      matchingSkillPoints += Math.min(myLvl, optimalLvl);
    }
  }

  skillComparison.sort((a, b) => b.priority - a.priority);

  // Compare stats
  const statComparison = [];
  for (const [statName, bench] of Object.entries(optimal.statBenchmarks || {})) {
    const myVal = myUnified.skills?.[statName]?.total ?? 0;
    const med = bench.median;
    const ratio = med > 0 ? myVal / med : 1;
    statComparison.push({
      name: statName,
      mine: myVal,
      topMedian: med,
      p90: bench.p90,
      ratio: Math.round(ratio * 100) / 100,
    });
  }

  // Compare equipment
  const equipComparison = {};
  for (const slot of ["weapon", "ammo", "helmet", "chest", "boots", "gloves", "pants"]) {
    const myItem = myUnified.equipment?.[slot];
    const myCode = typeof myItem === "string" ? myItem : myItem?.code || "none";
    const recItem = optimal.equipAnalysis?.slotAnalysis?.[slot]?.recommendedItem || "none";
    const slotStats = optimal.equipAnalysis?.slotAnalysis?.[slot]?.stats || {};
    equipComparison[slot] = {
      slot,
      mine: myCode,
      recommended: recItem,
      myStats: typeof myItem === "object" ? myItem?.skills || {} : {},
      targetStats: slotStats,
      matches: myCode !== "none" && myCode === recItem,
    };
  }

  // Calculate Optimization Score (0 - 100)
  // 50% based on skill alignment, 30% based on combat stats vs median, 20% on equipment match
  const skillRatio = totalComparedPoints > 0 ? matchingSkillPoints / totalComparedPoints : 1;
  const statRatios = statComparison.map((s) => Math.min(1.2, s.mine / Math.max(1, s.topMedian)));
  const avgStatRatio = statRatios.reduce((a, b) => a + b, 0) / Math.max(1, statRatios.length);

  let equipMatches = 0;
  for (const eq of Object.values(equipComparison)) {
    if (eq.matches) equipMatches++;
  }
  const equipRatio = equipMatches / 7;

  const score = Math.min(
    100,
    Math.round(skillRatio * 45 + Math.min(1, avgStatRatio) * 35 + equipRatio * 20)
  );

  // Formulate biggest improvements
  const improvements = [];
  const skillDeficits = skillComparison.filter((s) => s.diff > 0);
  if (skillDeficits.length > 0) {
    const topDeficit = skillDeficits[0];
    improvements.push(
      `Raise ${topDeficit.name} from level ${topDeficit.mine} to ${topDeficit.optimal} (Top priority)`
    );
  }

  if (equipComparison.weapon && !equipComparison.weapon.matches) {
    improvements.push(
      `Upgrade weapon from ${equipComparison.weapon.mine} to ${equipComparison.weapon.recommended}`
    );
  }

  if (!myUnified.equipment?.ammo) {
    const recommendedAmmo = optimal.equipAnalysis?.ammoAnalysis?.distribution?.find((d) => d.code !== "none")?.code || "lightAmmo";
    improvements.push(
      `Equip ammunition (e.g. ${recommendedAmmo}) for +10-40% attack`
    );
  }

  // Theoretical Evaluation & Validation
  const theoreticalEval = evaluateMyBuildTheoretical(myUnified, gameConfig, allPlayers, enrichedOptions);
  const validation = validatePlayerStats(myUnified, skillRules);

  return {
    me: myUnified,
    level: myLevel,
    optimal,
    score,
    improvements,
    skillComparison,
    statComparison,
    equipComparison,
    theoreticalEval,
    validation,
    liveBattleData,
    telemetryMetrics,
    modelMetadata: MODEL_METADATA,
  };
}

/**
 * Compare two player builds side by side
 */
export function compareBuilds(playerA, playerB) {
  const skills = {};
  const allSkillNames = new Set([
    ...Object.keys(playerA.skills || {}),
    ...Object.keys(playerB.skills || {}),
  ]);

  for (const name of allSkillNames) {
    const a = playerA.skills?.[name] || { level: 0, total: 0 };
    const b = playerB.skills?.[name] || { level: 0, total: 0 };
    skills[name] = {
      levelA: a.level,
      levelB: b.level,
      totalA: a.total,
      totalB: b.total,
    };
  }

  const equipment = {};
  const slots = ["weapon", "ammo", "helmet", "chest", "boots", "gloves", "pants"];
  for (const s of slots) {
    const itemA = playerA.equipment?.[s];
    const itemB = playerB.equipment?.[s];
    const codeA = typeof itemA === "string" ? itemA : itemA?.code || "none";
    const codeB = typeof itemB === "string" ? itemB : itemB?.code || "none";
    equipment[s] = {
      slot: s,
      itemA: codeA,
      itemB: codeB,
      statsA: typeof itemA === "object" ? itemA?.skills || {} : {},
      statsB: typeof itemB === "object" ? itemB?.skills || {} : {},
    };
  }

  return {
    playerA: { name: playerA.name, level: playerA.level, weeklyDamage: playerA.weeklyDamage },
    playerB: { name: playerB.name, level: playerB.level, weeklyDamage: playerB.weeklyDamage },
    damageDiff: (playerA.weeklyDamage || 0) - (playerB.weeklyDamage || 0),
    skills,
    equipment,
  };
}
