/**
 * WarEra Battle Telemetry Engine (Hardened)
 * 
 * Records timestamped observations of Country and MU battle order consensus,
 * reconstructs continuous battle windows and lull periods, calculates observed
 * coverage and confidence, and provides timeline data for discrete combat simulation.
 * 
 * Data Integrity Guarantees:
 * 1. Physical separation: Production telemetry strictly stored in telemetry.jsonl;
 *    synthetic/seeded test fixtures strictly stored in synthetic.jsonl.
 * 2. Every live sample contains metadata: source: "live", samplingIntervalMs, context.
 * 3. Confidence evaluates ACTUALLY OBSERVED duration, strictly excluding offline gaps.
 * 4. Coverage denominator = Known Qualifying Time + Known Lull Time (excludes UNKNOWN time).
 * 5. Order transitions (attacker -> defender or battle changes) preserve separate windows.
 * 6. Context segmentation: observations are partitioned by Player Country + MU combination.
 */

import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(__dirname, "../data/battle_availability");
let activeTelemetryDataDir = null;

/**
 * Configure a custom telemetry data directory (e.g. for isolated test environments)
 * @param {string|null} dir
 */
export function setTelemetryDataDir(dir) {
  activeTelemetryDataDir = dir ? path.resolve(dir) : null;
}

/**
 * Reset telemetry data directory back to default
 */
export function resetTelemetryDataDir() {
  activeTelemetryDataDir = null;
}

/**
 * Get the currently active telemetry data directory
 */
export function getTelemetryDataDir() {
  if (activeTelemetryDataDir) return activeTelemetryDataDir;
  if (process.env.WARERA_TELEMETRY_DIR) return path.resolve(process.env.WARERA_TELEMETRY_DIR);
  return DEFAULT_DATA_DIR;
}

/**
 * Ensure telemetry data directory exists
 */
export function ensureTelemetryDir(dir = null) {
  const target = dir || getTelemetryDataDir();
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
  return target;
}

/**
 * Get path to the telemetry log file
 * 
 * @param {boolean} isSynthetic - If true, returns path to synthetic test file
 */
export function getTelemetryFilePath(isSynthetic = false) {
  return path.join(getTelemetryDataDir(), isSynthetic ? "synthetic.jsonl" : "telemetry.jsonl");
}

/**
 * Get the synthetic test fixture path
 */
export function getSyntheticFilePath() {
  return path.join(getTelemetryDataDir(), "synthetic.jsonl");
}

/**
 * Get path to the recorder lock file
 */
export function getLockFilePath() {
  return path.join(getTelemetryDataDir(), "telemetry.lock");
}

/**
 * Get path to the recorder status heartbeat file
 */
export function getStatusFilePath() {
  return path.join(getTelemetryDataDir(), "recorder_status.json");
}

/**
 * Get path to the executions log file
 */
export function getExecutionsFilePath() {
  return path.join(getTelemetryDataDir(), "executions.jsonl");
}

/**
 * Record a live Battle Mode combat hit execution telemetry record
 * Append-only to data/battle_availability/executions.jsonl
 */
export async function recordExecutionTelemetry(entry = {}) {
  ensureTelemetryDir();
  const record = {
    timestamp: entry.timestamp || new Date().toISOString(),
    hostname: entry.hostname || os.hostname(),
    battleId: entry.battleId || null,
    roundId: entry.roundId || null,
    region: entry.region || null,
    side: entry.side || null,
    damageBonus: typeof entry.damageBonus === "number" ? entry.damageBonus : null,
    bountyRate: typeof entry.bountyRate === "number" ? entry.bountyRate : null,
    healthBefore: typeof entry.healthBefore === "number" ? entry.healthBefore : null,
    healthAfter: typeof entry.healthAfter === "number" ? entry.healthAfter : null,
    actualHealthDelta: typeof entry.actualHealthDelta === "number" ? entry.actualHealthDelta : null,
    damageDealt: typeof entry.damageDealt === "number" ? entry.damageDealt : null,
    loot: entry.loot || null,
    verificationState: entry.verificationState || "UNKNOWN_HIT",
    mutationIdentifier: entry.mutationIdentifier || null,
  };
  const line = JSON.stringify(record) + "\n";
  const targetFile = getExecutionsFilePath();
  await fs.promises.appendFile(targetFile, line, "utf8");
  return record;
}

/**
 * Generate a signature string for active qualifying battles
 * to detect order transitions (side changes, target battle changes)
 */
export function getBattleSignature(battles) {
  if (!battles || battles.length === 0) return "none";
  return battles
    .map(b => `${b.battleId}:${b.side || b.orderedSide || "unknown"}`)
    .sort()
    .join(";");
}

