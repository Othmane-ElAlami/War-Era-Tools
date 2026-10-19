/**
 * WarEra Daily Tasks - Achievement Participation Sweep Engine
 * 
 * When Combat Debuff is active and Mode is Both:
 * 1. Discover all active battles directly via API.
 * 2. Resolve safe deterministic side and action per strict priority rules:
 *    - Priority 1: Player's own country battles
 *    - Priority 2: Both Country Order and MU Order agree
 *    - Priority 3: Only one order exists (non-conflicting)
 *    - Skip if orders conflict or point against own country
 *    - Skip if no safe deterministic side
 * 3. Lexicographically rank targets (Own country > Both orders > Bonus > Bounty rate).
 * 4. Join as many distinct battles as remaining Health allows (1 hit per distinct battle).
 * 5. Strictly ZERO Bread / food / energy consumed for this sweep.
 * 6. Supports Dry-Run / Intelligence mode (0 combat clicks).
 */

import { sleep, closeModals, readResources } from "./daily_automator.mjs";
import ui, { colors, icons } from "./ui.mjs";

/**
 * Fetch game config to dynamically determine battle hit Health cost.
 */
export async function getBattleHitCost(page) {
  try {
    const cost = await page.evaluate(async () => {
      const res = await fetch("https://api4.warera.io/trpc/gameConfig.getGameConfig", { credentials: "include" });
      if (res.ok) {
        const json = await res.json();
        return json?.result?.data?.battle?.healthCost;
      }
      return 10;
    });
    return typeof cost === "number" && cost > 0 ? cost : 10;
  } catch {
    return 10;
  }
}

/**
 * Fetch all active battles and player context, resolving safe side and action for each.
 */
