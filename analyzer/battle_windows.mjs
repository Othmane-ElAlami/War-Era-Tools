/**
 * WarEra Battle Availability & Window Modeling Engine
 * 
 * Inspects live WarEra battles, evaluates Country and MU order consensus,
 * measures round/battle timings, and constructs realistic battle window schedules.
 */

import { fetchActiveBattleIds, fetchBattleById, fetchDamageBonuses } from "./api.mjs";

/**
 * Scan all active battles and produce a complete, auditable snapshot of battle states,
 * order configurations, live damage bonuses, bounties, and selector rankings.
 * 
 * Schema Version 2 Core Engine.
 * 
 * @param {string} countryId - Target player country ObjectId
 * @param {string} muId - Target player Military Unit ObjectId
 * @param {Object} options - { scanTimestamp: string }
 */
export async function scanLiveBattlesTelemetry(countryId = null, muId = null, options = {}) {
  const scanTimestamp = options.scanTimestamp || new Date().toISOString();
  let battleIds = [];
  try {
    battleIds = await fetchActiveBattleIds();
  } catch (err) {
    battleIds = [];
  }

  const allActiveBattles = [];
  let countryOrderCount = 0;
  let muOrderCount = 0;
  let agreeingOrdersCount = 0;

  for (const id of battleIds) {
    let b = null;
    let bonuses = null;
    try {
      b = await fetchBattleById(id);
    } catch {
      continue;
    }
    if (!b) continue;

    try {
      bonuses = await fetchDamageBonuses(id);
    } catch {
      bonuses = null;
    }

    const defCountryOrders = b.defender?.countryOrders || [];
    const attCountryOrders = b.attacker?.countryOrders || [];
    const defMuOrders = b.defender?.muOrders || [];
    const attMuOrders = b.attacker?.muOrders || [];

    const hasCountryOrderDef = countryId ? defCountryOrders.includes(countryId) : false;
    const hasCountryOrderAtt = countryId ? attCountryOrders.includes(countryId) : false;
    const hasMuOrderDef = muId ? defMuOrders.includes(muId) : false;
    const hasMuOrderAtt = muId ? attMuOrders.includes(muId) : false;

    if (hasCountryOrderDef || hasCountryOrderAtt) countryOrderCount++;
    if (hasMuOrderDef || hasMuOrderAtt) muOrderCount++;

    const countryOrderPresent = hasCountryOrderDef || hasCountryOrderAtt;
    const countryOrderSide = hasCountryOrderDef && !hasCountryOrderAtt
      ? "defender"
      : hasCountryOrderAtt && !hasCountryOrderDef
      ? "attacker"
      : (hasCountryOrderDef && hasCountryOrderAtt ? "both" : null);

    const muOrderPresent = hasMuOrderDef || hasMuOrderAtt;
    const muOrderSide = hasMuOrderDef && !hasMuOrderAtt
      ? "defender"
      : hasMuOrderAtt && !hasMuOrderDef
      ? "attacker"
      : (hasMuOrderDef && hasMuOrderAtt ? "both" : null);

    const agreeDef = hasCountryOrderDef && hasMuOrderDef;
    const agreeAtt = hasCountryOrderAtt && hasMuOrderAtt;
    const ordersAgree = agreeDef || agreeAtt;
    if (ordersAgree) agreeingOrdersCount++;

    const resolvedSide = agreeDef
      ? "defender"
      : agreeAtt
      ? "attacker"
      : (countryOrderSide && countryOrderSide !== "both"
      ? countryOrderSide
      : (muOrderSide && muOrderSide !== "both" ? muOrderSide : null));

    const attCountryId = b.attacker?.country || null;
    const defCountryId = b.defender?.country || null;
    const resolvedSideCountryId = resolvedSide === "defender"
      ? defCountryId
      : resolvedSide === "attacker"
      ? attCountryId
      : null;

    const isPlayerCountryWar = Boolean(
      countryId && (countryId === attCountryId || countryId === defCountryId)
    );

    // Live damage bonus resolution from official battle.getDamageBonuses tRPC endpoint
    const sideBonusObj = resolvedSide && bonuses ? bonuses[resolvedSide] : (bonuses?.attacker || bonuses?.defender || null);
    const damageBonusPercent = typeof sideBonusObj?.totalPercent === "number"
      ? sideBonusObj.totalPercent
      : (ordersAgree ? (isPlayerCountryWar ? 40 : 20) : (countryOrderPresent || muOrderPresent ? 10 : 0));

    const bonusComponents = {
      countryOrderBonus: sideBonusObj?.countryOrderBonusPercent ?? (countryOrderPresent ? 10 : 0),
      muOrderBonus: sideBonusObj?.muOrderBonusPercent ?? (muOrderPresent ? 10 : 0),
      patrioticBonus: sideBonusObj?.patrioticBonusPercent ?? (isPlayerCountryWar ? 20 : 0),
      allianceBonus: sideBonusObj?.countryAlliesBonusPercent ?? 0,
      naturalEnemyBonus: sideBonusObj?.swornEnemyBonusPercent ?? 0,
      defensivePactBonus: sideBonusObj?.defensivePactBonusPercent ?? 0,
      muHqBonus: sideBonusObj?.muHqBonusPercent ?? 0,
      regionDefenseBonus: sideBonusObj?.regionDefenseBonusPercent ?? 0,
      regionAttackBonus: sideBonusObj?.regionAttackBonusPercent ?? 0,
      regionNotLinkedToCapitalMalus: sideBonusObj?.regionNotLinkedToCapitalMalusPercent ?? 0,
      lostAttackingRegionMalus: sideBonusObj?.lostAttackingRegionMalusPercent ?? 0,
      resistanceBonus: sideBonusObj?.resistanceBonusPercent ?? 0,
      occupyingYourRegionsMalus: sideBonusObj?.occupyingYourRegionsMalusPercent ?? 0,
      revoltBunkerCopyBonus: sideBonusObj?.revoltBunkerCopyBonusPercent ?? 0,
      pacificationDefenseBonus: sideBonusObj?.pacificationDefenseBonusPercent ?? 0,
    };

    // Bounty resolution
    const defBounty = b.defender?.moneyPer1kDamages || 0;
    const attBounty = b.attacker?.moneyPer1kDamages || 0;
    const bountyRate = resolvedSide === "defender"
      ? defBounty
      : resolvedSide === "attacker"
      ? attBounty
      : Math.max(defBounty, attBounty);

    // Timings
    const startMs = b.createdAt ? new Date(b.createdAt).getTime() : Date.now();
    const elapsedHours = Math.max(0, Math.round(((Date.now() - startMs) / 3600000) * 10) / 10);
    const roundsToWin = b.roundsToWin || 2;
    const currentWonRounds = (b.defender?.wonRoundsCount || 0) + (b.attacker?.wonRoundsCount || 0);
    const estTotalHours = Math.max(16, (currentWonRounds + 1) * 8);
    const remainingHours = Math.max(1, Math.round((estTotalHours - elapsedHours) * 10) / 10);

    // Eligibility check per battle selector rules
    let selectorEligible = false;
    let selectorSkipReason = null;

    if (!countryOrderPresent && !muOrderPresent) {
      selectorSkipReason = "No orders";
    } else if (!countryOrderPresent) {
      selectorSkipReason = "MU order only (missing Country order)";
    } else if (!muOrderPresent) {
      selectorSkipReason = "Country order only (missing MU order)";
    } else if (countryOrderSide !== muOrderSide) {
      selectorSkipReason = "Country and MU orders conflict";
    } else {
      selectorEligible = true;
      selectorSkipReason = null;
    }

    const currentRoundId = b.currentRound || (b.rounds && b.rounds[b.rounds.length - 1]) || null;
    const regionName = b.defender?.region || b.region || "Unknown Region";

    allActiveBattles.push({
      timestamp: scanTimestamp,
      battleId: id,
      roundId: currentRoundId,
      regionName,
      battleType: b.type || "regular",
      isActive: Boolean(b.isActive !== false),
      attackerCountryId: attCountryId,
      defenderCountryId: defCountryId,
      playerCountryId: countryId,
      playerMuId: muId,
      countryOrderPresent,
      countryOrderSide,
      muOrderPresent,
      muOrderSide,
      ordersAgree,
      resolvedSide,
      resolvedSideCountryId,
      isPlayerCountryWar,
      damageBonusPercent,
      countryOrderBonus: bonusComponents.countryOrderBonus,
      muOrderBonus: bonusComponents.muOrderBonus,
      patrioticBonus: bonusComponents.patrioticBonus,
      allianceBonus: bonusComponents.allianceBonus,
      naturalEnemyBonus: bonusComponents.naturalEnemyBonus,
      otherBonusComponents: bonusComponents,
      bountyRate,
      battleStartTime: b.createdAt || null,
      battleEndTime: b.endedAt || null,
      remainingTimeHours: remainingHours,
      elapsedHours,
      roundsToWin,
      selectorEligible,
      selectorSkipReason,
      selectorRank: null,
      selectedTarget: false,
      rawEvidence: {
        defenderCountryOrders: defCountryOrders,
        attackerCountryOrders: attCountryOrders,
        defenderMuOrders: defMuOrders,
        attackerMuOrders: attMuOrders,
        defenderMoneyPer1kDamages: defBounty,
        attackerMoneyPer1kDamages: attBounty,
        bonusesRaw: bonuses ? {
          attackerTotal: bonuses.attacker?.totalPercent,
          defenderTotal: bonuses.defender?.totalPercent,
        } : null,
      },
    });
  }

  // Lexicographical ranking across eligible battles:
  // 1. My country's own war (isPlayerCountryWar)
  // 2. Highest damage bonus (damageBonusPercent)
  // 3. Highest bounty reward rate (bountyRate)
  const eligibleBattles = allActiveBattles.filter((b) => b.selectorEligible);
  eligibleBattles.sort((a, b) => {
    const aCountry = a.isPlayerCountryWar ? 1 : 0;
    const bCountry = b.isPlayerCountryWar ? 1 : 0;
    if (aCountry !== bCountry) return bCountry - aCountry;
    if (a.damageBonusPercent !== b.damageBonusPercent) return b.damageBonusPercent - a.damageBonusPercent;
    return b.bountyRate - a.bountyRate;
  });

  eligibleBattles.forEach((b, idx) => {
    b.selectorRank = idx + 1;
    if (idx === 0) b.selectedTarget = true;
  });

  const selectedBattle = eligibleBattles.length > 0 ? eligibleBattles[0] : null;

  // Backwards compatibility list
  const qualifyingBattles = eligibleBattles.map((b) => ({
    battleId: b.battleId,
    side: b.resolvedSide,
    battleType: b.battleType,
    roundId: b.roundId,
  }));

  return {
    totalActiveBattles: allActiveBattles.length,
    countryOrderBattlesCount: countryOrderCount,
    muOrderBattlesCount: muOrderCount,
    agreeingOrdersCount,
    qualifyingBattlesCount: eligibleBattles.length,
    hasQualifyingBattle: eligibleBattles.length > 0,
    selectedBattleId: selectedBattle?.battleId || null,
    selectedBattle,
    activeBattles: allActiveBattles,
    qualifyingBattles,
    isWindowActiveNow: eligibleBattles.length > 0,
  };
}