/**
 * Record a single live battle availability telemetry observation
 * 
 * Schema Version 2:
 * {
 *   schemaVersion: 2,
 *   hostname: string,
 *   timestamp: string (ISO),
 *   source: "live",
 *   samplingIntervalMs: number,
 *   playerCountryId: string,
 *   playerMuId: string,
 *   totalActiveBattles: number,
 *   qualifyingBattlesCount: number,
 *   hasQualifyingBattle: boolean,
 *   selectedBattleId: string|null,
 *   activeBattles: [ ... ],
 *   qualifyingBattles: [ ... ]
 * }
 * 
 * @param {Object} sampleData
 * @param {Object} options - { intervalMs: 300000, minIntervalSeconds: 210 }
 */
export async function recordTelemetrySample(sampleData, options = {}) {
  ensureTelemetryDir();
  const intervalMs = options.intervalMs || 300000;
  const minIntervalMs = (options.minIntervalSeconds || Math.round((intervalMs / 1000) * 0.7)) * 1000;

  const nowIso = sampleData.timestamp || new Date().toISOString();
  const nowMs = new Date(nowIso).getTime();

  // Load the last recorded LIVE sample to check for deduplication
  const lastSample = await getLastTelemetrySample({ onlyLive: true });

  if (lastSample) {
    const lastMs = new Date(lastSample.timestamp).getTime();
    const elapsedMs = Math.abs(nowMs - lastMs);

    const sameStatus = Boolean(lastSample.hasQualifyingBattle) === Boolean(sampleData.hasQualifyingBattle);
    const lastSig = getBattleSignature(lastSample.qualifyingBattles);
    const currSig = getBattleSignature(sampleData.qualifyingBattles);
    const sameBattles = lastSig === currSig;

    // Deduplicate only if identical state AND within min interval
    if (elapsedMs < minIntervalMs && sameStatus && sameBattles) {
      return {
        recorded: false,
        reason: "duplicate_skipped",
        sample: lastSample,
        elapsedMs,
      };
    }
  }

  const cleanRecord = {
    schemaVersion: 2,
    hostname: sampleData.hostname || os.hostname(),
    timestamp: nowIso,
    source: sampleData.source || "live",
    samplingIntervalMs: intervalMs,
    playerCountryId: sampleData.playerCountryId || null,
    playerMuId: sampleData.playerMuId || null,
    totalActiveBattles: sampleData.totalActiveBattles ?? (sampleData.activeBattles?.length || (sampleData.qualifyingBattles?.length || 0)),
    qualifyingBattlesCount: sampleData.qualifyingBattlesCount ?? (sampleData.qualifyingBattles?.length || 0),
    hasQualifyingBattle: Boolean(sampleData.hasQualifyingBattle),
    selectedBattleId: sampleData.selectedBattleId || null,
    activeBattles: (sampleData.activeBattles || []).map(b => ({
      timestamp: b.timestamp || nowIso,
      battleId: b.battleId,
      roundId: b.roundId || null,
      regionName: b.regionName || "Unknown Region",
      battleType: b.battleType || "regular",
      isActive: Boolean(b.isActive !== false),
      attackerCountryId: b.attackerCountryId || null,
      defenderCountryId: b.defenderCountryId || null,
      playerCountryId: b.playerCountryId || sampleData.playerCountryId || null,
      playerMuId: b.playerMuId || sampleData.playerMuId || null,
      countryOrderPresent: Boolean(b.countryOrderPresent),
      countryOrderSide: b.countryOrderSide || null,
      muOrderPresent: Boolean(b.muOrderPresent),
      muOrderSide: b.muOrderSide || null,
      ordersAgree: Boolean(b.ordersAgree),
      resolvedSide: b.resolvedSide || null,
      resolvedSideCountryId: b.resolvedSideCountryId || null,
      isPlayerCountryWar: Boolean(b.isPlayerCountryWar),
      damageBonusPercent: typeof b.damageBonusPercent === "number" ? b.damageBonusPercent : 0,
      countryOrderBonus: typeof b.countryOrderBonus === "number" ? b.countryOrderBonus : 0,
      muOrderBonus: typeof b.muOrderBonus === "number" ? b.muOrderBonus : 0,
      patrioticBonus: typeof b.patrioticBonus === "number" ? b.patrioticBonus : 0,
      allianceBonus: typeof b.allianceBonus === "number" ? b.allianceBonus : 0,
      naturalEnemyBonus: typeof b.naturalEnemyBonus === "number" ? b.naturalEnemyBonus : 0,
      otherBonusComponents: b.otherBonusComponents || null,
      bountyRate: typeof b.bountyRate === "number" ? b.bountyRate : 0,
      battleStartTime: b.battleStartTime || null,
      battleEndTime: b.battleEndTime || null,
      remainingTimeHours: typeof b.remainingTimeHours === "number" ? b.remainingTimeHours : null,
      elapsedHours: typeof b.elapsedHours === "number" ? b.elapsedHours : null,
      roundsToWin: typeof b.roundsToWin === "number" ? b.roundsToWin : 2,
      selectorEligible: Boolean(b.selectorEligible),
      selectorSkipReason: b.selectorSkipReason || null,
      selectorRank: typeof b.selectorRank === "number" ? b.selectorRank : null,
      selectedTarget: Boolean(b.selectedTarget),
      rawEvidence: b.rawEvidence || null,
    })),
    qualifyingBattles: (sampleData.qualifyingBattles || []).map(b => ({
      battleId: b.battleId,
      side: b.side || b.orderedSide,
      battleType: b.battleType || b.type || "regular",
      roundId: b.roundId || b.currentRoundId || null,
    })),
  };

  const line = JSON.stringify(cleanRecord) + "\n";
  const targetFile = options.filePath || getTelemetryFilePath(options.synthetic);
  await fs.promises.appendFile(targetFile, line, "utf8");

  return {
    recorded: true,
    sample: cleanRecord,
  };
}

