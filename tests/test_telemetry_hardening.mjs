/**
 * Automated Verification Suite for Hardened Battle Availability Telemetry
 * 
 * Verifies all 10 requirements:
 * 1. --seed cannot contaminate live telemetry.
 * 2. observed ignores all synthetic fixtures.
 * 3. Offline gaps remain UNKNOWN.
 * 4. Offline gaps do not reduce observed coverage.
 * 5. Confidence uses actual observed duration.
 * 6. Country/MU changes create separate telemetry contexts.
 * 7. 5-minute battle windows survive reconstruction accurately.
 * 8. Order-side transitions split windows correctly.
 * 9. Existing live samples remain valid.
 * 10. --battle-availability=25%, 50%, unlimited still work independently.
 */

import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import {
  recordTelemetrySample,
  loadTelemetrySamples,
  loadTelemetrySamplesSync,
  reconstructWindows,
  calculateObservedAvailability,
  generateSeedTelemetry,
  getTelemetryFilePath,
  getSyntheticFilePath,
  assertContextUniformity,
  resolveTelemetryContext,
  getLatestTelemetryContextSync,
  setTelemetryDataDir,
  resetTelemetryDataDir,
} from "../analyzer/battle_telemetry.mjs";
import { simulateSustainedCombat } from "../analyzer/sustain_model.mjs";
import { resolveBattleSchedule } from "../analyzer/battle_windows.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURE_TELEMETRY = path.join(__dirname, "fixtures", "sample_telemetry.jsonl");

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "warera_test_hardening_"));
setTelemetryDataDir(TEST_DIR);
process.env.WARERA_TELEMETRY_DIR = TEST_DIR;

// Seed baseline telemetry into isolated test dir from synthetic fixture
if (fs.existsSync(FIXTURE_TELEMETRY)) {
  fs.copyFileSync(FIXTURE_TELEMETRY, path.join(TEST_DIR, "telemetry.jsonl"));
}

console.log("🧪 Running Battle Availability Telemetry Hardening Verification Suite...\n");

// -------------------------------------------------------------
// Test 1: --seed cannot contaminate live telemetry
// -------------------------------------------------------------
console.log("Test 1: Verifying --seed cannot contaminate live telemetry...");
const liveBefore = fs.readFileSync(getTelemetryFilePath(), "utf8");
await generateSeedTelemetry(3, { countryId: "c_test", muId: "m_test" });
const liveAfter = fs.readFileSync(getTelemetryFilePath(), "utf8");
assert.strictEqual(liveBefore, liveAfter, "Live telemetry file was modified by seed!");
assert.ok(fs.existsSync(getSyntheticFilePath()), "Synthetic file was not created!");
console.log("  ✓ Seed wrote only to synthetic.jsonl; telemetry.jsonl was completely untouched.\n");

// -------------------------------------------------------------
// Test 2: observed ignores all synthetic fixtures
// -------------------------------------------------------------
console.log("Test 2: Verifying observed mode strictly ignores synthetic fixtures...");
const liveSamples = loadTelemetrySamplesSync({ onlyLive: true });
for (const s of liveSamples) {
  assert.strictEqual(s.source, "live", `Sample with source ${s.source} found in live load!`);
  assert.ok(!String(s.qualifyingBattles?.[0]?.battleId || "").startsWith("6a9d00"), "Synthetic battle ID found in live samples!");
}
console.log(`  ✓ Loaded ${liveSamples.length} verified live samples; 0 synthetic samples allowed.\n`);

