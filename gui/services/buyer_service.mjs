/**
 * WarEra Tools - Equipment Buyer Service
 * 
 * Implements:
 * 1. Graphical market analysis with exhaustive pagination
 * 2. Fail-closed protection for incomplete markets (nextCursor !== null)
 * 3. 3-Strategy loadout generation (Best Value, Best Performance, Cheapest)
 * 4. Pipeline diagnostics (Fetched, Valid, Pareto, Stat distributions, Raw market max)
 * 5. Safe sequential purchase execution with per-item revalidation & wallet checks
 */

import { EventEmitter } from "events";
import { USER_ID, resolveUserId } from "../../config.mjs";
import { fetchGameConfig, fetchWithRetry, getCookieHeader } from "../../analyzer/api.mjs";
import { fetchMarketTaxRate } from "../../analyzer/market_pricing.mjs";
import {
  SUPPORTED_CATEGORIES,
  SLOT_LABELS,
  formatStatShort,
  resolveRarity,
  resolveCategories,
  extractRarityCatalog,
  fetchAllMarketOffers,
  sanitizeMarketOffers,
  eliminateDominatedOffers,
  evaluateGearOffer,
  evaluateWeaponOffer,
  findCategoryRecommendations,
  selectRecommendationByStrategy,
  findOverallBestValue,
  optimizeLoadoutUnderBudget,
  buildFullLoadout,
  verifyFuturePurchaseSafety,
  formatAlternativeSummary,
  PurchaseVerificationState,
  submitMarketPurchase,
  refreshAndValidateOffer,
  verifyMarketPurchase,
  fetchUserInventory,
} from "../../analyzer/buyer_evaluator.mjs";
import {
  fetchLiveWalletGold,
  pollReconciledWalletGold,
} from "../../equipment_buyer.mjs";

class BuyerService extends EventEmitter {
  constructor() {
    super();
    this.isAnalyzing = false;
    this.isPurchasing = false;
    this.abortController = null;
    this.lastAnalysis = null;
  }

