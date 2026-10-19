/**
 * WarEra Daily Tasks - Combat Debuff Detection
 * 
 * Inspects live WarEra API (`user.getMe`) and React DOM state
 * to determine if a combat debuff is active and its remaining duration.
 */

import { sleep } from "./daily_automator.mjs";

/**
 * Format milliseconds into human-readable duration (e.g. "8h 4m", "45m 12s")
 */
export function formatDuration(ms) {
  if (ms <= 0) return "0m 0s";
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

/**
 * Detect whether a combat debuff is currently active on the player.
 * Checks both the live tRPC API (`user.getMe`) and React DOM fiber state.
 * 
 * Returns:
 * {
 *   debuffActive: boolean,
 *   remainingDebuffDurationMs: number,
 *   remainingDurationFormatted: string,
 *   debuffCodes: string[],
 *   debuffEndAt: string | null,
 *   attackDebuffPercent: number
 * }
 */
export async function detectCombatDebuff(page) {
  try {
    const data = await page.evaluate(async () => {
      let debuffCodes = [];
      let debuffEndAt = null;
      let attackDebuffPercent = 0;

      // 1. Try API call to user.getMe
      try {
        const res = await fetch("https://api4.warera.io/trpc/user.getMe", { credentials: "include" });
        if (res.ok) {
          const json = await res.json();
          const user = Array.isArray(json) ? json[0]?.result?.data : json?.result?.data;
          if (user?.buffs) {
            debuffCodes = user.buffs.debuffCodes || [];
            debuffEndAt = user.buffs.debuffEndAt || null;
          }
          if (user?.skills?.attack?.debuffsPercent) {
            attackDebuffPercent = user.skills.attack.debuffsPercent;
          }
        }
      } catch {}

      // 2. Corroborate with React DOM fiber state
      let domText = null;
      try {
        function getFiber(el) {
          const key = Object.keys(el || {}).find(k => k.startsWith("__reactFiber"));
          return key ? el[key] : null;
        }

        const elements = Array.from(document.querySelectorAll("*"));
        for (const el of elements) {
          const fiber = getFiber(el);
          if (!fiber) continue;
          let cur = fiber;
          while (cur) {
            const title = cur.memoizedProps?.title || cur.memoizedProps?.tooltipProps?.title;
            const titleStr = typeof title === "string" ? title : JSON.stringify(title || "");
            if (titleStr.includes("Remaining debuff duration")) {
              domText = el.innerText?.trim();
              break;
            }
            cur = cur.return;
          }
          if (domText) break;
        }
      } catch {}

      return {
        debuffCodes,
        debuffEndAt,
        attackDebuffPercent,
        domText,
      };
    });

    const debuffEndAtMs = data.debuffEndAt ? new Date(data.debuffEndAt).getTime() : 0;
    const now = Date.now();
    const remainingDebuffDurationMs = Math.max(0, debuffEndAtMs - now);

    const debuffActive = Boolean(
      (data.debuffCodes.length > 0 || debuffEndAtMs > 0 || data.domText) &&
      remainingDebuffDurationMs > 0
    );

    return {
      debuffActive,
      remainingDebuffDurationMs,
      remainingDurationFormatted: formatDuration(remainingDebuffDurationMs),
      debuffCodes: data.debuffCodes,
      debuffEndAt: data.debuffEndAt,
      attackDebuffPercent: data.attackDebuffPercent,
      domText: data.domText,
    };
  } catch (err) {
    return {
      debuffActive: false,
      remainingDebuffDurationMs: 0,
      remainingDurationFormatted: "0m 0s",
      debuffCodes: [],
      debuffEndAt: null,
      attackDebuffPercent: 0,
      error: err.message,
    };
  }
}
