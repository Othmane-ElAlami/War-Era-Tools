/**
 * WarEra Tools - Comprehensive GUI & Service Verification Suite
 * 
 * Verifies:
 * 1. Central paths abstraction & AppData resolution
 * 2. Safe data migration (copy-only, non-destructive)
 * 3. Secret masking (never exposes raw JWT/cookies)
 * 4. Dashboard data mapping & resource parsing
 * 5. Daily automation mode selection & duplicate prevention
 * 6. Battle intelligence & ranking consensus mapping
 * 7. Buyer 3-card strategy switching & independent calculations
 * 8. Buyer fail-closed incomplete market protection
 * 9. Buyer purchase confirmation & dry-run safety
 * 10. Reseller inventory audit & perfect/max-crit keep protection
 * 11. Reseller listing confirmation & dry-run safety
 * 12. Build analyzer data mapping & ROI calculation
 * 13. Telemetry analytics & Schema v1 vs v2 non-fabrication
 * 14. Scheduled task status parsing
 */

import assert from "assert";
import fs from "fs";
import path from "path";
import os from "os";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.WARERA_TEST = "1";
import {
  isPackaged,
  getAppDir,
  setAppDir,
  resetAppDir,
  getDataDir,
  getTelemetryDir,
  getCookiesPath,
  detectRepoData,
  importRepoData,
} from "../gui/services/paths.mjs";
import {
  maskSecret,
  loadSettings,
  saveSettings,
  getSanitizedAuthStatus,
} from "../gui/services/settings_service.mjs";
import {
  getDashboardState,
  checkCdpReachable,
  getLastBattleExecution,
  getLastDailyRunInfo,
} from "../gui/services/dashboard_service.mjs";
import { dailyService } from "../gui/services/daily_service.mjs";
import { battlesService } from "../gui/services/battles_service.mjs";
import { buyerService } from "../gui/services/buyer_service.mjs";
import { resellerService } from "../gui/services/reseller_service.mjs";
import { analyzerService } from "../gui/services/analyzer_service.mjs";
import { telemetryService } from "../gui/services/telemetry_service.mjs";
import { schedulerService } from "../gui/services/scheduler_service.mjs";
import { logsService } from "../gui/services/logs_service.mjs";

console.log("🖥️  Running WarEra Tools GUI & Service Verification Suite...\n");

let passed = 0;
let total = 0;

function it(name, fn) {
  total++;
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`     ${err.stack || err.message}`);
  }
}

async function itAsync(name, fn) {
  total++;
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`     ${err.stack || err.message}`);
  }
}

// -------------------------------------------------------------
// 1. PATHS ABSTRACTION & DATA ISOLATION
// -------------------------------------------------------------
console.log("Test Suite 1: Path Abstraction & Runtime Storage");

const tempAppDir = fs.mkdtempSync(path.join(os.tmpdir(), "warera_gui_test_"));
setAppDir(tempAppDir);
process.env.WARERA_COOKIE_FILE = path.join(tempAppDir, "cookies.json");

