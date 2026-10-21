#!/usr/bin/env node

/**
 * WarEra Daily Task Scheduler & Lock Verification Suite
 * 
 * Tests:
 * 1. Task XML generation defaults to PT10M (every 10 minutes)
 * 2. Task XML contains BootTrigger, LogonTrigger, and RestartOnFailure
 * 3. Task XML supports custom interval parameter
 * 4. Cross-host lock recovery (foreign hostname immediately recovered without process killing)
 * 5. Same-host active lock detection
 * 6. VBS silent runner generation
 * 7. Clean lock release
 */

import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import {
  TASK_NAME,
  acquireDailyLock,
  releaseDailyLock,
  generateDailyTaskXml,
  writeDailyVbsRunner,
  getDailyVbsPath,
  isPidAlive,
} from "../daily_task.mjs";

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

const TEST_DIR = path.join(os.tmpdir(), `warera_test_daily_${Date.now()}`);
const TEST_LOCK_FILE = path.join(TEST_DIR, "daily_automator.lock");

function setup() {
  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }
}

function cleanup() {
  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {}
}

async function test1_xmlIntervalAndTriggers() {
  console.log("\n📋 Test 1: Task XML 10-Minute Cadence & Resilience Triggers");
  console.log("  ─────────────────────────────────────────────────────────");

  const xml = generateDailyTaskXml();

  assertIncludes(xml, "<Interval>PT10M</Interval>", "XML repetition interval is PT10M (every 10 minutes)");
  assertIncludes(xml, "<BootTrigger>", "XML contains BootTrigger for headless boot startup");
  assertIncludes(xml, "<LogonTrigger>", "XML contains LogonTrigger for interactive session");
  assertIncludes(xml, "<RestartOnFailure>", "XML contains RestartOnFailure settings");
  assertIncludes(xml, "<Interval>PT1M</Interval>", "RestartOnFailure retry interval is PT1M");
  assertIncludes(xml, "<Count>3</Count>", "RestartOnFailure retry count is 3");
  assertIncludes(xml, "<ExecutionTimeLimit>PT15M</ExecutionTimeLimit>", "ExecutionTimeLimit is PT15M (tailored for 10m cadence)");
  assertIncludes(xml, "10-Minute Automator", "Task description indicates 10-Minute Automator");
}

async function test2_xmlCustomInterval() {
  console.log("\n📋 Test 2: Task XML Custom Interval Support");
  console.log("  ─────────────────────────────────────────────────────────");

  const xmlCustom = generateDailyTaskXml({ interval: "PT5M" });
  assertIncludes(xmlCustom, "<Interval>PT5M</Interval>", "Custom interval PT5M passed through correctly");
}

async function test3_crossHostLockRecovery() {
  console.log("\n📋 Test 3: Cross-Host Lock Recovery");
  console.log("  ─────────────────────────────────────────────────────────");

  // Create a lock from a foreign host
  const foreignHost = `${os.hostname().toUpperCase()}_REMOTE_HOST`;
  const foreignLock = {
    pid: 88888,
    startedAt: new Date().toISOString(),
    hostname: foreignHost,
  };
  fs.writeFileSync(TEST_LOCK_FILE, JSON.stringify(foreignLock, null, 2), "utf8");

  // Acquire lock: should immediately recover because host is foreign, regardless of PID
  const result = acquireDailyLock(TEST_LOCK_FILE);

  assert(result.acquired === true, "Lock acquired successfully despite foreign host lock");
  assert(result.staleRecovered === true, "staleRecovered is true");
  assert(result.crossHostRecovered === true, "crossHostRecovered is true");
  assertEqual(result.staleHostname, foreignHost, "staleHostname correctly identifies foreign host");
  assertEqual(result.stalePid, 88888, "stalePid correctly preserved");
  assertEqual(result.lock.pid, process.pid, "New lock holds current PID");
  assertEqual(result.lock.hostname, os.hostname(), "New lock holds current hostname");

  // Verify on-disk lock
  const onDisk = JSON.parse(fs.readFileSync(TEST_LOCK_FILE, "utf8"));
  assertEqual(onDisk.hostname, os.hostname(), "On-disk lock has current hostname");
  assertEqual(onDisk.pid, process.pid, "On-disk lock has current process PID");

  releaseDailyLock(TEST_LOCK_FILE, true);
}

