/**
 * WarEra Daily Tasks - Battle Intelligence & Eligibility Engine
 * 
 * Modular implementation for discovering all active battles,
 * evaluating Country and MU orders, verifying side consensus,
 * reading side-specific damage bonus & bounty, and lexicographically ranking targets.
 * 
 * ABSOLUTE SAFETY GUARD: Zero combat actions or resource spending.
 */

import { sleep, closeModals, navigateTo, readResources, assertNotUnrest } from "./daily_automator.mjs";
import { connect } from "./browser.mjs";
import ui, { colors, icons } from "./ui.mjs";
import { recordExecutionTelemetry } from "./analyzer/battle_telemetry.mjs";

export const VERIFIED_HIT = "VERIFIED_HIT";
export const FAILED_HIT = "FAILED_HIT";
export const UNKNOWN_HIT = "UNKNOWN_HIT";

/**
 * Dynamically detect the player's country and Military Unit (MU)
 * from live navigation/sidebar. Never hardcodes IDs or names.
 */
export async function detectPlayerCombatContext(page, knownCountry = null) {
  const spin = ui.spinner("Detecting player combat context (Country & MU)...");
  await closeModals(page);

  const context = await page.evaluate((knownC) => {
    const links = Array.from(document.querySelectorAll("a"));

    // 1. Player Country
    let countryId = knownC?.id || null;
    let countryName = knownC?.name || "";
    let countryHref = knownC?.href || null;

    if (!countryId) {
      for (const a of links) {
        const txt = a.innerText.trim().toUpperCase();
        const href = a.getAttribute("href") || "";
        if (txt === "COUNTRY" && href.includes("/country/")) {
          const m = href.match(/\/country\/([a-f0-9]+)/);
          if (m) {
            countryId = m[1];
            countryHref = href;
            break;
          }
        }
      }
    }

    // 2. Player Military Unit (MU)
    let muId = null;
    let muName = "";
    let muHref = null;
    for (const a of links) {
      const txt = a.innerText.trim().toUpperCase();
      const href = a.getAttribute("href") || "";
      if ((txt.startsWith("MU") || txt.startsWith("MILITARY UNIT")) && href.includes("/mu/")) {
        const m = href.match(/\/mu\/([a-f0-9]+)/);
        if (m) {
          muId = m[1];
          muHref = href;
          break;
        }
      }
    }

    return {
      country: { id: countryId, name: countryName, href: countryHref },
      mu: { id: muId, name: muName, href: muHref },
    };
  }, knownCountry);

  // If countryName is blank (e.g. icon-only link in sidebar), fetch from country page
  if (context.country.id && !context.country.name) {
    try {
      await page.goto(`https://app.warera.io/country/${context.country.id}`, { waitUntil: "domcontentloaded" });
      await sleep(2000);
      const name = await page.evaluate(() => {
        const text = document.body.innerText;
        const match = text.match(/Country\n([^\n]+)/i);
        return match ? match[1].trim() : "";
      });
      if (name) context.country.name = name;
    } catch {
      /* fallback to ID */
    }
  }

  // If muName is blank, fetch from MU page
  if (context.mu.id && !context.mu.name) {
    try {
      await page.goto(`https://app.warera.io/mu/${context.mu.id}`, { waitUntil: "domcontentloaded" });
      await sleep(2000);
      const name = await page.evaluate(() => {
        const text = document.body.innerText;
        const match = text.match(/Military Unit\n([^\n]+)/i);
        if (match && match[1].trim()) return match[1].trim();
        const h1 = document.querySelector("h1");
        if (h1 && h1.innerText.trim()) return h1.innerText.trim();
        return "";
      });
      if (name) context.mu.name = name;
    } catch {
      /* fallback to ID */
    }
  }

  spin.succeed(
    `Context: Country = ${colors.target(context.country.name || context.country.id)} | MU = ${colors.target(context.mu.name || context.mu.id)}`
  );

  return context;
}

/**
 * Discover all currently active battles from /battles.
 * Paginates using "LOAD MORE" until the entire list is loaded.
 * Returns deduplicated list of battle cards with initial order badges and participants.
 */