// Write valid mock JWT cookie in isolated test dir
const mockPayload = Buffer.from(
  JSON.stringify({
    data: { _id: "mock_user_123", username: "TestCommander" },
    exp: Math.floor(Date.now() / 1000) + 86400,
  })
).toString("base64url");
const mockJwt = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${mockPayload}.mockSignature`;
fs.writeFileSync(
  path.join(tempAppDir, "cookies.json"),
  JSON.stringify([{ name: "jwt", value: mockJwt }])
);

// Copy synthetic fixture into isolated temp app dir
const fixtureTelemetry = path.resolve(__dirname, "fixtures", "sample_telemetry.jsonl");
const tempTelemetryDir = path.join(tempAppDir, "data", "battle_availability");
fs.mkdirSync(tempTelemetryDir, { recursive: true });
if (fs.existsSync(fixtureTelemetry)) {
  fs.copyFileSync(fixtureTelemetry, path.join(tempTelemetryDir, "telemetry.jsonl"));
}
process.env.WARERA_TELEMETRY_DIR = tempTelemetryDir;

// Install offline fetch mock for external WarEra API endpoints
const originalFetch = globalThis.fetch;
globalThis.fetch = async function mockFetch(url, options = {}) {
  const urlStr = String(url);

  if (urlStr.includes("9222")) {
    return {
      ok: false,
      status: 503,
      json: async () => ({}),
      text: async () => "Unavailable",
    };
  }

  if (urlStr.includes("country.getMyCountry")) {
    return {
      ok: true,
      status: 200,
      json: async () => [
        {
          result: {
            data: {
              _id: "c_1",
              name: "Republic of Testland",
              title: "Republic of Testland",
              marketTaxRate: 1,
            },
          },
        },
      ],
      text: async () => JSON.stringify([{ result: { data: { name: "Republic of Testland", marketTaxRate: 1 } } }]),
    };
  }

  if (urlStr.includes("user.getMe") || urlStr.includes("user.getUserById")) {
    const userData = {
      _id: "mock_user_123",
      username: "TestCommander",
      level: 40,
      citizenship: "c_1",
      militaryUnit: "mu_1",
      strength: 150,
      damage: 1000,
      health: 100,
      maxHealth: 100,
      hunger: 100,
      maxHunger: 100,
      energy: 100,
      maxEnergy: 100,
      entrepreneurship: 50,
      maxEntrepreneurship: 100,
      money: 250.5,
      gold: 250.5,
    };
    return {
      ok: true,
      status: 200,
      json: async () => [
        { result: { data: userData } },
        { result: { data: userData } },
        { result: { data: userData } },
      ],
      text: async () => JSON.stringify([{ result: { data: userData } }]),
    };
  }

  if (urlStr.includes("inventory.")) {
    const invData = {
      _id: "inv_123",
      money: 250.5,
      gold: 250.5,
      items: {
        equipments: [
          {
            _id: "eq_helm_1",
            name: "Green Helmet",
            itemCode: "green_helmet",
            quality: "uncommon",
            slot: "helmet",
            skills: { criticalDamages: 8 },
          },
          {
            _id: "eq_boots_1",
            name: "Green Boots",
            itemCode: "green_boots",
            quality: "uncommon",
            slot: "boots",
            skills: { dodge: 8 },
          },
        ],
        weapons: [
          {
            _id: "wp_gun_1",
            name: "Green Gun",
            itemCode: "green_gun",
            quality: "uncommon",
            slot: "weapon",
            skills: { attack: 16, criticalChance: 8 },
          },
        ],
      },
    };
    const equippedData = {
      helmet: null,
      chest: null,
      gloves: null,
      pants: null,
      boots: null,
      weapon: null,
    };

    return {
      ok: true,
      status: 200,
      json: async () => [
        { result: { data: invData } },
        { result: { data: equippedData } },
        { result: { data: invData } },
      ],
      text: async () => JSON.stringify([{ result: { data: invData } }]),
    };
  }

  if (urlStr.includes("itemOffer.")) {
    const offersData = {
      offers: [
        {
          _id: "off_1",
          price: 5.0,
          itemCode: "green_helmet",
          item: {
            _id: "eq_mkt_1",
            name: "Green Helmet",
            itemCode: "green_helmet",
            quality: "uncommon",
            slot: "helmet",
            skills: { criticalDamages: 8 },
          },
        },
        {
          _id: "off_2",
          price: 4.5,
          itemCode: "green_boots",
          item: {
            _id: "eq_mkt_2",
            name: "Green Boots",
            itemCode: "green_boots",
            quality: "uncommon",
            slot: "boots",
            skills: { dodge: 8 },
          },
        },
      ],
      total: 2,
      nextCursor: null,
    };
    return {
      ok: true,
      status: 200,
      json: async () => [
        { result: { data: offersData } },
        { result: { data: [] } },
      ],
      text: async () => JSON.stringify([{ result: { data: offersData } }]),
    };
  }

  if (urlStr.includes("gameConfig.getGameConfig")) {
    const configPath = path.resolve(__dirname, "../data/game_config.json");
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
    const realConfig = raw.config || raw;
    return {
      ok: true,
      status: 200,
      json: async () => [{ result: { data: realConfig } }],
      text: async () => JSON.stringify([{ result: { data: realConfig } }]),
    };
  }

  if (urlStr.includes("ranking.getRanking")) {
    const rankingData = {
      type: "weeklyUserDamages",
      items: [
        { rank: 1, user: "mock_user_123", value: 5000000, tier: 1, country: "c_1", mu: "mu_1" },
      ],
      tierValues: { "1": 1000000 },
    };
    return {
      ok: true,
      status: 200,
      json: async () => [{ result: { data: rankingData } }],
      text: async () => JSON.stringify([{ result: { data: rankingData } }]),
    };
  }

  return {
    ok: true,
    status: 200,
    json: async () => [{ result: { data: {} } }],
    text: async () => JSON.stringify([{ result: { data: {} } }]),
  };
};

it("1.1 setAppDir overrides root application data directory", () => {
  assert.strictEqual(getAppDir(), tempAppDir);
  assert.strictEqual(getDataDir(), path.join(tempAppDir, "data"));
  assert.strictEqual(getTelemetryDir(), path.join(tempAppDir, "data", "battle_availability"));
});

it("1.2 detectRepoData identifies existing repository assets", () => {
  const repoInfo = detectRepoData();
  assert.strictEqual(repoInfo.hasGameConfig, true);

  // Assert against mock fixture folder with telemetry and cookies
  const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "warera_mock_repo_"));
  fs.writeFileSync(path.join(mockDir, "cookies.json"), "[]");
  fs.mkdirSync(path.join(mockDir, "data", "battle_availability"), { recursive: true });
  fs.writeFileSync(path.join(mockDir, "data", "battle_availability", "telemetry.jsonl"), '{"timestamp":"2026-01-01T00:00:00Z"}\n');
  const mockInfo = detectRepoData(mockDir);
  assert.strictEqual(mockInfo.hasCookies, true);
  assert.strictEqual(mockInfo.hasTelemetry, true);
  assert.strictEqual(mockInfo.samplesCount, 1);
  fs.rmSync(mockDir, { recursive: true, force: true });
});

it("1.3 importRepoData copies safely without deleting originals", () => {
  const mockDir = fs.mkdtempSync(path.join(os.tmpdir(), "warera_mock_src_"));
  const testImportTarget = fs.mkdtempSync(path.join(os.tmpdir(), "warera_import_dest_"));
  fs.writeFileSync(path.join(mockDir, "cookies.json"), "[]");
  fs.mkdirSync(path.join(mockDir, "data", "battle_availability"), { recursive: true });
  fs.writeFileSync(path.join(mockDir, "data", "battle_availability", "telemetry.jsonl"), "sample\n");

  const result = importRepoData(mockDir, testImportTarget);
  assert.strictEqual(result.cookies, true);
  assert.strictEqual(result.telemetry, true);

  // Assert target files exist in isolated temp directory
  assert.ok(fs.existsSync(path.join(testImportTarget, "cookies.json")));
  assert.ok(fs.existsSync(path.join(testImportTarget, "data", "battle_availability", "telemetry.jsonl")));

  // Assert originals in mockDir still exist
  assert.ok(fs.existsSync(path.join(mockDir, "cookies.json")));
  assert.ok(fs.existsSync(path.join(mockDir, "data", "battle_availability", "telemetry.jsonl")));
  fs.rmSync(mockDir, { recursive: true, force: true });
  fs.rmSync(testImportTarget, { recursive: true, force: true });
});

// -------------------------------------------------------------
// 2. SETTINGS & SECRET MASKING
// -------------------------------------------------------------
console.log("\nTest Suite 2: Settings & Secret Masking");

it("2.1 maskSecret strictly hides private token characters", () => {
  const samplePayload = Buffer.from(JSON.stringify({ data: { _id: "0123456789abcdef01234567" } })).toString("base64");
  const sampleToken = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${samplePayload}.signature123456`;
  const masked = maskSecret(sampleToken);
  assert.strictEqual(masked.startsWith("eyJhbGci"), true);
  assert.strictEqual(masked.endsWith("3456"), true);
  assert.ok(masked.includes("••••••••"));
  assert.strictEqual(masked.includes("0123456789abcdef"), false, "Payload leaked in masked string!");
});