/**
 * Read the last recorded telemetry sample
 */
export async function getLastTelemetrySample(options = {}) {
  const filePath = options.filePath || getTelemetryFilePath(options.synthetic);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (options.onlyLive && parsed.source !== "live") continue;
        return parsed;
      } catch {
        // continue
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Synchronously read the last recorded telemetry sample
 */
export function getLastTelemetrySampleSync(options = {}) {
  const filePath = options.filePath || getTelemetryFilePath(options.synthetic);
  if (!fs.existsSync(filePath)) return null;

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.trim().split("\n").filter(Boolean);
    if (lines.length === 0) return null;

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (options.onlyLive && parsed.source !== "live") continue;
        return parsed;
      } catch {
        // continue
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Synchronously extract the latest active Country & MU context from recorded telemetry
 * 
 * @param {Object} options - { synthetic: false }
 * @returns {{ countryId: string|null, muId: string|null }}
 */
export function getLatestTelemetryContextSync(options = {}) {
  const lastSample = getLastTelemetrySampleSync(options);
  return {
    countryId: lastSample?.playerCountryId || null,
    muId: lastSample?.playerMuId || null,
  };
}

/**
 * Assert that every sample in the given list strictly matches the expected Country and MU context.
 * Throws an error immediately if a mismatched context sample is found when not in "all" mode.
 * 
 * @param {Array} samples
 * @param {Object} expectedContext - { countryId, muId, all }
 */
export function assertContextUniformity(samples, expectedContext = null) {
  if (!expectedContext || expectedContext.all === true) {
    return true;
  }
  const targetCountry = expectedContext.countryId || null;
  const targetMu = expectedContext.muId || null;
  if (!targetCountry && !targetMu) {
    return true;
  }

  for (const s of samples) {
    if (targetCountry && s.playerCountryId && s.playerCountryId !== targetCountry) {
      throw new Error(
        `Context isolation violation: telemetry sample at ${s.timestamp || "unknown"} has Country ${s.playerCountryId}, expected ${targetCountry}`
      );
    }
    if (targetMu && s.playerMuId && s.playerMuId !== targetMu) {
      throw new Error(
        `Context isolation violation: telemetry sample at ${s.timestamp || "unknown"} has MU ${s.playerMuId}, expected ${targetMu}`
      );
    }
  }
  return true;
}

/**
 * Resolve telemetry context from CLI argument or fallback options
 * 
 * Allowed values for telemetryContextOption:
 * - "current" (default): Resolves to fallbackContext or latest live telemetry context
 * - "all": Combines all contexts ({ all: true, countryId: null, muId: null, raw: "all" })
 * - "<countryId>:<muId>": Explicit historical context query
 * 
 * @param {string|Object} telemetryContextOption
 * @param {Object} fallbackContext - { countryId, muId }
 * @returns {{ all: boolean, countryId: string|null, muId: string|null, raw: string }}
 */
export function resolveTelemetryContext(telemetryContextOption = "current", fallbackContext = null) {
  if (telemetryContextOption && typeof telemetryContextOption === "object") {
    if (telemetryContextOption.all) {
      return { all: true, countryId: null, muId: null, raw: "all" };
    }
    return {
      all: false,
      countryId: telemetryContextOption.countryId || null,
      muId: telemetryContextOption.muId || null,
      raw: telemetryContextOption.raw || "custom",
    };
  }

  const raw = String(telemetryContextOption || "current").trim();

  if (raw.toLowerCase() === "all") {
    return {
      all: true,
      countryId: null,
      muId: null,
      raw: "all",
    };
  }

  if (raw.includes(":")) {
    const [countryId, muId] = raw.split(":");
    return {
      all: false,
      countryId: countryId || null,
      muId: muId || null,
      raw,
    };
  }

  // "current" mode: use fallbackContext if available, otherwise read latest sample
  if (fallbackContext?.countryId || fallbackContext?.muId) {
    return {
      all: false,
      countryId: fallbackContext.countryId || null,
      muId: fallbackContext.muId || null,
      raw: "current",
    };
  }

  const latest = getLatestTelemetryContextSync();
  return {
    all: false,
    countryId: latest.countryId || null,
    muId: latest.muId || null,
    raw: "current",
  };
}

/**
 * Parse and validate telemetry lines from raw content
 */
function parseTelemetryContent(content, options = {}) {
  const lines = content.trim().split("\n").filter(Boolean);
  const samples = [];
  let syntheticDetectedInLive = false;

  const targetCountry = options.context?.countryId || null;
  const targetMu = options.context?.muId || null;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (!parsed || !parsed.timestamp) continue;

      // Detect synthetic contamination
      const isSynthetic = parsed.source === "synthetic" ||
        (parsed.qualifyingBattles || []).some(b => String(b.battleId || "").startsWith("6a9d00") || String(b.roundId || "").endsWith("r1"));

      if (isSynthetic && !options.synthetic) {
        syntheticDetectedInLive = true;
        if (options.onlyLive !== false) {
          continue; // Strictly reject synthetic entries from live telemetry
        }
      }

      parsed.timestampMs = new Date(parsed.timestamp).getTime();
      parsed.source = isSynthetic ? "synthetic" : (parsed.source || "live");
      parsed.schemaVersion = typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1;
      parsed.hostname = parsed.hostname || null;
      if (parsed.schemaVersion === 1) {
        // Strictly preserve v1 contract: do not fabricate missing v2 fields
        parsed.activeBattles = undefined;
        parsed.selectedBattleId = undefined;
      }

      // Context filtering if context is provided and not in "all" mode
      if (options.context && !options.context.all && (targetCountry || targetMu)) {
        if (targetCountry && parsed.playerCountryId !== targetCountry) {
          continue;
        }
        if (targetMu && parsed.playerMuId !== targetMu) {
          continue;
        }
      }

      samples.push(parsed);
    } catch {
      // Skip malformed lines
    }
  }

  samples.sort((a, b) => a.timestampMs - b.timestampMs);

  if (options.context && !options.context.all) {
    assertContextUniformity(samples, options.context);
  }

  if (options.sinceMs) {
    return {
      samples: samples.filter(s => s.timestampMs >= options.sinceMs),
      syntheticDetectedInLive,
    };
  }

  return { samples, syntheticDetectedInLive };
}

