import { resolveBattleSchedule } from "./battle_windows.mjs";
import { assertContextUniformity } from "./battle_telemetry.mjs";

export const ACTIVITY_PRESETS = {
  casual: {
    factor: 0.45,
    name: "Casual",
    label: "Casual (1-2 checks/day, heavy capping)",
    description: "Checks 1-2 times daily; bars frequently hit max capacity, wasting ~55% of passive regen.",
  },
  medium: {
    factor: 0.65,
    name: "Medium",
    label: "Medium (regular play, occasional capping)",
    description: "Plays several sessions daily; occasional overflow during work or sleep (~35% waste).",
  },
  active: {
    factor: 0.85,
    name: "Active",
    label: "Active (optimal food use, minimal waste)",
    description: "Frequent logins, eats bread on cooldown, minimal waste (~15% waste during sleep).",
  },
  maximum: {
    factor: 1.0,
    name: "Maximum",
    label: "Maximum (bot-like perfect efficiency, 0 waste)",
    description: "Perfect theoretical efficiency; resources consumed immediately at threshold, 0% wasted.",
  },
};

/**
 * Calculate combat sustain profile for a given Health and Hunger skill level
 * 
 * @param {number} healthLevel - Health skill level (0 - 10)
 * @param {number} hungerLevel - Hunger skill level (0 - 10)
 * @param {Object} options - Configuration options:
 *   - hours: number of hours (default: 6 for sustained, 168 for weekly)
 *   - days: number of days (overrides hours if provided)
 *   - breadLimit: maximum bread items consumable (number or Infinity, default Infinity)
 *   - activity: activity preset key ('casual' | 'medium' | 'active' | 'maximum', default 'active')
 *   - gameConfig: optional gameConfig object to dynamically extract constants
 */
