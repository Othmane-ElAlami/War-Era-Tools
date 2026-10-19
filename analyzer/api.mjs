import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
export function getCookiePath() {
  return process.env.WARERA_COOKIE_FILE ? path.resolve(process.env.WARERA_COOKIE_FILE) : path.join(ROOT_DIR, "cookies.json");
}

const API2_BASE = "https://api2.warera.io/trpc";
const API4_BASE = "https://api4.warera.io/trpc";

const DEFAULT_HEADERS = {
  "content-type": "application/json",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36 Edg/152.0.0.0",
};

/**
 * Helper sleep
 */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Load cookie header string from cookies.json if present
 */
export function getCookieHeader(customPath = null) {
  const cookiePath = customPath || getCookiePath();
  if (fs.existsSync(cookiePath)) {
    try {
      const raw = fs.readFileSync(cookiePath, "utf8");
      const cookies = JSON.parse(raw);
      if (Array.isArray(cookies) && cookies.length > 0) {
        return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
      }
    } catch {
      // Ignore read errors
    }
  }
  return null;
}

/**
 * Robust fetch with retry and finite request timeout
 */
export async function fetchWithRetry(url, options = {}, retries = 3, backoffMs = 500) {
  const timeoutMs = options.timeoutMs || 25000; // 25 seconds default timeout
  const maxAttempts = Math.max(1, typeof retries === "number" ? retries : 3);
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const fetchOptions = { ...options };
    if (!fetchOptions.signal) {
      fetchOptions.signal = AbortSignal.timeout(timeoutMs);
    }
    try {
      const res = await fetch(url, fetchOptions);
      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxAttempts) {
          await sleep(backoffMs * attempt);
          continue;
        }
        throw new Error(`HTTP ${res.status}: Server returned error status`);
      }
      return res;
    } catch (err) {
      const isTimeout =
        err.name === "TimeoutError" ||
        err.name === "AbortError" ||
        /timed out|timeout|aborted/i.test(err.message || "");
      const externallyAborted = options.signal && options.signal.aborted;
      if (attempt < maxAttempts && !externallyAborted) {
        await sleep(backoffMs * attempt);
        continue;
      }
      if (isTimeout) {
        const endpoint = url ? ` (${url.split("?")[0].split("/").pop()})` : "";
        const timeoutErr = new Error(`Request timed out after ${timeoutMs}ms${endpoint}`);
        timeoutErr.name = "TimeoutError";
        throw timeoutErr;
      }
      throw err;
    }
  }
}

/**
 * Fetch rankings (e.g. weeklyUserDamages)
 * Returns array of ranking items: [{ rank, user, value, tier, country, mu, _id }, ...]
 */
export async function fetchRankings(rankingType = "weeklyUserDamages") {
  const url = `${API4_BASE}/ranking.getRanking?batch=1`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({ "0": { rankingType } }),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch rankings (${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  const data = json[0]?.result?.data;
  if (!data || !Array.isArray(data.items)) {
    throw new Error("Invalid ranking response format");
  }

  return {
    type: data.type,
    items: data.items,
    tierValues: data.tierValues,
  };
}

/**
 * Fetch live game configuration (skills, items, battles, etc.)
 */
export async function fetchGameConfig() {
  const url = `${API2_BASE}/gameConfig.getGameConfig?batch=1`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({ "0": {} }),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch gameConfig (${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  const config = json[0]?.result?.data;
  if (!config) {
    throw new Error("Invalid gameConfig response format");
  }

  return config;
}

/**
 * Fetch user profiles and equipped items in batches
 * userIds: string[] (up to 10 at a time)
 * Returns array of { userId, user, equipment }
 */
export async function fetchUsersBatch(userIds) {
  if (!userIds || userIds.length === 0) return [];

  const procs = [];
  const body = {};

  userIds.forEach((uid, idx) => {
    procs.push("user.getUserById", "inventory.fetchCurrentEquipment");
    body[String(idx * 2)] = { userId: uid };
    body[String(idx * 2 + 1)] = { userId: uid };
  });

  const url = `${API2_BASE}/${procs.join(",")}?batch=1`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: DEFAULT_HEADERS,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch user batch (${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  const results = [];

  userIds.forEach((uid, idx) => {
    const uData = json[idx * 2]?.result?.data || null;
    const eqData = json[idx * 2 + 1]?.result?.data || null;
    results.push({
      userId: uid,
      user: uData,
      equipment: eqData,
    });
  });

  return results;
}

/**
 * Fetch the currently authenticated user and their equipped gear
 */
export async function fetchMe() {
  const cookieHeader = getCookieHeader();
  if (!cookieHeader) {
    throw new Error("No cookies found in cookies.json. Please log in first.");
  }

  const url = `${API4_BASE}/user.getMe?batch=1`;
  const res = await fetchWithRetry(url, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      cookie: cookieHeader,
    },
    body: JSON.stringify({ "0": {} }),
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch current user (${res.status}): ${await res.text()}`);
  }

  const json = await res.json();
  const me = json[0]?.result?.data;

  if (!me || !me._id) {
    throw new Error("Failed to resolve current user profile from session.");
  }

  // Fetch equipped items for this user
  let equipment = {};
  try {
    const eqUrl = `${API2_BASE}/inventory.fetchCurrentEquipment?batch=1`;
    const eqRes = await fetchWithRetry(eqUrl, {
      method: "POST",
      headers: {
        ...DEFAULT_HEADERS,
        cookie: cookieHeader,
      },
      body: JSON.stringify({ "0": { userId: me._id } }),
    });
    if (eqRes.ok) {
      const eqJson = await eqRes.json();
      equipment = eqJson[0]?.result?.data || {};
    }
  } catch {
    // Fallback to empty equipment
  }

  return {
    user: me,
    equipment,
  };
}

/**
 * Fetch all active battle IDs from live tRPC endpoint
 */
export async function fetchActiveBattleIds() {
  const cookieHeader = getCookieHeader();
  const url = `${API2_BASE}/battle.getSortedActiveBattles?input=%7B%7D`;
  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      ...DEFAULT_HEADERS,
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch active battles (HTTP ${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  return json.result?.data || [];
}

/**
 * Fetch detailed battle data by ID from live tRPC endpoint
 */
export async function fetchBattleById(battleId) {
  const cookieHeader = getCookieHeader();
  const input = encodeURIComponent(JSON.stringify({ battleId }));
  const url = `${API2_BASE}/battle.getById?input=${input}`;
  const res = await fetchWithRetry(url, {
    method: "GET",
    headers: {
      ...DEFAULT_HEADERS,
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch battle ${battleId} (HTTP ${res.status}): ${await res.text()}`);
  }
  const json = await res.json();
  return json.result?.data || null;
}

/**
 * Fetch detailed player-relative damage bonuses for a battle by ID from live tRPC endpoint
 * Returns { attacker: { totalPercent, patrioticBonusPercent, ... }, defender: { ... } }
 */
export async function fetchDamageBonuses(battleId) {
  const cookieHeader = getCookieHeader();
  const input = encodeURIComponent(JSON.stringify({ battleId }));
  const url = `${API2_BASE}/battle.getDamageBonuses?input=${input}`;
  try {
    const res = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        ...DEFAULT_HEADERS,
        ...(cookieHeader ? { cookie: cookieHeader } : {}),
      },
    }, 2, 300);
    if (!res.ok) {
      return null;
    }
    const json = await res.json();
    return json.result?.data || null;
  } catch {
    return null;
  }
}