/**
 * Load all recorded telemetry samples, sorted chronologically
 * 
 * @param {Object} options - { onlyLive: true, context: { countryId, muId }, synthetic: false, sinceMs }
 */
export async function loadTelemetrySamples(options = {}) {
  const filePath = options.filePath || getTelemetryFilePath(options.synthetic);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = await fs.promises.readFile(filePath, "utf8");
    const { samples, syntheticDetectedInLive } = parseTelemetryContent(content, options);
    samples.syntheticDetectedInLive = syntheticDetectedInLive;
    return samples;
  } catch (err) {
    console.error("Failed to load telemetry:", err.message);
    return [];
  }
}

/**
 * Synchronous version of loadTelemetrySamples for fast execution loops
 */
export function loadTelemetrySamplesSync(options = {}) {
  const filePath = options.filePath || getTelemetryFilePath(options.synthetic);
  if (!fs.existsSync(filePath)) {
    return [];
  }

  try {
    const content = fs.readFileSync(filePath, "utf8");
    const { samples, syntheticDetectedInLive } = parseTelemetryContent(content, options);
    samples.syntheticDetectedInLive = syntheticDetectedInLive;
    return samples;
  } catch (err) {
    return [];
  }
}

/**
 * Reconstruct continuous battle windows, lulls, and offline gaps from discrete samples
 * 
 * Rules:
 * - Group consecutive samples into windows
 * - Inter-sample deltas > 2.5 * median interval are marked as UNKNOWN / OFFLINE
 * - If orders shift side or battleId changes, terminate current window and start new window
 * - Boundary between consecutive samples is placed halfway between sample timestamps
 * 
 * @param {Array} samples - Chronologically sorted telemetry samples
 * @param {Object} options
 */