export async function discoverAllBattles(page, playerContext) {
  const spin = ui.spinner("Navigating to Battles page and loading all battles...");
  await navigateTo(page, "/battles", 'a[href="/battles"]');
  await sleep(3000);
  await closeModals(page);

  // Continuously click LOAD MORE until all battles are loaded
  let loadMoreClicks = 0;
  while (loadMoreClicks < 15) {
    const clicked = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      const loadMore = btns.find((b) => b.innerText.trim().toUpperCase() === "LOAD MORE" && !b.disabled);
      if (loadMore) {
        loadMore.scrollIntoView({ block: "center" });
        loadMore.click();
        return true;
      }
      return false;
    });

    if (!clicked) break;
    loadMoreClicks++;
    spin.text(`Loading more battles (page ${loadMoreClicks + 1})...`);
    await sleep(2000);
  }

  // Extract all unique battles from cards
  const battles = await page.evaluate((ctx) => {
    const cards = Array.from(document.querySelectorAll('a[href*="/battle/"]'));
    const list = [];
    const seen = new Set();

    for (const card of cards) {
      const href = card.getAttribute("href") || "";
      const m = href.match(/\/battle\/([a-f0-9]+)/);
      const battleId = m ? m[1] : null;
      if (!battleId || seen.has(battleId)) continue;
      seen.add(battleId);

      const lines = card.innerText.split("\n").map((s) => s.trim()).filter(Boolean);

      // Flags
      const flagImgs = Array.from(card.querySelectorAll("img")).filter((img) =>
        img.getAttribute("src")?.includes("/flags/")
      );
      const flags = flagImgs.map((img) => img.getAttribute("alt")?.replace(/\s*flag/i, "").trim() || "Unknown");
      const sideA = flags[0] || "Side A";
      const sideB = flags[1] || "Side B";

      // Region or Battle Name
      let region = lines[0] || "Unknown Region";
      if (!region || !isNaN(Number(region)) || region === "+" || region.includes("K") || region.includes("M")) {
        region = `${sideA} vs ${sideB}`;
      }

      // Badges on card
      const countryOrderLink = card.querySelector(`a[href*="/country/${ctx.country.id}"]`);
      const muOrderLink = card.querySelector(`a[href*="/mu/${ctx.mu.id}"]`);

      // Crosshairs
      const svgs = Array.from(card.querySelectorAll("svg"));
      const crosshairs = svgs.filter((s) => {
        const p = s.querySelector("path")?.getAttribute("d") || "";
        return p.startsWith("M12,8A4,4");
      }).length;

      // Card-level side-specific bounty reward rates
      const cardRect = card.getBoundingClientRect();
      const cardMidX = cardRect.x + cardRect.width / 2;
      let sideABountyRate = 0;
      let sideBBountyRate = 0;

      const coinSvgs = svgs.filter((s) => {
        const p = s.querySelector("path")?.getAttribute("d") || "";
        return p.startsWith("M12 5C7") || p.includes("M12 5C7");
      });

      for (const coin of coinSvgs) {
        const cRect = coin.getBoundingClientRect();
        const onLeft = cRect.x < cardMidX;
        const bText = coin.parentElement?.innerText?.trim() || coin.parentElement?.parentElement?.innerText?.trim() || "";
        const bMatch = bText.match(/(\d+(?:\.\d+)?)/);
        if (bMatch) {
          const val = parseFloat(bMatch[1]);
          if (onLeft) sideABountyRate = val;
          else sideBBountyRate = val;
        }
      }

      list.push({
        battleId,
        battleName: region,
        region,
        sideA,
        sideB,
        hasCountryOrderBadge: Boolean(countryOrderLink),
        hasMuOrderBadge: Boolean(muOrderLink),
        crosshairsCount: crosshairs,
        sideABountyRate,
        sideBBountyRate,
        cardBountyRate: Math.max(sideABountyRate, sideBBountyRate),
        bountyRewardRate: Math.max(sideABountyRate, sideBBountyRate),
        damageBountyRate: Math.max(sideABountyRate, sideBBountyRate),
        href,
      });
    }

    return list;
  }, playerContext);

  spin.succeed(`Discovered ${colors.highlight(battles.length)} active battles`);
  return battles;
}

/**
 * Inspect detailed battle page (/battle/<battleId>) to extract:
 * - Defender vs Attacker participants & actions (DEFEND vs ATTACK/RESIST)
 * - Country order side & MU order side via badge placement
 * - Side-specific damage bonus (+XX% / -XX%)
 * - Side-specific bounty
 */