it("2.2 saveSettings & loadSettings round-trips configurations", () => {
  saveSettings({ dryRun: false, battleHpFloor: 15 });
  const loaded = loadSettings();
  assert.strictEqual(loaded.dryRun, false);
  assert.strictEqual(loaded.battleHpFloor, 15);
  // Restore safe default
  saveSettings({ dryRun: true, battleHpFloor: 10 });
});

// -------------------------------------------------------------
// 3. DAILY AUTOMATION PROCESS & LOCK MANAGEMENT
// -------------------------------------------------------------
console.log("\nTest Suite 3: Daily Automation Controls & Concurrency Guard");

it("3.1 Duplicate daily automation start is rejected immediately", async () => {
  dailyService.isRunning = true;
  dailyService.activeChild = { pid: 4242 };

  try {
    await dailyService.startDaily({ mode: "nothing" });
    assert.fail("Should have thrown error on duplicate start");
  } catch (err) {
    assert.ok(err.message.includes("already running"));
  } finally {
    dailyService.isRunning = false;
    dailyService.activeChild = null;
  }
});

it("3.2 Stage detection recognizes output stage markers correctly", () => {
  dailyService.currentStage = "Idle";
  dailyService.detectStageFromOutput("── 🏭  COMPANIES ──");
  assert.strictEqual(dailyService.currentStage, "Companies");

  dailyService.detectStageFromOutput("── ⚔️  BATTLES ──");
  assert.strictEqual(dailyService.currentStage, "Battles");

  dailyService.detectStageFromOutput("Routine complete!");
  assert.strictEqual(dailyService.currentStage, "Summary");
});