export function calculateSustainProfile(healthLevel = 0, hungerLevel = 0, options = {}) {
  const cfg = options.gameConfig || {};
  
  // Game config constants with live defaults
  const healthCostPerHit = cfg.battle?.healthCost ?? 10;
  const regenDividedBy = cfg.user?.regenDividedBy ?? 10;
  const breadRegenPercent = cfg.items?.bread?.flatStats?.healthRegenPercent ?? 10;
  
  // Determine time horizon in hours
  let durationHours = 6;
  const rawHours = options.hours ?? options.durationHours;
  if (typeof options.days === "number" && options.days > 0) {
    durationHours = options.days * 24;
  } else if (typeof rawHours === "number" && rawHours > 0) {
    durationHours = rawHours;
  } else if (options.objective === "weekly") {
    durationHours = 168; // 7 days
  }

  // Determine activity preset
  const activityKey = (options.activity || "active").toLowerCase();
  const activity = ACTIVITY_PRESETS[activityKey] || ACTIVITY_PRESETS.active;
  const alpha = activity.factor;

  // Bread limit
  let breadLimit = Infinity;
  if (options.bread !== undefined && options.bread !== null) {
    if (typeof options.bread === "number") {
      breadLimit = options.bread;
    } else if (String(options.bread).toLowerCase() === "unlimited") {
      breadLimit = Infinity;
    } else {
      const parsed = parseInt(options.bread, 10);
      breadLimit = isNaN(parsed) ? Infinity : parsed;
    }
  }

  // 1. Max Bar Values
  // Health: 100 base + 10 per level (0-10 -> 100-200)
  const healthSkillCfg = cfg.skills?.health?.levels?.[healthLevel];
  const maxHealth = healthSkillCfg?.value ?? (100 + 10 * healthLevel);

  // Hunger: 4 base + 1 per level (0-10 -> 4-14)
  const hungerSkillCfg = cfg.skills?.hunger?.levels?.[hungerLevel];
  const maxHunger = hungerSkillCfg?.value ?? (4 + 1 * hungerLevel);

  // 2. Hourly Regeneration Rates
  // In WarEra: regenPerHour = maxBarValue / regenDividedBy (10)
  const hourlyHealthRegen = maxHealth / regenDividedBy;
  const hourlyHungerRegen = maxHunger / regenDividedBy;

  // 3. Hunger & Food Economy over time horizon
  // Initial hunger pool available at start of horizon
  const initialHunger = maxHunger;
  // Natural hunger regenerated over the duration
  const naturalHungerRegen = hourlyHungerRegen * durationHours;
  const totalHungerGenerated = initialHunger + naturalHungerRegen;

  // Effective hunger capacity used based on player activity
  const usableHunger = totalHungerGenerated * alpha;
  const hungerWasted = totalHungerGenerated * (1 - alpha);

  // Each bread costs 1 hunger point
  const maxBreadsPossible = Math.floor(usableHunger);
  const breadsConsumed = Math.max(0, Math.min(breadLimit, maxBreadsPossible));

  // Health restored per bread: (breadRegenPercent% of maxHealth)
  const hpPerBread = (breadRegenPercent / 100) * maxHealth;
  const healthFromBread = breadsConsumed * hpPerBread;

  // 4. Health Economy over time horizon
  // Initial health pool
  const initialHealth = maxHealth;
  // Natural health regenerated over duration
  const naturalHealthRegen = hourlyHealthRegen * durationHours;
  const totalHealthGenerated = initialHealth + naturalHealthRegen;

  // Passive health utilized based on player activity
  const usablePassiveHealth = totalHealthGenerated * alpha;
  const passiveHealthWasted = totalHealthGenerated * (1 - alpha);

  // Total usable health pool
  const totalEffectiveHealth = usablePassiveHealth + healthFromBread;
  const totalPotentialHealth = totalHealthGenerated + (Math.floor(totalHungerGenerated) * hpPerBread);

  // 5. Combat Action Throughput (Hits)
  // Each hit costs healthCostPerHit (10) HP
  const totalHits = Math.floor(totalEffectiveHealth / healthCostPerHit);
  const hitsFromInitial = Math.floor((initialHealth * alpha) / healthCostPerHit);
  const hitsFromRegen = Math.floor((naturalHealthRegen * alpha) / healthCostPerHit);
  const hitsFromBread = Math.floor(healthFromBread / healthCostPerHit);

  // Resource efficiency %
  const resourceEfficiencyPercent = totalPotentialHealth > 0
    ? Math.round((totalEffectiveHealth / totalPotentialHealth) * 1000) / 10
    : 100;

  return {
    healthLevel,
    hungerLevel,
    maxHealth,
    maxHunger,
    hourlyHealthRegen: Math.round(hourlyHealthRegen * 10) / 10,
    hourlyHungerRegen: Math.round(hourlyHungerRegen * 100) / 100,
    dailyHealthRegen: Math.round(hourlyHealthRegen * 24),
    dailyHungerRegen: Math.round(hourlyHungerRegen * 24 * 10) / 10,
    durationHours,
    durationDays: Math.round((durationHours / 24) * 10) / 10,
    activityPreset: activityKey,
    activityName: activity.name,
    activityFactor: alpha,
    activityLabel: activity.label,
    breadLimit,
    breadsConsumed,
    hpPerBread: Math.round(hpPerBread * 10) / 10,
    healthFromBread: Math.round(healthFromBread),
    initialHealth,
    naturalHealthRegen: Math.round(naturalHealthRegen),
    usablePassiveHealth: Math.round(usablePassiveHealth),
    healthWasted: Math.round(passiveHealthWasted),
    totalEffectiveHealth: Math.round(totalEffectiveHealth),
    totalPotentialHealth: Math.round(totalPotentialHealth),
    resourceEfficiencyPercent,
    healthCostPerHit,
    totalHits,
    hitsFromInitial,
    hitsFromRegen,
    hitsFromBread,
  };
}

/**
 * Discrete Event-Based Sustained Combat Simulation
 * 
 * Simulates resource accumulation, overflow capping at Max Bars,
 * bread eating, and combat action throughput across realistic battle windows.
 * 
 * Tracks:
 * - resourceLimitedHits (hits if battle is 100% available)
 * - battleWindowCapacity (maximum hits battle windows could absorb)
 * - actualPossibleHits = min(resourceLimitedHits, battleWindowCapacity)
 * - battleWindowLoss = resourceLimitedHits - actualPossibleHits
 * - hpRegenWastedAtCap: HP wasted while capped at Max HP during lulls
 * - hungerRegenWastedAtCap: Hunger wasted at cap
 */