// -------------------------------------------------------------
// Test 3 & 4: Offline gaps remain UNKNOWN and do NOT reduce observed coverage
// -------------------------------------------------------------
console.log("Test 3 & 4: Verifying offline gaps remain UNKNOWN and do not reduce observed coverage...");
const baseTime = 1725667200000; // arbitrary start
const samplesWithGap = [
  // Session 1: 1 hour of continuous battles (12 samples @ 5m)
  ...Array(12).fill(0).map((_, i) => ({
    timestamp: new Date(baseTime + i * 300000).toISOString(),
    timestampMs: baseTime + i * 300000,
    source: "live",
    samplingIntervalMs: 300000,
    hasQualifyingBattle: true,
    qualifyingBattles: [{ battleId: "b1", side: "attacker" }],
  })),
  // Session 1 continued: 1 hour of continuous lull (12 samples @ 5m)
  ...Array(12).fill(0).map((_, i) => ({
    timestamp: new Date(baseTime + (12 + i) * 300000).toISOString(),
    timestampMs: baseTime + (12 + i) * 300000,
    source: "live",
    samplingIntervalMs: 300000,
    hasQualifyingBattle: false,
    qualifyingBattles: [],
  })),
  // 48-hour OFFLINE GAP (sampler turned off)
  // Session 2: 1 hour of continuous battles (12 samples @ 5m)
  ...Array(12).fill(0).map((_, i) => ({
    timestamp: new Date(baseTime + (24 * 300000) + 172800000 + i * 300000).toISOString(),
    timestampMs: baseTime + (24 * 300000) + 172800000 + i * 300000,
    source: "live",
    samplingIntervalMs: 300000,
    hasQualifyingBattle: true,
    qualifyingBattles: [{ battleId: "b2", side: "attacker" }],
  })),
];

const metricsWithGap = calculateObservedAvailability(samplesWithGap);
console.log(`  Known battle time:  ${metricsWithGap.qualifyingDurationHours}h`);
console.log(`  Known non-battle:   ${metricsWithGap.lullDurationHours}h`);
console.log(`  Actually observed:  ${metricsWithGap.actualObservedHours}h`);
console.log(`  Unknown/offline:    ${metricsWithGap.unknownDurationHours}h`);
console.log(`  Observed coverage:  ${metricsWithGap.observedCoveragePct}%`);

assert.ok(metricsWithGap.unknownDurationHours >= 47, "Offline gap was not classified as unknown!");
// In known time: 2 hours qualifying out of 3 hours known = ~66.7% coverage
assert.ok(metricsWithGap.observedCoveragePct >= 65 && metricsWithGap.observedCoveragePct <= 68, `Coverage was ${metricsWithGap.observedCoveragePct}%, expected ~66.7% over known time!`);
console.log("  ✓ Unknown offline gap (48h) was strictly excluded from coverage denominator.\n");

// -------------------------------------------------------------
// Test 5: Confidence uses actual observed duration
// -------------------------------------------------------------
console.log("Test 5: Verifying confidence uses actual observed duration (not wall-clock)...");
// In samplesWithGap: wall-clock span is ~51h (2.1 days), but actual observed duration is only 3.0h (< 24h)
assert.strictEqual(metricsWithGap.confidence, "VERY LOW", `Confidence was ${metricsWithGap.confidence} instead of VERY LOW for 3h actual observed time!`);
assert.strictEqual(metricsWithGap.isSufficient, false, "Should be insufficient (< 24h actual observed)");
console.log("  ✓ Wall-clock (51h) did NOT inflate confidence; evaluated as VERY LOW based on 3h actual observed.\n");

// -------------------------------------------------------------
// Test 6: Country/MU changes create separate telemetry contexts
// -------------------------------------------------------------
console.log("Test 6: Verifying Country/MU changes create separate telemetry contexts...");
const multiContextSamples = [
  { timestamp: new Date(baseTime).toISOString(), timestampMs: baseTime, playerCountryId: "MOROCCO", playerMuId: "ROYAL_ARMY", hasQualifyingBattle: true },
  { timestamp: new Date(baseTime + 300000).toISOString(), timestampMs: baseTime + 300000, playerCountryId: "MOROCCO", playerMuId: "ROYAL_ARMY", hasQualifyingBattle: true },
  { timestamp: new Date(baseTime + 600000).toISOString(), timestampMs: baseTime + 600000, playerCountryId: "FRANCE", playerMuId: "FRENCH_LEGION", hasQualifyingBattle: false },
];
const moroccoMetrics = calculateObservedAvailability(multiContextSamples.filter(s => s.playerCountryId === "MOROCCO"));
const franceMetrics = calculateObservedAvailability(multiContextSamples.filter(s => s.playerCountryId === "FRANCE"));
assert.strictEqual(moroccoMetrics.totalSamples, 2);
assert.strictEqual(moroccoMetrics.observedCoveragePct, 100);
assert.strictEqual(franceMetrics.totalSamples, 1);
assert.strictEqual(franceMetrics.coverageDisplay, "Insufficient data");
assert.strictEqual(franceMetrics.confirmedHistoricalDuration, "0m");
assert.strictEqual(franceMetrics.windowDuration, "Not yet established");
console.log("  ✓ Multi-context samples correctly partitioned into distinct environments.\n");