export async function discoverAndResolveParticipationBattles(page, playerContext = null) {
  const spin = ui.spinner("Discovering active battles and resolving safe participation sides...");

  const data = await page.evaluate(async (pCtx) => {
    // 1. Get player context
    let countryId = pCtx?.country?.id;
    let muId = pCtx?.mu?.id;

    if (!countryId || !muId) {
      const resUser = await fetch("https://api4.warera.io/trpc/user.getMe", { credentials: "include" });
      const user = (await resUser.json())?.result?.data;
      if (!countryId) countryId = user?.country;

      if (!muId) {
        const muLink = document.querySelector('a[href*="/mu/"]')?.getAttribute("href");
        muId = muLink?.match(/\/mu\/([a-f0-9]+)/)?.[1] || null;
      }
    }

    // 2. Discover all active battles directly via API
    const resBattles = await fetch("https://api4.warera.io/trpc/battle.getSortedActiveBattles", { credentials: "include" });
    const battleIds = (await resBattles.json())?.result?.data || [];

    // 3. Country lookup dictionary
    const resCountries = await fetch("https://api4.warera.io/trpc/country.getAllCountries", { credentials: "include" });
    const countriesList = (await resCountries.json())?.result?.data || [];
    const countryNames = {};
    countriesList.forEach((c) => { countryNames[c._id] = c.name; });

    // 4. Detailed evaluation of each battle
    const evaluated = [];

    for (const id of battleIds) {
      try {
        const res = await fetch(
          `https://api4.warera.io/trpc/battle.getById?input=${encodeURIComponent(JSON.stringify({ battleId: id }))}`,
          { credentials: "include" }
        );
        const b = (await res.json())?.result?.data;
        if (!b || !b.isActive) continue;

        const defCountryId = b.defender?.country;
        const attCountryId = b.attacker?.country;
        const defCountryName = countryNames[defCountryId] || defCountryId || "Defender";
        const attCountryName = countryNames[attCountryId] || attCountryId || "Attacker";

        const isDefCountry = Boolean(countryId && defCountryId === countryId);
        const isAttCountry = Boolean(countryId && attCountryId === countryId);
        const countryParticipating = isDefCountry || isAttCountry;

        const hasCountryDef = Boolean(countryId && b.defender?.countryOrders?.includes(countryId));
        const hasCountryAtt = Boolean(countryId && b.attacker?.countryOrders?.includes(countryId));
        const hasMuDef = Boolean(muId && b.defender?.muOrders?.includes(muId));
        const hasMuAtt = Boolean(muId && b.attacker?.muOrders?.includes(muId));

        let countryOrderSide = null;
        if (hasCountryDef && !hasCountryAtt) countryOrderSide = "defender";
        else if (hasCountryAtt && !hasCountryDef) countryOrderSide = "attacker";

        let muOrderSide = null;
        if (hasMuDef && !hasMuAtt) muOrderSide = "defender";
        else if (hasMuAtt && !hasMuDef) muOrderSide = "attacker";

        let chosenSide = null;
        let action = null;
        let skipReason = null;
        let bothOrdersAgree = false;

        // Priority 1 & 5: Own country participating
        if (countryParticipating) {
          const ownSide = isDefCountry ? "defender" : "attacker";
          const enemySide = isDefCountry ? "attacker" : "defender";

          // Rule 5: If an order points against player's country -> REJECT / SKIP
          if (countryOrderSide === enemySide || muOrderSide === enemySide) {
            skipReason = "Order points against player country";
          } else {
            chosenSide = ownSide;
          }
        }
        // Priority 2: Both Country and MU orders exist and agree
        else if (countryOrderSide && muOrderSide) {
          if (countryOrderSide === muOrderSide) {
            chosenSide = countryOrderSide;
            bothOrdersAgree = true;
          } else {
            // Rule 4: Orders conflict -> SKIP
            skipReason = "Country order and MU order conflict on opposite sides";
          }
        }
        // Priority 3: Only ONE explicit order exists (non-conflicting)
        else if (countryOrderSide && !muOrderSide) {
          chosenSide = countryOrderSide;
        } else if (muOrderSide && !countryOrderSide) {
          chosenSide = muOrderSide;
        }
        // Rule 6: No safe deterministic side established -> SKIP
        else {
          skipReason = "No country participation and no explicit orders";
        }

        // Action resolution from structural battle data
        if (chosenSide) {
          if (chosenSide === "defender") {
            action = "DEFEND";
          } else {
            action = b.type === "resistance" ? "RESIST" : "ATTACK";
          }
        }

        // Bounty rate per damage on the chosen side
        const bountyRate = chosenSide === "defender"
          ? (b.defender?.moneyPer1kDamages || 0)
          : (b.attacker?.moneyPer1kDamages || 0);

        evaluated.push({
          battleId: id,
          type: b.type || "regular",
          name: `${defCountryName} vs ${attCountryName}`,
          defCountry: defCountryName,
          attCountry: attCountryName,
          countryParticipating,
          countryOrderSide,
          muOrderSide,
          bothOrdersAgree,
          chosenSide,
          action,
          bountyRate,
          damageBonus: 0,
          skipReason,
          buttonId: chosenSide === "defender" ? "defender-hit-button" : "attacker-hit-button",
          currentRound: b.currentRound,
        });
      } catch (err) {
        evaluated.push({
          battleId: id,
          skipReason: `API error: ${err.message}`,
        });
      }
    }

    return {
      playerContext: {
        countryId,
        countryName: countryNames[countryId] || countryId,
        muId,
      },
      totalActiveBattles: battleIds.length,
      evaluated,
    };
  }, playerContext);

  spin.succeed(
    `Evaluated ${colors.highlight(data.totalActiveBattles)} active battles: ${colors.success(data.evaluated.filter((b) => b.chosenSide).length)} eligible for participation`
  );

  return data;
}

/**
 * Rank eligible participation battles strictly:
 * 1. My country's own battles
 * 2. Country + MU consensus battles
 * 3. Highest ordered-side damage bonus
 * 4. Highest ordered-side bounty rate
 */
export function rankParticipationBattles(eligibleBattles) {
  return [...eligibleBattles].sort((a, b) => {
    // 1. My country's own battles
    const aCountry = a.countryParticipating ? 1 : 0;
    const bCountry = b.countryParticipating ? 1 : 0;
    if (aCountry !== bCountry) return bCountry - aCountry;

    // 2. Both orders agree
    const aBoth = a.bothOrdersAgree ? 1 : 0;
    const bBoth = b.bothOrdersAgree ? 1 : 0;
    if (aBoth !== bBoth) return bBoth - aBoth;

    // 3. Highest damage bonus
    if (a.damageBonus !== b.damageBonus) {
      return b.damageBonus - a.damageBonus;
    }

    // 4. Highest bounty rate
    return (b.bountyRate || 0) - (a.bountyRate || 0);
  });
}