export function simulateSustainedCombat(healthLevel = 0, hungerLevel = 0, options = {}) {
  // 1. Calculate ideal capacity baseline
  const ideal = calculateSustainProfile(healthLevel, hungerLevel, {
    ...options,
    battleAvailability: "unlimited",
  });

  // 2. Resolve battle availability schedule
  const schedule = options.schedule || resolveBattleSchedule(options.battleAvailability || "unlimited", options.liveBattleData, options);

  // If 100% availability, ideal capacity matches simulation perfectly
  if (schedule.coveragePct >= 100) {
    return {
      ...ideal,
      schedule,
      resourceLimitedHits: ideal.totalHits,
      battleWindowCapacity: ideal.totalHits,
      actualPossibleHits: ideal.totalHits,
      battleWindowLoss: 0,
      healthLimitedLoss: 0,
      hpRegenWastedAtCap: 0,
      hungerRegenWastedAtCap: 0,
      isRealisticSim: false,
    };
  }

  // If using historical recorded timeline, run Event-Based Analytical Simulation
  if (schedule.isHistoricalTimeline && schedule.windowsTimeline?.length > 0) {
    return simulateEventBasedCombat(ideal, schedule);
  }

  // 3. Discrete simulation parameters for periodic assumption models
  const durationHours = ideal.durationHours;
  const alpha = ideal.activityFactor;
  const maxHp = ideal.maxHealth;
  const maxHunger = ideal.maxHunger;
  const hpRegenHr = ideal.hourlyHealthRegen;
  const hungerRegenHr = ideal.hourlyHungerRegen;
  const hpPerBread = ideal.hpPerBread;
  const breadLimit = ideal.breadLimit;

  let currentHp = maxHp;
  let currentHunger = maxHunger;
  let breadsLeft = breadLimit;

  let totalHits = 0;
  let hpRegenWastedAtCap = 0;
  let hungerRegenWastedAtCap = 0;
  let breadsConsumed = 0;
  let hpFromBread = 0;

  // Dynamically scale step size so short windows are not lost
  const battleHours = schedule.battleHoursPerCycle || 12;
  const dt = Math.min(0.25, Math.max(0.05, battleHours / 10));
  const totalSteps = durationHours / dt;

  for (let s = 0; s < totalSteps; s++) {
    const t = s * dt;
    const cycleTime = t % schedule.cycleHours;
    const isBattleOpen = cycleTime < schedule.battleHoursPerCycle;

    // Natural regeneration
    currentHp += hpRegenHr * dt;
    currentHunger += hungerRegenHr * dt;

    if (currentHp > maxHp) {
      hpRegenWastedAtCap += (currentHp - maxHp);
      currentHp = maxHp;
    }
    if (currentHunger > maxHunger) {
      hungerRegenWastedAtCap += (currentHunger - maxHunger);
      currentHunger = maxHunger;
    }

    if (isBattleOpen) {
      // Consume food/bread if hungry and HP deficit exists
      while (currentHunger >= 1 && breadsLeft > 0 && (maxHp - currentHp) >= hpPerBread) {
        currentHunger -= 1;
        currentHp += hpPerBread;
        breadsLeft--;
        breadsConsumed++;
        hpFromBread += hpPerBread;
      }

      // Execute hits (10 HP / hit)
      const hitsPossible = Math.floor(currentHp / 10);
      if (hitsPossible > 0) {
        const hitsDone = Math.floor(hitsPossible * alpha);
        currentHp -= (hitsDone * 10);
        totalHits += hitsDone;
      }
    }
  }

  const resourceLimitedHits = ideal.totalHits;
  const actualPossibleHits = Math.min(resourceLimitedHits, totalHits);
  const battleWindowLoss = Math.max(0, resourceLimitedHits - actualPossibleHits);
  const battleWindowCapacity = totalHits;

  return {
    ...ideal,
    schedule,
    resourceLimitedHits,
    battleWindowCapacity,
    actualPossibleHits,
    totalHits: actualPossibleHits,
    battleWindowLoss,
    healthLimitedLoss: 0,
    hpRegenWastedAtCap: Math.round(hpRegenWastedAtCap),
    hungerRegenWastedAtCap: Math.round(hungerRegenWastedAtCap * 10) / 10,
    breadsConsumed,
    hpFromBread: Math.round(hpFromBread),
    totalEffectiveHealth: actualPossibleHits * 10,
    isRealisticSim: true,
  };
}

/**
 * Event-based timeline combat simulation
 * 
 * Replays reconstructed battle windows and lulls analytically between events,
 * ensuring that 5-minute or short windows are captured with exact precision,
 * while accurately computing HP & Hunger capping during quiet lull events.
 */