export async function inspectBattleOrdersAndSides(page, battle, playerContext) {
  const currentUrl = page.url ? page.url() : "";
  if (!currentUrl.includes(`/battle/${battle.battleId}`)) {
    await navigateTo(page, `/battle/${battle.battleId}`);
    await sleep(2500);
  }
  await closeModals(page);

  const detail = await page.evaluate((ctx) => {
    const defBtn = document.getElementById("defender-hit-button");
    const attBtn = document.getElementById("attacker-hit-button");

    if (!defBtn || !attBtn) {
      return { validPage: false, reason: "Combat buttons missing" };
    }

    const defRect = defBtn.getBoundingClientRect();
    const attRect = attBtn.getBoundingClientRect();
    const midX = (defRect.right + attRect.left) / 2;

    // 1. Actions
    const defAction = defBtn.innerText.replace(/\n/g, " ").trim().split(" ")[0] || "DEFEND";
    const attAction = attBtn.innerText.replace(/\n/g, " ").trim().split(" ")[0] || "ATTACK";

    // 2. Flags & Countries
    const defImg = defBtn.querySelector("img") || defBtn.parentElement?.querySelector("img");
    const attImg = attBtn.querySelector("img") || attBtn.parentElement?.querySelector("img");

    const defCountry = defImg?.getAttribute("alt")?.replace(/\s*flag/i, "").trim() || "Defender";
    const attCountry = attImg?.getAttribute("alt")?.replace(/\s*flag/i, "").trim() || "Attacker";

    // 3. Side-specific Damage Bonus
    function parseBonusFromArea(btn) {
      let cur = btn.parentElement;
      while (cur && cur !== document.body) {
        const m = cur.innerText.match(/([+-]?\d+(?:\.\d+)?%)/);
        if (m) {
          const num = parseFloat(m[1].replace("%", ""));
          return isNaN(num) ? 0 : num;
        }
        cur = cur.parentElement;
      }
      return 0;
    }

    const defBonus = parseBonusFromArea(defBtn);
    const attBonus = parseBonusFromArea(attBtn);

    // 4. Side-specific Bounty Reward Rate (per damage payout, e.g. 0.05, 0.08)
    function parseBountyRateFromArea(mid) {
      const bottomLimit = Math.max(defRect.bottom, attRect.bottom, 500) + 50;
      const coinSvgs = Array.from(document.querySelectorAll("svg")).filter((s) => {
        const p = s.querySelector("path")?.getAttribute("d") || "";
        const r = s.getBoundingClientRect();
        return (p.startsWith("M12 5C7") || p.includes("M12 5C7")) && r.y > 100 && r.y < bottomLimit;
      });

      const candidates = [];
      for (const s of coinSvgs) {
        const r = s.getBoundingClientRect();
        const onThisSide = mid === "left" ? r.x < midX : r.x >= midX;
        if (onThisSide) {
          const txt = s.parentElement?.innerText?.trim() || s.parentElement?.parentElement?.innerText?.trim() || "";
          const m = txt.match(/(\d+(?:\.\d+)?)/);
          if (m) {
            candidates.push({ val: parseFloat(m[1]), y: r.y });
          }
        }
      }

      if (candidates.length === 0) return 0;
      if (candidates.length > 1) {
        // The damage bounty rate is the decimal payout rate (e.g. 0.05, 0.08, 0.12), not the larger pool balance
        const decimalCandidate = candidates.find((c) => c.val < 1);
        if (decimalCandidate) return decimalCandidate.val;
        candidates.sort((a, b) => b.y - a.y);
        return candidates[0].val;
      }
      return candidates[0].val;
    }

    const defBountyRate = parseBountyRateFromArea("left");
    const attBountyRate = parseBountyRateFromArea("right");

    // 5. Order Badges Placement (confined strictly to the combat area)
    const crosshairSvgs = Array.from(document.querySelectorAll("svg")).filter((s) => {
      const p = s.querySelector("path")?.getAttribute("d") || "";
      const r = s.getBoundingClientRect();
      return (
        p.startsWith("M12,8A4,4") &&
        r.x >= defRect.left - 100 &&
        r.x <= attRect.right + 100 &&
        r.y >= defRect.top - 50 &&
        r.y <= defRect.bottom + 400
      );
    });

    let countryOrder = { exists: false, side: null };
    let muOrder = { exists: false, side: null };

    for (const svg of crosshairSvgs) {
      const rect = svg.getBoundingClientRect();
      const onLeft = rect.x < midX;
      const sideName = onLeft ? defCountry : attCountry;

      let cur = svg.parentElement;
      for (let depth = 0; depth < 4 && cur; depth++) {
        if (ctx.country.id && !countryOrder.exists) {
          const cLink = cur.querySelector(`a[href*="/country/${ctx.country.id}"]`);
          if (cLink) {
            countryOrder = { exists: true, side: sideName };
          }
        }
        if (ctx.mu.id && !muOrder.exists) {
          const mLink = cur.querySelector(`a[href*="/mu/${ctx.mu.id}"]`);
          if (mLink) {
            muOrder = { exists: true, side: sideName };
          }
        }
        cur = cur.parentElement;
      }
    }

    return {
      validPage: true,
      defender: { action: defAction, country: defCountry, bonus: defBonus, bountyRate: defBountyRate },
      attacker: { action: attAction, country: attCountry, bonus: attBonus, bountyRate: attBountyRate },
      countryOrder,
      muOrder,
    };
  }, playerContext);

  if (!detail.validPage) {
    return {
      ...battle,
      validPage: false,
      eligible: false,
      skipReason: detail.reason || "Battle page invalid",
      countryOrder: { exists: false, side: null },
      muOrder: { exists: false, side: null },
      playerCountryInvolved: false,
      orderedSide: null,
      actionType: null,
      damageBonus: 0,
      bountyRewardRate: 0,
      damageBountyRate: 0,
      bounty: 0,
    };
  }

  // Determine eligibility and consensus
  const hasCountryOrder = detail.countryOrder.exists;
  const hasMuOrder = detail.muOrder.exists;
  const countryOrderSide = detail.countryOrder.side;
  const muOrderSide = detail.muOrder.side;

  let eligible = false;
  let skipReason = null;
  let orderedSide = null;
  let damageBonus = 0;
  let bountyRewardRate = 0;
  let actionType = null;
  let buttonId = null;

  if (!hasCountryOrder && !hasMuOrder) {
    skipReason = "No orders";
  } else if (!hasCountryOrder) {
    skipReason = "MU order only (missing Country order)";
  } else if (!hasMuOrder) {
    skipReason = "Country order only (missing MU order)";
  } else if (countryOrderSide !== muOrderSide) {
    skipReason = "Country and MU orders conflict";
  } else {
    eligible = true;
    orderedSide = countryOrderSide;

    const isDef = orderedSide.toUpperCase() === detail.defender.country.toUpperCase();
    const sideInfo = isDef ? detail.defender : detail.attacker;

    actionType = sideInfo.action;
    damageBonus = sideInfo.bonus;
    bountyRewardRate = sideInfo.bountyRate || 0;
    buttonId = isDef ? "defender-hit-button" : "attacker-hit-button";
  }

  const playerCountryName = playerContext.country.name.toUpperCase();
  const playerCountryInvolved =
    Boolean(playerCountryName) &&
    (detail.defender.country.toUpperCase() === playerCountryName ||
      detail.attacker.country.toUpperCase() === playerCountryName);

  return {
    ...battle,
    validPage: true,
    sideA: detail.defender.country,
    sideB: detail.attacker.country,
    countryOrder: detail.countryOrder,
    muOrder: detail.muOrder,
    playerCountryInvolved,
    eligible,
    skipReason,
    orderedSide,
    actionType,
    damageBonus,
    bountyRewardRate,
    damageBountyRate: bountyRewardRate,
    bounty: bountyRewardRate,
    buttonId,
  };
}

/**
 * Resolve combat action button for the ordered side.
 */
export function resolveOrderedBattleAction(battleDetail, orderedSide) {
  if (!battleDetail || !orderedSide) return null;

  if (orderedSide.toUpperCase() === battleDetail.sideA.toUpperCase()) {
    return {
      side: battleDetail.sideA,
      actionType: battleDetail.actionType || "DEFEND",
      buttonId: "defender-hit-button",
    };
  }

  if (orderedSide.toUpperCase() === battleDetail.sideB.toUpperCase()) {
    return {
      side: battleDetail.sideB,
      actionType: battleDetail.actionType || "ATTACK",
      buttonId: "attacker-hit-button",
    };
  }

  return null;
}

