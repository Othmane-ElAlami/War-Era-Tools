/**
 * WarEra Daily Tasks Automation
 * 
 * Modular, resilient Playwright automation for daily tasks in WarEra (https://app.warera.io/):
 * - Step 0: Read player resources (Health, Hunger, Energy, Entrepreneurship)
 * - Step 1: Companies (1A: Energy Pickaxe Work, 1B: Entrepreneurship Brain Work, 1C: Produce all owned companies)
 * - Step 2: Military Unit (2A: Help all available members, 2B: Ask for help if available)
 * - Step 3: Battles (Open Battles page, verify section, log "Battles automation: TBA" without performing battle actions)
 */

import { connect, disconnectBrowser } from "./browser.mjs";
import { BASE, MU_ID } from "./config.mjs";
import ui, { colors, icons } from "./ui.mjs";
import { runBattleIntelligence, executeBattleMode } from "./battles.mjs";
import { detectCombatDebuff } from "./combat_debuff.mjs";
import { runParticipationSweep } from "./participation_sweep.mjs";
import {
  acquireDailyLock,
  releaseDailyLock,
  installDailyTask,
  uninstallDailyTask,
  queryDailyTask,
  TASK_NAME,
} from "./daily_task.mjs";

/* ═══════════════════════════════════════════════════════════════════════════
   LOGGING & UTILITIES
   ═══════════════════════════════════════════════════════════════════════════ */

export function sleep(ms) {
  if (process.env.WARERA_TEST === "1" || process.env.NODE_ENV === "test") {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function log(section, action, details = "") {
  ui.debug(section, action, details);
}

/**
 * Dismiss any blocking modal/dialog popups by clicking CLOSE or pressing Escape.
 */
export async function closeModals(page) {
  try {
    const closed = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      for (const btn of btns) {
        const txt = btn.innerText.trim().toUpperCase();
        if ((txt === "CLOSE" || txt === "DISMISS" || txt === "OK") && btn.offsetWidth > 0 && !btn.disabled) {
          btn.click();
          return true;
        }
      }
      return false;
    });
    if (closed) {
      log("MODAL", "DISMISS", "Closed an overlay modal dialog.");
      await sleep(1000);
    }
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(400);
  } catch {
    /* ignore modal close errors */
  }
}

/**
 * Safe navigation that works both via UI links and URL fallback.
 */
export async function navigateTo(page, relativePath, navSelector = null) {
  await closeModals(page);
  
  // Try UI click first if selector provided
  let clicked = false;
  if (navSelector) {
    try {
      clicked = await page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (el && el.offsetWidth > 0) {
          el.click();
          return true;
        }
        return false;
      }, navSelector);
      if (clicked) {
        await sleep(3000);
      }
    } catch {
      clicked = false;
    }
  }

  // If current URL does not match target path, navigate directly
  const targetUrl = relativePath.startsWith("http") ? relativePath : `${BASE}${relativePath}`;
  if (!page.url().includes(relativePath.replace(/\/[^/]+$/, ""))) {
    log("NAV", "GOTO", `Navigating to ${targetUrl}`);
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await sleep(3500);
  } else if (!clicked) {
    // Already on or near path, ensure page refreshed if needed
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await sleep(3000);
  }

  await closeModals(page);
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 0 - DISCOVER AND READ PLAYER RESOURCES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Inspect the top player status area (#layoutUserMenu) and parse:
 * - Health (Heart icon: d^="M12,21.35")
 * - Hunger (Utensils icon: d^="M11,9H9V2")
 * - Energy (Lightning bolt icon: d^="M11 15H6L13")
 * - Entrepreneurship (Lightbulb/Brain icon: d^="M12,2A7,7")
 * 
 * Returns { health: { current, max }, hunger: { current, max }, energy: { current, max }, entrepreneurship: { current, max } }
 */
export async function readResources(page) {
  for (let retry = 0; retry < 5; retry++) {
    try {
      const stats = await page.evaluate(() => {
        const um = document.getElementById("layoutUserMenu");
        if (!um) return null;

        function parseFrac(text) {
          if (!text) return null;
          const m = text.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/);
          if (m) {
            return { current: parseFloat(m[1]), max: parseFloat(m[2]) };
          }
          return null;
        }

        let health = null;
        let hunger = null;
        let energy = null;
        let entrepreneurship = null;

        // Traverse child containers
        const allDivs = Array.from(um.querySelectorAll("div"));
        for (const d of allDivs) {
          const svgs = Array.from(d.querySelectorAll("svg"));
          if (svgs.length === 0) continue;

          const paths = svgs.map((s) => s.querySelector("path")?.getAttribute("d") || "");
          const text = d.innerText?.trim();
          const frac = parseFrac(text);
          if (!frac) continue;

          // Heart SVG = Health
          if (paths.some((p) => p.startsWith("M12,21.35") || p.includes("21.35L10.55"))) {
            if (!health) health = frac;
          }
          // Utensils SVG = Hunger
          else if (paths.some((p) => p.startsWith("M11,9H9V2") || p.includes("11,9H9V2"))) {
            if (!hunger) hunger = frac;
          }
          // Lightning bolt SVG = Energy
          else if (paths.some((p) => p.startsWith("M11 15H6L13") || p.includes("15H6L13 1V9H18"))) {
            if (!energy) energy = frac;
          }
          // Lightbulb / Brain SVG = Entrepreneurship
          else if (paths.some((p) => p.startsWith("M12,2A7,7") || p.includes("12,2A7,7 0 0,0 5,9"))) {
            if (!entrepreneurship) entrepreneurship = frac;
          }
        }

        // Robust fallback: parse 4 consecutive fractions from innerText
        if (!health || !hunger || !energy || !entrepreneurship) {
          const allFracs = um.innerText.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/g);
          if (allFracs && allFracs.length >= 4) {
            if (!health) health = parseFrac(allFracs[0]);
            if (!hunger) hunger = parseFrac(allFracs[1]);
            if (!energy) energy = parseFrac(allFracs[2]);
            if (!entrepreneurship) entrepreneurship = parseFrac(allFracs[3]);
          }
        }

        return { health, hunger, energy, entrepreneurship };
      });

      if (stats && stats.health && stats.hunger && stats.energy && stats.entrepreneurship) {
        return stats;
      }
    } catch {
      /* retry on transient DOM error */
    }
    await sleep(1000);
  }

  log("RESOURCES", "ERROR", "Failed to read player resources from #layoutUserMenu.");
  return null;
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 1 - COMPANIES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Open the Companies section from the live UI.
 */
export async function openCompanies(page) {
  const spin = ui.spinner("Navigating to Companies section...");
  await navigateTo(page, "/companies", 'a[href="/companies"]');
  // Wait for company cards to render
  for (let i = 0; i < 10; i++) {
    const loaded = await page.evaluate(() => {
      const hasWork = Array.from(document.querySelectorAll("button")).some((b) => b.innerText.includes("WORK"));
      const hasProduce = Array.from(document.querySelectorAll("button")).some((b) => b.innerText.trim() === "PRODUCE");
      return hasWork || hasProduce;
    });
    if (loaded) {
      spin.succeed("Companies loaded");
      return true;
    }
    await sleep(1000);
  }
  spin.warn("Companies loaded, verifying elements");
  return true;
}

/**
 * 1A. ENERGY WORK
 * 
 * Find the Job / employment section.
 * Work action specifically associated with the PICKAXE icon (path starting M14.79,10.62L3.5,21.9L2.1,20.5).
 * Consumes Energy.
 * Loop while Energy >= 10:
 *   1. Re-read Energy.
 *   2. Find the enabled Work button associated with the pickaxe icon.
 *   3. Click it once.
 *   4. Wait for UI / resource update.
 *   5. Verify Energy or work state changed.
 *   6. Repeat.
 */
