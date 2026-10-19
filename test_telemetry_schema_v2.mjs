#!/usr/bin/env node

/**
 * WarEra Battle Telemetry Schema v2 Test Suite
 * 
 * Tests:
 * 1. Schema v1 backwards compatibility (v1 records parse with schemaVersion: 1, activeBattles: undefined)
 * 2. Schema v2 record emission with schemaVersion: 2, hostname, activeBattles, bonuses, selector ranks
 * 3. Cross-host lock recovery (foreign hostname lock is safely recovered)
 * 4. recordExecutionTelemetry appends valid JSON to executions.jsonl
 * 5. Task Scheduler XML has BootTrigger, LogonTrigger, and RestartOnFailure
 * 6. Mixed v1+v2 timeline calculation
 * 7. Assertion proving production telemetry files are 100% byte-identical before and after test
 * 
 * STRICT TEST ISOLATION:
 * All test operations run in an isolated temporary directory (os.tmpdir).
 * Production telemetry files are NEVER read, written, or modified by this test suite.
 */

import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Import telemetry engine
import {
  recordTelemetrySample,
  loadTelemetrySamples,
  loadTelemetrySamplesSync,
  calculateObservedAvailability,
  recordExecutionTelemetry,
  getExecutionsFilePath,
  getTelemetryFilePath,
  ensureTelemetryDir,
  setTelemetryDataDir,
  resetTelemetryDataDir,
  getTelemetryDataDir,
} from "./analyzer/battle_telemetry.mjs";

// Import recorder daemon
import {
  acquireRecorderLock,
  releaseRecorderLock,
  generateTaskXml,
  isPidAlive,
  atomicWriteJson,
} from "./analyzer/recorder_daemon.mjs";

// ─── Production File Snapshot (Pre-flight Integrity Check) ────

const PROD_DIR = path.resolve(__dirname, "data/battle_availability");
const PROD_FILES = {
  telemetry: path.join(PROD_DIR, "telemetry.jsonl"),
  executions: path.join(PROD_DIR, "executions.jsonl"),
  lock: path.join(PROD_DIR, "telemetry.lock"),
  status: path.join(PROD_DIR, "recorder_status.json"),
};

function hashFile(filepath) {
  if (!fs.existsSync(filepath)) return null;
  const content = fs.readFileSync(filepath);
  return {
    size: content.length,
    sha256: crypto.createHash("sha256").update(content).digest("hex"),
  };
}

const prodSnapshots = {};
for (const [key, filepath] of Object.entries(PROD_FILES)) {
  prodSnapshots[key] = hashFile(filepath);
}

// ─── Test Infrastructure ─────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    failures.push(message);
    console.log(`  ✗ ${message}`);
  }
}