/**
 * Rank all eligible battles using strict lexicographic order:
 * 1. MY COUNTRY'S OWN WARS (playerCountryInvolved === true)
 * 2. HIGHEST DAMAGE BONUS (for orderedSide)
 * 3. HIGHEST BOUNTY REWARD RATE (for orderedSide)
 */
export function rankBattles(eligibleBattles) {
  return [...eligibleBattles].sort((a, b) => {
    // 1. My country's own war
    const aCountry = a.playerCountryInvolved ? 1 : 0;
    const bCountry = b.playerCountryInvolved ? 1 : 0;
    if (aCountry !== bCountry) {
      return bCountry - aCountry;
    }

    // 2. Highest damage bonus on orderedSide
    if (a.damageBonus !== b.damageBonus) {
      return b.damageBonus - a.damageBonus;
    }

    // 3. Highest bounty reward rate from damage on orderedSide
    const aRate = a.bountyRewardRate ?? a.damageBountyRate ?? 0;
    const bRate = b.bountyRewardRate ?? b.damageBountyRate ?? 0;
    return bRate - aRate;
  });
}

/**
 * Execute the complete Battle intelligence, scan, and selection routine.
 * DOES NOT PERFORM COMBAT ACTIONS.
 */
export async function runBattleIntelligence(page, knownCountry = null) {
  ui.item(icons.battles, colors.highlight("Battle Intelligence & Selection Engine"));
  await closeModals(page);

  // 1. Detect dynamic player combat context
  const playerContext = await detectPlayerCombatContext(page, knownCountry);

  // 2. Discover all active battles across all pages
  const allBattles = await discoverAllBattles(page, playerContext);

  // 3. Separate candidate battles (those displaying order badges or potential) from others
  const inspectedBattles = [];
  const candidateBattles = allBattles.filter((b) => b.hasCountryOrderBadge || b.hasMuOrderBadge || b.crosshairsCount > 0);

  // Inspect candidates thoroughly on their detail page
  for (const candidate of candidateBattles) {
    const detail = await inspectBattleOrdersAndSides(page, candidate, playerContext);
    inspectedBattles.push(detail);
  }

  // Populate remaining battles that have 0 badges directly as non-eligible
  for (const b of allBattles) {
    if (!inspectedBattles.some((ib) => ib.battleId === b.battleId)) {
      inspectedBattles.push({
        ...b,
        countryOrder: { exists: false, side: null },
        muOrder: { exists: false, side: null },
        playerCountryInvolved:
          Boolean(playerContext.country.name) &&
          (b.sideA?.toUpperCase() === playerContext.country.name.toUpperCase() ||
            b.sideB?.toUpperCase() === playerContext.country.name.toUpperCase()),
        eligible: false,
        skipReason: "No orders",
        orderedSide: null,
        actionType: null,
        damageBonus: 0,
        bountyRewardRate: b.cardBountyRate || 0,
        damageBountyRate: b.cardBountyRate || 0,
        bounty: b.cardBountyRate || 0,
      });
    }
  }

  // 4. Log individual decision for each scanned battle
  ui.item(icons.transition, colors.dim("Battle scan decisions:"));
  for (const b of inspectedBattles) {
    ui.battleScanItem(b);
  }

  // 5. Filter eligible battles
  const eligibleBattles = inspectedBattles.filter((b) => b.eligible);

  // 6. Rank eligible battles
  const ranked = rankBattles(eligibleBattles);

  // 7. Render Diagnostic Table
  ui.battleDiagnosticTable(inspectedBattles);

  // 8. Select #1 battle and report
  if (ranked.length > 0) {
    const winner = ranked[0];
    const resolvedAction = resolveOrderedBattleAction(winner, winner.orderedSide);

    let reason = "";
    if (winner.playerCountryInvolved) {
      reason = `Country war for ${playerContext.country.name}`;
      if (winner.damageBonus > 0) reason += `, damage bonus +${winner.damageBonus}%`;
      if (winner.bountyRewardRate > 0) reason += `, bounty rate ${winner.bountyRewardRate}`;
    } else {
      reason = `Highest damage bonus (+${winner.damageBonus}%)`;
      if (winner.bountyRewardRate > 0) reason += `, bounty rate ${winner.bountyRewardRate}`;
    }

    ui.selectedBattleCard(winner, reason, resolvedAction);
    ui.item(
      icons.success,
      `Battle selected: ${colors.highlight(winner.region)} (${colors.warning(winner.actionType)} for ${colors.target(winner.orderedSide)})`
    );
    ui.subItem(
      `🔥 Damage bonus: ${colors.highlight((winner.damageBonus >= 0 ? '+' : '') + winner.damageBonus + '%')} | 💰 Damage bounty rate: ${colors.gold(winner.bountyRewardRate.toString())}`
    );
    ui.item(
      icons.warning,
      colors.dim("Combat safety guard active: ZERO combat clicks performed (Intelligence mode only)")
    );
    return winner;
  } else {
    ui.item(
      icons.info,
      colors.dim("No battle qualified under dual-order eligibility rule (Country + MU consensus required).")
    );
    return null;
  }
}

/**
 * Fetch game config and player armor to dynamically determine real live battle hit Health cost.
 * Formula: Math.max(1, Math.floor(baseCost * (1 - armor / 100)))
 */