export function reconstructWindows(samples, options = {}) {
  const context = options.context || options.currentContext || null;
  if (context && !context.all && samples?.length > 0) {
    assertContextUniformity(samples, context);
  }

  if (!samples || samples.length === 0) {
    return {
      segments: [],
      windows: [],
      lulls: [],
      unobservedGaps: [],
      medianIntervalMs: 300000,
      knownObservedMs: 0,
      qualifyingObservedMs: 0,
      lullObservedMs: 0,
      unknownOfflineMs: 0,
      wallClockMs: 0,
      hasEstablishedIntervals: false,
      intervalsCount: 0,
      currentState: "No telemetry data",
    };
  }

  // 1. Determine median sampling interval from consecutive sample deltas
  const intervals = [];
  for (let i = 1; i < samples.length; i++) {
    const diff = samples[i].timestampMs - samples[i - 1].timestampMs;
    if (diff > 0) intervals.push(diff);
  }
  intervals.sort((a, b) => a - b);
  const medianIntervalMs = intervals.length > 0
    ? intervals[Math.floor(intervals.length / 2)]
    : (samples[0].samplingIntervalMs || 300000);

  const latestSample = samples[samples.length - 1];
  const currentState = latestSample.hasQualifyingBattle
    ? "Qualifying battle available"
    : "No qualifying battle available";

  if (samples.length === 1) {
    // Isolated single sample:
    // A single live sample should not be treated as proving that its state persisted for the entire sampling interval.
    // Leading and trailing boundaries are uncertain.
    // Confirmed historical duration = 0m, window duration = Not yet established, coverage = Insufficient data.
    return {
      segments: [],
      windows: [],
      lulls: [],
      unobservedGaps: [],
      medianIntervalMs,
      knownObservedMs: 0,
      qualifyingObservedMs: 0,
      lullObservedMs: 0,
      unknownOfflineMs: 0,
      wallClockMs: 0,
      hasEstablishedIntervals: false,
      intervalsCount: 0,
      currentState,
      isolatedSample: samples[0],
    };
  }

  // Maximum gap before classifying as an unobserved offline period
  const maxGapMs = Math.max(medianIntervalMs * 2.5, 900000); // at least 15m

  const segments = [];
  const unobservedGaps = [];

  // Build intervals between consecutive samples
  // An interior interval [S_i, S_{i+1}] counts as known observed time ONLY when S_i and S_{i+1} are compatible.
  let currentSegment = null;
  let intervalsCount = 0;

  for (let i = 0; i < samples.length - 1; i++) {
    const s1 = samples[i];
    const s2 = samples[i + 1];
    const deltaMs = s2.timestampMs - s1.timestampMs;

    if (deltaMs > maxGapMs) {
      // Offline / unknown gap
      if (currentSegment) {
        currentSegment.durationHours = Math.round((currentSegment.durationMs / 3600000) * 1000) / 1000;
        segments.push(currentSegment);
        currentSegment = null;
      }
      unobservedGaps.push({
        startMs: s1.timestampMs,
        endMs: s2.timestampMs,
        durationMs: deltaMs,
        durationHours: Math.round((deltaMs / 3600000) * 10) / 10,
      });
      continue;
    }

    // Interior interval within normal sampling cadence
    const sig1 = getBattleSignature(s1.qualifyingBattles);
    const sig2 = getBattleSignature(s2.qualifyingBattles);
    const isQualifyingCompatible = s1.hasQualifyingBattle && s2.hasQualifyingBattle && (sig1 === sig2);
    const isLullCompatible = !s1.hasQualifyingBattle && !s2.hasQualifyingBattle;

    if (isQualifyingCompatible || isLullCompatible) {
      intervalsCount++;
      const isOpen = isQualifyingCompatible;
      const sig = isOpen ? sig1 : "lull";
      const battles = isOpen ? (s1.qualifyingBattles || []) : [];

      if (
        currentSegment &&
        currentSegment.isOpen === isOpen &&
        currentSegment.signature === sig &&
        currentSegment.endMs === s1.timestampMs
      ) {
        // Extend existing compatible segment
        currentSegment.endMs = s2.timestampMs;
        currentSegment.durationMs += deltaMs;
        currentSegment.sampleCount++;
      } else {
        // Close previous segment if exists
        if (currentSegment) {
          currentSegment.durationHours = Math.round((currentSegment.durationMs / 3600000) * 1000) / 1000;
          segments.push(currentSegment);
        }
        // Start new confirmed segment
        currentSegment = {
          isOpen,
          startMs: s1.timestampMs,
          endMs: s2.timestampMs,
          durationMs: deltaMs,
          durationHours: Math.round((deltaMs / 3600000) * 1000) / 1000,
          qualifyingBattles: battles,
          signature: sig,
          sampleCount: 2,
        };
      }
    } else {
      // Incompatible consecutive samples: transition interval (e.g. battle -> lull, lull -> battle, or side change)
      // Neither state is confirmed across the full interval.
      // Close any active confirmed segment.
      if (currentSegment) {
        currentSegment.durationHours = Math.round((currentSegment.durationMs / 3600000) * 1000) / 1000;
        segments.push(currentSegment);
        currentSegment = null;
      }
    }
  }

  if (currentSegment) {
    currentSegment.durationHours = Math.round((currentSegment.durationMs / 3600000) * 1000) / 1000;
    segments.push(currentSegment);
  }

  const windows = segments.filter(s => s.isOpen);
  const lulls = segments.filter(s => !s.isOpen);

  let qualifyingObservedMs = 0;
  for (const w of windows) qualifyingObservedMs += w.durationMs;

  let lullObservedMs = 0;
  for (const l of lulls) lullObservedMs += l.durationMs;

  let unknownOfflineMs = 0;
  for (const g of unobservedGaps) unknownOfflineMs += g.durationMs;

  const knownObservedMs = qualifyingObservedMs + lullObservedMs;
  const firstMs = samples[0].timestampMs;
  const lastMs = samples[samples.length - 1].timestampMs;
  const wallClockMs = lastMs - firstMs;

  return {
    segments,
    windows,
    lulls,
    unobservedGaps,
    medianIntervalMs,
    knownObservedMs,
    qualifyingObservedMs,
    lullObservedMs,
    unknownOfflineMs,
    wallClockMs,
    hasEstablishedIntervals: intervalsCount > 0,
    intervalsCount,
    currentState,
  };
}