/**
 * Scan all active battles to find qualifying battles (v1 backwards-compatible signature)
 */
export async function scanLiveQualifyingBattles(countryId = null, muId = null) {
  const result = await scanLiveBattlesTelemetry(countryId, muId);
  return {
    totalActiveBattles: result.totalActiveBattles,
    countryOrderBattlesCount: result.countryOrderBattlesCount,
    muOrderBattlesCount: result.muOrderBattlesCount,
    qualifyingBattles: result.qualifyingBattles,
    isWindowActiveNow: result.isWindowActiveNow,
    telemetrySnapshot: result,
  };
}

import { loadTelemetrySamplesSync, calculateObservedAvailability } from "./battle_telemetry.mjs";

/**
 * Parse CLI flag or option into a structured Battle Availability Profile
 * 
 * @param {string} flagValue - 'unlimited' | 'observed' | '50%' | '30%' etc.
 * @param {Object} liveData - Result from scanLiveQualifyingBattles
 * @param {Object} options - { telemetryMetrics, telemetrySamples }
 */
export function resolveBattleSchedule(flagValue = "unlimited", liveData = null, options = {}) {
  const raw = String(flagValue || "unlimited").trim().toLowerCase();

  // 1. Unlimited / Ideal Capacity
  if (raw === "unlimited" || raw === "ideal" || raw === "100" || raw === "100%") {
    return {
      mode: "unlimited",
      coveragePct: 100,
      isAssumption: false,
      isHistoricalTimeline: false,
      label: "Ideal Capacity (100% Battle Availability)",
      description: "Assumes a qualifying battle with order consensus is always available 24/7.",
      cycleHours: 24,
      battleHoursPerCycle: 24,
      lullHoursPerCycle: 0,
      liveData,
    };
  }

  // 2. Actually Observed Local Historical Telemetry
  if (raw === "observed") {
    const context = options.context || (options.countryId || options.muId ? { countryId: options.countryId, muId: options.muId } : null);
    const telemetrySamples = options.telemetrySamples || loadTelemetrySamplesSync({ context });
    const metrics = options.telemetryMetrics || calculateObservedAvailability(
      telemetrySamples,
      { context }
    );

    const daysDisplay = metrics.actualObservedDays ?? metrics.observationPeriodDays ?? 0;
    const hoursDisplay = metrics.actualObservedHours ?? metrics.totalObservedDurationHours ?? 0;

    if (metrics.hasEstablishedIntervals && metrics.windowsTimeline?.length > 0) {
      return {
        mode: "observed",
        insufficient: !metrics.isSufficient,
        coveragePct: metrics.observedCoveragePct,
        isAssumption: false,
        isHistoricalTimeline: true,
        label: `Observed Historical Telemetry (${metrics.observedCoveragePct}% coverage over ${daysDisplay} days)`,
        description: `Calculated from ${metrics.totalSamples.toLocaleString()} locally recorded telemetry samples (${metrics.confidence} confidence). Replays exact sequence of battle windows.`,
        telemetryMetrics: metrics,
        windowsTimeline: metrics.windowsTimeline,
        totalObservedDurationHours: hoursDisplay,
        cycleHours: Math.max(24, Math.round(hoursDisplay)),
        liveData,
        context,
      };
    }

    // Insufficient historical data (no confirmed intervals / 0 samples)
    const fallbackCov = metrics.observedCoveragePct !== null ? metrics.observedCoveragePct : 50;
    const fallbackBattleHours = Math.round(24 * (fallbackCov / 100) * 10) / 10;
    return {
      mode: "observed",
      insufficient: true,
      coveragePct: fallbackCov,
      isAssumption: false,
      isHistoricalTimeline: false,
      label: !metrics.hasEstablishedIntervals
        ? `Insufficient Historical Telemetry (${metrics.totalSamples === 1 ? "1 isolated sample" : "no confirmed intervals"})`
        : `Insufficient Historical Telemetry (${metrics.totalSamples} samples, < 24h)`,
      description: `Insufficient locally recorded telemetry to establish observed coverage.`,
      telemetryMetrics: metrics,
      cycleHours: 24,
      battleHoursPerCycle: fallbackBattleHours,
      lullHoursPerCycle: 24 - fallbackBattleHours,
      liveData,
      context,
    };
  }

  // 3. User-defined percentage assumption (e.g. '50%', '30%', '75%', '25%')
  const num = parseFloat(raw.replace("%", ""));
  const coveragePct = isNaN(num) ? 50 : Math.max(1, Math.min(100, num));
  const battleHours = Math.round(24 * (coveragePct / 100) * 10) / 10;
  const lullHours = Math.round((24 - battleHours) * 10) / 10;

  return {
    mode: "percentage",
    coveragePct,
    isAssumption: true,
    isHistoricalTimeline: false,
    label: `Configured Assumption (${coveragePct}% Battle Availability)`,
    description: `User-specified assumption: ${battleHours}h battle window alternating with ${lullHours}h lull per 24h cycle.`,
    cycleHours: 24,
    battleHoursPerCycle: battleHours,
    lullHoursPerCycle: lullHours,
    liveData,
  };
}