export async function getBattleHitHealthCost(page) {
  try {
    const cost = await page.evaluate(async () => {
      let baseCost = 10;
      try {
        const cfgRes = await fetch("https://api4.warera.io/trpc/gameConfig.getGameConfig", { credentials: "include" });
        if (cfgRes.ok) {
          const json = await cfgRes.json();
          const hc = json?.result?.data?.battle?.healthCost;
          if (typeof hc === "number" && hc > 0) baseCost = hc;
        }
      } catch {}

      try {
        const meRes = await fetch("https://api4.warera.io/trpc/user.getMe", { credentials: "include" });
        if (meRes.ok) {
          const json = await meRes.json();
          const me = json?.result?.data;
          const armor = me?.skills?.armor?.totalAfterSoftCap ?? me?.skills?.armor?.total ?? 0;
          if (typeof armor === "number" && armor > 0) {
            const discounted = Math.floor(baseCost * (1 - armor / 100));
            return Math.max(1, discounted);
          }
        }
      } catch {}

      return baseCost;
    });
    return typeof cost === "number" && cost > 0 ? cost : 10;
  } catch {
    return 10;
  }
}

/**
 * Poll fresh player resources immediately after a hit until Health changes
 * or bounded polling timeout is reached.
 * Suggested intervals: 0ms, 200ms, 400ms, 800ms, 1500ms.
 */
export async function pollFreshResourcesAfterHit(page, beforeHealth, intervals = [0, 200, 400, 800, 1500]) {
  for (let i = 0; i < intervals.length; i++) {
    const delay = intervals[i];
    if (delay > 0) {
      await sleep(delay);
    }
    const freshRes = await readResources(page);
    if (freshRes && typeof freshRes.health?.current === "number") {
      if (Math.abs(freshRes.health.current - beforeHealth) > 0.001) {
        return {
          resources: freshRes,
          health: freshRes.health.current,
          stale: false,
          attempts: i + 1,
        };
      }
    }
  }

  const lastRes = await readResources(page);
  return {
    resources: lastRes,
    health: lastRes?.health?.current ?? beforeHealth,
    stale: true,
    attempts: intervals.length,
  };
}

/**
 * Immediate revalidation directly before every live mutation:
 * Re-fetches battle status, round, order state, side existence,
 * in-region presence, and live player resources.
 */
export async function revalidateBattleBeforeHit(page, battle, playerContext) {
  // 1. Strict Resistance/UNREST isolation guard
  assertNotUnrest(battle.region || battle.battleName, page.url());

  // 2. Ensure page is on target battle
  const targetPath = `/battle/${battle.battleId}`;
  if (!page.url().includes(battle.battleId)) {
    await navigateTo(page, targetPath);
    await sleep(2500);
  }
  await closeModals(page);

  // 3. Inspect live battle page
  const inspect = await inspectBattleOrdersAndSides(page, battle, playerContext);
  if (!inspect.validPage) {
    return {
      valid: false,
      reason: inspect.skipReason || "Battle page elements invalid or missing",
      code: "PAGE_INVALID",
    };
  }

  // 4. Verify side consensus still holds
  if (!inspect.eligible || inspect.orderedSide !== battle.orderedSide) {
    return {
      valid: false,
      reason: inspect.skipReason || `Ordered side changed from ${battle.orderedSide} to ${inspect.orderedSide}`,
      code: "SIDE_NOT_SAFELY_RESOLVED",
    };
  }

  // 5. Verify combat button in live DOM (ensure player is in battle region, button not replaced by MOVE)
  const btnCheck = await page.evaluate((bId) => {
    const btn = document.getElementById(bId);
    if (!btn) {
      const bodyText = document.body.innerText || "";
      if (bodyText.includes("MOVE")) {
        return { ok: false, reason: "Player not in battle region (MOVE button displayed)", code: "NOT_IN_REGION" };
      }
      return { ok: false, reason: `Combat button #${bId} not found in live DOM`, code: "BUTTON_MISSING" };
    }
    if (btn.disabled) {
      return { ok: false, reason: `Combat button #${bId} is disabled`, code: "BUTTON_DISABLED" };
    }
    if (btn.offsetWidth === 0 || btn.offsetHeight === 0) {
      return { ok: false, reason: `Combat button #${bId} is hidden or zero size`, code: "BUTTON_HIDDEN" };
    }
    return { ok: true, text: btn.innerText.replace(/\n/g, " ").trim() };
  }, inspect.buttonId);

  if (!btnCheck.ok) {
    return { valid: false, reason: btnCheck.reason, code: btnCheck.code };
  }

  // 6. Read live player resources immediately before hit
  const resources = await readResources(page);
  const hitCost = await getBattleHitHealthCost(page);
  if (!resources || resources.health.current < hitCost) {
    return {
      valid: false,
      reason: `Insufficient Health (${resources?.health?.current ?? 0} < ${hitCost})`,
      code: "INSUFFICIENT_RESOURCES",
      resources,
      hitCost,
    };
  }

  return {
    valid: true,
    inspect,
    buttonId: inspect.buttonId,
    actionType: inspect.actionType,
    resources,
    hitCost,
    orderedSide: inspect.orderedSide,
  };
}

/**
 * Execute a single battle hit:
 * - Immediate pre-flight revalidation
 * - Dry-run support (zero mutations)
 * - Live mutation submission via authoritative button click
 * - Authoritative network response & live state corroboration
 * - Classification: VERIFIED_HIT, FAILED_HIT, UNKNOWN_HIT
 */