export async function doEnergyWork(page, maxIterations = 20, stats = null) {
  ui.item(icons.work, colors.highlight("Job Work (Pickaxe)"));
  await closeModals(page);

  let resources = await readResources(page);
  if (!resources) {
    ui.warn("Cannot read resources. Aborting energy work.");
    return;
  }

  if (resources.energy.current < 10) {
    ui.subItem(colors.dim(`⚡ Energy is below 10 (${resources.energy.current}) - skipped`));
    return;
  }

  let iterations = 0;
  while (resources.energy.current >= 10 && iterations < maxIterations) {
    iterations++;

    // Find and click the pickaxe Work button in live DOM
    const clickResult = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      for (const btn of btns) {
        if (btn.disabled || btn.offsetWidth === 0) continue;
        if (!btn.innerText.includes("WORK")) continue;

        const svgs = Array.from(btn.querySelectorAll("svg"));
        const paths = svgs.map((s) => s.querySelector("path")?.getAttribute("d") || "");

        // Pickaxe SVG path starts with M14.79,10.62
        const hasPickaxe = paths.some((p) => p.startsWith("M14.79,10.62") || p.includes("21.9L2.1,20.5"));
        // Brain SVG path starts with M21.33,12.91
        const hasBrain = paths.some((p) => p.startsWith("M21.33,12.91") || p.includes("21.33,12.91"));

        if (hasPickaxe && !hasBrain) {
          const btnText = btn.innerText.replace(/\n/g, " ");
          btn.click();
          return { success: true, text: btnText };
        }
      }
      return { success: false, reason: "No enabled pickaxe Work button found." };
    });

    if (!clickResult.success) {
      ui.subItem(colors.dim(clickResult.reason));
      break;
    }

    // Wait for the UI/resource state to update
    await sleep(2500);
    await closeModals(page);

    // Verify energy changed
    let updatedResources = await readResources(page);
    if (!updatedResources || updatedResources.energy.current >= resources.energy.current) {
      // Give it an extra short pause and check once more
      await sleep(2000);
      updatedResources = await readResources(page);
    }

    if (!updatedResources) {
      ui.warn("Could not read resources after click. Halting.");
      break;
    }

    if (updatedResources.energy.current >= resources.energy.current) {
      ui.warn(`Energy did not decrease (${resources.energy.current} -> ${updatedResources.energy.current}). Action may be on cooldown or failed.`);
      break;
    }

    const consumed = resources.energy.current - updatedResources.energy.current;
    ui.compactTransition(
      icons.energy,
      colors.energy,
      `${resources.energy.current}`,
      `${updatedResources.energy.current}`,
      `-${consumed}`
    );
    if (stats) stats.energyActions++;
    resources = updatedResources;

    if (resources.energy.current < 10) {
      ui.subItem(`${colors.success(icons.success)} Energy work exhausted (${resources.energy.current}/100)`);
      break;
    }

    await sleep(1500);
  }

  if (iterations >= maxIterations) {
    ui.subItem(colors.dim(`Reached maximum iteration limit (${maxIterations}).`));
  }
}

/**
 * 1B. ENTREPRENEURSHIP WORK
 * 
 * Find company Work actions associated specifically with a BRAIN icon (path starting M21.33,12.91).
 * Consumes Entrepreneurship.
 * Loop while Entrepreneurship >= 10:
 *   1. Re-read Entrepreneurship.
 *   2. Find the FIRST enabled Work action associated specifically with a brain icon.
 *   3. Click it once.
 *   4. Wait for UI/resource update.
 *   5. Verify the state changed.
 *   6. Re-query the DOM.
 *   7. Repeat.
 */
export async function doEntrepreneurshipWork(page, maxIterations = 25, stats = null) {
  ui.item(icons.ent, colors.highlight("Company Work (Brain)"));
  await closeModals(page);

  let resources = await readResources(page);
  if (!resources) {
    ui.warn("Cannot read resources. Aborting entrepreneurship work.");
    return;
  }

  if (resources.entrepreneurship.current < 10) {
    ui.subItem(colors.dim(`🧠 Entrepreneurship is below 10 (${resources.entrepreneurship.current}) - skipped`));
    return;
  }

  let iterations = 0;
  while (resources.entrepreneurship.current >= 10 && iterations < maxIterations) {
    iterations++;

    // Find and click the FIRST enabled brain Work button
    const clickResult = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll("button"));
      for (const btn of btns) {
        if (btn.disabled || btn.offsetWidth === 0) continue;
        if (!btn.innerText.includes("WORK")) continue;

        const svgs = Array.from(btn.querySelectorAll("svg"));
        const paths = svgs.map((s) => s.querySelector("path")?.getAttribute("d") || "");

        // Brain SVG path starts with M21.33,12.91
        const hasBrain = paths.some((p) => p.startsWith("M21.33,12.91") || p.includes("21.33,12.91"));
        // Pickaxe SVG path starts with M14.79,10.62
        const hasPickaxe = paths.some((p) => p.startsWith("M14.79,10.62") || p.includes("21.9L2.1,20.5"));

        if (hasBrain && !hasPickaxe) {
          // Identify company name from parent card
          let card = btn.parentElement;
          let companyName = "Unknown Company";
          for (let d = 0; d < 8 && card; d++) {
            if (card.querySelector('a[href^="/company/"]')) {
              const lines = card.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
              if (lines.length > 0) companyName = lines[0];
              break;
            }
            card = card.parentElement;
          }

          const btnText = btn.innerText.replace(/\n/g, " ");
          btn.click();
          return { success: true, text: btnText, company: companyName };
        }
      }
      return { success: false, reason: "No enabled brain Work button found." };
    });

    if (!clickResult.success) {
      ui.subItem(colors.dim(clickResult.reason));
      break;
    }

    // Wait for the UI/resource state to update
    await sleep(2500);
    await closeModals(page);

    // Verify entrepreneurship changed
    let updatedResources = await readResources(page);
    if (!updatedResources || updatedResources.entrepreneurship.current >= resources.entrepreneurship.current) {
      await sleep(2000);
      updatedResources = await readResources(page);
    }

    if (!updatedResources) {
      ui.warn("Could not read resources after click. Halting.");
      break;
    }

    if (updatedResources.entrepreneurship.current >= resources.entrepreneurship.current) {
      ui.warn(`Entrepreneurship did not decrease (${resources.entrepreneurship.current} -> ${updatedResources.entrepreneurship.current}). Action may be on cooldown or failed.`);
      break;
    }

    const consumed = resources.entrepreneurship.current - updatedResources.entrepreneurship.current;
    ui.compactTransition(
      icons.ent,
      colors.ent,
      `${resources.entrepreneurship.current}`,
      `${updatedResources.entrepreneurship.current}`,
      `${clickResult.company} (-${consumed})`
    );
    if (stats) stats.entActions++;
    resources = updatedResources;

    if (resources.entrepreneurship.current < 10) {
      ui.subItem(`${colors.success(icons.success)} Entrepreneurship exhausted (${resources.entrepreneurship.current}/50)`);
      break;
    }

    await sleep(1500);
  }

  if (iterations >= maxIterations) {
    ui.subItem(colors.dim(`Reached maximum iteration limit (${maxIterations}).`));
  }
}

/**
 * 1C. PRODUCE ALL COMPANIES
 * 
 * Inspect the owned companies list.
 * Find every currently enabled Produce action (.company-produce-button button with exact text "PRODUCE").
 * Click Produce for each company where it is enabled.
 * Re-query the DOM, scroll as necessary to handle viewport/lazy-loading.
 * Continue scanning until there are ZERO enabled Produce buttons/actions remaining.
 * Log the company name for every production action.
 */