/**
 * Format milliseconds into human readable "Xh Ym" or "Xd Yh"
 */
export function formatDuration(ms) {
  if (!ms || ms <= 0) return "0m";
  const totalMinutes = Math.round(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;

  if (days >= 2) {
    return `${days}d ${remHours}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

/**
 * Calculate comprehensive telemetry metrics, confidence, and context breakdown
 * 
 * Confidence scale strictly uses ACTUALLY OBSERVED duration (knownObservedHours):
 * < 24h: VERY LOW
 * 1-3 days (24-72h): LOW
 * 3-7 days (72-168h): MODERATE
 * 7-14 days (168-336h): HIGH
 * 14+ days (336h+): VERY HIGH
 * 
 * Coverage Denominator Formula:
 * coverage = Qualifying Time / Actually Observed Time (Known Time)
 * Unknown/offline periods are strictly excluded from the denominator.
 * 
 * @param {Array} samples
 * @param {Object} options - { currentContext: { countryId, muId } }
 */
export function calculateObservedAvailability(samples, options = {}) {
  const context = options.context || options.currentContext || null;
  if (context && !context.all && samples?.length > 0) {
    assertContextUniformity(samples, context);
  }

  if (!samples || samples.length === 0) {
    return {
      hasTelemetry: false,
      totalSamples: 0,
      qualifyingSamples: 0,
      observedCoveragePct: null,
      coverageDisplay: "Insufficient data",
      sampleCoveragePct: 0,
      wallClockDays: 0,
      wallClockHours: 0,
      actualObservedDays: 0,
      actualObservedHours: 0,
      confirmedHistoricalDuration: "0m",
      qualifyingDurationHours: 0,
      lullDurationHours: 0,
      unknownDurationHours: 0,
      unknownDurationDays: 0,
      longestQualifyingWindow: "Not yet established",
      longestQualifyingWindowMs: 0,
      windowDuration: "Not yet established",
      longestLull: "Not yet established",
      longestLullMs: 0,
      distinctBattleWindowsCount: 0,
      confidence: "VERY LOW",
      isSufficient: false,
      hasEstablishedIntervals: false,
      currentState: "No telemetry data",
      coverageByHourOfDay: Array(24).fill(0).map((_, h) => ({ hour: h, qualifying: 0, total: 0, coveragePct: 0 })),
      coverageByDay: [],
      windowsTimeline: [],
      contexts: [],
      syntheticDetectedInLive: Boolean(samples?.syntheticDetectedInLive),
    };
  }

  const totalSamples = samples.length;
  const qualifyingSamples = samples.filter(s => s.hasQualifyingBattle).length;
  const sampleCoveragePct = Math.round((qualifyingSamples / totalSamples) * 1000) / 10;

  // Reconstruct windows
  const recon = reconstructWindows(samples, options);

  const actualObservedHours = Math.round((recon.knownObservedMs / 3600000) * 10) / 10;
  const actualObservedDays = Math.round((recon.knownObservedMs / 86400000) * 10) / 10;
  const wallClockHours = Math.round((recon.wallClockMs / 3600000) * 10) / 10;
  const wallClockDays = Math.round((recon.wallClockMs / 86400000) * 10) / 10;
  const qualifyingHours = Math.round((recon.qualifyingObservedMs / 3600000) * 10) / 10;
  const lullHours = Math.round((recon.lullObservedMs / 3600000) * 10) / 10;
  const unknownHours = Math.round((recon.unknownOfflineMs / 3600000) * 10) / 10;
  const unknownDays = Math.round((recon.unknownOfflineMs / 86400000) * 10) / 10;

  const hasEstablishedIntervals = recon.hasEstablishedIntervals;

  // Coverage over KNOWN observed time
  // Do not report 100% historical coverage until at least one real time interval exists between live samples
  const observedCoveragePct = hasEstablishedIntervals && recon.knownObservedMs > 0
    ? Math.round((recon.qualifyingObservedMs / recon.knownObservedMs) * 1000) / 10
    : null;
  const coverageDisplay = hasEstablishedIntervals && observedCoveragePct !== null
    ? `${observedCoveragePct}%`
    : "Insufficient data";

  // Longest window and lull
  let maxWindowMs = 0;
  for (const w of recon.windows) {
    if (w.durationMs > maxWindowMs) maxWindowMs = w.durationMs;
  }

  let maxLullMs = 0;
  for (const l of recon.lulls) {
    if (l.durationMs > maxLullMs) maxLullMs = l.durationMs;
  }

  const longestQualifyingWindow = hasEstablishedIntervals && recon.windows.length > 0
    ? formatDuration(maxWindowMs)
    : "Not yet established";

  const windowDuration = longestQualifyingWindow;

  const longestLull = hasEstablishedIntervals && recon.lulls.length > 0
    ? formatDuration(maxLullMs)
    : (hasEstablishedIntervals ? "0m" : "Not yet established");

  const confirmedHistoricalDuration = formatDuration(recon.knownObservedMs);

  // Confidence based strictly on ACTUALLY OBSERVED duration
  // Keep the current VERY LOW confidence guard when insufficient (< 24h)
  let confidence = "VERY LOW";
  if (hasEstablishedIntervals) {
    if (actualObservedHours >= 336) { // 14+ days
      confidence = "VERY HIGH";
    } else if (actualObservedHours >= 168) { // 7-14 days
      confidence = "HIGH";
    } else if (actualObservedHours >= 72) { // 3-7 days
      confidence = "MODERATE";
    } else if (actualObservedHours >= 24) { // 1-3 days
      confidence = "LOW";
    } else {
      confidence = "VERY LOW";
    }
  }

  const isSufficient = hasEstablishedIntervals && actualObservedHours >= 24;

  // Hourly coverage breakdown: only populated when real intervals exist
  const hourBuckets = Array(24).fill(0).map((_, h) => ({ hour: h, qualifying: 0, total: 0 }));
  if (hasEstablishedIntervals) {
    for (const s of samples) {
      const h = new Date(s.timestamp).getHours();
      hourBuckets[h].total++;
      if (s.hasQualifyingBattle) hourBuckets[h].qualifying++;
    }
  }
  const coverageByHourOfDay = hourBuckets.map(b => ({
    hour: b.hour,
    qualifying: b.qualifying,
    total: b.total,
    coveragePct: b.total > 0 ? Math.round((b.qualifying / b.total) * 1000) / 10 : 0,
  }));

  // Daily coverage breakdown
  const dayBuckets = {};
  if (hasEstablishedIntervals) {
    for (const s of samples) {
      const d = s.timestamp.substring(0, 10);
      if (!dayBuckets[d]) dayBuckets[d] = { date: d, qualifying: 0, total: 0 };
      dayBuckets[d].total++;
      if (s.hasQualifyingBattle) dayBuckets[d].qualifying++;
    }
  }
  const coverageByDay = Object.values(dayBuckets).map(b => ({
    date: b.date,
    qualifying: b.qualifying,
    total: b.total,
    coveragePct: b.total > 0 ? Math.round((b.qualifying / b.total) * 1000) / 10 : 0,
  }));

  // Build sequential timeline of segments for event-based simulation
  const firstMs = samples[0].timestampMs;
  const windowsTimeline = recon.segments.map(seg => ({
    isOpen: seg.isOpen,
    startMs: seg.startMs,
    endMs: seg.endMs,
    startHour: Math.max(0, (seg.startMs - firstMs) / 3600000),
    endHour: Math.max(0, (seg.endMs - firstMs) / 3600000),
    durationHours: seg.durationHours,
    sampleCount: seg.sampleCount,
    qualifyingBattles: seg.qualifyingBattles,
    signature: seg.signature,
  }));

  // Context inventory
  const contextMap = {};
  for (const s of samples) {
    const key = `${s.playerCountryId || "none"}:${s.playerMuId || "none"}`;
    if (!contextMap[key]) {
      contextMap[key] = {
        countryId: s.playerCountryId,
        muId: s.playerMuId,
        count: 0,
        qualifyingCount: 0,
      };
    }
    contextMap[key].count++;
    if (s.hasQualifyingBattle) contextMap[key].qualifyingCount++;
  }
  const contexts = Object.values(contextMap);

  return {
    hasTelemetry: true,
    totalSamples,
    qualifyingSamples,
    observedCoveragePct,
    coverageDisplay,
    sampleCoveragePct,
    wallClockDays,
    wallClockHours,
    actualObservedDays,
    actualObservedHours,
    observationPeriodDays: actualObservedDays,
    totalObservedDurationHours: actualObservedHours,
    confirmedHistoricalDuration,
    qualifyingDurationHours: qualifyingHours,
    lullDurationHours: lullHours,
    unknownDurationHours: unknownHours,
    unknownDurationDays: unknownDays,
    longestQualifyingWindow,
    longestQualifyingWindowMs: maxWindowMs,
    windowDuration,
    longestLull,
    longestLullMs: maxLullMs,
    distinctBattleWindowsCount: recon.windows.length,
    confidence,
    isSufficient,
    hasEstablishedIntervals,
    currentState: recon.currentState,
    coverageByHourOfDay,
    coverageByDay,
    windowsTimeline,
    unobservedGapsCount: recon.unobservedGaps.length,
    contexts,
    context,
    currentContext: context,
    syntheticDetectedInLive: Boolean(samples?.syntheticDetectedInLive),
    firstObservationTimestamp: samples[0].timestamp,
    lastObservationTimestamp: samples[samples.length - 1].timestamp,
    samples,
  };
}

/**
 * Generate a realistic telemetry dataset for testing and demonstration
 * 
 * Writes EXCLUSIVELY to data/battle_availability/synthetic.jsonl.
 * Never touches telemetry.jsonl.
 * 
 * @param {number} days - Duration to seed in days (default: 8.2)
 * @param {Object} playerContext - { countryId, muId }
 */
export async function generateSeedTelemetry(days = 8.2, playerContext = {}, options = {}) {
  ensureTelemetryDir();
  const countryId = playerContext.countryId || null;
  const muId = playerContext.muId || null;

  const totalMs = days * 86400000;
  const stepMs = 300000; // 5 minutes
  const totalSteps = Math.floor(totalMs / stepMs);
  const startMs = Date.now() - totalMs;

  const records = [];
  let battleIdCounter = 1;

  for (let i = 0; i < totalSteps; i++) {
    const currentMs = startMs + i * stepMs;
    const hourOfCycle = ((i * stepMs) / 3600000) % 22;
    const isOpen = hourOfCycle < 8; // 8 hours open, 14 hours lull (36.4% coverage)

    const battleId = `6a9d${battleIdCounter.toString(16).padStart(4, "0")}36c1d8b39eb93416`;
    if (hourOfCycle === 0) battleIdCounter++;

    records.push({
      timestamp: new Date(currentMs).toISOString(),
      source: "synthetic",
      samplingIntervalMs: stepMs,
      playerCountryId: countryId,
      playerMuId: muId,
      qualifyingBattles: isOpen
        ? [{ battleId, side: "attacker", battleType: "resistance", roundId: `${battleId}r1` }]
        : [],
      hasQualifyingBattle: isOpen,
    });
  }

  const synthFile = options.filePath || getSyntheticFilePath();
  const fileContent = records.map(r => JSON.stringify(r)).join("\n") + "\n";
  await fs.promises.writeFile(synthFile, fileContent, "utf8");

  return {
    seededDays: days,
    samplesCount: records.length,
    filePath: synthFile,
  };
}