export async function executeSingleBattleHit(page, battle, playerContext, options = {}) {
  const dryRun = options.dryRun === true;

  // Helper: log execution telemetry for non-dry-run hits before returning
  const logAndReturn = async (result) => {
    if (!dryRun && !result.dryRun) {
      try {
        await recordExecutionTelemetry({
          battleId: battle.battleId || battle.id || null,
          roundId: battle.roundId || battle.currentRoundId || null,
          region: battle.regionName || battle.region || null,
          side: battle.orderedSide || battle.side || null,
          damageBonus: typeof battle.damageBonus === "number" ? battle.damageBonus : null,
          bountyRate: typeof battle.bountyRate === "number" ? battle.bountyRate : null,
          healthBefore: typeof result.beforeHealth === "number" ? result.beforeHealth : null,
          healthAfter: typeof result.afterHealth === "number" ? result.afterHealth : null,
          actualHealthDelta: (typeof result.beforeHealth === "number" && typeof result.afterHealth === "number")
            ? result.beforeHealth - result.afterHealth
            : null,
          damageDealt: typeof result.damage === "number" ? result.damage : null,
          loot: result.loot || null,
          verificationState: result.status,
          mutationIdentifier: result.code || null,
        });
      } catch (err) {
        // Execution telemetry logging must never block or crash the combat loop
        if (process.env.DEBUG) {
          console.error(`  [Execution Telemetry] Failed to record: ${err.message}`);
        }
      }
    }
    return result;
  };

  // 1. Immediate pre-flight revalidation directly before mutation
  const reval = await revalidateBattleBeforeHit(page, battle, playerContext);
  if (!reval.valid) {
    return logAndReturn({
      status: FAILED_HIT,
      reason: reval.reason,
      code: reval.code,
      beforeHealth: reval.resources?.health?.current || 0,
      afterHealth: reval.resources?.health?.current || 0,
    });
  }

  const beforeHealth = options.simulatedHealth !== undefined ? options.simulatedHealth : reval.resources.health.current;
  const hitCost = options.liveHealthCost !== undefined ? options.liveHealthCost : (reval.hitCost || 10);

  // 2. DRY-RUN MODE: Zero mutations submitted (not logged to execution journal)
  if (dryRun) {
    const afterHealth = Math.max(0, parseFloat((beforeHealth - hitCost).toFixed(1)));
    return {
      status: VERIFIED_HIT,
      dryRun: true,
      action: reval.actionType || battle.actionType,
      beforeHealth,
      afterHealth,
      damage: 0,
      buttonId: reval.buttonId,
      liveHealthCost: hitCost,
    };
  }

  // 3. LIVE MUTATION SUBMISSION
  // Prepare listener for authoritative roundDamages.hit tRPC network response
  let responsePromise = page
    .waitForResponse(
      (resp) => resp.url().includes("roundDamages.hit") && resp.request().method() === "POST",
      { timeout: 15000 }
    )
    .catch((err) => ({ isTimeout: true, error: err }));

  // Click target combat button ONCE
  const clickOutcome = await page.evaluate((btnId) => {
    const btn = document.getElementById(btnId);
    if (!btn || btn.disabled || btn.offsetWidth === 0) {
      return { clicked: false, reason: "Button became disabled or missing immediately prior to click" };
    }
    btn.click();
    return { clicked: true };
  }, reval.buttonId);

  if (!clickOutcome.clicked) {
    return logAndReturn({
      status: FAILED_HIT,
      reason: clickOutcome.reason,
      code: "CLICK_FAILED",
      beforeHealth,
      afterHealth: beforeHealth,
    });
  }

  // 4. Await response and evaluate outcome
  const resp = await responsePromise;

  // Timeout or network drop => outcome uncertain => UNKNOWN_HIT (stop immediately, never retry)
  if (resp && resp.isTimeout) {
    return logAndReturn({
      status: UNKNOWN_HIT,
      reason: `Network timeout awaiting roundDamages.hit response: ${resp.error?.message || "timeout"}`,
      code: "TIMEOUT",
      beforeHealth,
      afterHealth: beforeHealth,
    });
  }

  if (!resp || typeof resp.status !== "function") {
    return logAndReturn({
      status: UNKNOWN_HIT,
      reason: "Indeterminate response object from roundDamages.hit mutation",
      code: "INDETERMINATE",
      beforeHealth,
      afterHealth: beforeHealth,
    });
  }

  if (resp.status() !== 200) {
    const errText = await resp.text().catch(() => "HTTP Error");
    return logAndReturn({
      status: FAILED_HIT,
      reason: `roundDamages.hit returned HTTP ${resp.status()}: ${errText}`,
      code: "HTTP_ERROR",
      beforeHealth,
      afterHealth: beforeHealth,
    });
  }

  let body;
  try {
    body = await resp.json();
  } catch (err) {
    return logAndReturn({
      status: UNKNOWN_HIT,
      reason: `Failed to parse roundDamages.hit response JSON: ${err.message}`,
      code: "JSON_PARSE_ERROR",
      beforeHealth,
      afterHealth: beforeHealth,
    });
  }

  const payload = Array.isArray(body) ? body[0]?.result?.data : body?.result?.data;
  const payloadError = Array.isArray(body) ? body[0]?.error : body?.error;

  if (payloadError) {
    return logAndReturn({
      status: FAILED_HIT,
      reason: payloadError.message || JSON.stringify(payloadError),
      code: "MUTATION_ERROR",
      beforeHealth,
      afterHealth: beforeHealth,
    });
  }

  // 5. Authoritative Live State Corroboration via Post-Hit Polling
  const pollResult = await pollFreshResourcesAfterHit(page, beforeHealth);
  await closeModals(page);

  if (pollResult.stale) {
    console.log(`  ${colors.warning("⚠️  Health update pending/stale")}`);
  }

  // Determine authoritative afterHealth:
  // If fresh DOM read observed a change, use it.
  // Otherwise if server returned updatedHealth in mutation payload, use that.
  // Otherwise fall back to beforeHealth.
  let afterHealth;
  if (!pollResult.stale) {
    afterHealth = pollResult.health;
  } else if (typeof payload?.updatedHealth === "number") {
    afterHealth = payload.updatedHealth;
  } else {
    afterHealth = beforeHealth;
  }

  const damageDealt = payload?.damages ?? 0;

  if (damageDealt > 0 || Math.abs(afterHealth - beforeHealth) > 0.001 || payload?.updatedHealth !== undefined) {
    return logAndReturn({
      status: VERIFIED_HIT,
      dryRun: false,
      action: reval.actionType || battle.actionType,
      damage: damageDealt,
      beforeHealth,
      afterHealth,
      healthStale: pollResult.stale,
      loot: payload?.loot,
      previousDamages: payload?.previousDamagesCount,
      updatedMoney: payload?.updatedMoney,
      buttonId: reval.buttonId,
    });
  }

  return logAndReturn({
    status: FAILED_HIT,
    reason: "Mutation returned 200 but live damage/health changes could not be verified.",
    code: "NO_LIVE_EVIDENCE",
    beforeHealth,
    afterHealth,
    healthStale: pollResult.stale,
  });
}