function simulateEventBasedCombat(ideal, schedule) {
  if (schedule.context && !schedule.context.all && schedule.telemetryMetrics?.samples) {
    assertContextUniformity(schedule.telemetryMetrics.samples, schedule.context);
  }

  const durationHours = ideal.durationHours;
  const alpha = ideal.activityFactor;
  const maxHp = ideal.maxHealth;
  const maxHunger = ideal.maxHunger;
  const hpRegenHr = ideal.hourlyHealthRegen;
  const hungerRegenHr = ideal.hourlyHungerRegen;
  const hpPerBread = ideal.hpPerBread;
  const breadLimit = ideal.breadLimit;

  let currentHp = maxHp;
  let currentHunger = maxHunger;
  let breadsLeft = breadLimit;

  let totalHits = 0;
  let hpRegenWastedAtCap = 0;
  let hungerRegenWastedAtCap = 0;
  let breadsConsumed = 0;
  let hpFromBread = 0;

  const timeline = schedule.windowsTimeline || [];
  let simTime = 0;

  // Iterate across timeline segments until durationHours is reached
  while (simTime < durationHours && timeline.length > 0) {
    for (let i = 0; i < timeline.length; i++) {
      if (simTime >= durationHours) break;

      const seg = timeline[i];
      const remainingHours = durationHours - simTime;
      const tau = Math.min(seg.durationHours, remainingHours);
      if (tau <= 0) continue;

      if (!seg.isOpen) {
        // --- LULL EVENT ---
        // Passive accumulation without combat; excess above caps is wasted
        const hpGen = hpRegenHr * tau;
        const hungerGen = hungerRegenHr * tau;

        currentHp += hpGen;
        currentHunger += hungerGen;

        if (currentHp > maxHp) {
          hpRegenWastedAtCap += (currentHp - maxHp);
          currentHp = maxHp;
        }
        if (currentHunger > maxHunger) {
          hungerRegenWastedAtCap += (currentHunger - maxHunger);
          currentHunger = maxHunger;
        }
      } else {
        // --- QUALIFYING BATTLE WINDOW EVENT ---
        // 1. Initial pool discharge at window opening (eat available bread if hungry)
        while (currentHunger >= 1 && breadsLeft > 0 && (maxHp - currentHp) >= hpPerBread) {
          currentHunger -= 1;
          currentHp += hpPerBread;
          breadsLeft--;
          breadsConsumed++;
          hpFromBread += hpPerBread;
        }

        let hitsPossible = Math.floor(currentHp / 10);
        if (hitsPossible > 0) {
          const hitsDone = Math.floor(hitsPossible * alpha);
          currentHp -= (hitsDone * 10);
          totalHits += hitsDone;
        }

        // 2. Regeneration occurring during the window (tau hours)
        const hpGen = hpRegenHr * tau;
        const hungerGen = hungerRegenHr * tau;
        currentHp += hpGen;
        currentHunger += hungerGen;

        // Eat bread as hunger becomes available during window
        const breadsPossible = Math.min(breadsLeft, Math.floor(currentHunger));
        if (breadsPossible > 0) {
          currentHunger -= breadsPossible;
          currentHp += breadsPossible * hpPerBread;
          breadsLeft -= breadsPossible;
          breadsConsumed += breadsPossible;
          hpFromBread += breadsPossible * hpPerBread;
        }

        // Convert generated HP to hits
        hitsPossible = Math.floor(currentHp / 10);
        if (hitsPossible > 0) {
          const hitsDone = Math.floor(hitsPossible * alpha);
          currentHp -= (hitsDone * 10);
          totalHits += hitsDone;
        }

        // Clamping (cannot exceed maxHp)
        if (currentHp > maxHp) {
          hpRegenWastedAtCap += (currentHp - maxHp);
          currentHp = maxHp;
        }
        if (currentHunger > maxHunger) {
          hungerRegenWastedAtCap += (currentHunger - maxHunger);
          currentHunger = maxHunger;
        }
      }

      simTime += tau;
    }
  }

  const resourceLimitedHits = ideal.totalHits;
  const actualPossibleHits = Math.min(resourceLimitedHits, totalHits);
  const battleWindowLoss = Math.max(0, resourceLimitedHits - actualPossibleHits);
  const battleWindowCapacity = totalHits;

  return {
    ...ideal,
    schedule,
    resourceLimitedHits,
    battleWindowCapacity,
    actualPossibleHits,
    totalHits: actualPossibleHits,
    battleWindowLoss,
    healthLimitedLoss: 0,
    hpRegenWastedAtCap: Math.round(hpRegenWastedAtCap),
    hungerRegenWastedAtCap: Math.round(hungerRegenWastedAtCap * 10) / 10,
    breadsConsumed,
    hpFromBread: Math.round(hpFromBread),
    totalEffectiveHealth: actualPossibleHits * 10,
    isRealisticSim: true,
    isEventBased: true,
  };
}