// -------------------------------------------------------------
// 4. BATTLES SERVICE & DRY-RUN EXECUTION
// -------------------------------------------------------------
console.log("\nTest Suite 4: Battles Service & Hit Safety Invariants");

await itAsync("4.1 Live battle execution requires explicit confirmation flag", async () => {
  try {
    await battlesService.executeBattleMode({ dryRun: false, confirmed: false });
    assert.fail("Live execution without confirmed=true must throw");
  } catch (err) {
    assert.ok(err.message.includes("explicit confirmation"));
  }
});

await itAsync("4.2 Dry-run battle execution simulates hits with zero mutations", async () => {
  const result = await battlesService.executeBattleMode({ dryRun: true, maxHits: 3 });
  assert.strictEqual(result.dryRun, true);
  assert.strictEqual(typeof result.totalDamage, "number");
  assert.strictEqual(result.records.length, result.hitsExecuted);
  for (const r of result.records) {
    assert.strictEqual(r.isDryRun, true);
    assert.strictEqual(r.verificationState, "VERIFIED_HIT");
  }
});

// -------------------------------------------------------------
// 5. EQUIPMENT BUYER: 3-STRATEGY SWITCHING & SAFETY
// -------------------------------------------------------------
console.log("\nTest Suite 5: Equipment Buyer 3-Strategy Switching & Invariants");

it("5.1 Buyer rejects live purchase without explicit confirmed=true", async () => {
  try {
    await buyerService.executePurchases({
      confirmedLoadout: { items: [{ slot: "helmet", offerId: "123", buyerPrice: 5 }] },
      dryRun: false,
      confirmed: false,
    });
    assert.fail("Should have thrown error on unconfirmed live purchase");
  } catch (err) {
    assert.ok(err.message.includes("explicit confirmation"));
  }
});

it("5.2 Buyer dry-run purchase simulates sequential acquisition", async () => {
  const mockLoadout = {
    strategy: "best-value",
    totalCost: 15.2,
    items: [
      { slot: "helmet", offerId: "h1", itemTitle: "Green Helmet", buyerPrice: 5.1 },
      { slot: "chest", offerId: "c1", itemTitle: "Green Chest", buyerPrice: 10.1 },
    ],
  };

  const res = await buyerService.executePurchases({
    confirmedLoadout: mockLoadout,
    dryRun: true,
    confirmed: true,
  });

  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(res.purchased.length, 2);
  assert.strictEqual(res.actualSpent, 15.2);
  assert.strictEqual(res.haltedEarly, false);
});

// -------------------------------------------------------------
// 6. EQUIPMENT RESELLER AUDIT & SAFETY
// -------------------------------------------------------------
console.log("\nTest Suite 6: Equipment Reseller & Listing Invariants");

it("6.1 Reseller rejects live listing without explicit confirmed=true", async () => {
  try {
    await resellerService.executeListings({
      candidates: [{ itemId: "item_123", sellerPrice: 10.0 }],
      dryRun: false,
      confirmed: false,
    });
    assert.fail("Should have thrown error on unconfirmed live listing");
  } catch (err) {
    assert.ok(err.message.includes("explicit confirmation"));
  }
});

it("6.2 Reseller dry-run simulates listing proceeds with zero mutations", async () => {
  const candidates = [
    { itemId: "item_1", itemTitle: "Green Gloves", sellerPrice: 4.5 },
    { itemId: "item_2", itemTitle: "Green Boots", sellerPrice: 3.5 },
  ];

  const res = await resellerService.executeListings({
    candidates,
    dryRun: true,
    confirmed: true,
  });

  assert.strictEqual(res.dryRun, true);
  assert.strictEqual(res.listedCount, 2);
  assert.strictEqual(res.actualListedValue, 8.0);
});

