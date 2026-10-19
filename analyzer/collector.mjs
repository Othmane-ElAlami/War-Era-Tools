/**
 * Collector and local cache manager for rankings, player profiles, and game configuration
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { fetchRankings, fetchGameConfig, fetchUsersBatch, sleep } from "./api.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT_DIR, "data");
const PLAYERS_DIR = path.join(DATA_DIR, "players");
const ANALYSIS_DIR = path.join(DATA_DIR, "analysis");
const RANKINGS_FILE = path.join(DATA_DIR, "rankings.json");
const CONFIG_FILE = path.join(DATA_DIR, "game_config.json");

// Default cache TTLs
const RANKINGS_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const PLAYERS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CONFIG_TTL_MS = 48 * 60 * 60 * 1000;  // 48 hours

/**
 * Ensure storage directories exist
 */
export function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PLAYERS_DIR)) fs.mkdirSync(PLAYERS_DIR, { recursive: true });
  if (!fs.existsSync(ANALYSIS_DIR)) fs.mkdirSync(ANALYSIS_DIR, { recursive: true });
}

/**
 * Load or fetch live game configuration
 */
export async function getGameConfig(forceRefresh = false) {
  ensureDirs();

  if (!forceRefresh && fs.existsSync(CONFIG_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
      const age = Date.now() - new Date(cached.updatedAt).getTime();
      if (age < CONFIG_TTL_MS && cached.config) {
        return cached.config;
      }
    } catch {
      // Fall through to fetch
    }
  }

  const config = await fetchGameConfig();
  fs.writeFileSync(
    CONFIG_FILE,
    JSON.stringify({ updatedAt: new Date().toISOString(), config }, null, 2)
  );
  return config;
}

/**
 * Load or fetch weekly rankings
 */
export async function getRankings(forceRefresh = false, rankingType = "weeklyUserDamages") {
  ensureDirs();

  if (!forceRefresh && fs.existsSync(RANKINGS_FILE)) {
    try {
      const cached = JSON.parse(fs.readFileSync(RANKINGS_FILE, "utf8"));
      const age = Date.now() - new Date(cached.updatedAt).getTime();
      if (age < RANKINGS_TTL_MS && Array.isArray(cached.items)) {
        return cached.items;
      }
    } catch {
      // Fall through to fetch
    }
  }

  const res = await fetchRankings(rankingType);
  fs.writeFileSync(
    RANKINGS_FILE,
    JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        type: res.type,
        totalItems: res.items.length,
        items: res.items,
      },
      null,
      2
    )
  );
  return res.items;
}

/**
 * Load a single player from local cache
 */
export function getCachedPlayer(playerId) {
  const filePath = path.join(PLAYERS_DIR, `${playerId}.json`);
  if (fs.existsSync(filePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return cached;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Save a player to local cache
 */
export function saveCachedPlayer(player) {
  ensureDirs();
  const filePath = path.join(PLAYERS_DIR, `${player.playerId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(player, null, 2));
}

/**
 * Load all players currently saved in local cache
 */
export function getAllCachedPlayers() {
  ensureDirs();
  const files = fs.readdirSync(PLAYERS_DIR).filter((f) => f.endsWith(".json"));
  const players = [];
  for (const file of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(PLAYERS_DIR, file), "utf8"));
      if (p && p.playerId && p.level) {
        players.push(p);
      }
    } catch {
      // Ignore corrupt entries
    }
  }
  return players;
}

/**
 * Unify API user and equipment responses into clean standardized schema
 */
export function buildUnifiedPlayerRecord(rankingItem, uData, eqData) {
  return {
    playerId: rankingItem.user || uData._id,
    name: uData.username || "Unknown",
    level: uData.leveling?.level || 1,
    weeklyDamage: rankingItem.value || 0,
    rank: rankingItem.rank || null,
    tier: rankingItem.tier || null,
    country: rankingItem.country || uData.country || null,
    mu: rankingItem.mu || uData.mu || null,
    updatedAt: new Date().toISOString(),

    leveling: {
      level: uData.leveling?.level || 1,
      totalSkillPoints: uData.leveling?.totalSkillPoints || 0,
      spentSkillPoints: uData.leveling?.spentSkillPoints || 0,
      availableSkillPoints: uData.leveling?.availableSkillPoints || 0,
      totalXp: uData.leveling?.totalXp || 0,
      prestigeLevel: uData.leveling?.prestigeLevel || 0,
    },

    skills: Object.fromEntries(
      Object.entries(uData.skills || {}).map(([skillName, s]) => [
        skillName,
        {
          level: s.level ?? 0,
          baseValue: s.value ?? 0,
          weaponBonus: s.weapon ?? null,
          equipmentBonus: s.equipment ?? null,
          total: s.total ?? 0,
          totalAfterSoftCap: s.totalAfterSoftCap ?? null,
          ammoPercent: s.ammoPercent ?? 0,
          militaryRankPercent: s.militaryRankPercent ?? 0,
          buffsPercent: s.buffsPercent ?? 0,
          debuffsPercent: s.debuffsPercent ?? 0,
        },
      ])
    ),

    equipment: {
      weapon: eqData?.weapon || null,
      ammo: eqData?.ammo || null,
      helmet: eqData?.helmet || null,
      chest: eqData?.chest || null,
      boots: eqData?.boots || null,
      gloves: eqData?.gloves || null,
      pants: eqData?.pants || null,
    },

    stats: {
      careerDamages: uData.stats?.damagesCount || 0,
      careerWorks: uData.stats?.worksCount || 0,
      militaryRank: uData.militaryRank || 0,
      estimatedWealth: uData.stats?.estimatedWealth || 0,
      gemsPurchased: uData.stats?.gemsPurchased || 0,
    },
  };
}

/**
 * Collect high-ranking player profiles (respects rate limits, uses local cache)
 */
export async function collectTopPlayers(count = 200, forceRefresh = false, onProgress = null) {
  ensureDirs();
  const rankings = await getRankings(forceRefresh);
  const targetRankings = rankings.slice(0, count);

  const players = [];
  const missing = [];

  for (const item of targetRankings) {
    const cached = getCachedPlayer(item.user);
    if (!forceRefresh && cached) {
      const age = Date.now() - new Date(cached.updatedAt).getTime();
      if (age < PLAYERS_TTL_MS) {
        // Update ranking damage in case it changed this week
        cached.weeklyDamage = item.value;
        cached.rank = item.rank;
        players.push(cached);
        continue;
      }
    }
    missing.push(item);
  }

  if (missing.length > 0) {
    const batchSize = 10;
    for (let i = 0; i < missing.length; i += batchSize) {
      const chunk = missing.slice(i, i + batchSize);
      const uids = chunk.map((c) => c.user);

      try {
        const batchResults = await fetchUsersBatch(uids);
        chunk.forEach((item, idx) => {
          const res = batchResults[idx];
          if (res?.user && res.user.leveling) {
            const record = buildUnifiedPlayerRecord(item, res.user, res.equipment);
            saveCachedPlayer(record);
            players.push(record);
          }
        });
      } catch (err) {
        console.warn(`Warning: failed to fetch batch ${i / batchSize + 1}:`, err.message);
      }

      if (onProgress) {
        onProgress(players.length, targetRankings.length);
      }

      await sleep(150); // Respect rate limits
    }
  }

  // Sort collected players by rank
  players.sort((a, b) => (a.rank || 99999) - (b.rank || 99999));
  return players;
}