/**
 * Execute Achievement Participation Sweep:
 * - Runs 1 hit per distinct battle using leftover Health.
 * - Stops immediately when Health < hitCost.
 * - NEVER consumes Bread.
 * - In dryRun mode, simulates progression without clicking.
 */
export async function runParticipationSweep(page, options = {}) {
  const dryRun = options.dryRun !== false; // Default to true for safety
  const maxHitsCap = options.maxHits || 20;
  const stats = options.stats || null;

  ui.section("BATTLE PARTICIPATION SWEEP", icons.battles);

  // 1. Determine dynamic hit cost
  const hitCost = await getBattleHitCost(page);

  // 2. Read live starting resources
  let currentRes = await readResources(page);
  if (!currentRes) {
    ui.warn("Cannot read player resources. Aborting participation sweep.");
    return { distinctJoined: 0, healthSpent: 0 };
  }

  const startingHealth = currentRes.health.current;
  const maxPossibleHits = Math.min(maxHitsCap, Math.floor(startingHealth / hitCost));

  console.log(`  ${colors.accent("Goal:")} 1 hit per distinct active battle`);
  console.log(`  ${colors.dim("Health per hit:")} ${colors.health(hitCost.toString())}`);
  console.log(`  ${colors.dim("Maximum possible joins from current Health:")} ${colors.highlight(maxPossibleHits.toString())}`);
  if (dryRun) {
    console.log(`  ${colors.warning("⚡ DRY-RUN / INTELLIGENCE MODE: Zero combat clicks will be performed")}`);
  }
  console.log();

  if (startingHealth < hitCost) {
    ui.item(
      icons.warning,
      `Starting Health (${startingHealth}) is below hit cost (${hitCost}). Cannot perform participation sweep.`
    );
    return { distinctJoined: 0, healthSpent: 0, remainingHealth: startingHealth };
  }

  // 3. Discover and safely resolve battles
  const battleData = await discoverAndResolveParticipationBattles(page, options.playerContext);
  const eligibleBattles = battleData.evaluated.filter((b) => b.chosenSide);
  const rankedBattles = rankParticipationBattles(eligibleBattles);

  // Diagnostic output of all candidates
  console.log();
  console.log(`  ${colors.highlight("PARTICIPATION CANDIDATES EVALUATION:")}`);
  const tableData = battleData.evaluated.map((b) => ({
    Battle: b.name || b.battleId,
    Type: b.type || "-",
    "Country In": b.countryParticipating ? "YES" : "NO",
    "Country Order": b.countryOrderSide || "-",
    "MU Order": b.muOrderSide || "-",
    Side: b.chosenSide || "-",
    Action: b.action || "-",
    "Bounty Rate": b.bountyRate || 0,
    Status: b.chosenSide ? "ELIGIBLE" : "SKIPPED",
    Reason: b.skipReason || "Safe candidate",
  }));
  console.table(tableData);

  if (rankedBattles.length === 0) {
    ui.item(
      icons.info,
      colors.dim("No active battles met the safe deterministic side criteria. Participation sweep completed.")
    );
    return { distinctJoined: 0, healthSpent: 0, remainingHealth: startingHealth };
  }

  // 4. Execution Loop (1 hit per distinct battle)
  const participatedBattleIds = new Set();
  let hitsPerformed = 0;
  let simulatedHealth = startingHealth;

  for (const battle of rankedBattles) {
    // Check stop conditions
    if (hitsPerformed >= maxPossibleHits) {
      ui.item(icons.clock, colors.dim(`Reached maximum planned participation hits (${maxPossibleHits}). Stopping.`));
      break;
    }

    if (participatedBattleIds.has(battle.battleId)) {
      continue; // Never hit same battle twice
    }

    // Live Health check before every hit
    if (!dryRun) {
      currentRes = await readResources(page);
      if (!currentRes || currentRes.health.current < hitCost) {
        ui.item(
          icons.warning,
          colors.dim(`Stopped: insufficient Health (${currentRes?.health?.current || 0} < ${hitCost}) for another hit.`)
        );
        break;
      }
    } else {
      if (simulatedHealth < hitCost) {
        ui.item(
          icons.warning,
          colors.dim(`Stopped: insufficient simulated Health (${simulatedHealth.toFixed(1)} < ${hitCost}) for another hit.`)
        );
        break;
      }
    }

    const beforeHp = dryRun ? simulatedHealth : currentRes.health.current;

    if (dryRun) {
      // Dry-run simulation: log progression without performing clicks
      const afterHp = parseFloat((beforeHp - hitCost).toFixed(1));
      ui.sweepHitItem(battle.name, battle.action, beforeHp, afterHp, true);
      participatedBattleIds.add(battle.battleId);
      hitsPerformed++;
      simulatedHealth = afterHp;
      if (stats) stats.participationHits = (stats.participationHits || 0) + 1;
      continue;
    }

    // LIVE EXECUTION: Navigate to battle and perform exactly ONE hit
    try {
      await page.goto(`https://app.warera.io/battle/${battle.battleId}`, { waitUntil: "domcontentloaded" });
      await sleep(2500);
      await closeModals(page);

      // Pre-flight assertion in live DOM
      const preflight = await page.evaluate((b) => {
        const btn = document.getElementById(b.buttonId);
        if (!btn || btn.disabled || btn.offsetWidth === 0) {
          return { ok: false, reason: `Target button #${b.buttonId} disabled or missing` };
        }
        const txt = btn.innerText.trim().toUpperCase();
        if (!txt.includes(b.action.toUpperCase())) {
          return { ok: false, reason: `Button action mismatch (expected ${b.action}, found ${txt})` };
        }
        return { ok: true };
      }, battle);

      if (!preflight.ok) {
        ui.subItem(colors.warning(`Skipped ${battle.name}: ${preflight.reason}`));
        continue;
      }

      // Read Health immediately before click
      const resBefore = await readResources(page);
      if (!resBefore || resBefore.health.current < hitCost) {
        ui.subItem(colors.warning(`Health dropped below hitCost before click. Halting sweep.`));
        break;
      }

      // Click button ONCE
      const clicked = await page.evaluate((btnId) => {
        const btn = document.getElementById(btnId);
        if (btn && !btn.disabled) {
          btn.click();
          return true;
        }
        return false;
      }, battle.buttonId);

      if (!clicked) {
        ui.subItem(colors.warning(`Failed to click #${battle.buttonId} on ${battle.name}`));
        continue;
      }

      // Wait for server response and UI update
      await sleep(2500);
      await closeModals(page);

      // Re-read Health immediately after click
      const resAfter = await readResources(page);
      if (!resAfter) {
        ui.subItem(colors.warning(`Could not re-read Health after hit. Marking battle as participated.`));
        participatedBattleIds.add(battle.battleId);
        hitsPerformed++;
        continue;
      }

      const healthDiff = (resBefore.health.current - resAfter.health.current).toFixed(1);
      if (resAfter.health.current < resBefore.health.current) {
        // Hit successfully registered
        participatedBattleIds.add(battle.battleId);
        hitsPerformed++;
        if (stats) stats.participationHits = (stats.participationHits || 0) + 1;
        ui.sweepHitItem(battle.name, battle.action, resBefore.health.current, resAfter.health.current, false);
      } else {
        ui.subItem(colors.warning(`Health did not decrease after click on ${battle.name}. Skipping to next.`));
      }
    } catch (err) {
      ui.subItem(colors.warning(`Error executing hit on ${battle.name}: ${err.message}`));
    }
  }

  // Final sweep summary
  const finalHealth = dryRun ? simulatedHealth : (await readResources(page))?.health?.current || 0;
  const totalSpent = parseFloat((startingHealth - finalHealth).toFixed(1));

  console.log();
  console.log(`  ${colors.highlight("Achievement participation:")}`);
  console.log(`  ${colors.success(icons.success)} ${colors.highlight(hitsPerformed.toString())} distinct battles joined`);
  console.log(`  ❤️  ${colors.health(totalSpent.toString())} Health spent`);
  console.log(`  ❤️  ${colors.health(finalHealth.toFixed(1))} Health remaining`);
  console.log(`  ${colors.dim("🍞 Zero Bread consumed (Preserved)")}`);

  return {
    distinctJoined: hitsPerformed,
    healthSpent: totalSpent,
    remainingHealth: finalHealth,
  };
}