  /**
   * Cancel ongoing read-only market analysis
   */
  cancelAnalysis() {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
      this.isAnalyzing = false;
      this.emit("progress", { stage: "cancelled", message: "Market analysis cancelled by user." });
    }
  }

  /**
   * Run full exhaustive market analysis across specified categories and rarity.
   * STRICT SAFETY: 100% read-only.
   */
  async analyzeMarket(options = {}) {
    if (this.isAnalyzing) {
      throw new Error("Market analysis is already in progress.");
    }

    this.isAnalyzing = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    const {
      rarity = "green",
      categories = ["helmet", "chest", "gloves", "pants", "boots"],
      strategy = "best-value",
      budget = null,
      compareEquipped = false,
      maxPages = 300, // Exhaustive cap
    } = options;

    try {
      this.emit("progress", { stage: "init", message: "Fetching live game configuration..." });
      const gameConfig = await fetchGameConfig();

      const rarityConfig = resolveRarity(rarity, gameConfig);
      const activeCategories = resolveCategories(categories.join(","), null, gameConfig);
      const catalog = extractRarityCatalog(gameConfig, rarityConfig.canonical);
      const taxRate = await fetchMarketTaxRate();

      // Check current user inventory / wallet
      let liveEquipped = null;
      let walletGold = 0;
      const effectiveUserId = resolveUserId();
      try {
        walletGold = await fetchLiveWalletGold(effectiveUserId);
        if (compareEquipped) {
          const inv = await fetchUserInventory(effectiveUserId);
          liveEquipped = inv.equipped || null;
        }
      } catch {}

      const categoryResults = {};
      const diagnostics = {};
      let marketIncomplete = false;
      let incompleteReason = "";

      for (const slot of activeCategories) {
        if (signal.aborted) throw new Error("Analysis aborted by user.");

        const isWeapon = slot === "weapon";
        const rangeInfo = !isWeapon ? catalog.gear[slot] : null;
        const targetWeapons = isWeapon ? catalog.weapons : null;

        if (!isWeapon && !rangeInfo) continue;
        if (isWeapon && (!targetWeapons || targetWeapons.length === 0)) continue;

        const slotLabel = SLOT_LABELS[slot] || slot;

        this.emit("progress", {
          stage: "fetching",
          slot,
          slotLabel,
          message: `Fetching ${rarityConfig.displayName} ${slotLabel} market...`,
        });

        // Track pagination progress
        let lastReportedCount = 0;
        const onProgress = (info) => {
          if (info.count !== lastReportedCount) {
            lastReportedCount = info.count;
            this.emit("progress", {
              stage: "pagination",
              slot,
              page: info.page,
              count: info.count,
              message: `Scanning ${slotLabel}: Page ${info.page} (${info.count} offers fetched)`,
            });
          }
        };

        let rawOffers = [];
        let hitSafetyCap = false;

        try {
          if (isWeapon) {
            const allWeaponEvaluated = [];
            let allWeaponRawCount = 0;
            let allWeaponValidCount = 0;
            const statDistribution = {};

            for (const wMeta of targetWeapons) {
              const raw = await fetchAllMarketOffers(wMeta.code, {
                excludeUserId: effectiveUserId,
                onProgress,
                maxPages,
                signal,
              });
              allWeaponRawCount += raw.length;
              if (raw.length >= maxPages * 12) hitSafetyCap = true;

              const valid = sanitizeMarketOffers(raw, {
                excludeUserId: effectiveUserId,
                requiredStats: ["attack", "criticalChance"],
                taxRate,
              });
              allWeaponValidCount += valid.length;

              for (const off of valid) {
                const evalOffer = evaluateWeaponOffer(
                  off,
                  wMeta,
                  liveEquipped?.weapon || null,
                  null,
                  gameConfig,
                  {
                    allOffersForCode: raw,
                    excludeUserId: effectiveUserId,
                    compareEquipped,
                  }
                );
                allWeaponEvaluated.push(evalOffer);
                if (typeof evalOffer.attack === "number") {
                  statDistribution[evalOffer.attack] = (statDistribution[evalOffer.attack] || 0) + 1;
                }
              }
            }

            const validWeps = allWeaponEvaluated.filter(
              (o) => !o.isInvalidRange && o.disposition !== "INVALID LIVE RANGE"
            );
            const highestMarketCrit = validWeps.length > 0
              ? Math.max(...validWeps.map((o) => o.criticalChance || 0))
              : null;
            const rawMarketMaxStat = validWeps.length > 0
              ? Math.max(...validWeps.map((o) => o.attack || 0))
              : null;

            categoryResults["weapon"] = {
              category: "weapon",
              equipped: liveEquipped?.weapon || null,
              evaluatedOffers: allWeaponEvaluated,
              highestMarketCrit,
              weaponMeta: targetWeapons[0],
            };

            diagnostics["weapon"] = {
              slot: "weapon",
              slotLabel: "Weapon",
              primaryStat: "attack / crit",
              theoreticalRange: {
                min: targetWeapons[0]?.dynamicStats?.attack?.[0] || 0,
                max: targetWeapons[0]?.dynamicStats?.attack?.[1] || 0,
              },
              theoreticalMax: targetWeapons[0]?.dynamicStats?.attack?.[1] || 0,
              rawMarketMax: rawMarketMaxStat,
              fetchedCount: allWeaponRawCount,
              validCount: allWeaponValidCount,
              paretoCount: validWeps.length,
              statDistribution,
            };
          } else {
            rawOffers = await fetchAllMarketOffers(rangeInfo.itemCode, {
              excludeUserId: effectiveUserId,
              onProgress,
              maxPages,
              signal,
            });

            if (rawOffers.length >= maxPages * 12) {
              hitSafetyCap = true;
            }

            const validOffers = sanitizeMarketOffers(rawOffers, {
              excludeUserId: effectiveUserId,
              requiredStats: [rangeInfo.statName],
              taxRate,
            });

            const evaluatedOffers = validOffers.map((off) =>
              evaluateGearOffer(off, rangeInfo, liveEquipped?.[slot] || null, {
                allOffersForCode: rawOffers,
                excludeUserId: effectiveUserId,
                compareEquipped,
              })
            );

            const inRangeOffers = evaluatedOffers.filter((o) => !o.isInvalidRange);
            const statValues = inRangeOffers.map((o) => o.statValue);
            const statDistribution = {};
            for (const v of statValues) {
              statDistribution[v] = (statDistribution[v] || 0) + 1;
            }
            const rawMarketMaxStat = statValues.length > 0 ? Math.max(...statValues) : null;

            const { nonDominated = [] } = eliminateDominatedOffers(
              inRangeOffers,
              (o) => o.statValue,
              (o) => o.buyerPrice
            ) || {};

            categoryResults[slot] = {
              category: slot,
              equipped: liveEquipped?.[slot] || null,
              rangeInfo,
              evaluatedOffers,
              statDistribution,
              rawMarketMaxStat,
            };

            diagnostics[slot] = {
              slot,
              slotLabel,
              primaryStat: rangeInfo.statName,
              theoreticalRange: {
                min: rangeInfo.minPossibleStat,
                max: rangeInfo.maxPossibleStat,
              },
              theoreticalMax: rangeInfo.maxPossibleStat ?? 0,
              rawMarketMax: rawMarketMaxStat,
              fetchedCount: rawOffers.length,
              validCount: validOffers.length,
              paretoCount: nonDominated.length,
              statDistribution,
            };
          }
        } catch (err) {
          if (err.name === "AbortError" || signal.aborted) throw err;
          console.warn(`Failed fetching offers for ${slot}:`, err.message);
        }

        if (hitSafetyCap) {
          marketIncomplete = true;
          incompleteReason = `Market coverage incomplete for ${slotLabel} (Safety limit reached before market exhaustion).`;
        }
      }

      // If market is incomplete, FAIL CLOSED per Requirement 20
      if (marketIncomplete) {
        this.lastAnalysis = {
          marketIncomplete: true,
          error: "MARKET COVERAGE INCOMPLETE",
          details: incompleteReason,
          diagnostics,
        };
        return this.lastAnalysis;
      }

      // Build independent loadouts using mature buildFullLoadout engine
      const numBudget = budget && Number(budget) > 0 ? Number(budget) : null;
      const loadoutBaseOptions = {
        budget: numBudget,
        activeCategories,
        rarity: rarityConfig.canonical,
        rarityDisplayName: rarityConfig.displayName,
        compareEquipped,
      };

      const bestValueLoadout = buildFullLoadout(categoryResults, { ...loadoutBaseOptions, strategy: "best-value" });
      const bestPerfLoadout = buildFullLoadout(categoryResults, { ...loadoutBaseOptions, strategy: "best-performance" });
      const cheapestLoadout = buildFullLoadout(categoryResults, { ...loadoutBaseOptions, strategy: "cheapest" });

      // Format table rows for UI
      const formatLoadoutForUi = (loadout, stratKey, stratLabel) => {
        const items = (loadout.items || []).map((item) => {
          const diag = diagnostics[item.slot] || {};
          const offer = item.offer || {};
          return {
            slot: item.slot,
            slotLabel: item.slotLabel || SLOT_LABELS[item.slot] || item.slot,
            offerId: offer.offerId || offer._id || item.offerId,
            itemTitle: item.itemTitle || `${rarityConfig.displayName} ${item.slotLabel || item.slot}`,
            statSummary: item.statDisplay || item.statSummary || formatStatShort(offer.skills),
            liveRange: item.rangeDisplay || (diag.rawMarketMax ? `+${diag.theoreticalRange?.min || 0}…+${diag.rawMarketMax}` : "-"),
            rollDisplay: item.rollDisplay || "0%",
            buyerPrice: Number((item.cost || item.buyerPrice || 0).toFixed(3)),
            marketValue: Number((item.fairBuyerPrice || item.fairMarketValue || item.cost || item.buyerPrice || 0).toFixed(3)),
            discount: Number((item.discount || 0).toFixed(3)),
            marketMax: diag.rawMarketMax ?? item.maxPossibleStat ?? "-",
            selectedStat: item.statValue || offer.skills?.[diag.primaryStat] || 0,
            offer,
          };
        });

        return {
          strategy: stratKey,
          strategyDisplayName: stratLabel,
          items,
          totalCost: Number((loadout.totalCost || 0).toFixed(3)),
          averageRoll: Math.round(loadout.avgQualityPercent || 0),
          normalizedQuality: Number(((loadout.avgQualityPercent || 0) / 20).toFixed(2)), // 0-5.0 scale
          marketValue: Number((loadout.totalMarketValue || loadout.totalCost || 0).toFixed(3)),
          totalDiscount: Number((loadout.totalDiscount || 0).toFixed(3)),
          itemCount: items.length,
          fitsBudget: numBudget ? (loadout.totalCost || 0) <= numBudget : true,
          feasible: Boolean(loadout.feasible),
        };
      };

      const result = {
        marketIncomplete: false,
        timestamp: new Date().toISOString(),
        rarity: rarityConfig.canonical,
        rarityDisplayName: rarityConfig.displayName,
        walletGold,
        budget: numBudget,
        selectedStrategy: strategy,
        diagnostics,
        loadouts: {
          "best-value": formatLoadoutForUi(bestValueLoadout, "best-value", "BEST VALUE"),
          "best-performance": formatLoadoutForUi(bestPerfLoadout, "best-performance", "BEST PERFORMANCE"),
          "cheapest": formatLoadoutForUi(cheapestLoadout, "cheapest", "CHEAPEST"),
        },
      };

      this.lastAnalysis = result;
      return result;
    } finally {
      this.isAnalyzing = false;
      this.abortController = null;
    }
  }

  /**
   * Execute live sequential purchases with strict safety guards.
   * STRICT SAFETY: Requires explicit confirmed=true flag and confirmedLoadout.
   */
  async executePurchases(options = {}) {
    if (this.isPurchasing) {
      throw new Error("Purchase execution is already in progress.");
    }

    const {
      confirmedLoadout,
      dryRun = true,
      confirmed = false,
      maxSlippage = 0,
    } = options;

    if (!confirmedLoadout || !Array.isArray(confirmedLoadout.items) || confirmedLoadout.items.length === 0) {
      throw new Error("No items selected in confirmed loadout.");
    }

    if (!dryRun && !confirmed) {
      throw new Error("Live purchase execution requires explicit confirmation.");
    }

    this.isPurchasing = true;
    this.emit("purchase-status", { state: "starting", dryRun, itemsCount: confirmedLoadout.items.length });

    const results = {
      dryRun,
      strategy: confirmedLoadout.strategy,
      totalPlanned: confirmedLoadout.totalCost,
      actualSpent: 0,
      purchased: [],
      failed: [],
      haltedEarly: false,
      haltReason: null,
    };

    try {
      if (dryRun) {
        // DRY RUN: Simulates sequential purchases without mutations
        for (let i = 0; i < confirmedLoadout.items.length; i++) {
          const item = confirmedLoadout.items[i];
          const record = {
            slot: item.slot,
            offerId: item.offerId,
            itemTitle: item.itemTitle,
            cost: item.buyerPrice,
            verificationState: PurchaseVerificationState.VERIFIED_PURCHASED,
            isDryRun: true,
          };
          results.purchased.push(record);
          results.actualSpent += item.buyerPrice;
          this.emit("item-purchased", record);
        }
        return results;
      }

      // LIVE EXECUTION: Sequentially verify and purchase each item
      const execUserId = resolveUserId();
      const initialWallet = await fetchLiveWalletGold(execUserId);
      let remainingWallet = initialWallet;

      for (let i = 0; i < confirmedLoadout.items.length; i++) {
        const item = confirmedLoadout.items[i];

        // 1. Wallet check
        if (remainingWallet < item.buyerPrice) {
          results.haltedEarly = true;
          results.haltReason = `Insufficient Gold (Available: ${remainingWallet.toFixed(3)} G, Required: ${item.buyerPrice.toFixed(3)} G)`;
          break;
        }

        // 2. Preflight revalidation
        this.emit("purchase-progress", { slot: item.slot, offerId: item.offerId, status: "revalidating" });
        let revalidatedOffer = null;
        try {
          revalidatedOffer = await refreshAndValidateOffer(
            { offerId: item.offerId, itemCode: item.itemCode, buyerPrice: item.buyerPrice },
            { myUserId: execUserId, plannedBuyerPrice: item.buyerPrice, maxSlippagePct: maxSlippage }
          );
        } catch (err) {
          results.failed.push({ slot: item.slot, offerId: item.offerId, error: err.message });
          results.haltedEarly = true;
          results.haltReason = `Preflight revalidation failed: ${err.message}`;
          break;
        }

        // 3. Submit mutation
        this.emit("purchase-progress", { slot: item.slot, offerId: item.offerId, status: "submitting" });
        let buyRes = null;
        try {
          buyRes = await submitMarketPurchase(item.offerId);
        } catch (err) {
          results.failed.push({ slot: item.slot, offerId: item.offerId, error: err.message });
          results.haltedEarly = true;
          results.haltReason = `Purchase mutation failed: ${err.message}`;
          break;
        }

        // 4. Verify post-purchase state
        this.emit("purchase-progress", { slot: item.slot, offerId: item.offerId, status: "verifying" });
        const vState = await verifyMarketPurchase(item.offerId, { myUserId: execUserId });

        if (vState.state === PurchaseVerificationState.VERIFIED_PURCHASED) {
          remainingWallet -= item.buyerPrice;
          results.actualSpent += item.buyerPrice;
          const record = {
            slot: item.slot,
            offerId: item.offerId,
            itemTitle: item.itemTitle,
            cost: item.buyerPrice,
            verificationState: vState.state,
          };
          results.purchased.push(record);
          this.emit("item-purchased", record);
        } else {
          results.failed.push({ slot: item.slot, offerId: item.offerId, verificationState: vState.state });
          results.haltedEarly = true;
          results.haltReason = `Post-purchase verification was ${vState.state}. Halting immediately to avoid ambiguous state.`;
          break;
        }
      }

      return results;
    } finally {
      this.isPurchasing = false;
      this.emit("purchase-status", { state: "idle" });
    }
  }
}

export const buyerService = new BuyerService();
