/**
 * WarEra Tools - Build & Damage Analyzer Service
 * 
 * Exposes build and damage optimization, respec analysis,
 * skill investment ROI, and leaderboard benchmarks.
 * STRICT SAFETY: 100% read-only, reuses existing analyzer algorithms.
 */

import { analyzeMyBuild, analyzeLevel, compareBuilds } from "../../analyzer/optimizer.mjs";
import { fetchMe, fetchGameConfig } from "../../analyzer/api.mjs";
import { getAllCachedPlayers } from "../../analyzer/collector.mjs";

export class AnalyzerService {
  /**
   * Run full build analysis for current authenticated player or specified level.
   */
  async runAnalysis(options = {}) {
    const {
      target = "me", // 'me' or 'level'
      level = null,
      objective = "damage", // 'damage', 'weekly'
      gear = "average",
      bread = null,
      hours = null,
      telemetryContext = "current",
    } = options;

    if (target === "level" && level) {
      const result = await analyzeLevel(level, {
        objective,
        gear,
        bread,
        hours,
        telemetryContext,
      });
      return {
        mode: "level",
        level,
        objective,
        data: result,
      };
    }

    // Default: Analyze current player's build
    const result = await analyzeMyBuild({
      objective,
      gear,
      bread,
      hours,
      telemetryContext,
    });

    return {
      mode: "me",
      objective,
      player: {
        username: result.me?.user?.username || "You",
        level: result.level,
        score: result.score || 0,
        expectedDamage: result.theoreticalEval?.currentDamage || 0,
        optimalDamage: result.theoreticalEval?.optimalDamage || 0,
        efficiencyPercent: result.theoreticalEval?.efficiencyPct || 0,
      },
      skills: result.me?.user?.skills || {},
      stats: result.statComparison || [],
      respec: {
        combatSkills: result.theoreticalEval?.respecDiff || [],
        nonCombatSkills: result.theoreticalEval?.wastedPoints || [],
      },
      roiRankings: result.theoreticalEval?.nextUpgrades || [],
      equipmentComparison: Array.isArray(result.equipComparison)
        ? result.equipComparison
        : Object.values(result.equipComparison || {}),
      benchmarkGaps: result.statComparison || [],
    };
  }
}

export const analyzerService = new AnalyzerService();