async function test4_sameHostLocking() {
  console.log("\n📋 Test 4: Same-Host Active & Dead PID Lock Behavior");
  console.log("  ─────────────────────────────────────────────────────────");

  // 1. Acquire clean lock
  const res1 = acquireDailyLock(TEST_LOCK_FILE);
  assert(res1.acquired === true, "First acquisition on fresh file succeeds");

  // 2. Re-acquire by same process succeeds
  const res2 = acquireDailyLock(TEST_LOCK_FILE);
  assert(res2.acquired === true, "Re-acquisition by own PID succeeds");
  assertEqual(res2.staleRecovered, false, "staleRecovered is false for own PID");

  // 3. Fake a dead PID on same host
  const deadLock = {
    pid: 999998,
    startedAt: new Date(Date.now() - 3600000).toISOString(),
    hostname: os.hostname(),
  };
  fs.writeFileSync(TEST_LOCK_FILE, JSON.stringify(deadLock, null, 2), "utf8");

  const res3 = acquireDailyLock(TEST_LOCK_FILE);
  assert(res3.acquired === true, "Stale dead PID lock on same host is recovered");
  assert(res3.staleRecovered === true, "staleRecovered is true for dead PID");
  assertEqual(res3.crossHostRecovered, false, "crossHostRecovered is false for same host");
  assertEqual(res3.stalePid, 999998, "stalePid reported correctly");

  releaseDailyLock(TEST_LOCK_FILE, true);
}

async function test5_vbsRunnerGeneration() {
  console.log("\n📋 Test 5: Silent VBScript Runner Generation");
  console.log("  ─────────────────────────────────────────────────────────");

  const isolatedVbsPath = path.join(TEST_DIR, "run_daily_silent.vbs");
  const vbsPath = writeDailyVbsRunner({ mode: "nothing", vbsPath: isolatedVbsPath, projectDir: TEST_DIR });
  assert(fs.existsSync(vbsPath), "run_daily_silent.vbs created in isolated test directory");

  const content = fs.readFileSync(vbsPath, "utf8");
  assertIncludes(content, "WScript.Shell", "VBS contains WScript.Shell instantiation");
  assertIncludes(content, "daily_automator.mjs", "VBS invokes daily_automator.mjs");
  assertIncludes(content, "--headless", "VBS specifies --headless");
  assertIncludes(content, "--mode=nothing", "VBS specifies --mode=nothing");
  assertIncludes(content, "WshShell.Run cmd, 0, False", "VBS runs with SW_HIDE (window style 0)");
}

async function main() {
  console.log("\n╔══════════════════════════════════════════════════════╗");
  console.log("║  WarEra Daily Task Scheduler & Lock Test Suite       ║");
  console.log("╚══════════════════════════════════════════════════════╝");

  setup();

  try {
    await test1_xmlIntervalAndTriggers();
    await test2_xmlCustomInterval();
    await test3_crossHostLockRecovery();
    await test4_sameHostLocking();
    await test5_vbsRunnerGeneration();
  } catch (err) {
    console.error(`\n✗ FATAL ERROR: ${err.message}`);
    console.error(err.stack);
    failed++;
    failures.push(`FATAL: ${err.message}`);
  }

  cleanup();

  console.log("\n" + "═".repeat(54));
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  if (failures.length > 0) {
    console.log("  Failures:");
    for (const f of failures) {
      console.log(`    ✗ ${f}`);
    }
  }
  console.log("═".repeat(54));

  process.exit(failed > 0 ? 1 : 0);
}

main();