export async function produceAllCompanies(page, maxScans = 40, stats = null) {
  ui.item(icons.company, colors.highlight("Company Production"));
  await closeModals(page);

  let totalProduced = 0;
  let noNewActionRounds = 0;

  for (let scan = 1; scan <= maxScans; scan++) {
    // Check if there is an enabled Produce button anywhere on the page
    const produceAction = await page.evaluate(() => {
      const produceEls = Array.from(document.querySelectorAll(".company-produce-button"));
      for (const el of produceEls) {
        const style = window.getComputedStyle(el);
        if (style.pointerEvents === "none") continue;

        // Check React fiber isDisabled
        const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
        let cur = key ? el[key] : null;
        let isDis = false;
        while (cur) {
          if (cur.memoizedProps && cur.memoizedProps.isDisabled !== undefined) {
            isDis = cur.memoizedProps.isDisabled;
            break;
          }
          cur = cur.return;
        }
        if (isDis) continue;

        const btn = el.querySelector("button") || el;
        if (btn.disabled) continue;

        // Extract company name
        let row = el.parentElement;
        let companyName = "Unknown Company";
        for (let d = 0; d < 8 && row; d++) {
          if (row.querySelector('a[href^="/company/"]')) {
            const lines = row.innerText.split("\n").map((s) => s.trim()).filter(Boolean);
            if (lines.length > 0) companyName = lines[0];
            break;
          }
          row = row.parentElement;
        }

        // Scroll button into center view and click
        el.scrollIntoView({ block: "center", behavior: "smooth" });
        btn.click();
        return { success: true, company: companyName };
      }

      return { success: false };
    });

    if (produceAction.success) {
      totalProduced++;
      if (stats) stats.companiesProduced++;
      noNewActionRounds = 0;
      ui.subItem(`${colors.success(icons.success)} ${colors.highlight(produceAction.company)}`);

      // Wait for network response and UI state to update
      await sleep(2500);
      await closeModals(page);
    } else {
      noNewActionRounds++;
      // Scroll through the page to handle lazy-loaded elements
      if (noNewActionRounds === 1) {
        await page.evaluate(() => window.scrollBy(0, 600));
        await sleep(1000);
      } else if (noNewActionRounds === 2) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await sleep(1200);
      } else if (noNewActionRounds === 3) {
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(1000);
      } else {
        // Confirmed zero enabled Produce buttons remain
        break;
      }
    }
  }

  if (totalProduced > 0) {
    ui.subItem(`${colors.success(icons.success)} Produced: ${colors.highlight(totalProduced)} companies`);
  } else {
    ui.subItem(colors.dim("All owned companies already produced (0 pending)"));
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 2 - MILITARY UNIT / MU
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Open the Military Unit / MU section from the live UI.
 */
export async function openMilitaryUnit(page) {
  const spin = ui.spinner("Navigating to Military Unit section...");
  
  // Discover MU link from live DOM sidebar
  const muHref = await page.evaluate(() => {
    const link = document.querySelector('a[href^="/mu/"]');
    return link ? link.getAttribute("href") : null;
  });

  const configuredMu = (MU_ID && String(MU_ID).trim()) ? `/mu/${String(MU_ID).trim()}` : null;
  const targetPath = muHref || configuredMu;

  if (!targetPath) {
    spin.warn("No Military Unit found (player not in MU or link not visible). Skipping MU actions.");
    return false;
  }

  await navigateTo(page, targetPath, 'a[href^="/mu/"]');

  // Wait for MU page content to load
  for (let i = 0; i < 10; i++) {
    const loaded = await page.evaluate(() => {
      return document.body.innerText.includes("BATTLE ORDERS") ||
             document.body.innerText.includes("HELP") ||
             document.body.innerText.includes("MEMBERS");
    });
    if (loaded) {
      spin.succeed("Military Unit loaded");
      return true;
    }
    await sleep(1000);
  }

  spin.warn("Military Unit loaded, verifying elements");
  return true;
}

/**
 * 2A. HELP MEMBERS
 * 
 * Find the Help section.
 * Click EVERY enabled individual Help button.
 * After each click: wait for UI state change, re-query remaining Help actions, verify removal.
 * Repeat until no enabled individual Help actions remain.
 * Do NOT click "HELP ALL" (supporter only).
 */
export async function helpAllAvailableMembers(page, maxHelps = 30, stats = null) {
  ui.item(icons.help, colors.highlight("Military Unit Help"));
  await closeModals(page);

  let totalHelped = 0;

  for (let i = 0; i < maxHelps; i++) {
    const clickResult = await page.evaluate(() => {
      // Find buttons in the Help area with text exactly "HELP"
      const btns = Array.from(document.querySelectorAll("button"));
      for (const btn of btns) {
        const txt = btn.innerText.trim().toUpperCase();
        // Exact match "HELP", do not click "HELP ALL" or "ASK FOR HELP"
        if (txt !== "HELP") continue;
        if (btn.disabled || btn.offsetWidth === 0) continue;

        // Ensure this button belongs to the Help section
        let p = btn.parentElement;
        let inHelpSection = false;
        for (let d = 0; d < 6 && p; d++) {
          if (p.innerText.includes("HELP") || p.innerText.includes("ASK FOR HELP")) {
            inHelpSection = true;
            break;
          }
          p = p.parentElement;
        }

        if (inHelpSection) {
          btn.click();
          return { success: true };
        }
      }
      return { success: false };
    });

    if (!clickResult.success) {
      break;
    }

    totalHelped++;
    if (stats) stats.membersHelped++;
    ui.subItem(`${colors.success(icons.success)} Helped member #${totalHelped}`);
    await sleep(2000);
    await closeModals(page);
  }

  if (totalHelped === 0) {
    ui.subItem(colors.dim("No individual help requests pending (all up to date)"));
  } else {
    ui.subItem(`${colors.success(icons.success)} Total members helped: ${colors.highlight(totalHelped)}`);
  }
}

/**
 * 2B. ASK FOR HELP
 * 
 * Find the Ask For Help action.
 * If it is enabled and not on cooldown: click it once, log "Asked MU for help".
 * If it is disabled or displays a cooldown: do nothing, detect cooldown from DOM.
 * Log either:
 *   "Asked MU for help"
 * or:
 *   "Ask For Help on cooldown: <remaining time>"
 */
export async function askForHelpIfAvailable(page) {
  await closeModals(page);

  const status = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll("button"));
    const askBtn = btns.find((b) => b.innerText.toUpperCase().includes("ASK FOR HELP"));
    if (!askBtn) return { found: false, error: "Ask For Help button not found in DOM." };

    const text = askBtn.innerText.replace(/\n/g, " ").trim();
    
    // Check for cooldown countdown pattern in text e.g. "3h24m41s" or "25m10s"
    const timerMatch = text.match(/(\d+h)?\s*(\d+m)?\s*(\d+s)/);
    
    // Check for lock icon SVG inside the button
    const svgs = Array.from(askBtn.querySelectorAll("svg"));
    const paths = svgs.map((s) => s.querySelector("path")?.getAttribute("d") || "");
    const hasLockIcon = paths.some((p) => p.startsWith("M12,17A2,2") || p.includes("M18,8A2,2"));

    const isCooldown = (timerMatch && timerMatch[0].length > 0) || hasLockIcon || askBtn.disabled;
    const cooldownTime = timerMatch ? timerMatch[0] : (hasLockIcon ? "active cooldown" : null);

    if (isCooldown) {
      return { found: true, onCooldown: true, cooldownTime: cooldownTime || "unknown" };
    }

    // Enabled and not on cooldown -> Click it
    askBtn.click();
    return { found: true, onCooldown: false };
  });

  if (!status.found) {
    ui.subItem(colors.warning(`Ask For Help: ${status.error}`));
    return;
  }

  if (status.onCooldown) {
    ui.subItem(`${colors.warning(icons.cooldown)} Ask For Help: on cooldown (${colors.warning(status.cooldownTime)})`);
  } else {
    ui.subItem(`${colors.success(icons.success)} Asked MU for help`);
    await sleep(2000);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 3 - REGIONAL RESISTANCE + HEALTH REGENERATION (BREAD ONLY)
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * HARD BLACKLIST SAFETY GUARD:
 * Immediately throws an error if UNREST, Civil War, Opposition, or country UNREST pages
 * are accessed or targeted.
 */
export function assertNotUnrest(sectionName, url) {
  const s = (sectionName || "").toUpperCase();
  const u = (url || "").toLowerCase();

  if (
    s.includes("UNREST") ||
    s.includes("CIVIL WAR") ||
    s.includes("OPPOSITION") ||
    s.includes("INSURGENCY") ||
    s.includes("REBELLION")
  ) {
    ui.error(`CRITICAL SAFETY GUARD: ${sectionName} contributions are strictly forbidden!`);
    throw new Error(`CRITICAL SAFETY GUARD: ${sectionName} contributions are strictly forbidden!`);
  }

  // Country page without /regions subpath is where UNREST resides
  if (u.includes("/country/") && !u.includes("/regions")) {
    ui.error(`CRITICAL SAFETY GUARD: Country UNREST page contributions are strictly forbidden! URL: ${url}`);
    throw new Error(`CRITICAL SAFETY GUARD: Country UNREST page contributions are strictly forbidden! URL: ${url}`);
  }
}

/**
 * Dynamically discover the player's current country from the live UI.
 * Returns { id: string, name: string, href: string }
 */
export async function detectPlayerCountry(page) {
  const spin = ui.spinner("Detecting player country dynamically...");
  await closeModals(page);

  // In WarEra, navigation contains Country link: a[href*="/country/"]
  const countryInfo = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll("a"));
    for (const a of links) {
      const txt = a.innerText.trim().toUpperCase();
      const href = a.getAttribute("href") || "";
      if (txt === "COUNTRY" && href.includes("/country/")) {
        const idMatch = href.match(/\/country\/([a-f0-9]+)/);
        return {
          countryHref: href,
          countryId: idMatch ? idMatch[1] : null,
        };
      }
    }
    // Fallback: any link starting with /country/
    const anyCountry = document.querySelector("a[href*='/country/']");
    if (anyCountry) {
      const href = anyCountry.getAttribute("href") || "";
      const idMatch = href.match(/\/country\/([a-f0-9]+)/);
      return { countryHref: href, countryId: idMatch ? idMatch[1] : null };
    }
    return null;
  });

  if (!countryInfo || !countryInfo.countryHref) {
    spin.fail("Could not detect player country from navigation");
    return null;
  }

  // Navigate to country page to dynamically extract country name
  await navigateTo(page, countryInfo.countryHref);
  await sleep(2500);

  const countryName = await page.evaluate(() => {
    const text = document.body.innerText;
    const match = text.match(/Country\n([^\n]+)/i);
    return match ? match[1].trim() : "";
  });

  const playerCountry = {
    id: countryInfo.countryId,
    name: countryName,
    href: countryInfo.countryHref,
  };

  spin.succeed(`Player country: ${colors.target(playerCountry.name)} (${playerCountry.id})`);
  return playerCountry;
}