/**
 * Master Battle Mode Execution Engine:
 * - Scans, filters, and lexicographically ranks all active battles.
 * - Selects #1 battle.
 * - In dry-run mode: prints intended hits and expected resource use (0 mutations).
 * - In live mode: submits verified hits one by one, revalidating before every hit.
 * - Aborts on UNKNOWN_HIT with zero duplicate attempts.
 */
export async function executeBattleMode(page, options = {}) {
  const dryRun = options.dryRun === true;
  const maxHitsCap = options.maxHits || 10;
  const stats = options.stats || null;

  ui.battleModeBanner(dryRun);
  await closeModals(page);

  // 1. Detect dynamic player combat context
  const playerContext = options.playerContext?.country?.id
    ? options.playerContext
    : await detectPlayerCombatContext(page, options.knownCountry);

  // 2. Discover all active battles across all pages
  const allBattles = await discoverAllBattles(page, playerContext);
  const candidateBattles = allBattles.filter((b) => b.hasCountryOrderBadge || b.hasMuOrderBadge || b.crosshairsCount > 0);

  const inspectedBattles = [];
  for (const candidate of candidateBattles) {
    const detail = await inspectBattleOrdersAndSides(page, candidate, playerContext);
    inspectedBattles.push(detail);
  }

  for (const b of allBattles) {
    if (!inspectedBattles.some((ib) => ib.battleId === b.battleId)) {
      inspectedBattles.push({
        ...b,
        countryOrder: { exists: false, side: null },
        muOrder: { exists: false, side: null },
        playerCountryInvolved:
          Boolean(playerContext.country.name) &&
          (b.sideA?.toUpperCase() === playerContext.country.name.toUpperCase() ||
            b.sideB?.toUpperCase() === playerContext.country.name.toUpperCase()),
        eligible: false,
        skipReason: "No orders",
        orderedSide: null,
        actionType: null,
        damageBonus: 0,
        bountyRewardRate: b.cardBountyRate || 0,
        damageBountyRate: b.cardBountyRate || 0,
        bounty: b.cardBountyRate || 0,
      });
    }
  }

  // 3. Log individual decisions & Diagnostic Table
  ui.item(icons.transition, colors.dim("Battle scan decisions:"));
  for (const b of inspectedBattles) {
    ui.battleScanItem(b);
  }

  const eligibleBattles = inspectedBattles.filter((b) => b.eligible);
  const ranked = rankBattles(eligibleBattles);
  ui.battleDiagnosticTable(inspectedBattles);

  const summary = {
    considered: allBattles.length,
    joined: 0,
    hitsVerified: 0,
    hitsFailed: 0,
    skipped: allBattles.length,
    healthSpent: 0,
  };

  if (ranked.length === 0) {
    ui.item(
      icons.info,
      colors.dim("No battle qualified under dual-order eligibility rule (Country + MU consensus required).")
    );
    ui.battleModeSummary(summary);
    return { winner: null, ...summary };
  }

  // 4. Select #1 battle and report
  const winner = ranked[0];
  const resolvedAction = resolveOrderedBattleAction(winner, winner.orderedSide);

  let reason = "";
  if (winner.playerCountryInvolved) {
    reason = `Country war for ${playerContext.country.name}`;
    if (winner.damageBonus > 0) reason += `, damage bonus +${winner.damageBonus}%`;
    if (winner.bountyRewardRate > 0) reason += `, bounty rate ${winner.bountyRewardRate}`;
  } else {
    reason = `Highest damage bonus (+${winner.damageBonus}%)`;
    if (winner.bountyRewardRate > 0) reason += `, bounty rate ${winner.bountyRewardRate}`;
  }

  ui.selectedBattleCard(winner, reason, resolvedAction);
  ui.battleTargetInfo(winner);

  // 5. Initial resource read & hit planning
  const initialRes = await readResources(page);
  if (!initialRes || typeof initialRes.health?.current !== "number") {
    ui.error("Cannot read player resources. Halting Battle Mode.");
    ui.battleModeSummary(summary);
    return { winner, ...summary };
  }

  const healthBeforeBattle = initialRes.health.current;
  let liveHealthCost = await getBattleHitHealthCost(page);
  const estimatedHits = Math.max(0, Math.floor((healthBeforeBattle - 10) / liveHealthCost));
  const plannedHits = Math.min(maxHitsCap, estimatedHits);

  console.log(`  ${colors.dim("Health per hit:")} ${colors.health(liveHealthCost.toString())}${liveHealthCost < 10 ? " " + colors.dim("(Armor reduction active)") : ""}`);
  console.log(`  ${colors.dim("Current Health:")}  ${colors.health(healthBeforeBattle.toString())}`);
  console.log(`  ${colors.dim("Planned hits:")}    ${colors.highlight(plannedHits.toString())} ${colors.dim(`(Health down to 10)`)}`);
  console.log();

  if (healthBeforeBattle < 10 + liveHealthCost || plannedHits <= 0) {
    ui.item(
      icons.warning,
      `Health (${healthBeforeBattle}) is insufficient for combat hits without dropping below 10 HP (Cost: ${liveHealthCost} HP).`
    );
    ui.battleModeSummary(summary);
    return { winner, healthBeforeBattle, healthAfterBattle: healthBeforeBattle, actualHealthSpent: 0, ...summary };
  }

  // 6. Hit Execution Loop - Hit-by-Hit with Fresh Health Checks
  const healthAfterEachVerifiedHit = [];
  let simulatedHealth = healthBeforeBattle;
  let hitIndex = 0;

  while (hitIndex < plannedHits) {
    // Fresh Health check before EVERY hit
    let freshHealthBeforeHit;
    if (dryRun) {
      freshHealthBeforeHit = simulatedHealth;
    } else {
      const freshRes = await readResources(page);
      if (!freshRes || typeof freshRes.health?.current !== "number") {
        ui.item(icons.warning, colors.warning("Cannot confirm fresh player Health before next hit. Halting safely."));
        break;
      }
      freshHealthBeforeHit = freshRes.health.current;
    }

    // Never intentionally drop below 10 HP floor
    if (freshHealthBeforeHit < 10 + liveHealthCost) {
      console.log(`  ${colors.dim(`Health (${freshHealthBeforeHit}) reached safety floor (below 10 + ${liveHealthCost} HP). Stopping.`)}`);
      break;
    }

    console.log(`Hit ${hitIndex + 1} of ${plannedHits}:`);

    const hitResult = await executeSingleBattleHit(page, winner, playerContext, {
      dryRun,
      simulatedHealth: freshHealthBeforeHit,
      liveHealthCost,
    });

    ui.battleHitResult(hitResult);

    if (hitResult.status === VERIFIED_HIT) {
      summary.hitsVerified++;
      healthAfterEachVerifiedHit.push(hitResult.afterHealth);

      if (dryRun) {
        simulatedHealth = hitResult.afterHealth;
      } else {
        // Adapt liveHealthCost if observed delta differs
        const observedDelta = parseFloat((hitResult.beforeHealth - hitResult.afterHealth).toFixed(1));
        if (observedDelta > 0 && Math.abs(observedDelta - liveHealthCost) > 0.001) {
          liveHealthCost = observedDelta;
          console.log(`  ${colors.dim("Dynamic Health cost updated to:")} ${colors.health(liveHealthCost.toString())}`);
        }

        // Never trust stale health for next hit: stop safely if state is stale
        if (hitResult.healthStale) {
          ui.item(icons.warning, colors.warning("Health state remains stale after polling timeout. Halting further hits safely."));
          break;
        }
      }

      if (stats) {
        stats.battleHitsVerified = (stats.battleHitsVerified || 0) + 1;
        stats.selectedBattle = `${winner.region} (${winner.actionType || "FIGHT"})`;
      }

      hitIndex++;
    } else if (hitResult.status === FAILED_HIT) {
      summary.hitsFailed++;
      ui.item(icons.warning, colors.warning(`Hit failed: ${hitResult.reason}. Halting hits on this battle.`));
      break;
    } else if (hitResult.status === UNKNOWN_HIT) {
      summary.hitsFailed++;
      ui.item(icons.error, colors.error(`UNKNOWN_HIT: ${hitResult.reason}`));
      ui.item(icons.error, colors.error(`CRITICAL SAFETY STOP: Halting Battle Mode immediately without retry.`));
      break;
    }
  }

  // 7. Final Actual Spend Calculation from fresh verified states
  let healthAfterBattle;
  if (dryRun) {
    healthAfterBattle = simulatedHealth;
  } else {
    const finalFreshRes = await readResources(page);
    healthAfterBattle = finalFreshRes?.health?.current ?? (
      healthAfterEachVerifiedHit.length > 0
        ? healthAfterEachVerifiedHit[healthAfterEachVerifiedHit.length - 1]
        : healthBeforeBattle
    );
  }

  const actualHealthSpent = Math.max(0, parseFloat((healthBeforeBattle - healthAfterBattle).toFixed(1)));
  summary.healthSpent = actualHealthSpent;
  summary.joined = summary.hitsVerified > 0 ? 1 : 0;
  summary.skipped = summary.considered - summary.joined;

  ui.battleModeSummary(summary);
  return { winner, healthBeforeBattle, healthAfterBattle, actualHealthSpent, ...summary };
}

/* ─── Direct execution if run from CLI ─── */
const isDirectExecution = process.argv[1] && !process.argv[1].includes("test") && (
  process.argv[1].endsWith("battles.mjs") ||
  process.argv[1].endsWith("battles")
);

if (isDirectExecution) {
  (async () => {
    ui.banner();
    const isDryRun = process.argv.includes("--dry-run");
    const spinConnect = ui.spinner("Connecting to authenticated browser session...");
    const { browser, page } = await connect();
    spinConnect.succeed("Connected to browser session");

    try {
      await executeBattleMode(page, { dryRun: isDryRun });
    } catch (err) {
      ui.error(`Battle Mode execution failed: ${err.message}`);
    } finally {
      try {
        await browser.close();
      } catch {
        /* ignore */
      }
    }
  })();
}