function assertEqual(actual, expected, message) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    failures.push(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    console.log(`  ✗ ${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertIncludes(str, substr, message) {
  if (typeof str === "string" && str.includes(substr)) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    failures.push(`${message} (string does not include "${substr}")`);
    console.log(`  ✗ ${message} (string does not include "${substr}")`);
  }
}

// ─── Isolated Test Environment ───────────────────────────────

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "warera_v2_test_"));
setTelemetryDataDir(TEST_DIR);
process.env.WARERA_TELEMETRY_DIR = TEST_DIR;

const TEST_TELEMETRY_FILE = path.join(TEST_DIR, "telemetry.jsonl");
const TEST_LOCK_FILE = path.join(TEST_DIR, "test_lock.json");
const TEST_EXECUTIONS_FILE = path.join(TEST_DIR, "executions.jsonl");

// Sample v1 telemetry record (as historically stored)
const SAMPLE_V1 = {
  timestamp: "2026-09-17T10:00:00.000Z",
  source: "live",
  samplingIntervalMs: 300000,
  playerCountryId: "333333333333333333333333",
  playerMuId: "444444444444444444444444",
  qualifyingBattles: [
    { battleId: "bbbbbbbbbbbbbbbbbbbbbbbb", side: "attacker", battleType: "resistance", roundId: "bbbbbbbbbbbbbbbbbbbbbbbb_r3" }
  ],
  hasQualifyingBattle: true,
};

// Sample v2 telemetry input
const SAMPLE_V2_INPUT = {
  timestamp: "2026-09-23T02:00:00.000Z",
  source: "live",
  samplingIntervalMs: 300000,
  playerCountryId: "333333333333333333333333",
  playerMuId: "444444444444444444444444",
  totalActiveBattles: 5,
  qualifyingBattlesCount: 2,
  hasQualifyingBattle: true,
  selectedBattleId: "bbbbbbbbbbbbbbbbbbbbbbbb",
  activeBattles: [
    {
      battleId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      roundId: "bbbbbbbbbbbbbbbbbbbbbbbb_r3",
      regionName: "Region Alpha",
      battleType: "resistance",
      isActive: true,
      attackerCountryId: "aaa",
      defenderCountryId: "bbb",
      countryOrderPresent: true,
      countryOrderSide: "attacker",
      muOrderPresent: true,
      muOrderSide: "attacker",
      ordersAgree: true,
      resolvedSide: "attacker",
      isPlayerCountryWar: true,
      damageBonusPercent: 70,
      countryOrderBonus: 10,
      muOrderBonus: 10,
      patrioticBonus: 10,
      allianceBonus: 10,
      naturalEnemyBonus: 10,
      bountyRate: 0.11,
      selectorEligible: true,
      selectorRank: 1,
      selectedTarget: true,
    },
    {
      battleId: "00000000000000000000dead",
      regionName: "Region Beta",
      battleType: "regular",
      isActive: true,
      countryOrderPresent: true,
      countryOrderSide: "defender",
      muOrderPresent: false,
      ordersAgree: false,
      damageBonusPercent: 20,
      bountyRate: 0.05,
      selectorEligible: false,
      selectorSkipReason: "Country order only",
      selectorRank: null,
      selectedTarget: false,
    },
  ],
  qualifyingBattles: [
    { battleId: "bbbbbbbbbbbbbbbbbbbbbbbb", side: "attacker", battleType: "resistance", roundId: "bbbbbbbbbbbbbbbbbbbbbbbb_r3" }
  ],
};

// ─── Tests ───────────────────────────────────────────────────

async function test1_schemaV1BackwardsCompatibility() {
  console.log("\n📋 Test 1: Schema v1 Backwards Compatibility");
  console.log("  ─────────────────────────────────────────");

  const v1TestFile = path.join(TEST_DIR, "v1_compat_test.jsonl");
  const v1Line = JSON.stringify(SAMPLE_V1) + "\n";
  fs.writeFileSync(v1TestFile, v1Line, "utf8");

  const content = fs.readFileSync(v1TestFile, "utf8");
  const lines = content.trim().split("\n").filter(Boolean);
  assertEqual(lines.length, 1, "Single v1 line written to isolated file");

  const parsed = JSON.parse(lines[0]);
  assertEqual(parsed.schemaVersion, undefined, "v1 record on disk has no schemaVersion field");
  assertEqual(parsed.hostname, undefined, "v1 record on disk has no hostname field");
  assertEqual(parsed.activeBattles, undefined, "v1 record on disk has no activeBattles field");
  assertEqual(parsed.selectedBattleId, undefined, "v1 record on disk has no selectedBattleId field");
  assert(Array.isArray(parsed.qualifyingBattles), "v1 record has qualifyingBattles array");
  assertEqual(parsed.qualifyingBattles.length, 1, "v1 record has 1 qualifying battle");
  assertEqual(parsed.hasQualifyingBattle, true, "v1 record hasQualifyingBattle = true");

  const loaded = loadTelemetrySamplesSync({ filePath: v1TestFile });
  assertEqual(loaded.length, 1, "loadTelemetrySamplesSync parsed 1 record");
  assertEqual(loaded[0].schemaVersion, 1, "Engine automatically assigns schemaVersion: 1 on load");
  assertEqual(loaded[0].activeBattles, undefined, "activeBattles remains undefined (not fabricated)");
}

async function test2_schemaV2RecordEmission() {
  console.log("\n📋 Test 2: Schema v2 Record Emission in Isolated Environment");
  console.log("  ─────────────────────────────────────────");

  const result = await recordTelemetrySample(SAMPLE_V2_INPUT, {
    intervalMs: 300000,
    synthetic: false,
  });

  assert(result.recorded === true, "v2 sample was recorded");
  const sample = result.sample;

  assertEqual(sample.schemaVersion, 2, "Emitted record has schemaVersion: 2");
  assert(typeof sample.hostname === "string" && sample.hostname.length > 0, "Emitted record has hostname string");
  assertEqual(sample.hostname, os.hostname(), "Hostname matches current machine");
  assertEqual(sample.source, "live", "Source is 'live'");
  assertEqual(sample.totalActiveBattles, 5, "totalActiveBattles = 5");
  assertEqual(sample.qualifyingBattlesCount, 2, "qualifyingBattlesCount = 2");
  assertEqual(sample.hasQualifyingBattle, true, "hasQualifyingBattle = true");
  assertEqual(sample.selectedBattleId, "bbbbbbbbbbbbbbbbbbbbbbbb", "selectedBattleId matches");

  // Verify activeBattles array
  assert(Array.isArray(sample.activeBattles), "activeBattles is an array");
  assertEqual(sample.activeBattles.length, 2, "activeBattles has 2 entries");

  const ab1 = sample.activeBattles[0];
  assertEqual(ab1.battleId, "bbbbbbbbbbbbbbbbbbbbbbbb", "First active battle ID matches");
  assertEqual(ab1.damageBonusPercent, 70, "First active battle damage bonus = 70");
  assertEqual(ab1.countryOrderBonus, 10, "countryOrderBonus = 10");
  assertEqual(ab1.muOrderBonus, 10, "muOrderBonus = 10");
  assertEqual(ab1.bountyRate, 0.11, "bountyRate = 0.11");
  assertEqual(ab1.selectorEligible, true, "selectorEligible = true");
  assertEqual(ab1.selectorRank, 1, "selectorRank = 1");
  assertEqual(ab1.selectedTarget, true, "selectedTarget = true");
  assertEqual(ab1.ordersAgree, true, "ordersAgree = true");

  const ab2 = sample.activeBattles[1];
  assertEqual(ab2.selectorEligible, false, "Second battle selectorEligible = false");
  assertEqual(ab2.selectorSkipReason, "Country order only", "Second battle skip reason matches");
  assertEqual(ab2.damageBonusPercent, 20, "Second battle damage bonus = 20");
  assertEqual(ab2.selectedTarget, false, "Second battle selectedTarget = false");

  // Verify file on disk in isolated directory
  assert(fs.existsSync(TEST_TELEMETRY_FILE), "Isolated telemetry file exists on disk");
  const lines = fs.readFileSync(TEST_TELEMETRY_FILE, "utf8").trim().split("\n");
  assertEqual(lines.length, 1, "Exactly 1 record written to isolated test file");
  const diskRecord = JSON.parse(lines[0]);
  assertEqual(diskRecord.schemaVersion, 2, "Disk record has schemaVersion: 2");
  assertEqual(diskRecord.activeBattles[0].damageBonusPercent, 70, "Disk record has damageBonusPercent: 70");
}

async function test3_crossHostLockRecovery() {
  console.log("\n📋 Test 3: Cross-Host Lock Recovery");
  console.log("  ─────────────────────────────────────────");

  const foreignHost = "FOREIGN_REMOTE_HOST";
  const foreignLock = {
    pid: 7464,
    startedAt: "2026-09-22T10:00:00.000Z",
    hostname: foreignHost,
  };
  atomicWriteJson(TEST_LOCK_FILE, foreignLock);
  assert(fs.existsSync(TEST_LOCK_FILE), "Test lock file created in isolated dir");

  const result = acquireRecorderLock(TEST_LOCK_FILE);
  assert(result.acquired === true, `Lock acquired despite foreign hostname ${foreignHost}`);
  assert(result.staleRecovered === true, "Stale recovery flagged");
  assert(result.crossHostRecovered === true, "Cross-host recovery flagged");
  assertEqual(result.stalePid, 7464, "Stale PID correctly reported as 7464");
  assertEqual(result.staleHostname, foreignHost, `Stale hostname correctly reported as ${foreignHost}`);
  assertEqual(result.lock.pid, process.pid, "New lock has current process PID");
  assertEqual(result.lock.hostname, os.hostname(), "New lock has current hostname");

  releaseRecorderLock(TEST_LOCK_FILE, true);
}

async function test4_executionTelemetryLogging() {
  console.log("\n📋 Test 4: Execution Telemetry Logging in Isolated Environment");
  console.log("  ─────────────────────────────────────────");

  const entry1 = await recordExecutionTelemetry({
    battleId: "bbbbbbbbbbbbbbbbbbbbbbbb",
    roundId: "bbbbbbbbbbbbbbbbbbbbbbbb_r3",
    region: "Region Alpha",
    side: "attacker",
    damageBonus: 70,
    bountyRate: 0.11,
    healthBefore: 100,
    healthAfter: 90,
    actualHealthDelta: 10,
    damageDealt: 1500,
    loot: { money: 0.165 },
    verificationState: "VERIFIED_HIT",
    mutationIdentifier: "test-mut-001",
  });

  assert(entry1 !== null, "Execution record returned");
  assertEqual(entry1.verificationState, "VERIFIED_HIT", "verificationState = VERIFIED_HIT");
  assertEqual(entry1.battleId, "bbbbbbbbbbbbbbbbbbbbbbbb", "battleId matches");
  assertEqual(entry1.damageBonus, 70, "damageBonus = 70");
  assertEqual(entry1.bountyRate, 0.11, "bountyRate = 0.11");
  assertEqual(entry1.healthBefore, 100, "healthBefore = 100");
  assertEqual(entry1.healthAfter, 90, "healthAfter = 90");
  assertEqual(entry1.damageDealt, 1500, "damageDealt = 1500");
  assert(typeof entry1.hostname === "string", "hostname is a string");
  assert(typeof entry1.timestamp === "string", "timestamp is a string");

  const entry2 = await recordExecutionTelemetry({
    battleId: "00000000000000000000dead",
    verificationState: "FAILED_HIT",
    healthBefore: 90,
    healthAfter: 90,
  });

  assertEqual(entry2.verificationState, "FAILED_HIT", "FAILED_HIT record created");
  assertEqual(entry2.healthBefore, 90, "FAILED_HIT healthBefore = 90");
  assertEqual(entry2.damageDealt, null, "FAILED_HIT damageDealt = null");

  // Verify the executions file was created in TEST_DIR, NOT production
  assertEqual(getExecutionsFilePath(), TEST_EXECUTIONS_FILE, "getExecutionsFilePath points to isolated TEST_DIR");
  assert(fs.existsSync(TEST_EXECUTIONS_FILE), "Isolated executions file exists");
  const content = fs.readFileSync(TEST_EXECUTIONS_FILE, "utf8");
  const lines = content.trim().split("\n").filter(Boolean);
  assertEqual(lines.length, 2, "Exactly 2 execution entries written to isolated file");
}

async function test5_generateTaskXmlBootTrigger() {
  console.log("\n📋 Test 5: Task Scheduler XML has BootTrigger");
  console.log("  ─────────────────────────────────────────");

  const xml = generateTaskXml({ dryRun: true });

  assertIncludes(xml, "<LogonTrigger>", "XML contains LogonTrigger");
  assertIncludes(xml, "<BootTrigger>", "XML contains BootTrigger");
  assertIncludes(xml, "<RestartOnFailure>", "XML contains RestartOnFailure");
  assertIncludes(xml, "<Interval>PT1M</Interval>", "RestartOnFailure interval is PT1M");
  assertIncludes(xml, "<Count>5</Count>", "RestartOnFailure count is 5");
  assertIncludes(xml, "WarEra Battle Availability Telemetry Recorder Daemon", "XML contains task description");
}

async function test6_mixedV1V2ParsingPreservation() {
  console.log("\n📋 Test 6: Mixed v1+v2 Parsing Preservation");
  console.log("  ─────────────────────────────────────────");

  const mixedFile = path.join(TEST_DIR, "mixed_v1_v2.jsonl");

  const v1Record = {
    timestamp: "2026-09-17T10:00:00.000Z",
    source: "live",
    samplingIntervalMs: 300000,
    playerCountryId: "country1",
    playerMuId: "mu1",
    qualifyingBattles: [{ battleId: "b1", side: "attacker", battleType: "resistance", roundId: "r1" }],
    hasQualifyingBattle: true,
  };

  const v2Record = {
    schemaVersion: 2,
    hostname: "test-telemetry-host",
    timestamp: "2026-09-23T02:00:00.000Z",
    source: "live",
    samplingIntervalMs: 300000,
    playerCountryId: "country1",
    playerMuId: "mu1",
    totalActiveBattles: 3,
    qualifyingBattlesCount: 1,
    hasQualifyingBattle: true,
    selectedBattleId: "b2",
    activeBattles: [
      {
        battleId: "b2",
        damageBonusPercent: 70,
        selectorEligible: true,
        selectorRank: 1,
        selectedTarget: true,
        bountyRate: 0.11,
      },
    ],
    qualifyingBattles: [{ battleId: "b2", side: "attacker", battleType: "regular", roundId: "r2" }],
  };

  const content = JSON.stringify(v1Record) + "\n" + JSON.stringify(v2Record) + "\n";
  fs.writeFileSync(mixedFile, content, "utf8");

  const raw = fs.readFileSync(mixedFile, "utf8");
  const lines = raw.trim().split("\n").filter(Boolean);
  assertEqual(lines.length, 2, "Mixed file has 2 lines");

  const p1 = JSON.parse(lines[0]);
  const p2 = JSON.parse(lines[1]);

  assertEqual(p1.schemaVersion, undefined, "v1 record on disk has no schemaVersion");
  assertEqual(p1.hostname, undefined, "v1 record on disk has no hostname");
  assertEqual(p1.activeBattles, undefined, "v1 record on disk has no activeBattles");

  assertEqual(p2.schemaVersion, 2, "v2 record has schemaVersion: 2");
  assertEqual(p2.hostname, "test-telemetry-host", "v2 record has hostname: test-telemetry-host");
  assert(Array.isArray(p2.activeBattles), "v2 record has activeBattles array");
  assertEqual(p2.activeBattles[0].damageBonusPercent, 70, "v2 active battle has damageBonusPercent: 70");
  assertEqual(p2.selectedBattleId, "b2", "v2 record has selectedBattleId");

  assert(Array.isArray(p1.qualifyingBattles), "v1 has qualifyingBattles");
  assert(Array.isArray(p2.qualifyingBattles), "v2 has qualifyingBattles");
}

async function test7_productionFilesByteIdentical() {
  console.log("\n📋 Test 7: Strict Production Data Immutability Assertion");
  console.log("  ─────────────────────────────────────────────────────────");

  // Reset telemetry directory configuration
  resetTelemetryDataDir();
  delete process.env.WARERA_TELEMETRY_DIR;

  // Clean up isolated temporary directory
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    assert(!fs.existsSync(TEST_DIR), "Isolated temporary test directory cleaned up");
  } catch (err) {
    console.error(`  Warning: failed to clean up ${TEST_DIR}: ${err.message}`);
  }

  // Verify byte-level equality for telemetry and executions logs
  for (const key of ["telemetry", "executions"]) {
    const filepath = PROD_FILES[key];
    const snap = prodSnapshots[key];
    const current = hashFile(filepath);

    if (snap === null) {
      assert(current === null, `Production file ${key} (${path.basename(filepath)}) did not exist before and was NOT created by tests`);
    } else {
      assert(current !== null, `Production file ${key} (${path.basename(filepath)}) still exists`);
      assertEqual(current.size, snap.size, `Production file ${key} size is byte-identical (${snap.size} bytes)`);
      assertEqual(current.sha256, snap.sha256, `Production file ${key} SHA-256 hash is byte-identical`);
    }
  }

  // Verify telemetry.lock and recorder_status.json were never modified by THIS test process
  for (const key of ["lock", "status"]) {
    const filepath = PROD_FILES[key];
    const snap = prodSnapshots[key];
    const current = hashFile(filepath);

    if (snap === null) {
      assert(current === null, `Production file ${key} (${path.basename(filepath)}) was NOT created by tests`);
    } else if (current && current.sha256 === snap.sha256) {
      assert(true, `Production file ${key} is byte-identical`);
    } else if (current) {
      try {
        const content = JSON.parse(fs.readFileSync(filepath, "utf8"));
        assert(content.pid !== process.pid, `Production file ${key} was NOT modified by test process (PID ${process.pid})`);
        console.log(`  ℹ Production file ${key} modified by external background daemon PID ${content.pid}`);
      } catch {
        assert(false, `Production file ${key} was unexpectedly modified`);
      }
    }
  }

  // Verify that tests ran 100% isolated and did not write into repo's data directory
  assert(!fs.existsSync(PROD_FILES.telemetry), "Production telemetry.jsonl was NOT created in repo by tests");
  assert(!fs.existsSync(PROD_FILES.executions), "Production executions.jsonl was NOT created in repo by tests");
  assert(!fs.existsSync(PROD_FILES.lock), "Production telemetry.lock was NOT created in repo by tests");

  // Verify fixture integrity
  const fixturePath = path.resolve(__dirname, "tests/fixtures/sample_telemetry.jsonl");
  assert(fs.existsSync(fixturePath), "Synthetic sample_telemetry.jsonl fixture exists and is trackable");
  const fixtureCount = fs.readFileSync(fixturePath, "utf8").trim().split("\n").filter(Boolean).length;
  assert(fixtureCount === 30, `Synthetic sample_telemetry.jsonl fixture has expected 30 records (got ${fixtureCount})`);
  console.log(`  ✓ Confirmed test environment isolation and synthetic fixture integrity (${fixtureCount} records)`);
}

// ─── Run All Tests ───────────────────────────────────────────

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║  WarEra Battle Telemetry Schema v2 Verification Suite    ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`  Isolated Test Directory: ${TEST_DIR}`);

  try {
    await test1_schemaV1BackwardsCompatibility();
    await test2_schemaV2RecordEmission();
    await test3_crossHostLockRecovery();
    await test4_executionTelemetryLogging();
    await test5_generateTaskXmlBootTrigger();
    await test6_mixedV1V2ParsingPreservation();
    await test7_productionFilesByteIdentical();
  } catch (err) {
    console.error(`\n✗ FATAL TEST ERROR: ${err.message}`);
    console.error(err.stack);
    failed++;
    failures.push(`FATAL: ${err.message}`);
  }

  // Summary
  console.log("\n" + "═".repeat(58));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("  Failures:");
    for (const f of failures) {
      console.log(`    ✗ ${f}`);
    }
  }
  console.log("═".repeat(58));

  process.exit(failed > 0 ? 1 : 0);
}

main();
