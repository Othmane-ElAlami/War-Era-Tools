/**
 * Skill analysis, dynamic tree parsing, and allocation optimizer
 */

import { median, mean, percentile, spearmanCorrelation, correlationEvidence } from "./statistics.mjs";

/**
 * Dynamically extract skill rules from live gameConfig
 */
export function parseSkillRules(gameConfig) {
  const rawSkills = gameConfig?.skills || {};
  const rules = {};

  for (const [skillName, cfg] of Object.entries(rawSkills)) {
    const levelsObj = cfg.levels || {};
    const levelNums = Object.keys(levelsObj).map(Number).sort((a, b) => a - b);
    const maxLevel = levelNums.length > 0 ? levelNums[levelNums.length - 1] : 10;

    const costs = {};
    const totalCosts = {};
    const values = {};
    const unlocks = {};

    let unlockAtLevel = cfg.unlockAtLevel || 1;

    for (const lvl of levelNums) {
      const entry = levelsObj[String(lvl)] || {};
      costs[lvl] = entry.cost ?? lvl;
      totalCosts[lvl] = entry.totalCost ?? (lvl * (lvl + 1)) / 2;
      values[lvl] = entry.value ?? 0;
      unlocks[lvl] = entry.unlockAtLevel ?? unlockAtLevel;
      if (entry.unlockAtLevel && lvl === 1) {
        unlockAtLevel = entry.unlockAtLevel;
      }
    }

    // Check linearity of stat values
    let isLinear = true;
    if (levelNums.length >= 3) {
      const step1 = (values[1] ?? 0) - (values[0] ?? 0);
      for (let i = 2; i < levelNums.length; i++) {
        const step = (values[i] ?? 0) - (values[i - 1] ?? 0);
        if (Math.abs(step - step1) > 0.001) {
          isLinear = false;
          break;
        }
      }
    }

    rules[skillName] = {
      name: skillName,
      maxLevel,
      unlockAtLevel,
      unlocks,
      costs,
      totalCosts,
      values,
      isLinear,
      softCap: cfg.softCap || null,
      skillOverflow: cfg.skillOverflow || null,
      skillOverflowValue: cfg.skillOverflowValue || null,
    };
  }

  return rules;
}

/**
 * Total skill points budget for a given player level (4 points per level)
 */
export function maxPointsForLevel(level) {
  return Math.max(0, level * 4);
}

/**
 * Calculate total points spent for a given skill allocation
 */
export function calculateSpentPoints(allocation, skillRules) {
  let spent = 0;
  for (const [skillName, lvl] of Object.entries(allocation)) {
    if (!lvl || lvl <= 0) continue;
    const rule = skillRules[skillName];
    if (rule?.totalCosts?.[lvl] !== undefined) {
      spent += rule.totalCosts[lvl];
    } else {
      // Fallback: standard cumulative sum
      spent += (lvl * (lvl + 1)) / 2;
    }
  }
  return spent;
}

/**
 * Cost to upgrade a specific skill by 1 level
 */
export function nextPointCost(skillName, currentLevel, skillRules) {
  const targetLevel = currentLevel + 1;
  const rule = skillRules[skillName];
  if (rule?.costs?.[targetLevel] !== undefined) {
    return rule.costs[targetLevel];
  }
  return targetLevel;
}

/**
 * Analyze skill allocations across a player sample
 */