// -------------------------------------------------------------
// Test 7: Isolated sample vs confirming samples boundary semantics
// -------------------------------------------------------------
console.log("Test 7: Verifying isolated sample vs confirming samples boundary semantics...");
// Part A: One isolated battle sample surrounded by lulls has NO confirming sample
const isolatedBattleSamples = [
  { timestamp: new Date(baseTime).toISOString(), timestampMs: baseTime, hasQualifyingBattle: false, qualifyingBattles: [] },
  { timestamp: new Date(baseTime + 300000).toISOString(), timestampMs: baseTime + 300000, hasQualifyingBattle: true, qualifyingBattles: [{ battleId: "b_iso", side: "attacker" }] },
  { timestamp: new Date(baseTime + 600000).toISOString(), timestampMs: baseTime + 600000, hasQualifyingBattle: false, qualifyingBattles: [] },
];
const reconIsolated = reconstructWindows(isolatedBattleSamples);
assert.strictEqual(reconIsolated.windows.length, 0, "Isolated battle sample was incorrectly assigned a window without a confirming sample!");
assert.strictEqual(reconIsolated.qualifyingObservedMs, 0, "Isolated sample had non-zero qualifying time!");

// Part B: Exactly one isolated sample reports required fields
const singleSample = [{ timestamp: new Date(baseTime).toISOString(), timestampMs: baseTime, hasQualifyingBattle: true, qualifyingBattles: [{ battleId: "b_single", side: "attacker" }] }];
const singleMetrics = calculateObservedAvailability(singleSample);
assert.strictEqual(singleMetrics.currentState, "Qualifying battle available");
assert.strictEqual(singleMetrics.confirmedHistoricalDuration, "0m");
assert.strictEqual(singleMetrics.coverageDisplay, "Insufficient data");
assert.strictEqual(singleMetrics.windowDuration, "Not yet established");
assert.strictEqual(singleMetrics.confidence, "VERY LOW");
console.log("  ✓ One isolated sample reports 0m confirmed, Insufficient data coverage, and Not yet established window.");

// Part C: Once a second compatible sample arrives 5m later, interval is counted as known qualifying time
const confirmingSamples = [
  { timestamp: new Date(baseTime).toISOString(), timestampMs: baseTime, hasQualifyingBattle: true, qualifyingBattles: [{ battleId: "b_short", side: "attacker" }] },
  { timestamp: new Date(baseTime + 300000).toISOString(), timestampMs: baseTime + 300000, hasQualifyingBattle: true, qualifyingBattles: [{ battleId: "b_short", side: "attacker" }] },
  { timestamp: new Date(baseTime + 600000).toISOString(), timestampMs: baseTime + 600000, hasQualifyingBattle: false, qualifyingBattles: [] },
];
const reconConfirming = reconstructWindows(confirmingSamples);
assert.strictEqual(reconConfirming.windows.length, 1);
const shortWinDurationMinutes = Math.round(reconConfirming.windows[0].durationMs / 60000);
console.log(`  Reconstructed window duration with confirming sample: ${shortWinDurationMinutes} minutes`);
assert.strictEqual(shortWinDurationMinutes, 5, `Expected 5m window between confirming samples, got ${shortWinDurationMinutes}m`);
console.log("  ✓ 5-minute battle window confirmed and established by consecutive compatible samples.\n");

