/**
 * WarEra Tools - Battles Service
 * 
 * Manages battle scanning, order inspection, lexicographical ranking,
 * and live/dry-run battle hit execution.
 * Reuses existing battle logic from battles.mjs and analyzer/battle_windows.mjs.
 */

import { EventEmitter } from "events";
import { scanLiveBattlesTelemetry } from "../../analyzer/battle_windows.mjs";
import { fetchMe } from "../../analyzer/api.mjs";
import {
  VERIFIED_HIT,
  FAILED_HIT,
  UNKNOWN_HIT,
  rankBattles,
  resolveOrderedBattleAction,
  inspectBattleOrdersAndSides,
  executeSingleBattleHit,
  getBattleHitHealthCost,
  pollFreshResourcesAfterHit,
} from "../../battles.mjs";
import { recordExecutionTelemetry } from "../../analyzer/battle_telemetry.mjs";
import { connect, disconnectBrowser } from "../../browser.mjs";

class BattlesService extends EventEmitter {
  constructor() {
    super();
    this.isExecuting = false;
    this.cachedScan = null;
    this.lastScanTime = null;
  }

  /**
   * Scan all active battles and evaluate orders, consensus, and eligibility.
   * STRICT SAFETY: 100% read-only.
   */
  async scanBattles(contextOverride = null) {
    let countryId = contextOverride?.countryId;
    let muId = contextOverride?.muId;

    if (!countryId || !muId) {
      try {
        const me = await fetchMe();
        if (!countryId) countryId = me.user?.country;
        if (!muId) muId = me.user?.mu;
      } catch {}
    }

    const context = {
      countryId: countryId || null,
      muId: muId || null,
    };

    const telemetryScan = await scanLiveBattlesTelemetry(context);
    this.cachedScan = telemetryScan;
    this.lastScanTime = new Date().toISOString();

    // Map each battle into structured UI presentation
    const battles = (telemetryScan.activeBattles || []).map((b) => {
      return {
        battleId: b.battleId,
        roundId: b.roundId,
        regionName: b.regionName,
        battleType: b.battleType,
        isPlayerCountryWar: Boolean(b.isPlayerCountryWar),
        countryOrderPresent: Boolean(b.countryOrderPresent),
        countryOrderSide: b.countryOrderSide,
        muOrderPresent: Boolean(b.muOrderPresent),
        muOrderSide: b.muOrderSide,
        ordersAgree: Boolean(b.ordersAgree),
        resolvedSide: b.resolvedSide,
        damageBonusPercent: b.damageBonusPercent || 0,
        bountyRate: b.bountyRate || 0,
        remainingTimeHours: b.remainingTimeHours,
        selectorEligible: Boolean(b.selectorEligible),
        selectorSkipReason: b.selectorSkipReason || "",
        selectorRank: b.selectorRank,
        selectedTarget: Boolean(b.selectedTarget),
      };
    });

    return {
      timestamp: this.lastScanTime,
      totalActive: telemetryScan.totalActiveBattles || battles.length,
      qualifyingCount: telemetryScan.qualifyingBattlesCount || 0,
      selectedBattleId: telemetryScan.selectedBattleId || null,
      context,
      battles,
    };
  }

  /**
   * Execute Battle Mode (Live or Dry Run).
   * In dry run mode: simulates battle hits without any browser combat clicks or mutations.
   * In live mode: requires explicit confirmed=true flag.
   */
  async executeBattleMode(options = {}) {
    if (this.isExecuting) {
      throw new Error("Battle execution is already in progress.");
    }

    const {
      dryRun = true,
      confirmed = false,
      maxHits = 10,
      hpFloor = 10,
    } = options;

    if (!dryRun && !confirmed) {
      throw new Error("Live battle execution requires explicit confirmation.");
    }

    this.isExecuting = true;
    this.emit("status", { state: "starting", dryRun });

    const results = {
      dryRun,
      targetBattleId: null,
      targetRegion: null,
      hitsPlanned: 0,
      hitsExecuted: 0,
      totalDamage: 0,
      lootGained: [],
      records: [],
      stopReason: null,
    };

    try {
      // 1. Refresh battle state to get top target
      const scan = await this.scanBattles();
      const topTarget = scan.battles.find((b) => b.selectedTarget) || scan.battles.find((b) => b.selectorEligible);

      if (!topTarget) {
        results.stopReason = "NO_QUALIFYING_BATTLE";
        this.emit("status", { state: "stopped", reason: results.stopReason });
        return results;
      }

      results.targetBattleId = topTarget.battleId;
      results.targetRegion = topTarget.regionName;

      // 2. Fetch current user health
      let currentHealth = 100;
      try {
        const me = await fetchMe();
        currentHealth = me.user?.skills?.health?.currentBarValue || 100;
      } catch {}

      const hitCost = 10;
      const availableHp = Math.max(0, currentHealth - hpFloor);
      const possibleHits = Math.min(maxHits, Math.floor(availableHp / hitCost));
      results.hitsPlanned = possibleHits;

      if (possibleHits <= 0) {
        results.stopReason = "INSUFFICIENT_HEALTH";
        this.emit("status", { state: "stopped", reason: results.stopReason });
        return results;
      }

      // 3. Execution loop
      if (dryRun) {
        // DRY RUN: Simulates hits with mathematical precision
        let simulatedHealth = currentHealth;
        for (let i = 0; i < possibleHits; i++) {
          simulatedHealth -= hitCost;
          const hitDamage = Math.round(200 + Math.random() * 50);
          results.totalDamage += hitDamage;
          results.hitsExecuted++;

          const record = {
            hitIndex: i + 1,
            battleId: topTarget.battleId,
            verificationState: VERIFIED_HIT,
            healthBefore: Number((simulatedHealth + hitCost).toFixed(1)),
            healthAfter: Number(simulatedHealth.toFixed(1)),
            damageDealt: hitDamage,
            loot: [],
            isDryRun: true,
          };
          results.records.push(record);
          this.emit("hit", record);
        }
        results.stopReason = "SIMULATION_COMPLETE";
      } else {
        // LIVE EXECUTION: Browser-driven combat with authoritative verification
        const { browser, ctx, page } = await connect({ headless: true });
        try {
          let consecutiveFailures = 0;
          for (let i = 0; i < possibleHits; i++) {
            const hitResult = await executeSingleBattleHit(page, topTarget, { dryRun: false });
            results.records.push(hitResult);
            this.emit("hit", hitResult);

            if (hitResult.verificationState === VERIFIED_HIT) {
              results.hitsExecuted++;
              results.totalDamage += (hitResult.damageDealt || 0);
              consecutiveFailures = 0;
            } else if (hitResult.verificationState === UNKNOWN_HIT) {
              results.stopReason = "UNKNOWN_HIT_HALT";
              break;
            } else {
              consecutiveFailures++;
              if (consecutiveFailures >= 2) {
                results.stopReason = "MAX_CONSECUTIVE_FAILURES";
                break;
              }
            }
          }
        } finally {
          await disconnectBrowser(browser);
        }
      }

      return results;
    } finally {
      this.isExecuting = false;
      this.emit("status", { state: "idle" });
    }
  }
}

export const battlesService = new BattlesService();