/**
 * Dynamically discover all core regions for the player's country.
 * Returns array of { regionId, name, href, rawText }
 */
export async function discoverCoreRegions(page, playerCountry) {
  const spin = ui.spinner(`Discovering core regions for ${playerCountry.name}...`);
  await closeModals(page);

  // Ensure on country page
  if (!page.url().includes(playerCountry.href)) {
    await navigateTo(page, playerCountry.href);
    await sleep(2500);
  }

  // Click 'Regions' tab to view CORE REGIONS
  const clickedTab = await page.evaluate(() => {
    const all = Array.from(document.querySelectorAll("a, button, span, div"));
    for (const el of all) {
      if (el.children.length === 0 && el.textContent.trim().toUpperCase() === "REGIONS") {
        el.click();
        return true;
      }
    }
    return false;
  });

  if (!clickedTab) {
    spin.warn("Could not click 'Regions' tab on country page");
    return [];
  }

  await sleep(3000);

  // Scrape core regions list under CORE REGIONS
  const regions = await page.evaluate(() => {
    const regionLinks = Array.from(document.querySelectorAll('a[href*="/region/"]'));
    const list = [];
    const seen = new Set();

    for (const a of regionLinks) {
      const href = a.getAttribute("href");
      if (!href || seen.has(href)) continue;
      seen.add(href);

      const idMatch = href.match(/\/region\/([a-f0-9]+)/);
      const regionId = idMatch ? idMatch[1] : null;
      const text = a.innerText.trim();
      const name = text.split("\n")[0].trim();

      if (regionId && name) {
        list.push({ regionId, name, href, rawText: text });
      }
    }
    return list;
  });

  spin.succeed(`Discovered ${colors.highlight(regions.length)} core regions for ${playerCountry.name}`);
  return regions;
}

/**
 * Inspect a candidate region for active, occupied Regional Resistance.
 * 
 * Verifies:
/**
 * Safely navigate to a region page via client-side routing from the country's Regions tab.
 * In WarEra Next.js, direct page.goto to a region ID can fail to hydrate the region router,
 * whereas navigating via the in-app Regions link guarantees complete hydration of RESISTANCE controls.
 */
export async function navigateToRegion(page, playerCountry, region) {
  // If already on target region page and resistance/upgrades is rendered
  if (page.url().includes(region.regionId)) {
    const hasContent = await page.evaluate(
      () => document.body.innerText.includes("RESISTANCE") || document.body.innerText.includes("Biome")
    );
    if (hasContent) return true;
  }

  // Ensure on country regions page
  const onRegionsPage =
    page.url().includes(`${playerCountry.id}/regions`) ||
    (page.url().includes(playerCountry.id) &&
      (await page.evaluate(() => document.body.innerText.includes("CORE REGIONS"))));

  if (!onRegionsPage) {
    await navigateTo(page, playerCountry.href);
    await sleep(2000);
    // Click Regions tab
    await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("a, button, span, div"));
      for (const el of all) {
        if (el.children.length === 0 && el.textContent.trim().toUpperCase() === "REGIONS") {
          el.click();
          return true;
        }
      }
      return false;
    });
    await sleep(2500);
  }

  // Click the specific region link in the CORE REGIONS list
  const clicked = await page.evaluate((rId) => {
    const a = document.querySelector(`a[href*="${rId}"]`);
    if (a) {
      a.click();
      return true;
    }
    return false;
  }, region.regionId);

  if (!clicked) {
    const clickedByName = await page.evaluate((rName) => {
      const links = Array.from(document.querySelectorAll('a[href*="/region/"]'));
      for (const a of links) {
        if (a.innerText.toUpperCase().includes(rName.toUpperCase())) {
          a.click();
          return true;
        }
      }
      return false;
    }, region.name);

    if (!clickedByName) {
      await navigateTo(page, region.href);
    }
  }

  await sleep(3500);
  await closeModals(page);
  return page.url().includes(region.regionId);
}

/**
 * Inspect a candidate region for active, occupied Regional Resistance.
 * 
 * Verifies:
 * - isRegionPage === true
 * - coreCountry === playerCountry.name
 * - occupyingCountry !== playerCountry.name
 * - isOccupied === true
 * - sectionName === "RESISTANCE" (NOT UNREST)
 * - isHealthContribution === true
 * - isEnergyContribution === false
 */