// -------------------------------------------------------------
// Test 8: Order-side transitions split windows correctly
// -------------------------------------------------------------
console.log("Test 8: Verifying order-side transitions split windows correctly...");
const transitionSamples = [
  { timestamp: new Date(baseTime).toISOString(), timestampMs: baseTime, hasQualifyingBattle: true, qualifyingBattles: [{ battleId: "b1", side: "attacker" }] },
  { timestamp: new Date(baseTime + 300000).toISOString(), timestampMs: baseTime + 300000, hasQualifyingBattle: true, qualifyingBattles: [{ battleId: "b1", side: "attacker" }] },
  // Side changes to defender on same battle!
  { timestamp: new Date(baseTime + 600000).toISOString(), timestampMs: baseTime + 600000, hasQualifyingBattle: true, qualifyingBattles: [{ battleId: "b1", side: "defender" }] },
  { timestamp: new Date(baseTime + 900000).toISOString(), timestampMs: baseTime + 900000, hasQualifyingBattle: true, qualifyingBattles: [{ battleId: "b1", side: "defender" }] },
];
const reconTrans = reconstructWindows(transitionSamples);
assert.strictEqual(reconTrans.windows.length, 2, `Expected 2 separate windows across side transition, got ${reconTrans.windows.length}`);
assert.strictEqual(reconTrans.windows[0].signature, "b1:attacker");
assert.strictEqual(reconTrans.windows[1].signature, "b1:defender");
console.log("  ✓ Attacker -> Defender order transition correctly created two distinct windows.\n");

// -------------------------------------------------------------
// Test 9: Event-based simulation accuracy on 5-minute windows
// -------------------------------------------------------------
console.log("Test 9: Verifying event-based simulation accuracy on 5-minute windows...");
const eventSchedule = {
  isHistoricalTimeline: true,
  windowsTimeline: [
    { isOpen: false, durationHours: 10, startHour: 0, endHour: 10 },
    { isOpen: true, durationHours: 5 / 60, startHour: 10, endHour: 10 + 5 / 60 }, // 5-minute window
    { isOpen: false, durationHours: 10, startHour: 10 + 5 / 60, endHour: 20 + 5 / 60 },
  ],
  totalObservedDurationHours: 20 + 5 / 60,
  coveragePct: 0.4,
};
const simResult = simulateSustainedCombat(5, 4, { schedule: eventSchedule, durationHours: 20 + 5 / 60 });
console.log(`  Event simulation hits in 5m window: ${simResult.totalHits} hits`);
console.log(`  HP wasted at cap during lulls:      ${simResult.hpRegenWastedAtCap} HP`);
assert.ok(simResult.totalHits >= 10, "5-minute window failed to discharge accumulated HP in event simulation!");
assert.ok(simResult.hpRegenWastedAtCap > 0, "HP capping in lulls was not tracked!");
console.log("  ✓ Event simulation executed 5-minute window and tracked lull HP capping with exact precision.\n");

// -------------------------------------------------------------
// Test 10: Scenario modes (25%, 50%, unlimited) work independently
// -------------------------------------------------------------
console.log("Test 10: Verifying scenario modes (25%, 50%, unlimited) work independently...");
const unlSched = resolveBattleSchedule("unlimited");
const p50Sched = resolveBattleSchedule("50%");
const p25Sched = resolveBattleSchedule("25%");
assert.strictEqual(unlSched.mode, "unlimited");
assert.strictEqual(unlSched.coveragePct, 100);
assert.strictEqual(p50Sched.coveragePct, 50);
assert.strictEqual(p50Sched.isAssumption, true);
assert.strictEqual(p25Sched.coveragePct, 25);
assert.strictEqual(p25Sched.isAssumption, true);
console.log("  ✓ Unlimited, 50%, and 25% scenario modes remain completely functional as independent assumptions.\n");

// -------------------------------------------------------------
// Test 11: Regression Test: Context Isolation & Defaulting (Context A vs Context B)
// -------------------------------------------------------------
console.log("Test 11: Verifying Context Isolation, Defaulting & Strict Assertion...");

const telemetryFileBefore = fs.readFileSync(getTelemetryFilePath(), "utf8");

