/**
 * WarEra Tools - Equipment Reseller Service
 * 
 * Implements:
 * 1. Read-only inventory evaluation and market comparable analysis
 * 2. Stat-aware armor pricing & weapon Crit-first pricing
 * 3. Perfect roll & Max Crit KEEP safeguards
 * 4. Staged listing execution with preflight revalidation and explicit confirmation
 */

import { EventEmitter } from "events";
import { USER_ID, resolveUserId } from "../../config.mjs";
import { fetchGameConfig } from "../../analyzer/api.mjs";
import {
  extractEquipmentRanges,
  classifyInventoryItems,
} from "../../analyzer/equipment_rolls.mjs";
import {
  fetchMarketTaxRate,
  performInventoryAudit,
} from "../../analyzer/market_pricing.mjs";
import {
  fetchUserInventoryState,
  createActiveOffersTracker,
  prepareExecutionCandidates,
  getFullItemTitle,
  submitMarketListing,
  verifyListingWithBackoff,
  ListingVerificationState,
} from "../../equipment_reseller.mjs";

class ResellerService extends EventEmitter {
  constructor() {
    super();
    this.isAuditing = false;
    this.isListing = false;
    this.lastAudit = null;
  }

  /**
   * Run read-only inventory scan and pricing analysis across armor and weapons.
   * STRICT SAFETY: 100% read-only.
   */
  async auditInventory(options = {}) {
    if (this.isAuditing) {
      throw new Error("Inventory audit is already in progress.");
    }

    this.isAuditing = true;
    this.emit("audit-status", { state: "starting" });

    const {
      pricingStrategy = "competitive",
      maxUndercutPct = 0.05,
      maxListings = 1,
      slotFilter = null,
      qualityFilter = null,
    } = options;

    try {
      this.emit("audit-status", { state: "fetching", message: "Fetching gameConfig and live inventory..." });
      const gameConfig = await fetchGameConfig();
      const statRanges = extractEquipmentRanges(gameConfig);
      const taxRate = await fetchMarketTaxRate();

      this.emit("audit-status", { state: "inventory", message: "Fetching user inventory and active listings..." });
      const { inv, equipped, listedItemIds, myOffers } = await fetchUserInventoryState();

      const seenIds = new Set();
      const inventoryEquipments = [];
      const allInv = [
        ...(inv?.items?.equipments || []),
        ...(inv?.items?.weapons || []),
        ...myOffers.map((o) => o.item).filter(Boolean),
      ];
      for (const eq of allInv) {
        if (eq && eq._id && !seenIds.has(eq._id)) {
          seenIds.add(eq._id);
          inventoryEquipments.push(eq);
        }
      }

      this.emit("audit-status", { state: "classifying", message: `Classifying ${inventoryEquipments.length} inventory items...` });
      const classifiedItems = classifyInventoryItems(
        inventoryEquipments,
        equipped,
        listedItemIds,
        statRanges,
        gameConfig
      );

      this.emit("audit-status", { state: "pricing", message: `Pricing ${classifiedItems.length} items against live market...` });
      const auditResult = await performInventoryAudit(classifiedItems, {
        pricingStrategy,
        maxUndercutPct,
        taxRate,
        excludeUserId: resolveUserId(),
      });

      const activeTracker = createActiveOffersTracker(myOffers, statRanges, {
        pricingStrategy,
        maxUndercutPct,
        maxSimultaneous: 3,
        duplicateHandling: "same-price",
      });

      const { staged: allStaged, skipped } = prepareExecutionCandidates(
        auditResult.items,
        {
          pricingStrategy,
          maxUndercutPct,
          maxListings,
          slotFilter,
          qualityFilter,
        },
        activeTracker
      );

      const stagedItemIds = new Set(allStaged.map((s) => s.itemId));
      const skippedItemMap = new Map(skipped.map((s) => [s.itemId || s.item?.itemId, s.reason]));

      // Format items for the UI
      const pricedItems = auditResult.items.map((item) => {
        const p = item.pricing || {};
        const title = getFullItemTitle(item);

        let statsSummary = "";
        if (item.slot === "weapon") {
          statsSummary = `+${item.attack}A / +${item.criticalChance}C`;
        } else {
          statsSummary = `+${item.statValue} ${item.relevantStat || ""}`;
        }

        let rollDisplay = item.rollPosition || "-";
        if (item.slot === "weapon") {
          rollDisplay = item.isMaxCrit ? "MAX CRIT" : `${item.critRollPercent ?? item.rollPercent}%`;
        } else if (item.isPerfectRoll) {
          rollDisplay = "100% PERFECT";
        }

        let decision = item.finalDisposition || item.decision || "KEEP";
        let reason = item.decisionReason || "";

        if (item.equipped) {
          decision = "EQUIPPED";
          reason = "Currently equipped on character";
        } else if (item.listed) {
          decision = "ALREADY LISTED";
          reason = "Active listing on market";
        } else if (!item.tradable) {
          decision = "DAMAGED";
          reason = "Durability < 100 (untradable)";
        } else if (item.isPerfectRoll || item.isMaxCrit) {
          decision = item.isMaxCrit ? "KEEP - MAX CRIT" : "KEEP - PERFECT";
          reason = "Protected max roll (Safety invariant: Never sell)";
        } else if (stagedItemIds.has(item.itemId)) {
          decision = "SELL";
          reason = "Ready to list on market";
        } else if (skippedItemMap.has(item.itemId)) {
          decision = "HELD";
          reason = skippedItemMap.get(item.itemId);
        } else if (item.finalDisposition === "SELL - ELIGIBLE") {
          decision = "SELL";
          reason = p.pricingReason || "Eligible sub-max candidate";
        } else {
          reason = p.skipReason || p.pricingReason || reason;
        }

        return {
          itemId: item.itemId,
          itemCode: item.code,
          itemTitle: title,
          statsSummary,
          rollDisplay,
          exactComps: p.comparablesCount?.exact ?? 0,
          nearComps: p.comparablesCount?.near ?? 0,
          sellerPrice: p.suggestedPrice ? Number(p.suggestedPrice.toFixed(3)) : null,
          buyerPrice: p.displayedBuyerPrice ? Number(p.displayedBuyerPrice.toFixed(3)) : null,
          confidence: p.confidence || "LOW",
          decision,
          reason,
        };
      });

      // Prepare executable candidates (up to maxListings)
      const executableCandidates = allStaged.slice(0, maxListings).map((c) => ({
        itemId: c.itemId,
        itemTitle: getFullItemTitle(c),
        statsSummary: c.slot === "weapon" ? `+${c.attack}A / +${c.criticalChance}C` : `+${c.statValue} ${c.relevantStat || ""}`,
        sellerPrice: c.pricing?.suggestedPrice || 0,
        buyerPrice: c.pricing?.displayedBuyerPrice || 0,
      }));

      const totalExpectedProceeds = executableCandidates.reduce((sum, c) => sum + (c.sellerPrice || 0), 0);

      const result = {
        timestamp: new Date().toISOString(),
        taxRate,
        totalScanned: classifiedItems.length,
        sellCandidatesCount: allStaged.length + skipped.length,
        executableCount: allStaged.length,
        heldCount: skipped.length,
        alreadyListedCount: classifiedItems.filter((i) => i.listed).length,
        maxListings,
        expectedProceeds: Number(totalExpectedProceeds.toFixed(3)),
        executableCandidates,
        items: pricedItems,
      };

      this.lastAudit = result;
      return result;
    } finally {
      this.isAuditing = false;
      this.emit("audit-status", { state: "idle" });
    }
  }