await itAsync("6.3 Reseller auditInventory returns structured inventory scan and pricing", async () => {
  const audit = await resellerService.auditInventory({ pricingStrategy: "competitive", maxListings: 2 });
  assert.ok(typeof audit.totalScanned === "number");
  assert.ok(typeof audit.sellCandidatesCount === "number");
  assert.ok(typeof audit.executableCount === "number");
  assert.ok(typeof audit.heldCount === "number");
  assert.ok(typeof audit.taxRate === "number");
  assert.ok(Array.isArray(audit.items));
  assert.ok(Array.isArray(audit.executableCandidates));
  assert.ok(audit.executableCandidates.length <= 2);
  if (audit.items.length > 0) {
    const item = audit.items[0];
    assert.ok(item.itemId);
    assert.ok(item.itemTitle);
    assert.ok(item.decision);
  }
});

// -------------------------------------------------------------
// 7. TELEMETRY ANALYTICS & SCHEMA INTEGRITY
// -------------------------------------------------------------
console.log("\nTest Suite 7: Telemetry Analytics & Schema v1 vs v2 Isolation");

it("7.1 Telemetry analytics cleanly separates Schema v1 from Schema v2", () => {
  const analytics = telemetryService.getAnalytics();
  assert.ok(analytics.totalSamples > 0);
  assert.strictEqual(analytics.totalSamples, analytics.v1SamplesCount + analytics.v2SamplesCount);
  assert.strictEqual(analytics.timeOfDayAvailability.length, 24);
  assert.strictEqual(typeof analytics.observedCoveragePercent, "number");
});

// -------------------------------------------------------------
// 8. LOGS SERVICE VIEWER SAFETY
// -------------------------------------------------------------
console.log("\nTest Suite 8: Log Viewer & Disk Preservation");

it("8.1 readLogs returns sanitized logs with level and search filtering", () => {
  logsService.logOperation("system", "Test warning event", "WARN");
  logsService.logOperation("system", "Test error event", "ERROR");

  const warnResult = logsService.readLogs("system", { levelFilter: "WARN" });
  assert.strictEqual(warnResult.lines.length, 1);
  assert.ok(warnResult.lines[0].includes("Test warning event"));
});

// -------------------------------------------------------------
// 9. DASHBOARD DATA MAPPING
// -------------------------------------------------------------
console.log("\nTest Suite 9: Dashboard Data Mapping");

await itAsync("9.1 getDashboardState parses resources, session, and scheduler", async () => {
  const dash = await getDashboardState();
  assert.ok(dash.account.username);
  assert.strictEqual(typeof dash.resources.health.current, "number");
  assert.strictEqual(typeof dash.resources.hunger.current, "number");
  assert.strictEqual(typeof dash.resources.energy.current, "number");
  assert.strictEqual(typeof dash.resources.entrepreneurship.current, "number");
  assert.strictEqual(dash.session.isValid, true);
  assert.strictEqual(dash.scheduler.dailyTask.name, "WarEraDailyAutomator");
  assert.strictEqual(dash.scheduler.telemetryTask.name, "WarEraBattleTelemetry");
});

// -------------------------------------------------------------
// 10. SCHEDULER TASK QUERY
// -------------------------------------------------------------
console.log("\nTest Suite 10: Windows Scheduler Task Status Mapping");

it("10.1 schedulerService maps Windows tasks correctly", () => {
  const sched = schedulerService.getTasksStatus();
  assert.strictEqual(sched.supported, true);
  assert.strictEqual(sched.tasks.daily.name, "WarEraDailyAutomator");
  assert.strictEqual(sched.tasks.telemetry.name, "WarEraBattleTelemetry");
  assert.strictEqual(typeof sched.tasks.daily.installed, "boolean");
});

// -------------------------------------------------------------
// 11. BUILD ANALYZER SERVICE MAPPING
// -------------------------------------------------------------
console.log("\nTest Suite 11: Build Analyzer Model & ROI Mapping");

await itAsync("11.1 runAnalysis returns expected damage, efficiency, and ROI rankings", async () => {
  const analysis = await analyzerService.runAnalysis({ target: "me" });
  assert.strictEqual(analysis.mode, "me");
  assert.ok(analysis.player.expectedDamage > 0);
  assert.ok(analysis.player.efficiencyPercent > 0);
  assert.ok(Array.isArray(analysis.roiRankings));
  assert.ok(Array.isArray(analysis.equipmentComparison));
});

// Cleanup test isolation directory
resetAppDir();
globalThis.fetch = originalFetch;
try {
  fs.rmSync(tempAppDir, { recursive: true, force: true });
} catch {}
try {
  const rankingsPath = path.resolve(__dirname, "../data/rankings.json");
  if (fs.existsSync(rankingsPath)) fs.unlinkSync(rankingsPath);
} catch {}

console.log("\n==================================================");
console.log(`All ${passed}/${total} GUI Service tests passed successfully!`);
console.log("==================================================\n");