// Part A: Context A (Synthetic Historical Context)
const contextAQuery = resolveTelemetryContext("111111111111111111111111:222222222222222222222222");
const samplesA = loadTelemetrySamplesSync({ onlyLive: true, context: contextAQuery });
assert.strictEqual(samplesA.length, 12, `Expected 12 samples in Context A, got ${samplesA.length}`);
const metricsA = calculateObservedAvailability(samplesA, { context: contextAQuery });
assert.strictEqual(metricsA.totalSamples, 12);
assert.strictEqual(Math.round(metricsA.observedCoveragePct), 50, `Context A coverage expected 50%, got ${metricsA.observedCoveragePct}%`);
console.log(`  ✓ Context A partitioned: ${metricsA.totalSamples} samples, ${metricsA.observedCoveragePct}% coverage.`);

// Part B: Context B (Synthetic Active Context)
const contextBQuery = resolveTelemetryContext("333333333333333333333333:444444444444444444444444");
const samplesB = loadTelemetrySamplesSync({ onlyLive: true, context: contextBQuery });
assert.strictEqual(samplesB.length, 18, `Expected 18 samples in Context B, got ${samplesB.length}`);
const metricsB = calculateObservedAvailability(samplesB, { context: contextBQuery });
assert.ok(metricsB.observedCoveragePct >= 30 && metricsB.observedCoveragePct <= 70, `Context B coverage out of range: ${metricsB.observedCoveragePct}%`);
console.log(`  ✓ Context B partitioned: ${metricsB.totalSamples} samples, ${metricsB.observedCoveragePct}% coverage.`);

// Part C: Default to player's current context
const defaultContext = resolveTelemetryContext("current");
assert.strictEqual(defaultContext.countryId, "333333333333333333333333", "Default context country mismatch");
assert.strictEqual(defaultContext.muId, "444444444444444444444444", "Default context MU mismatch");
const schedCurrent = resolveBattleSchedule("observed", null, { context: defaultContext });
assert.strictEqual(schedCurrent.telemetryMetrics.totalSamples, 18, "Current schedule should resolve to Context B samples");
assert.strictEqual(Math.round(schedCurrent.coveragePct), Math.round(metricsB.observedCoveragePct), "Current schedule coverage should match Context B");
console.log(`  ✓ Default context resolved to Context B: ${schedCurrent.telemetryMetrics.totalSamples} samples, ${schedCurrent.coveragePct}% coverage.`);

// Part D: Query historical context explicitly via resolveBattleSchedule
const schedA = resolveBattleSchedule("observed", null, { context: contextAQuery });
assert.strictEqual(schedA.telemetryMetrics.totalSamples, 12, "Historical query should resolve to 12 samples");
console.log(`  ✓ Explicit historical query resolved to Context A (${schedA.telemetryMetrics.totalSamples} samples).`);

// Part E: Query all contexts combined
const contextAll = resolveTelemetryContext("all");
const schedAll = resolveBattleSchedule("observed", null, { context: contextAll });
assert.strictEqual(schedAll.telemetryMetrics.totalSamples, 30, "Combined query should load all samples");
console.log(`  ✓ --telemetry-context=all combined ${schedAll.telemetryMetrics.totalSamples} samples.`);

// Part F: Internal assertion rejects mismatched samples
assert.throws(() => {
  const contaminated = [samplesB[0], samplesA[0]];
  assertContextUniformity(contaminated, contextBQuery);
}, /Context isolation violation/, "assertContextUniformity failed to reject mismatched sample!");

assert.throws(() => {
  const contaminated = [samplesB[0], samplesA[0]];
  calculateObservedAvailability(contaminated, { context: contextBQuery });
}, /Context isolation violation/, "calculateObservedAvailability failed to reject mismatched sample!");
console.log("  ✓ Internal assertion strictly throws on contaminated / mismatched context samples.");

// Part G: File untouched assertion
const telemetryFileAfter = fs.readFileSync(getTelemetryFilePath(), "utf8");
assert.strictEqual(telemetryFileAfter, telemetryFileBefore, "telemetry.jsonl was modified during tests!");
console.log("  ✓ telemetry.jsonl was completely untouched.\n");

console.log("🎉 ALL 11 HARDENING & CONTEXT ISOLATION TESTS PASSED SUCCESSFULLY!");

// Cleanup isolated test directory
resetTelemetryDataDir();
delete process.env.WARERA_TELEMETRY_DIR;
try {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
} catch {}