  /**
   * Execute live market listings sequentially.
   * STRICT SAFETY: Requires explicit confirmed=true flag and candidate items.
   */
  async executeListings(options = {}) {
    if (this.isListing) {
      throw new Error("Listing execution is already in progress.");
    }

    const {
      candidates = [],
      dryRun = true,
      confirmed = false,
    } = options;

    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw new Error("No candidates selected for listing.");
    }

    if (!dryRun && !confirmed) {
      throw new Error("Live listing execution requires explicit confirmation.");
    }

    this.isListing = true;
    this.emit("listing-status", { state: "starting", dryRun, count: candidates.length });

    const results = {
      dryRun,
      totalRequested: candidates.length,
      listedCount: 0,
      plannedProceeds: candidates.reduce((sum, c) => sum + (c.sellerPrice || 0), 0),
      actualListedValue: 0,
      listings: [],
      failed: [],
      haltedEarly: false,
      haltReason: null,
    };

    try {
      if (dryRun) {
        // DRY RUN: Simulates listing without API mutations
        for (const item of candidates) {
          const record = {
            itemId: item.itemId,
            itemTitle: item.itemTitle,
            price: item.sellerPrice,
            status: "SIMULATED_LISTED",
            isDryRun: true,
          };
          results.listings.push(record);
          results.listedCount++;
          results.actualListedValue += item.sellerPrice;
          this.emit("item-listed", record);
        }
        return results;
      }

      // LIVE EXECUTION: Sequentially create and verify each listing
      for (const item of candidates) {
        this.emit("listing-progress", { itemId: item.itemId, status: "creating" });

        let listRes = null;
        const submissionTime = Date.now();
        try {
          listRes = await submitMarketListing(item.itemId, item.sellerPrice);
        } catch (err) {
          results.failed.push({ itemId: item.itemId, error: err.message });
          results.haltedEarly = true;
          results.haltReason = `Failed to create listing: ${err.message}`;
          break;
        }

        this.emit("listing-progress", { itemId: item.itemId, status: "verifying" });
        const vRes = await verifyListingWithBackoff(item.itemId, item.sellerPrice, {
          userId: resolveUserId(),
          submissionTime,
          createdOfferId: listRes?._id,
          mutationFailed: false,
        });

        if (vRes.state === ListingVerificationState.VERIFIED_LISTED || vRes.state === ListingVerificationState.VERIFIED_SOLD) {
          results.listedCount++;
          results.actualListedValue += item.sellerPrice;
          const record = {
            itemId: item.itemId,
            itemTitle: item.itemTitle,
            price: item.sellerPrice,
            offerId: vRes.offer?._id || listRes?._id || null,
            status: vRes.state,
          };
          results.listings.push(record);
          this.emit("item-listed", record);
        } else {
          results.failed.push({ itemId: item.itemId, error: vRes.reason || "Post-listing verification failed" });
          results.haltedEarly = true;
          results.haltReason = `Critical verification state ${vRes.state}: ${vRes.reason || "Unconfirmed"}. Halting immediately without retries.`;
          break;
        }
      }

      return results;
    } finally {
      this.isListing = false;
      this.emit("listing-status", { state: "idle" });
    }
  }
}

export const resellerService = new ResellerService();