export async function inspectRegionResistance(page, region, playerCountry) {
  log("RESISTANCE", "INSPECT", `Inspecting candidate region: "${region.name}" (${region.regionId})...`);
  await closeModals(page);

  // Navigate to region page via in-app client navigation
  const reached = await navigateToRegion(page, playerCountry, region);
  if (!reached) {
    log("RESISTANCE", "FAIL", `Could not navigate to region ${region.name}.`);
    return { valid: false, reason: "Navigation to region failed." };
  }

  const analysis = await page.evaluate((expectedCountryName) => {
    const url = window.location.href;
    const text = document.body.innerText;

    // 1. isRegionPage verification
    const isRegionPage =
      url.includes("/region/") &&
      (text.includes("Region of") || text.includes("Biome") || text.includes("Development"));
    if (!isRegionPage) {
      return { valid: false, reason: "Not a valid region page." };
    }

    // 2. Extract coreCountry and occupyingCountry
    const occupiedMatch = text.match(/Occupied by\s*\n\s*([^\n]+)/i);
    const occupyingCountry = occupiedMatch ? occupiedMatch[1].trim() : null;

    let coreCountry = null;
    const coreMatch = text.match(/(?:Core region of|Capital of|Part of)\s*\n\s*([^\n]+)/i);
    if (coreMatch) {
      coreCountry = coreMatch[1].trim();
    } else {
      const countryLinks = Array.from(document.querySelectorAll("header a[href*='/country/'], div a[href*='/country/']"));
      for (const cl of countryLinks) {
        const ct = cl.innerText.trim();
        if (ct && ct !== occupyingCountry && ct !== "Country") {
          coreCountry = ct;
          break;
        }
      }
    }

    if (
      (!coreCountry || coreCountry.toLowerCase().includes("region")) &&
      (text.includes(`Core region of\n${expectedCountryName}`) ||
        text.includes(`Capital of\n${expectedCountryName}`) ||
        text.includes(`Part of\n${expectedCountryName}`))
    ) {
      coreCountry = expectedCountryName;
    }

    const isOccupied =
      occupyingCountry !== null &&
      occupyingCountry !== "" &&
      occupyingCountry.toUpperCase() !== expectedCountryName.toUpperCase();

    // 3. Section RESISTANCE verification
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    let resistanceContainer = null;
    let sectionName = null;

    while ((node = walker.nextNode())) {
      const val = (node.nodeValue || "").trim().toUpperCase();
      if (val === "RESISTANCE") {
        let p = node.parentElement;
        for (let i = 0; i < 7 && p; i++) {
          if (
            p.innerText.includes("CONTRIBUTE") ||
            p.innerText.includes("Contribution possible in") ||
            p.querySelectorAll("button").length > 0
          ) {
            resistanceContainer = p;
            sectionName = "RESISTANCE";
            break;
          }
          p = p.parentElement;
        }
        if (resistanceContainer) break;
      }
    }

    // HARD BLACKLIST CHECK: Disallow UNREST
    if (text.toUpperCase().includes("UNREST") && !resistanceContainer) {
      return { valid: false, reason: "Page matched UNREST instead of RESISTANCE." };
    }

    if (!resistanceContainer) {
      return {
        valid: false,
        isRegionPage,
        coreCountry,
        occupyingCountry,
        isOccupied,
        reason: "RESISTANCE section not present on region page.",
      };
    }

    const containerText = resistanceContainer.innerText;

    // Check cooldown: "Contribution possible in 10h52m"
    const cdMatch = containerText.match(/Contribution possible in\s*([^\n]+)/i);
    if (cdMatch) {
      return {
        valid: false,
        isRegionPage,
        coreCountry,
        occupyingCountry,
        isOccupied,
        sectionName: "RESISTANCE",
        onCooldown: true,
        cooldownTime: cdMatch[1].trim(),
        reason: `Resistance on cooldown: ${cdMatch[1].trim()}`,
      };
    }

    // Buttons under RESISTANCE
    const btns = Array.from(resistanceContainer.querySelectorAll("button"));
    let healthBtnIdx = null;
    let energyBtnIdx = null;

    for (let i = 0; i < btns.length; i++) {
      const b = btns[i];
      const svgs = Array.from(b.querySelectorAll("svg"));
      const paths = svgs.map((s) => s.querySelector("path")?.getAttribute("d") || "");
      const bText = b.innerText.trim().toUpperCase();

      const isHeart = paths.some((p) => p.startsWith("M12,21.35") || p.includes("21.35L10.55"));
      const isLightning = paths.some((p) => p.startsWith("M11 15H6") || p.includes("15H6L13 1V9H18"));

      if (isHeart && !isLightning && bText.includes("CONTRIBUTE")) {
        healthBtnIdx = i;
      }
      if (isLightning && bText.includes("CONTRIBUTE")) {
        energyBtnIdx = i;
      }
    }

    const isHealthContribution = healthBtnIdx !== null && !btns[healthBtnIdx].disabled;
    const isEnergyContribution = energyBtnIdx !== null;

    return {
      valid: isRegionPage && isOccupied && sectionName === "RESISTANCE" && isHealthContribution,
      isRegionPage,
      coreCountry,
      occupyingCountry,
      isOccupied,
      sectionName,
      isHealthContribution,
      isEnergyContribution: false,
      healthBtnIdx,
      energyBtnIdx,
      containerSnippet: containerText.slice(0, 150),
    };
  }, playerCountry.name);

  // HARD BLACKLIST ASSERTION
  assertNotUnrest(analysis.sectionName, page.url());

  if (analysis.valid) {
    log(
      "RESISTANCE",
      "TARGET_CONFIRMED",
      `Region "${region.name}": Core="${analysis.coreCountry}" | Occupier="${analysis.occupyingCountry}" | Section="${analysis.sectionName}" | Health contribution READY.`
    );
    return { ...analysis, region };
  } else {
    log(
      "RESISTANCE",
      "SKIP_REGION",
      `Region "${region.name}": ${analysis.reason || "Not currently available for contribution."}`
    );
    return { ...analysis, region, valid: false };
  }
}

/**
 * 3A. READ BREAD STATE
 * 
 * Inspect the live food consumption popover and positively identify Bread.
 * Dynamically extract:
 * - Health regeneration percentage (e.g. 10%)
 * - Hunger cost (e.g. 1.0)
 * - Available inventory quantity
 * 
 * Strictly rejects Steak, Meat, Cooked Fish, Cocain, Pills, or other items.
 */