export function analyzeSkills(players, targetLevel, skillRules) {
  if (!players || players.length === 0) {
    return {
      skillStats: {},
      recommendedBuild: {},
      priorityOrder: [],
      nextPoints: [],
      evidence: {},
    };
  }

  const damages = players.map((p) => p.weeklyDamage);
  const totalBudget = maxPointsForLevel(targetLevel);
  const skillNames = Object.keys(skillRules);

  const skillStats = {};
  const scores = [];

  for (const name of skillNames) {
    const rule = skillRules[name];
    if (!rule) continue;

    // Check if skill is unlocked at this level
    const isUnlocked = targetLevel >= rule.unlockAtLevel;

    const playerLevels = players.map((p) => p.skills?.[name]?.level ?? 0);
    const playerTotals = players.map((p) => p.skills?.[name]?.total ?? 0);

    const medLvl = Math.round(median(playerLevels) * 10) / 10;
    const meanLvl = Math.round(mean(playerLevels) * 10) / 10;
    const p75Lvl = Math.round(percentile(playerLevels, 75) * 10) / 10;
    const maxObserved = Math.max(...playerLevels);

    // Adoption: percentage of players with points invested
    const usersWithPoints = playerLevels.filter((lvl) => lvl > 0).length;
    const adoptionPct = Math.round((usersWithPoints / players.length) * 100);

    // Correlation with weekly damage
    const correlation = spearmanCorrelation(playerLevels, damages);
    const correlationTot = spearmanCorrelation(playerTotals, damages);

    // High performer prevalence (top 25% of sample)
    const topQuartileSize = Math.max(1, Math.floor(players.length * 0.25));
    const topPerformers = players.slice(0, topQuartileSize);
    const topLevels = topPerformers.map((p) => p.skills?.[name]?.level ?? 0);
    const topMedian = median(topLevels);
    const topAdoptionPct = Math.round(
      (topLevels.filter((l) => l > 0).length / topPerformers.length) * 100
    );

    // Empirical priority score: combines adoption, correlation, and top-performer median
    // Rewards skills that high rankers invest in and correlate positively with damage
    const corrFactor = Math.max(0, correlation + 0.5); // shift into positive territory
    const priorityScore = isUnlocked
      ? (topMedian * 2 + medLvl) * (topAdoptionPct / 100) * corrFactor
      : 0;

    const statInfo = {
      name,
      isUnlocked,
      unlockAtLevel: rule.unlockAtLevel,
      medianLevel: medLvl,
      meanLevel: meanLvl,
      p75Level: p75Lvl,
      maxObserved,
      adoptionPct,
      topMedian,
      topAdoptionPct,
      correlation,
      statCorrelation: correlationTot,
      evidence: correlationEvidence(correlation),
      priorityScore: Math.round(priorityScore * 100) / 100,
    };

    skillStats[name] = statInfo;
    if (isUnlocked) {
      scores.push(statInfo);
    }
  }

  // Sort skills by empirical priority
  scores.sort((a, b) => b.priorityScore - a.priorityScore);
  const priorityOrder = scores.map((s) => s.name);

  // Construct optimal skill allocation within strict totalBudget
  // Strategy: greedy allocation following priority order and top performer targets
  const recommendedBuild = {};
  for (const name of skillNames) {
    recommendedBuild[name] = 0;
  }

  let remainingBudget = totalBudget;
  let changed = true;

  // We loop incrementing skill levels by 1 point step according to highest marginal benefit
  while (changed && remainingBudget > 0) {
    changed = false;
    let bestCandidate = null;
    let bestEfficiency = -1;

    for (const stat of scores) {
      const name = stat.name;
      const current = recommendedBuild[name];
      const rule = skillRules[name];
      if (current >= rule.maxLevel) continue;

      // Ensure level unlock condition is met
      const nextLvl = current + 1;
      const unlockReq = rule.unlocks?.[nextLvl] ?? rule.unlockAtLevel;
      if (targetLevel < unlockReq) continue;

      const cost = nextPointCost(name, current, skillRules);
      if (cost <= remainingBudget) {
        // Marginal value: priorityScore divided by cost
        // Bonus if we haven't reached top performer median yet
        const targetBenchmark = Math.max(stat.topMedian, stat.medianLevel);
        const benchmarkMultiplier = current < targetBenchmark ? 1.5 : 0.8;
        const efficiency = (stat.priorityScore / cost) * benchmarkMultiplier;

        if (efficiency > bestEfficiency) {
          bestEfficiency = efficiency;
          bestCandidate = name;
        }
      }
    }

    if (bestCandidate && bestEfficiency > 0) {
      const cost = nextPointCost(bestCandidate, recommendedBuild[bestCandidate], skillRules);
      recommendedBuild[bestCandidate] += 1;
      remainingBudget -= cost;
      changed = true;
    }
  }

  // Calculate next recommended points for progression
  const nextPoints = [];
  const simBuild = { ...recommendedBuild };
  let simRemaining = 10; // look ahead up to next 10 points
  while (nextPoints.length < 3 && simRemaining > 0) {
    let bestNext = null;
    let bestEff = -1;
    for (const stat of scores) {
      const name = stat.name;
      const current = simBuild[name];
      const rule = skillRules[name];
      if (current >= rule.maxLevel) continue;
      const nextLvl = current + 1;
      const unlockReq = rule.unlocks?.[nextLvl] ?? rule.unlockAtLevel;
      if (targetLevel < unlockReq) continue;

      const cost = nextPointCost(name, current, skillRules);
      const efficiency = stat.priorityScore / cost;
      if (efficiency > bestEff) {
        bestEff = efficiency;
        bestNext = { name, targetLevel: nextLvl, cost };
      }
    }
    if (bestNext) {
      nextPoints.push(bestNext);
      simBuild[bestNext.name] += 1;
      simRemaining -= bestNext.cost;
    } else {
      break;
    }
  }

  return {
    skillStats,
    recommendedBuild,
    priorityOrder,
    nextPoints,
    totalBudget,
    spentBudget: totalBudget - remainingBudget,
  };
}