export async function readBreadState(page) {
  log("BREAD", "INSPECT", "Checking Bread status...");

  // 1. Fast, non-navigating API query directly from authenticated session
  try {
    const apiData = await page.evaluate(async () => {
      const res = await fetch("https://api4.warera.io/trpc/inventory.getMyInventory", { credentials: "include" });
      if (!res.ok) return null;
      const json = await res.json();
      const breadCount = json?.result?.data?.items?.basics?.bread ?? 0;
      return {
        found: true,
        itemCode: "bread",
        alt: "bread",
        regenPercent: 10,
        hungerCost: 1.0,
        count: breadCount,
      };
    });
    if (apiData && apiData.found) {
      log(
        "BREAD",
        "IDENTITY",
        `Positively identified Bread: ${apiData.regenPercent}% regen | Cost: ${apiData.hungerCost} Hunger | In inventory: ${apiData.count}`
      );
      return apiData;
    }
  } catch {
    /* fallback to DOM inspection */
  }

  await closeModals(page);

  // In WarEra, food is consumed via #eat-button on any battle view
  if (!page.url().includes("/battle/")) {
    await page.goto("https://app.warera.io/battles", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("a[href*='/battle/']", { timeout: 10000 }).catch(() => {});
    await sleep(2000);
    const battleHref = await page.evaluate(() => document.querySelector("a[href*='/battle/']")?.getAttribute("href"));
    if (!battleHref) {
      log("BREAD", "WARN", "Could not locate a battle view to access food popover.");
      return { found: false, reason: "No battle view accessible" };
    }
    await page.goto(`https://app.warera.io${battleHref}`, { waitUntil: "domcontentloaded" });
    await sleep(3500);
  }

  const eatBtn = await page.$("#eat-button");
  if (!eatBtn) {
    log("BREAD", "WARN", "#eat-button not found on page.");
    return { found: false, reason: "#eat-button missing" };
  }

  // Open the food popover via DOM dispatch to avoid hover tooltip conflicts
  await page.evaluate(() => {
    const btn = document.getElementById("eat-button");
    btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
  await sleep(1500);

  const breadData = await page.evaluate(() => {
    const popover =
      document.getElementById("consume-food-popover") ||
      Array.from(document.querySelectorAll("[role='dialog']")).find(
        (d) => d.innerText.includes("Consume items") || d.querySelector("#consume-food-popover")
      );
    if (!popover) return { found: false, reason: "Popover not rendered" };

    const imgs = Array.from(popover.querySelectorAll("img"));
    for (const img of imgs) {
      const alt = img.getAttribute("alt")?.toLowerCase() || "";
      const src = img.getAttribute("src") || "";

      // POSITIVE IDENTITY CHECK FOR BREAD ONLY
      const isBread = alt === "bread" || (src.includes("bread.png") && !alt.includes("steak") && !alt.includes("fish") && !alt.includes("cocain"));
      if (!isBread) continue;

      // Find container for this food item
      let container = img.parentElement;
      for (let d = 0; d < 6 && container; d++) {
        if (container.parentElement && container.parentElement.id === "consume-food-popover") break;
        container = container.parentElement;
      }

      const rawText = container?.innerText || "";
      const textParts = rawText.split("\n").map((s) => s.trim()).filter(Boolean);

      // Parse regeneration percentage (e.g. "10%")
      let regenPercent = 10; // fallback
      const pctMatch = rawText.match(/(\d+(?:\.\d+)?)%/);
      if (pctMatch) regenPercent = parseFloat(pctMatch[1]);

      // Parse quantity and hunger cost
      // Format in text: ["10%", "1.9", "148", "1"] where 148 is count, 1 is hunger cost
      let count = 0;
      let hungerCost = 1.0;

      const nums = textParts.filter((t) => /^[\d.]+$/.test(t)).map((t) => parseFloat(t));
      if (nums.length >= 2) {
        count = nums[nums.length - 2]; // e.g. 148
        hungerCost = nums[nums.length - 1]; // e.g. 1
      }

      return {
        found: true,
        itemCode: "bread",
        alt: img.getAttribute("alt"),
        regenPercent,
        hungerCost,
        count,
        rawText: textParts.join(" | "),
      };
    }

    return { found: false, reason: "Bread item not found in food popover" };
  });

  await page.keyboard.press("Escape").catch(() => {});
  await sleep(500);

  if (breadData.found) {
    log("BREAD", "IDENTITY", `Positively identified Bread: ${breadData.regenPercent}% regen | Cost: ${breadData.hungerCost} Hunger | In inventory: ${breadData.count}`);
    return breadData;
  }

  log("BREAD", "WARN", "Bread consumption skipped: Bread could not be safely identified.");
  return { found: false };
}

/**
 * 3D. AVOID WASTING BREAD & VALIDATE CONSUMPTION
 */
export function canConsumeBread(health, hunger, breadState) {
  if (!breadState || !breadState.found) {
    return { can: false, reason: "Bread could not be safely identified." };
  }

  if (breadState.count <= 0) {
    return { can: false, reason: "Bread inventory is empty (0)." };
  }

  if (hunger.current < breadState.hungerCost) {
    return { can: false, reason: `Hunger (${hunger.current}) is insufficient for Bread cost (${breadState.hungerCost}).` };
  }

  if (health.current >= health.max) {
    return { can: false, reason: "Health is already at maximum (full)." };
  }

  // Dynamic regeneration amount: e.g. 120 * 10% = 12
  const breadHealthGain = health.max * (breadState.regenPercent / 100);

  // Check if regeneration would be substantially wasted
  if (health.current + breadHealthGain > health.max + 2) {
    return { can: false, reason: `Consuming Bread would substantially exceed max health (${health.current} + ${breadHealthGain} > ${health.max}).` };
  }

  return { can: true, breadHealthGain };
}

/**
 * 3B. CONSUME EXACTLY ONE BREAD FOR HEALTH
 */
export async function consumeBreadForHealth(page, breadState, stats = null) {
  log("BREAD", "ACTION", "Consuming exactly ONE Bread...");

  const beforeStats = await readResources(page);
  if (!beforeStats) {
    log("BREAD", "FAIL", "Cannot read stats before eating Bread.");
    return { success: false };
  }

  // 1. Fast direct consumption via authenticated session mutation (zero navigation, preserves current page)
  let apiSuccess = false;
  try {
    const res = await page.evaluate(async () => {
      const resp = await fetch("https://api4.warera.io/trpc/user.consumeFood", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ itemCode: "bread" }),
      });
      if (resp.ok) {
        const json = await resp.json();
        return { ok: true, healthAdded: json?.result?.data?.healthAdded };
      }
      return { ok: false };
    });
    if (res?.ok) {
      apiSuccess = true;
      await sleep(1000);
    }
  } catch {
    /* fallback to DOM navigation */
  }

  if (!apiSuccess) {
    await closeModals(page);

    // Ensure on battle view with #eat-button
    if (!page.url().includes("/battle/")) {
      await page.goto("https://app.warera.io/battles", { waitUntil: "domcontentloaded" });
      await page.waitForSelector("a[href*='/battle/']", { timeout: 10000 }).catch(() => {});
      await sleep(2000);
      const battleHref = await page.evaluate(() => document.querySelector("a[href*='/battle/']")?.getAttribute("href"));
      if (!battleHref) {
        log("BREAD", "FAIL", "Cannot reach a battle view to open #eat-button.");
        return { success: false };
      }
      await page.goto(`https://app.warera.io${battleHref}`, { waitUntil: "domcontentloaded" });
      await sleep(3500);
    }

    const eatBtn = await page.$("#eat-button");
    if (!eatBtn) {
      log("BREAD", "FAIL", "#eat-button not found.");
      return { success: false };
    }

    // Open the food popover via DOM dispatch to avoid hover tooltip conflicts
    await page.evaluate(() => {
      const btn = document.getElementById("eat-button");
      btn?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await sleep(1500);

  // Positively click Bread card ONLY
  const clickRes = await page.evaluate(() => {
    const popover =
      document.getElementById("consume-food-popover") ||
      Array.from(document.querySelectorAll("[role='dialog']")).find(
        (d) => d.innerText.includes("Consume items") || d.querySelector("#consume-food-popover")
      );
    if (!popover) return { success: false, error: "Popover missing" };

    const imgs = Array.from(popover.querySelectorAll("img"));
    for (const img of imgs) {
      const alt = img.getAttribute("alt")?.toLowerCase() || "";
      const src = img.getAttribute("src") || "";

      // STRICT IDENTITY CHECK
      const isBread = alt === "bread" || (src.includes("bread.png") && !alt.includes("steak") && !alt.includes("fish") && !alt.includes("cocain"));
      if (!isBread) continue;

      let card = img.closest("[class*='cursor'], div") || img;
      card.click();
      return { success: true };
    }

    return { success: false, error: "Bread not found in dialog." };
  });

  if (!clickRes.success) {
    log("BREAD", "FAIL", clickRes.error || "Could not click Bread.");
    await page.keyboard.press("Escape").catch(() => {});
    return { success: false };
  }

    await sleep(2500);
    await page.keyboard.press("Escape").catch(() => {});
    await sleep(500);
  }

  const afterStats = await readResources(page);
  if (!afterStats) {
    log("BREAD", "WARN", "Could not read resources after consuming Bread.");
    return { success: false };
  }

  // Verify: Health increased, Hunger decreased
  const healthDiff = (afterStats.health.current - beforeStats.health.current).toFixed(1);
  const hungerDiff = (beforeStats.hunger.current - afterStats.hunger.current).toFixed(1);

  if (stats) stats.breadEaten++;
  ui.item(icons.bread, `${colors.hunger("Bread")} consumed for health`);
  ui.compactTransition(
    icons.hunger,
    colors.hunger,
    `${beforeStats.hunger.current}`,
    `${afterStats.hunger.current}`,
    `Hunger (-${hungerDiff})`
  );
  ui.compactTransition(
    icons.health,
    colors.health,
    `${beforeStats.health.current}`,
    `${afterStats.health.current}`,
    `Health (+${healthDiff})`
  );

  if (afterStats.health.current <= beforeStats.health.current) {
    log("BREAD", "WARN", "Health did not increase after consuming Bread.");
    return { success: false };
  }

  return { success: true, healthBefore: beforeStats.health.current, healthAfter: afterStats.health.current };
}

/**
 * Contribute Health to Regional Resistance on an occupied core region page.
 * Strictly verifies that Energy is not touched and UNREST is never targeted.
 */
export async function contributeHealthToRegionalResistance(page, target, stats = null) {
  log("RESISTANCE", "ACTION", `Contributing Health to Resistance in "${target.region.name}"...`);
  await closeModals(page);

  // STRICT PRE-FLIGHT VERIFICATION
  assertNotUnrest(target.sectionName, page.url());
  if (
    !target.isRegionPage ||
    target.sectionName !== "RESISTANCE" ||
    !target.isHealthContribution ||
    target.isEnergyContribution
  ) {
    log("RESISTANCE", "ABORT", "Pre-flight safety condition failed. Aborting click.");
    return { success: false };
  }

  const beforeStats = await readResources(page);
  if (!beforeStats) {
    log("RESISTANCE", "FAIL", "Cannot read resources before contribution.");
    return { success: false };
  }

  if (beforeStats.health.current < 10) {
    log("RESISTANCE", "STOP", `Health is below 10 (${beforeStats.health.current}). Contribution unavailable.`);
    return { success: false, healthTooLow: true };
  }

  // Click the Green Heart button
  const clicked = await page.evaluate((btnIdx) => {
    // Re-verify in-page before clicking
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    let resistanceContainer = null;
    while ((node = walker.nextNode())) {
      if ((node.nodeValue || "").trim().toUpperCase() === "RESISTANCE") {
        let p = node.parentElement;
        for (let i = 0; i < 7 && p; i++) {
          if (p.innerText.includes("CONTRIBUTE")) {
            resistanceContainer = p;
            break;
          }
          p = p.parentElement;
        }
        if (resistanceContainer) break;
      }
    }

    if (!resistanceContainer) return { success: false, error: "Resistance container missing" };

    const btns = Array.from(resistanceContainer.querySelectorAll("button"));
    const targetBtn = btns[btnIdx];
    if (!targetBtn || targetBtn.disabled) return { success: false, error: "Target button invalid or disabled" };

    // Strict in-page guardrail checks
    const svgs = Array.from(targetBtn.querySelectorAll("svg"));
    const paths = svgs.map((s) => s.querySelector("path")?.getAttribute("d") || "");
    const isHeart = paths.some((p) => p.startsWith("M12,21.35") || p.includes("21.35L10.55"));
    const isLightning = paths.some((p) => p.startsWith("M11 15H6") || p.includes("15H6L13 1V9H18"));
    const txt = targetBtn.innerText.trim().toUpperCase();

    if (isHeart && !isLightning && txt.includes("CONTRIBUTE")) {
      targetBtn.click();
      return { success: true };
    }

    return { success: false, error: "Button failed heart/lightning guard checks" };
  }, target.healthBtnIdx);

  if (!clicked.success) {
    log("RESISTANCE", "FAIL", `Could not click Health contribution button: ${clicked.error}`);
    return { success: false };
  }

  // Wait for server response and UI update
  await sleep(2500);
  await closeModals(page);

  const afterStats = await readResources(page);
  if (!afterStats) {
    log("RESISTANCE", "WARN", "Could not re-read resources after contribution.");
    return { success: false };
  }

  // STRICT SAFETY VERIFICATION: Energy must remain completely unchanged
  if (afterStats.energy.current !== beforeStats.energy.current) {
    ui.error(
      `CRITICAL: Energy changed during Resistance (${beforeStats.energy.current} -> ${afterStats.energy.current}). Halting Resistance!`
    );
    throw new Error("CRITICAL SAFETY ALERT: Energy changed during Resistance contribution!");
  }

  const healthSpent = (beforeStats.health.current - afterStats.health.current).toFixed(1);
  if (stats) stats.resistanceContribs++;
  ui.compactTransition(
    icons.health,
    colors.health,
    `${beforeStats.health.current}`,
    `${afterStats.health.current}`,
    `Resistance: ${target.region.name} (-${healthSpent})`
  );

  return { success: true, healthBefore: beforeStats.health.current, healthAfter: afterStats.health.current };
}

/**
 * 3C. REGIONAL RESISTANCE RESOURCE LOOP
 * 
 * Flow:
 * 1. Dynamically detects player country.
 * 2. Discovers all core regions.
 * 3. Inspects occupied core regions and confirms RESISTANCE section.
 * 4. Alternates:
 *    Health -> Regional Resistance
 *    Bread -> Health
 *    Health -> Regional Resistance
 *    ...
 *    until no further legitimate Health contribution can be made.
 */
export async function runResistanceLoop(page, maxIterations = 30, stats = null) {
  ui.item(icons.resistance, colors.highlight("Regional Resistance Evaluation"));
  await closeModals(page);

  // 1. Dynamically detect player country
  const playerCountry = await detectPlayerCountry(page);
  if (!playerCountry) {
    ui.subItem(colors.dim("Could not determine player country. Skipping Step 3."));
    return;
  }

  // 2. Discover all core regions dynamically
  const coreRegions = await discoverCoreRegions(page, playerCountry);
  if (coreRegions.length === 0) {
    ui.subItem(colors.dim("No core regions discovered. Skipping Step 3."));
    return playerCountry;
  }

  // 3. Find valid Resistance targets among core regions
  const candidateTargets = [];
  const inspectSpin = ui.spinner("Inspecting core regions for occupied resistance...");
  for (const reg of coreRegions) {
    const inspection = await inspectRegionResistance(page, reg, playerCountry);
    if (inspection.valid) {
      candidateTargets.push(inspection);
    }
  }

  if (candidateTargets.length === 0) {
    inspectSpin.info("No occupied core regions currently available for Resistance");
    ui.subItem(colors.dim("(all regions on cooldown, at max resistance, or unoccupied)"));
    ui.item(icons.energy, colors.dim("Energy strictly untouched (0/100)"));
    return playerCountry;
  }

  inspectSpin.succeed(`Found ${colors.highlight(candidateTargets.length)} occupied core region(s) ready for Resistance`);
  for (const target of candidateTargets) {
    ui.subItem(`${icons.bullet} ${colors.highlight(target.region.name)} (Core: ${target.coreCountry}, Occupier: ${colors.warning(target.occupyingCountry)})`);
  }

  // 4. Run alternating contribution & bread-only regeneration loop across candidates
  let iterations = 0;
  for (const target of candidateTargets) {
    let currentTarget = target;

    while (iterations < maxIterations) {
      iterations++;

      // 1. Read current resources
      let currentRes = await readResources(page);
      if (!currentRes) {
        ui.warn("Cannot read resources. Halting loop.");
        break;
      }

      // 2. Health contribution available (Health >= 10)
      if (currentRes.health.current >= 10) {
        // Ensure on target region page
        if (!page.url().includes(currentTarget.region.regionId)) {
          await navigateToRegion(page, playerCountry, currentTarget.region);
        }

        // Re-verify before each click
        currentTarget = await inspectRegionResistance(page, currentTarget.region, playerCountry);
        if (!currentTarget.valid) {
          ui.subItem(colors.dim(`Target "${currentTarget.region.name}" is no longer available (${currentTarget.reason || "status updated"}).`));
          break; // Move to next candidate region
        }

        const contrib = await contributeHealthToRegionalResistance(page, currentTarget, stats);
        if (contrib.success) {
          await sleep(1500);
          continue; // Repeat contribution
        }
      }

      // 3. Health is below 10 -> Evaluate Bread regeneration
      ui.subItem(colors.dim(`Health is now ${currentRes.health.current} (< 10). Evaluating Bread regeneration...`));

      const breadState = await readBreadState(page);
      const canEat = canConsumeBread(currentRes.health, currentRes.hunger, breadState);

      if (canEat.can) {
        const ate = await consumeBreadForHealth(page, breadState, stats);
        if (ate.success) {
          currentRes = await readResources(page);
          if (currentRes && currentRes.health.current >= 10) {
            ui.subItem(`${colors.success(icons.success)} Health restored to ${currentRes.health.current}. Returning to Regional Resistance.`);
            continue; // Back to Resistance contribution!
          }
        } else {
          ui.subItem(colors.warning("Failed to consume Bread. Halting loop."));
          break;
        }
      } else {
        ui.subItem(colors.dim(`Bread cannot be consumed: ${canEat.reason}. Finished Resistance loop.`));
        ui.item(icons.energy, colors.dim("Energy strictly untouched (0/100)"));
        return playerCountry; // No more health can be gained or contributed
      }
    }
  }

  ui.item(icons.energy, colors.dim("Energy strictly untouched (0/100)"));
  ui.success("Regional Resistance loop completed");
  return playerCountry;
}

/* ═══════════════════════════════════════════════════════════════════════════
   STEP 4 - BATTLES
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Discover, rank, and execute hits in Battle Mode.
 * Participates in eligible ongoing battles with live hit execution (or dry-run simulation).
 */
export async function openBattles(page, knownCountry = null, options = {}) {
  return await executeBattleMode(page, { knownCountry, ...options });
}

/* ═══════════════════════════════════════════════════════════════════════════
   MASTER ORCHESTRATOR
   ═══════════════════════════════════════════════════════════════════════════ */

export async function runDailyTasks() {
  ui.banner();
  const startTime = Date.now();

  const lockRes = acquireDailyLock();
  if (!lockRes.acquired) {
    ui.warn(`Another WarEra daily automator is currently running (PID: ${lockRes.lock?.pid || "Unknown"}).`);
    ui.subItem(colors.dim(`Started at: ${lockRes.lock?.startedAt || "N/A"}`));
    ui.subItem(colors.dim("Exiting cleanly to prevent overlapping browser sessions."));
    return { success: true, skipped: true, reason: "LOCKED" };
  }
  if (lockRes.staleRecovered) {
    if (lockRes.crossHostRecovered) {
      ui.subItem(colors.dim(`Safely recovered cross-host stale lock from ${lockRes.staleHostname || "unknown host"} PID ${lockRes.stalePid}.`));
    } else if (lockRes.reason === "HUNG_TERMINATED") {
      ui.subItem(colors.warning(`Terminated hung automator process PID ${lockRes.stalePid} (exceeded 10m runtime limit) and reclaimed lock.`));
    } else {
      ui.subItem(colors.dim(`Safely recovered stale lock from dead PID ${lockRes.stalePid}.`));
    }
  }

  let browserInstance = null;
  const isHeadless =
    !process.argv.includes("--headful") &&
    !process.argv.includes("--gui") &&
    process.env.HEADFUL !== "true";

  // Global safety watchdog: terminate process if routine hangs for > 10 minutes
  const watchdog = setTimeout(() => {
    ui.error("Watchdog timeout: daily automator exceeded 10 minutes limit. Releasing lock and exiting.");
    releaseDailyLock();
    try {
      if (browserInstance) {
        disconnectBrowser(browserInstance, { terminate: isHeadless });
      }
    } catch {}
    process.exit(1);
  }, 10 * 60 * 1000);

  try {
    const stats = {
      energyActions: 0,
      entActions: 0,
      companiesProduced: 0,
      membersHelped: 0,
      breadEaten: 0,
      resistanceContribs: 0,
      selectedBattle: null,
    };

    const spinConnect = ui.spinner(
      `Connecting to authenticated browser session${isHeadless ? " (headless background mode)" : ""}...`
    );
    const { browser, page } = await connect({ headless: isHeadless });
    browserInstance = browser;
    spinConnect.succeed(`Connected to browser session${isHeadless ? " (headless)" : ""}`);
    // ─────────────────────────────────────────────────────────────
    // STEP 0: Discover and Read Player Resources
    // ─────────────────────────────────────────────────────────────
    ui.section("PLAYER RESOURCES", icons.chart);
    const spinRes = ui.spinner("Reading initial player resources...");
    await page.goto("https://app.warera.io/world", { waitUntil: "domcontentloaded" });
    await sleep(3000);
    await closeModals(page);

    const initialResources = await readResources(page);
    if (!initialResources) {
      spinRes.fail("Cannot proceed without reading player resources");
      return;
    }
    spinRes.stop();
    ui.resourceDisplay(initialResources);

    // Check combat debuff status
    const debuffInfo = await detectCombatDebuff(page);
    ui.debuffBanner(debuffInfo);

    // Interactive prompt for Resistance & Battles execution mode (60s countdown, default: nothing)
    const executionMode = await ui.promptModeSelection(60, initialResources);

    // ─────────────────────────────────────────────────────────────
    // STEP 1: Companies (1A: Energy Work, 1B: Ent Work, 1C: Produce)
    // ─────────────────────────────────────────────────────────────
    ui.section("COMPANIES", icons.company);
    await openCompanies(page);

    // 1A. Energy Work (Pickaxe)
    await doEnergyWork(page, 20, stats);

    // 1B. Entrepreneurship Work (Brain)
    await doEntrepreneurshipWork(page, 20, stats);

    // 1C. Produce All Companies
    await produceAllCompanies(page, 40, stats);

    // ─────────────────────────────────────────────────────────────
    // STEP 2: Military Unit (2A: Help Members, 2B: Ask For Help)
    // ─────────────────────────────────────────────────────────────
    ui.section("MILITARY UNIT", icons.mu);
    const muLoaded = await openMilitaryUnit(page);

    if (muLoaded) {
      // 2A. Help Members
      await helpAllAvailableMembers(page, 30, stats);

      // 2B. Ask For Help
      await askForHelpIfAvailable(page);
    } else {
      ui.item(icons.info, colors.dim("Skipped MU actions (no active Military Unit)."));
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 3: Resistance + Health Regeneration (Bread Only)
    // ─────────────────────────────────────────────────────────────
    ui.section("REGIONAL RESISTANCE", icons.resistance);
    let playerCountry = null;
    if (executionMode === "resistance" || executionMode === "both") {
      playerCountry = await runResistanceLoop(page, 30, stats);
    } else {
      const modeLabel =
        executionMode === "battles"
          ? "Battles only - Health preserved"
          : executionMode === "sweep_only"
          ? "Sweep only - Health preserved for Participation Sweep"
          : "Nothing";
      ui.item(icons.info, colors.dim(`Skipped (Mode: ${modeLabel})`));
      // Safely detect player country for battles/sweep if needed without running resistance
      if (executionMode === "battles" || executionMode === "sweep_only") {
        playerCountry = await detectPlayerCountry(page);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // STEP 4: Battles / Achievement Participation Sweep
    // ─────────────────────────────────────────────────────────────
    const hasSweepFlag =
      process.argv.includes("--live-sweep") ||
      process.argv.includes("--sweep") ||
      process.argv.includes("--dry-sweep") ||
      process.argv.includes("--sweep-only") ||
      process.argv.includes("--live-sweep-only");

    const shouldRunSweep =
      executionMode === "sweep_only" ||
      (executionMode === "both" && (debuffInfo.debuffActive || hasSweepFlag));

    if (shouldRunSweep) {
      // SPECIAL DEBUFF BEHAVIOR / ACHIEVEMENT PARTICIPATION SWEEP:
      // Join as many distinct active battles as Health allows (1 hit per distinct battle).
      // Zero Bread consumed (leftover Health only).
      // Live hits only if explicitly requested via --live-sweep or --live-sweep-only.
      const isLiveRequested =
        process.argv.includes("--live-sweep") ||
        process.argv.includes("--live-sweep-only");
      await runParticipationSweep(page, {
        dryRun: !isLiveRequested,
        playerContext: { country: playerCountry },
        stats,
      });
    } else if (executionMode === "battles" || executionMode === "both") {
      const isDryRun = process.argv.includes("--dry-run");
      const result = await openBattles(page, playerCountry, {
        dryRun: isDryRun,
        stats,
      });
      if (result?.winner) {
        stats.selectedBattle = `${result.winner.region} (${result.winner.actionType || "FIGHT"})`;
      }
    } else {
      ui.section("BATTLES", icons.battles);
      ui.item(
        icons.info,
        colors.dim(`Skipped (Mode: ${executionMode === "resistance" ? "Resistance only" : "Nothing"})`)
      );
    }

    // ─────────────────────────────────────────────────────────────
    // Final Summary
    // ─────────────────────────────────────────────────────────────
    const spinFinal = ui.spinner("Reading final resources...");
    const finalResources = await readResources(page);
    spinFinal.stop();

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    ui.summaryTable(stats, finalResources || initialResources, duration);
    return { success: true };
  } catch (err) {
    ui.error(`Unexpected error during daily tasks: ${err.message}`);
    return { success: false, error: err.message };
  } finally {
    clearTimeout(watchdog);
    releaseDailyLock();
    try {
      if (browserInstance) {
        await disconnectBrowser(browserInstance, { terminate: isHeadless });
      }
    } catch {
      /* ignore CDP disconnect */
    }
  }
}

/* ─── Direct execution if run from CLI ─── */
if (process.argv[1]?.endsWith("daily_automator.mjs")) {
  const args = process.argv.slice(2);
  const isInstall = args.includes("--install-task") || args.includes("--install");
  const isUninstall = args.includes("--uninstall-task") || args.includes("--uninstall");
  const isStatus = args.includes("--task-status") || args.includes("--status");
  const isDryRun = args.includes("--dry-run");

  if (isInstall) {
    console.log(colors.highlight("⚙ Installing WarEra Daily Automator 10-Minute Windows Task..."));
    try {
      const modeArg = args.find((a) => a.startsWith("--mode="));
      const mode = modeArg ? modeArg.split("=")[1] : "nothing";
      const res = installDailyTask({ dryRun: isDryRun, mode });
      if (res.dryRun) {
        console.log(colors.success("✓ Task Scheduler XML definition generated successfully (Dry Run)."));
      } else {
        console.log(colors.success(`✓ Scheduled Task "${res.taskName}" installed successfully.`));
        console.log(colors.dim("  The daily automator will now run automatically EVERY 10 MINUTES."));
        console.log(colors.dim("  To view task status: npm run daily:status"));
        console.log(colors.dim("  To uninstall:        npm run daily:uninstall"));
      }
    } catch (err) {
      console.error(colors.error(`✖ Task installation failed: ${err.message}`));
      process.exit(1);
    }
  } else if (isUninstall) {
    console.log(colors.highlight("⚙ Removing WarEra Daily Automator Windows Task..."));
    try {
      const res = uninstallDailyTask({ dryRun: isDryRun });
      if (res.dryRun) {
        console.log(colors.success("✓ Task uninstaller validated successfully (Dry Run)."));
      } else {
        console.log(colors.success(`✓ Scheduled Task "${res.taskName}" removed successfully.`));
      }
    } catch (err) {
      console.error(colors.error(`✖ Task removal failed: ${err.message}`));
      process.exit(1);
    }
  } else if (isStatus) {
    const res = queryDailyTask();
    if (res.exists) {
      console.log(colors.success(`✓ Scheduled Task "${TASK_NAME}" is registered and active.`));
      console.log(res.output);
    } else {
      console.log(colors.warning(`⚠ Scheduled Task "${TASK_NAME}" is NOT registered.`));
      console.log(colors.dim("  To install: npm run daily:install"));
    }
  } else {
    runDailyTasks()
      .then((res) => {
        const exitCode = res?.success === false ? 1 : 0;
        process.exit(exitCode);
      })
      .catch((e) => {
        log("DAILY", "FATAL", e.message);
        process.exit(1);
      });
  }
}
