/**
 * WarEra Tools - Modern Desktop GUI Controller
 * 
 * Drives all desktop pages, safety validations, confirmations,
 * real-time event subscriptions, and responsive UI updates.
 */

// Global State
const state = {
  activePage: "dashboard",
  dryRun: true,
  settings: {},
  dashboardData: null,
  buyerData: null,
  selectedBuyerStrategy: "best-value",
  resellerData: null,
  telemetryData: null,
};

// UI Elements Cache
const elements = {};

document.addEventListener("DOMContentLoaded", () => {
  cacheElements();
  bindNavigation();
  bindGlobalControls();
  bindDashboardPage();
  bindDailyPage();
  bindBattlesPage();
  bindBuyerPage();
  bindResellerPage();
  bindAnalyzerPage();
  bindTelemetryPage();
  bindSchedulerPage();
  bindLogsPage();
  bindSettingsPage();

  // Load initial settings and data
  initApp();
});

function cacheElements() {
  elements.app = document.getElementById("app");
  elements.sidebar = document.getElementById("sidebar");
  elements.sidebarToggle = document.getElementById("sidebarToggle");
  elements.pageTitle = document.getElementById("pageTitle");
  elements.globalDryRunToggle = document.getElementById("globalDryRunToggle");
  elements.globalDryRunText = document.getElementById("globalDryRunText");
  elements.globalRefreshBtn = document.getElementById("globalRefreshBtn");
  elements.sidebarSessionText = document.getElementById("sidebarSessionText");
  elements.sidebarSessionDot = document.querySelector("#sidebarSessionBadge .status-dot");

  // Modal elements
  elements.confirmModal = document.getElementById("confirmModalBackdrop");
  elements.confirmTitle = document.getElementById("confirmModalTitle");
  elements.confirmMessage = document.getElementById("confirmModalMessage");
  elements.confirmSummary = document.getElementById("confirmModalSummary");
  elements.confirmProceedBtn = document.getElementById("confirmModalProceed");
  elements.confirmCancelBtn = document.getElementById("confirmModalCancel");
  elements.confirmCloseBtn = document.getElementById("confirmModalClose");
  elements.toastContainer = document.getElementById("toastContainer");
}

/* ==========================================================================
   INITIALIZATION & NAVIGATION
   ========================================================================== */

async function initApp() {
  try {
    const settings = await window.wareraApi.loadSettings();
    state.settings = settings;
    state.dryRun = settings.dryRun !== false;
    updateDryRunUI();

    // Check auth status
    const auth = await window.wareraApi.getAuthStatus();
    updateSessionUI(auth);

    // Initial load for dashboard
    await refreshDashboard();
  } catch (err) {
    showToast(`Initialization notice: ${err.message}`, "info");
  }
}

function bindNavigation() {
  elements.sidebarToggle.addEventListener("click", () => {
    elements.sidebar.classList.toggle("collapsed");
  });

  const navItems = document.querySelectorAll(".sidebar-nav .nav-item");
  navItems.forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = btn.getAttribute("data-page");
      switchPage(page);
    });
  });

  elements.globalRefreshBtn.addEventListener("click", () => {
    refreshCurrentPage();
  });
}

function switchPage(pageId) {
  state.activePage = pageId;

  // Update Nav
  document.querySelectorAll(".sidebar-nav .nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.getAttribute("data-page") === pageId);
  });

  // Update Views
  document.querySelectorAll(".page-view").forEach((view) => {
    view.classList.toggle("active", view.id === `page-${pageId}`);
  });

  // Update Title
  const titles = {
    dashboard: "Dashboard",
    daily: "Daily Tasks Automation",
    battles: "Battle Intelligence & Combat",
    buyer: "Equipment Buyer",
    reseller: "Equipment Reseller",
    analyzer: "Build & Combat Analyzer",
    telemetry: "Battle Availability Telemetry",
    scheduler: "Windows Scheduled Tasks",
    logs: "Log Viewer",
    settings: "Settings & Session Management",
  };
  elements.pageTitle.textContent = titles[pageId] || "WarEra Tools";

  refreshCurrentPage();
}

async function refreshCurrentPage() {
  switch (state.activePage) {
    case "dashboard":
      await refreshDashboard();
      break;
    case "daily":
      await refreshDailyStatus();
      break;
    case "battles":
      await refreshBattles();
      break;
    case "telemetry":
      await refreshTelemetry();
      break;
    case "scheduler":
      await refreshScheduler();
      break;
    case "logs":
      await refreshLogs();
      break;
    case "settings":
      await refreshSettingsView();
      break;
  }
}

function bindGlobalControls() {
  elements.globalDryRunToggle.addEventListener("click", async () => {
    state.dryRun = !state.dryRun;
    await window.wareraApi.saveSettings({ dryRun: state.dryRun });
    updateDryRunUI();
    showToast(`Global mode changed to: ${state.dryRun ? "DRY RUN (Safe)" : "LIVE"}`, state.dryRun ? "warning" : "success");
  });
}

function updateDryRunUI() {
  if (state.dryRun) {
    elements.globalDryRunToggle.className = "mode-toggle-btn dry-run";
    elements.globalDryRunText.textContent = "DRY RUN";
  } else {
    elements.globalDryRunToggle.className = "mode-toggle-btn live";
    elements.globalDryRunText.textContent = "LIVE";
  }
}

function formatSessionExpiry(minutes) {
  if (!minutes || minutes <= 0) return "Expired";
  if (minutes < 60) return `${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m left`;
  const days = Math.floor(hours / 24);
  return `${days}d left`;
}

function updateSessionUI(auth) {
  if (auth.isValid) {
    elements.sidebarSessionText.textContent = `Session Active (${formatSessionExpiry(auth.expiresInMinutes)})`;
    elements.sidebarSessionDot.className = "status-dot green";
  } else if (auth.status === "EXPIRED") {
    elements.sidebarSessionText.textContent = "Session Expired";
    elements.sidebarSessionDot.className = "status-dot red";
  } else {
    elements.sidebarSessionText.textContent = "Not Connected";
    elements.sidebarSessionDot.className = "status-dot yellow";
  }
}

/* ==========================================================================
   1. DASHBOARD PAGE
   ========================================================================== */

function bindDashboardPage() {
  // Setup handled in initApp
}

async function refreshDashboard() {
  try {
    const data = await window.wareraApi.getDashboardState();
    state.dashboardData = data;

    // Account stats
    document.getElementById("dashPlayerName").textContent = data.account.username || "-";
    document.getElementById("dashPlayerDetails").textContent = `Level ${data.account.level} • Country: ${data.account.country}`;
    document.getElementById("dashGold").textContent = data.account.gold !== null ? `${Number(data.account.gold).toFixed(3)} G` : "- G";
    document.getElementById("dashMilitaryUnit").textContent = `${data.account.militaryUnitName}`;

    // Session & Telemetry
    document.getElementById("dashAuthStatus").textContent = data.session.isValid ? "Connected" : (data.session.status || "Expired");
    document.getElementById("dashAuthStatus").className = `stat-value ${data.session.isValid ? "text-green" : "text-red"}`;
    document.getElementById("dashAuthExpiry").textContent = data.session.expiresInMinutes ? `Expires in ${data.session.expiresInMinutes}m` : "Invalid token";

    document.getElementById("dashTelemetryStatus").textContent = data.telemetry.running ? "Running" : "Offline";
    document.getElementById("dashTelemetryStatus").className = `stat-value ${data.telemetry.running ? "text-green" : "text-yellow"}`;
    document.getElementById("dashTelemetrySamples").textContent = `${data.telemetry.samplesCollected.toLocaleString()} live samples`;

    // Resource Bars
    const res = data.resources;
    const updateBar = (valId, barId, cur, max) => {
      document.getElementById(valId).textContent = `${cur} / ${max}`;
      const pct = max > 0 ? Math.min(100, Math.round((cur / max) * 100)) : 0;
      document.getElementById(barId).style.width = `${pct}%`;
    };

    updateBar("dashHpVal", "dashHpBar", res.health.current, res.health.max);
    updateBar("dashHungerVal", "dashHungerBar", res.hunger.current, res.hunger.max);
    updateBar("dashEnergyVal", "dashEnergyBar", res.energy.current, res.energy.max);
    updateBar("dashEntVal", "dashEntBar", res.entrepreneurship.current, res.entrepreneurship.max);

    // Automation status
    document.getElementById("dashLastDaily").textContent = data.activity.lastDailyRun ? `${new Date(data.activity.lastDailyRun.lastModified).toLocaleTimeString()} (${data.activity.lastDailyRun.status})` : "No recent runs";
    document.getElementById("dashDailyTaskState").textContent = data.scheduler.dailyTask.exists ? "Installed & Active" : "Not Installed";
    document.getElementById("dashTelemetryTaskState").textContent = data.scheduler.telemetryTask.exists ? "Installed" : "Not Installed";
    document.getElementById("dashLastBattleResult").textContent = data.activity.lastBattleHit ? `Battle ${data.activity.lastBattleHit.battleId?.substring(0, 8)} (${data.activity.lastBattleHit.verificationState})` : "None";

    // Recent Transactions Table
    const txTable = document.querySelector("#dashTransactionsTable tbody");
    if (data.activity.recentTransactions && data.activity.recentTransactions.length > 0) {
      txTable.innerHTML = data.activity.recentTransactions.slice(0, 5).map((tx) => `
        <tr>
          <td>${new Date(tx.createdAt || Date.now()).toLocaleTimeString()}</td>
          <td><span class="badge ${tx.type === "buy" ? "green" : "blue"}">${tx.type || "tx"}</span></td>
          <td>${tx.money ? `${Number(tx.money).toFixed(2)} G` : "-"}</td>
          <td class="text-sub">${tx.description || tx.itemId || "-"}</td>
        </tr>
      `).join("");
    } else {
      txTable.innerHTML = `<tr><td colspan="4" class="text-center text-muted">No recent transactions recorded</td></tr>`;
    }

    updateSessionUI(data.session);
  } catch (err) {
    console.error("Dashboard refresh failed:", err);
  }
}

/* ==========================================================================
   2. DAILY AUTOMATION PAGE
   ========================================================================== */

function bindDailyPage() {
  const runBtn = document.getElementById("dailyRunBtn");
  const cancelBtn = document.getElementById("dailyCancelBtn");
  const clearBtn = document.getElementById("dailyClearLogBtn");
  const modeSelect = document.getElementById("dailyModeSelect");
  const headlessToggle = document.getElementById("dailyHeadlessToggle");
  const terminal = document.getElementById("dailyTerminal");

  clearBtn.addEventListener("click", () => {
    terminal.innerHTML = "";
  });

  runBtn.addEventListener("click", async () => {
    const mode = modeSelect.value;
    const headless = headlessToggle.checked;

    if (!state.dryRun && mode !== "nothing") {
      const confirmed = await showConfirmModal(
        "Confirm Daily Automation (LIVE)",
        `You are about to run Daily Automation in LIVE mode with mode "${mode}".`,
        `<div class="info-row"><span class="info-name">Mode:</span><span>${mode}</span></div>
         <div class="info-row"><span class="info-name">Safety:</span><span class="text-red">LIVE MUTATIONS ENABLED</span></div>`
      );
      if (!confirmed) return;
    }

    try {
      runBtn.disabled = true;
      cancelBtn.disabled = false;
      terminal.innerHTML = `<div class="log-line text-accent">[SYSTEM] Initiating Daily Automation (${mode}, dryRun: ${state.dryRun})...</div>`;

      await window.wareraApi.startDaily({
        mode,
        dryRun: state.dryRun,
        headless,
      });
    } catch (err) {
      runBtn.disabled = false;
      cancelBtn.disabled = true;
      showToast(`Daily automation error: ${err.message}`, "error");
    }
  });

  cancelBtn.addEventListener("click", async () => {
    try {
      await window.wareraApi.cancelDaily();
      showToast("Cancellation signal sent.", "info");
    } catch (err) {
      showToast(`Failed to cancel: ${err.message}`, "error");
    }
  });

  // Event subscriptions from main process
  window.wareraApi.onDailyLog((entry) => {
    const line = document.createElement("div");
    line.className = "log-line";
    line.textContent = entry.text;
    terminal.appendChild(line);
    terminal.scrollTop = terminal.scrollHeight;
  });

  window.wareraApi.onDailyStage((stage) => {
    updateStepperStage(stage);
    if (stage === "Completed" || stage === "Failed") {
      runBtn.disabled = false;
      cancelBtn.disabled = true;
      if (stage === "Completed") showToast("Daily automation completed!", "success");
    }
  });
}

function updateStepperStage(currentStage) {
  const steps = ["Companies", "Military Unit", "Resistance", "Battles", "Summary"];
  const currentIdx = steps.indexOf(currentStage);

  document.querySelectorAll("#dailyStepper .step-item").forEach((item) => {
    const stage = item.getAttribute("data-stage");
    const idx = steps.indexOf(stage);

    item.classList.remove("active", "completed");
    if (idx < currentIdx) {
      item.classList.add("completed");
    } else if (idx === currentIdx) {
      item.classList.add("active");
    }
  });
}

async function refreshDailyStatus() {
  const status = await window.wareraApi.getDailyStatus();
  const runBtn = document.getElementById("dailyRunBtn");
  const cancelBtn = document.getElementById("dailyCancelBtn");

  if (status.isRunning) {
    runBtn.disabled = true;
    cancelBtn.disabled = false;
    updateStepperStage(status.currentStage);
  } else {
    runBtn.disabled = false;
    cancelBtn.disabled = true;
  }
}

/* ==========================================================================
   3. BATTLES PAGE
   ========================================================================== */

function bindBattlesPage() {
  const refreshBtn = document.getElementById("battlesRefreshBtn");
  const executeBtn = document.getElementById("battlesExecuteBtn");

  refreshBtn.addEventListener("click", () => refreshBattles());

  executeBtn.addEventListener("click", async () => {
    if (!state.dryRun) {
      const confirmed = await showConfirmModal(
        "Confirm Battle Execution (LIVE)",
        "You are about to execute LIVE combat hits on the #1 ranked consensus battle.",
        `<div class="info-row"><span class="info-name">Mode:</span><span class="text-red">LIVE HITS</span></div>
         <div class="info-row"><span class="info-name">Safety Floor:</span><span>10 HP Minimum</span></div>`
      );
      if (!confirmed) return;
    }

    try {
      executeBtn.disabled = true;
      const hitStream = document.getElementById("battlesExecutionStream");
      const hitCards = document.getElementById("battlesHitCards");
      hitStream.style.display = "block";
      hitCards.innerHTML = `<div class="text-muted">Executing combat sequence...</div>`;

      const results = await window.wareraApi.executeBattles({
        dryRun: state.dryRun,
        confirmed: true,
      });

      showToast(`Combat complete! Hits executed: ${results.hitsExecuted}, Damage dealt: ${results.totalDamage}`, "success");
    } catch (err) {
      showToast(`Battle execution failed: ${err.message}`, "error");
    } finally {
      executeBtn.disabled = false;
    }
  });

  window.wareraApi.onBattleHit((hit) => {
    const hitCards = document.getElementById("battlesHitCards");
    const card = document.createElement("div");
    card.className = "mini-card";
    card.innerHTML = `
      <div class="stat-header">
        <span class="mini-label">Hit #${hit.hitIndex || 1}</span>
        <span class="badge ${hit.verificationState === "VERIFIED_HIT" ? "green" : (hit.verificationState === "UNKNOWN_HIT" ? "yellow" : "red")}">${hit.verificationState}</span>
      </div>
      <div class="mini-val text-accent">${hit.damageDealt ? `${hit.damageDealt} Dmg` : "No Dmg"}</div>
      <div class="stat-sub">HP: ${hit.healthBefore} ➔ ${hit.healthAfter}</div>
    `;
    hitCards.appendChild(card);
  });
}

async function refreshBattles() {
  const tableBody = document.querySelector("#battlesTable tbody");
  tableBody.innerHTML = `<tr><td colspan="12" class="text-center text-muted">Scanning live active battles...</td></tr>`;

  try {
    const scan = await window.wareraApi.scanBattles();
    document.getElementById("battlesCountBadge").textContent = `${scan.totalActive} active battles`;
    document.getElementById("battlesTopTargetBadge").textContent = scan.selectedBattleId ? `Top Target: #${scan.selectedBattleId.substring(0, 8)}` : "Top Target: None";

    if (!scan.battles || scan.battles.length === 0) {
      tableBody.innerHTML = `<tr><td colspan="12" class="text-center text-muted">No active battles found.</td></tr>`;
      return;
    }

    tableBody.innerHTML = scan.battles.map((b) => {
      const isTop = b.selectedTarget;
      const consensusText = b.ordersAgree ? "AGREE" : (b.countryOrderPresent || b.muOrderPresent ? "CONFLICT / ONE" : "NONE");
      const consensusClass = b.ordersAgree ? "badge green" : "badge yellow";

      return `
        <tr class="${isTop ? "selected" : ""}">
          <td>${isTop ? "⭐ #1 TARGET" : (b.selectorRank ? `#${b.selectorRank}` : "-")}</td>
          <td><strong>${b.regionName || b.battleId.substring(0, 8)}</strong></td>
          <td><span class="badge blue">${b.battleType}</span></td>
          <td>${b.isPlayerCountryWar ? "Yes" : "Foreign"}</td>
          <td>${b.countryOrderSide || "None"}</td>
          <td>${b.muOrderSide || "None"}</td>
          <td><span class="${consensusClass}">${consensusText}</span></td>
          <td><strong>${b.resolvedSide || "None"}</strong></td>
          <td>${b.damageBonusPercent}%</td>
          <td>${b.bountyRate ? `${Number(b.bountyRate).toFixed(3)} G` : "0 G"}</td>
          <td>${b.remainingTimeHours ? `${b.remainingTimeHours}h` : "-"}</td>
          <td><span class="badge ${b.selectorEligible ? "green" : "yellow"}">${b.selectorEligible ? "ELIGIBLE" : (b.selectorSkipReason || "SKIP")}</span></td>
        </tr>
      `;
    }).join("");
  } catch (err) {
    tableBody.innerHTML = `<tr><td colspan="12" class="text-center text-red">Scan error: ${err.message}</td></tr>`;
  }
}

/* ==========================================================================
   4. EQUIPMENT BUYER PAGE
   ========================================================================== */

function bindBuyerPage() {
  const analyzeBtn = document.getElementById("buyerAnalyzeBtn");
  const cancelBtn = document.getElementById("buyerCancelBtn");
  const purchaseBtn = document.getElementById("buyerPurchaseBtn");
  const budgetInput = document.getElementById("buyerBudgetInput");

  // Rarity radio selection
  document.querySelectorAll("#buyerRarityGroup input[type='radio']").forEach((radio) => {
    radio.addEventListener("change", () => {
      document.querySelectorAll("#buyerRarityGroup .rarity-pill").forEach((l) => l.classList.remove("active"));
      radio.closest(".rarity-pill")?.classList.add("active");
    });
  });

  // Slot checkboxes
  document.querySelectorAll("#buyerSlotsGroup input[type='checkbox']").forEach((cb) => {
    cb.addEventListener("change", () => {
      cb.closest(".cat-pill")?.classList.toggle("active", cb.checked);
    });
  });

  analyzeBtn.addEventListener("click", async () => {
    const selectedRarity = document.querySelector("#buyerRarityGroup input:checked")?.value || "green";
    const selectedSlots = Array.from(document.querySelectorAll("#buyerSlotsGroup input:checked")).map((i) => i.value);
    const budget = budgetInput.value ? parseFloat(budgetInput.value) : null;

    if (selectedSlots.length === 0) {
      showToast("Please select at least one equipment category to analyze.", "warning");
      return;
    }

    try {
      analyzeBtn.disabled = true;
      cancelBtn.style.display = "inline-flex";
      document.getElementById("buyerInitialPlaceholder").style.display = "none";
      document.getElementById("buyerProgressBox").style.display = "flex";
      document.getElementById("buyerProgressText").textContent = "Connecting to WarEra market...";
      document.getElementById("buyerIncompleteAlert").style.display = "none";
      document.getElementById("buyerResultsContainer").style.display = "none";
      document.getElementById("buyerStrategyCards").style.display = "none";

      const result = await window.wareraApi.analyzeBuyerMarket({
        rarity: selectedRarity,
        categories: selectedSlots,
        budget,
        strategy: state.selectedBuyerStrategy,
      });

      state.buyerData = result;

      if (result.marketIncomplete) {
        document.getElementById("buyerIncompleteAlert").style.display = "flex";
        document.getElementById("buyerIncompleteMsg").textContent = result.details || "Market coverage incomplete. Full market was not scanned.";
        return;
      }

      renderBuyerResults(result);
    } catch (err) {
      showToast(`Market analysis error: ${err.message}`, "error");
      document.getElementById("buyerInitialPlaceholder").style.display = "flex";
    } finally {
      analyzeBtn.disabled = false;
      cancelBtn.style.display = "none";
      document.getElementById("buyerProgressBox").style.display = "none";
    }
  });

  cancelBtn.addEventListener("click", () => {
    window.wareraApi.cancelBuyerAnalysis();
  });

  // Strategy card selection (changes view WITHOUT mutating)
  document.querySelectorAll("#buyerStrategyCards .strategy-card").forEach((card) => {
    card.addEventListener("click", () => {
      const strat = card.getAttribute("data-strategy");
      selectBuyerStrategy(strat);
    });
  });

  // Purchase Loadout
  purchaseBtn.addEventListener("click", async () => {
    if (!state.buyerData || !state.buyerData.loadouts) return;
    const currentLoadout = state.buyerData.loadouts[state.selectedBuyerStrategy];

    if (!currentLoadout || !currentLoadout.items || currentLoadout.items.length === 0) {
      showToast("Selected loadout has no available offers to buy.", "warning");
      return;
    }

    const summaryHtml = `
      <div class="info-row"><span class="info-name">Strategy:</span><strong>${currentLoadout.strategyDisplayName}</strong></div>
      <div class="info-row"><span class="info-name">Items Count:</span><strong>${currentLoadout.items.length}</strong></div>
      <div class="info-row"><span class="info-name">Total Gold:</span><strong class="text-gold">${currentLoadout.totalCost.toFixed(3)} G</strong></div>
      <div class="mt-2 text-sub">Items to buy:</div>
      ${currentLoadout.items.map((i) => `<div>• ${i.itemTitle} (${i.statSummary}) @ ${i.buyerPrice} G [#${i.offerId?.substring(0, 8)}]</div>`).join("")}
    `;

    const confirmed = await showConfirmModal(
      `Confirm Loadout Purchase (${state.dryRun ? "DRY RUN" : "LIVE"})`,
      state.dryRun
        ? "You are running in DRY RUN mode. Zero Gold will be spent and zero mutations performed."
        : "LIVE PURCHASE: This will spend real Gold from your wallet sequentially with preflight checks.",
      summaryHtml
    );

    if (!confirmed) return;

    try {
      purchaseBtn.disabled = true;
      const res = await window.wareraApi.executePurchases({
        confirmedLoadout: currentLoadout,
        dryRun: state.dryRun,
        confirmed: true,
      });

      if (res.haltedEarly) {
        showToast(`Purchase sequence halted: ${res.haltReason}`, "error");
      } else {
        showToast(`Purchased ${res.purchased.length} items successfully! Total: ${res.actualSpent.toFixed(3)} G`, "success");
      }
    } catch (err) {
      showToast(`Purchase execution failed: ${err.message}`, "error");
    } finally {
      purchaseBtn.disabled = false;
    }
  });

  window.wareraApi.onBuyerProgress((info) => {
    document.getElementById("buyerProgressText").textContent = info.message;
  });
}

function renderBuyerResults(result) {
  document.getElementById("buyerStrategyCards").style.display = "grid";
  document.getElementById("buyerResultsContainer").style.display = "block";

  // Update 3 Strategy Cards
  const bv = result.loadouts["best-value"];
  const bp = result.loadouts["best-performance"];
  const ch = result.loadouts["cheapest"];

  document.getElementById("cardBvCost").textContent = `${bv.totalCost.toFixed(3)} G`;
  document.getElementById("cardBvMetric").textContent = `Avg Roll: ${bv.averageRoll}% (${bv.itemCount} items)`;

  document.getElementById("cardBpCost").textContent = `${bp.totalCost.toFixed(3)} G`;
  document.getElementById("cardBpMetric").textContent = `Avg Roll: ${bp.averageRoll}% (${bp.itemCount} items)`;

  document.getElementById("cardChCost").textContent = `${ch.totalCost.toFixed(3)} G`;
  document.getElementById("cardChMetric").textContent = `Avg Roll: ${ch.averageRoll}% (${ch.itemCount} items)`;

  selectBuyerStrategy(state.selectedBuyerStrategy);

  // Render Diagnostics
  renderBuyerDiagnostics(result.diagnostics);
}

function selectBuyerStrategy(stratKey) {
  state.selectedBuyerStrategy = stratKey;

  document.querySelectorAll("#buyerStrategyCards .strategy-card").forEach((c) => {
    c.classList.toggle("active", c.getAttribute("data-strategy") === stratKey);
  });

  if (!state.buyerData || !state.buyerData.loadouts) return;
  const loadout = state.buyerData.loadouts[stratKey];

  document.getElementById("buyerSelectedLoadoutTitle").textContent = `${loadout.strategyDisplayName} Loadout`;
  document.getElementById("buyerTotalCost").textContent = `${loadout.totalCost.toFixed(3)} G`;
  document.getElementById("buyerTotalQuality").textContent = `${loadout.normalizedQuality} / 5.0 (${loadout.averageRoll}%)`;
  document.getElementById("buyerTotalMarketVal").textContent = `${loadout.marketValue.toFixed(3)} G`;
  document.getElementById("buyerTotalDiscount").textContent = `${loadout.totalDiscount.toFixed(3)} G`;

  const purchaseBtn = document.getElementById("buyerPurchaseBtn");
  if (purchaseBtn) {
    purchaseBtn.disabled = !loadout || !loadout.items || loadout.items.length === 0;
  }

  const tbody = document.querySelector("#buyerTable tbody");
  if (!loadout.items || loadout.items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" class="text-center text-muted" style="padding: 24px;">No matching equipment offers currently listed on the market.</td></tr>`;
  } else {
    tbody.innerHTML = loadout.items.map((item) => `
      <tr>
        <td><span class="badge blue">${item.slotLabel}</span></td>
        <td><strong>${item.itemTitle}</strong></td>
        <td class="text-accent"><strong>${item.statSummary}</strong></td>
        <td>${item.liveRange}</td>
        <td><span class="badge ${item.rollDisplay && item.rollDisplay.includes('PERFECT') ? 'purple' : 'green'}">${item.rollDisplay}</span></td>
        <td class="text-gold"><strong>${item.buyerPrice.toFixed(3)} G</strong></td>
        <td>${item.marketValue.toFixed(3)} G</td>
        <td class="${item.discount > 0 ? 'text-green' : 'text-sub'}">${item.discount > 0 ? `-${item.discount.toFixed(3)} G` : "0 G"}</td>
        <td>${item.marketMax ? `+${item.marketMax}` : "-"}</td>
      </tr>
    `).join("");
  }
}

function renderBuyerDiagnostics(diagnostics) {
  const container = document.getElementById("buyerDiagnosticsContent");
  if (!diagnostics) return;

  container.innerHTML = Object.values(diagnostics).map((d) => `
    <div class="mini-card mt-2">
      <div class="stat-header">
        <strong>${d.slotLabel} (${d.primaryStat})</strong>
        <span>Market Max: +${d.rawMarketMax} (Theor. Max: +${d.theoreticalMax})</span>
      </div>
      <div class="stat-sub">Fetched: ${d.fetchedCount} | Valid: ${d.validCount} | Pareto Non-Dominated: ${d.paretoCount}</div>
      <div class="stat-sub text-muted">Distribution: ${Object.entries(d.statDistribution || {}).map(([k, v]) => `+${k}: ${v}`).join(", ")}</div>
    </div>
  `).join("");
}

/* ==========================================================================
   5. EQUIPMENT RESELLER PAGE
   ========================================================================== */

function bindResellerPage() {
  const auditBtn = document.getElementById("resellerAuditBtn");
  const executeBtn = document.getElementById("resellerExecuteBtn");
  const pricingSelect = document.getElementById("resellerPricingSelect");
  const maxListingsInput = document.getElementById("resellerMaxListingsInput");
  const progressBox = document.getElementById("resellerProgressBox");
  const progressText = document.getElementById("resellerProgressText");
  const initialPlaceholder = document.getElementById("resellerInitialPlaceholder");
  const tableContainer = document.getElementById("resellerTableContainer");
  const auditChips = document.getElementById("resellerAuditChips");

  auditBtn.addEventListener("click", async () => {
    try {
      auditBtn.disabled = true;
      executeBtn.disabled = true;
      if (initialPlaceholder) initialPlaceholder.style.display = "none";
      if (tableContainer) tableContainer.style.display = "none";
      if (auditChips) auditChips.style.display = "none";
      if (progressBox) progressBox.style.display = "flex";
      if (progressText) progressText.textContent = "Connecting to WarEra API and loading inventory...";

      const audit = await window.wareraApi.auditResellerInventory({
        pricingStrategy: pricingSelect.value,
        maxListings: parseInt(maxListingsInput.value, 10) || 1,
      });

      state.resellerData = audit;
      renderResellerResults(audit);
    } catch (err) {
      showToast(`Reseller audit error: ${err.message}`, "error");
      if (initialPlaceholder) initialPlaceholder.style.display = "flex";
      if (tableContainer) tableContainer.style.display = "none";
      if (auditChips) auditChips.style.display = "none";
    } finally {
      auditBtn.disabled = false;
      if (progressBox) progressBox.style.display = "none";
    }
  });

  if (window.wareraApi.onResellerAuditStatus) {
    window.wareraApi.onResellerAuditStatus((info) => {
      if (progressText && info && info.message) {
        progressText.textContent = info.message;
      }
    });
  }

  executeBtn.addEventListener("click", async () => {
    if (!state.resellerData || !state.resellerData.executableCandidates) return;
    const candidates = state.resellerData.executableCandidates;

    if (candidates.length === 0) {
      showToast("No executable sell candidates available to list.", "warning");
      return;
    }

    const summaryHtml = `
      <div class="info-row"><span class="info-name">Listings Count:</span><strong>${candidates.length}</strong></div>
      <div class="info-row"><span class="info-name">Expected Proceeds:</span><strong class="text-gold">${state.resellerData.expectedProceeds.toFixed(3)} G</strong></div>
      <div class="mt-2 text-sub">Items to list:</div>
      ${candidates.map((c) => `<div>• ${c.itemTitle} (${c.statsSummary}) @ ${c.sellerPrice} G</div>`).join("")}
    `;

    const confirmed = await showConfirmModal(
      `Confirm Market Listings (${state.dryRun ? "DRY RUN" : "LIVE"})`,
      state.dryRun
        ? "DRY RUN active. Zero live market listings will be created."
        : "LIVE LISTINGS: This will post items directly to the WarEra live market.",
      summaryHtml
    );

    if (!confirmed) return;

    try {
      executeBtn.disabled = true;
      const res = await window.wareraApi.executeListings({
        candidates,
        dryRun: state.dryRun,
        confirmed: true,
      });

      showToast(`Listed ${res.listedCount} items successfully! Expected value: ${res.actualListedValue.toFixed(3)} G`, "success");
    } catch (err) {
      showToast(`Listing failed: ${err.message}`, "error");
    } finally {
      executeBtn.disabled = false;
    }
  });
}

function renderResellerResults(audit) {
  const initialPlaceholder = document.getElementById("resellerInitialPlaceholder");
  const tableContainer = document.getElementById("resellerTableContainer");
  const auditChips = document.getElementById("resellerAuditChips");

  if (initialPlaceholder) initialPlaceholder.style.display = "none";
  if (auditChips) auditChips.style.display = "grid";
  if (tableContainer) tableContainer.style.display = "block";

  document.getElementById("resellerTotalScanned").textContent = audit.totalScanned;
  document.getElementById("resellerSellCandidates").textContent = audit.sellCandidatesCount;
  document.getElementById("resellerExecutableCount").textContent = audit.executableCount;
  document.getElementById("resellerHeldCount").textContent = audit.heldCount;
  document.getElementById("resellerTaxRate").textContent = `${audit.taxRate}%`;

  const executeBtn = document.getElementById("resellerExecuteBtn");
  executeBtn.disabled = audit.executableCount === 0;

  const tbody = document.querySelector("#resellerTable tbody");
  if (!audit.items || audit.items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="text-center text-muted" style="padding: 24px;">No equipment found in inventory.</td></tr>`;
    return;
  }

  tbody.innerHTML = audit.items.map((i) => {
    let badgeClass = "badge blue";
    if (i.decision === "SELL") badgeClass = "badge green";
    else if (i.decision.includes("PERFECT") || i.decision.includes("MAX CRIT")) badgeClass = "badge purple";
    else if (i.decision.includes("EQUIPPED")) badgeClass = "badge blue";
    else if (i.decision.includes("ALREADY LISTED")) badgeClass = "badge yellow";
    else if (i.decision.includes("DAMAGED")) badgeClass = "badge red";
    else if (i.decision.includes("HELD") || i.decision.includes("REVIEW")) badgeClass = "badge yellow";

    return `
      <tr>
        <td><strong>${i.itemTitle}</strong></td>
        <td class="text-accent"><strong>${i.statsSummary}</strong></td>
        <td><span class="badge ${i.rollDisplay && (i.rollDisplay.includes('PERFECT') || i.rollDisplay.includes('MAX CRIT')) ? 'purple' : 'default'}">${i.rollDisplay}</span></td>
        <td>${i.exactComps}</td>
        <td>${i.nearComps}</td>
        <td class="text-gold"><strong>${i.sellerPrice !== null ? `${i.sellerPrice.toFixed(3)} G` : "-"}</strong></td>
        <td>${i.buyerPrice !== null ? `${i.buyerPrice.toFixed(3)} G` : "-"}</td>
        <td><span class="badge ${i.confidence === "HIGH" ? "green" : i.confidence === "MOD" ? "yellow" : "red"}">${i.confidence}</span></td>
        <td><span class="${badgeClass}">${i.decision}</span></td>
        <td class="text-sub">${i.reason}</td>
      </tr>
    `;
  }).join("");
}

/* ==========================================================================
   6. BUILD ANALYZER PAGE
   ========================================================================== */

function bindAnalyzerPage() {
  const runBtn = document.getElementById("analyzerRunBtn");
  runBtn.addEventListener("click", async () => {
    try {
      runBtn.disabled = true;
      const res = await window.wareraApi.runBuildAnalysis({ target: "me" });

      document.getElementById("analyzerExpectedDamage").textContent = Math.round(res.player.expectedDamage);
      document.getElementById("analyzerOptimalDamage").textContent = Math.round(res.player.optimalDamage);
      document.getElementById("analyzerEfficiency").textContent = `${res.player.efficiencyPercent}%`;

      // Respec advice
      const respecBox = document.getElementById("analyzerRespecContent");
      if (res.respec.combatSkills.length > 0) {
        respecBox.innerHTML = `
          <div><strong>Recommended Combat Respec:</strong></div>
          <ul class="mt-2 ml-2">
            ${res.respec.combatSkills.map((s) => `<li>• ${s.skill}: ${s.currentLevel} ➔ ${s.targetLevel} (${s.delta > 0 ? `+${s.delta}` : s.delta} pts)</li>`).join("")}
          </ul>
          <div class="mt-3 text-sub">${res.respec.nonCombatPointsSpent} points spent outside combat that can be optimized for damage.</div>
        `;
      } else {
        respecBox.innerHTML = `<p class="text-green">✓ Your combat allocation is mathematically optimal for current level.</p>`;
      }

      // ROI Table
      const roiTbody = document.querySelector("#analyzerRoiTable tbody");
      roiTbody.innerHTML = res.roiRankings.slice(0, 5).map((r) => `
        <tr>
          <td><strong>${r.skill}</strong></td>
          <td>${r.type}</td>
          <td>${r.upgrade}</td>
          <td>${r.cost} pt</td>
          <td class="text-green">+${r.gainPercent}%</td>
          <td class="text-accent">${r.roi}</td>
        </tr>
      `).join("");

      // Gaps Table
      const gapsTbody = document.querySelector("#analyzerGapsTable tbody");
      gapsTbody.innerHTML = res.benchmarkGaps.map((g) => `
        <tr>
          <td><strong>${g.stat}</strong></td>
          <td>${g.mine}</td>
          <td>${g.topMedian}</td>
          <td class="${g.ratioPercent < 50 ? "text-yellow" : "text-green"}">${g.ratioPercent}%</td>
        </tr>
      `).join("");
    } catch (err) {
      showToast(`Analysis error: ${err.message}`, "error");
    } finally {
      runBtn.disabled = false;
    }
  });
}

/* ==========================================================================
   7. TELEMETRY PAGE
   ========================================================================== */

function bindTelemetryPage() {
  document.getElementById("telemetryStartBtn").addEventListener("click", async () => {
    const interval = document.getElementById("telemetryIntervalSelect").value;
    const res = await window.wareraApi.startTelemetry(interval);
    showToast(res.started ? `Telemetry daemon started (PID ${res.pid})` : res.message, res.started ? "success" : "info");
    await refreshTelemetry();
  });

  document.getElementById("telemetryStopBtn").addEventListener("click", async () => {
    const res = await window.wareraApi.stopTelemetry();
    showToast(res.stopped ? "Telemetry daemon stopped." : res.message, res.stopped ? "success" : "info");
    await refreshTelemetry();
  });

  document.getElementById("telemetryInstallTaskBtn").addEventListener("click", async () => {
    const confirmed = await showConfirmModal(
      "Install Telemetry Task",
      "Do you want to register WarEraBattleTelemetry as a Windows Scheduled Task (Runs at boot/logon)?"
    );
    if (!confirmed) return;

    try {
      await window.wareraApi.installTelemetryTask();
      showToast("Telemetry Windows Scheduled Task installed successfully!", "success");
      await refreshTelemetry();
    } catch (err) {
      showToast(`Failed to install task: ${err.message}`, "error");
    }
  });

  document.getElementById("telemetryUninstallTaskBtn").addEventListener("click", async () => {
    try {
      await window.wareraApi.uninstallTelemetryTask();
      showToast("Telemetry Windows Scheduled Task removed.", "success");
      await refreshTelemetry();
    } catch (err) {
      showToast(`Failed to remove task: ${err.message}`, "error");
    }
  });
}

async function refreshTelemetry() {
  try {
    const analytics = await window.wareraApi.getTelemetryAnalytics();
    state.telemetryData = analytics;

    document.getElementById("telemCoverage").textContent = `${analytics.observedCoveragePercent}%`;
    document.getElementById("telemConfidence").textContent = analytics.confidence;
    document.getElementById("telemBattleHours").textContent = `${analytics.knownBattleHours}h`;
    document.getElementById("telemLullHours").textContent = analytics.longestKnownLullFormatted;

    document.getElementById("telemV1Count").textContent = analytics.v1SamplesCount.toLocaleString();
    document.getElementById("telemV2Count").textContent = analytics.v2SamplesCount.toLocaleString();

    // 24h Heatmap Render
    const heatmap = document.getElementById("telemHeatmap");
    heatmap.innerHTML = analytics.timeOfDayAvailability.map((cell) => {
      let lvl = "level-0";
      if (cell.percentage > 75) lvl = "level-4";
      else if (cell.percentage > 50) lvl = "level-3";
      else if (cell.percentage > 25) lvl = "level-2";
      else if (cell.percentage > 0) lvl = "level-1";

      return `
        <div class="heatmap-cell ${lvl}" title="${cell.hourLabel}: ${cell.percentage}% coverage (${cell.qualifyingScans}/${cell.totalScans} scans)">
          <span>${cell.hour}</span>
          <span style="font-size: 8px;">${cell.percentage}%</span>
        </div>
      `;
    }).join("");

    // Executions Table
    const execTbody = document.querySelector("#telemExecutionsTable tbody");
    if (analytics.recentExecutions && analytics.recentExecutions.length > 0) {
      execTbody.innerHTML = analytics.recentExecutions.map((e) => `
        <tr>
          <td>${new Date(e.timestamp).toLocaleTimeString()}</td>
          <td>${e.battleId?.substring(0, 8)}</td>
          <td><span class="badge ${e.verificationState === "VERIFIED_HIT" ? "green" : "red"}">${e.verificationState}</span></td>
          <td class="text-accent">${e.damageDealt ? `${e.damageDealt}` : "-"}</td>
          <td>${e.healthBefore} ➔ ${e.healthAfter}</td>
          <td>${e.hostname || "local"}</td>
        </tr>
      `).join("");
    } else {
      execTbody.innerHTML = `<tr><td colspan="6" class="text-center text-muted">No combat executions recorded</td></tr>`;
    }
  } catch (err) {
    console.error("Telemetry refresh failed:", err);
  }
}

/* ==========================================================================
   8. SCHEDULER PAGE
   ========================================================================== */

function bindSchedulerPage() {
  document.getElementById("schedDailyInstallBtn").addEventListener("click", async () => {
    const cadence = document.getElementById("schedDailyCadenceSelect").value;
    try {
      await window.wareraApi.dailyInstallTask(cadence);
      showToast("Daily Automator task installed successfully.", "success");
      await refreshScheduler();
    } catch (err) {
      showToast(`Install error: ${err.message}`, "error");
    }
  });

  document.getElementById("schedDailyUninstallBtn").addEventListener("click", async () => {
    try {
      await window.wareraApi.dailyUninstallTask();
      showToast("Daily Automator task removed.", "success");
      await refreshScheduler();
    } catch (err) {
      showToast(`Uninstall error: ${err.message}`, "error");
    }
  });

  document.getElementById("schedDailyEnableBtn").addEventListener("click", async () => {
    await window.wareraApi.dailyEnableTask();
    await refreshScheduler();
  });

  document.getElementById("schedDailyDisableBtn").addEventListener("click", async () => {
    await window.wareraApi.dailyDisableTask();
    await refreshScheduler();
  });

  document.getElementById("schedTelemInstallBtn").addEventListener("click", async () => {
    try {
      await window.wareraApi.telemetryInstallTask("5m");
      showToast("Telemetry task installed successfully.", "success");
      await refreshScheduler();
    } catch (err) {
      showToast(`Install error: ${err.message}`, "error");
    }
  });

  document.getElementById("schedTelemUninstallBtn").addEventListener("click", async () => {
    try {
      await window.wareraApi.telemetryUninstallTask();
      showToast("Telemetry task removed.", "success");
      await refreshScheduler();
    } catch (err) {
      showToast(`Uninstall error: ${err.message}`, "error");
    }
  });

  document.getElementById("schedTelemEnableBtn").addEventListener("click", async () => {
    await window.wareraApi.telemetryEnableTask();
    await refreshScheduler();
  });

  document.getElementById("schedTelemDisableBtn").addEventListener("click", async () => {
    await window.wareraApi.telemetryDisableTask();
    await refreshScheduler();
  });
}

async function refreshScheduler() {
  const sched = await window.wareraApi.getSchedulerStatus();
  if (!sched.supported) return;

  const d = sched.tasks.daily;
  document.getElementById("schedDailyBadge").textContent = d.installed ? d.status : "Not Installed";
  document.getElementById("schedDailyBadge").className = `badge ${d.installed && d.enabled ? "green" : (d.installed ? "yellow" : "red")}`;
  document.getElementById("schedDailyStatus").textContent = d.status;
  document.getElementById("schedDailyLastRun").textContent = d.lastRunTime;
  document.getElementById("schedDailyNextRun").textContent = d.nextRunTime;

  const t = sched.tasks.telemetry;
  document.getElementById("schedTelemBadge").textContent = t.installed ? t.status : "Not Installed";
  document.getElementById("schedTelemBadge").className = `badge ${t.installed && t.enabled ? "green" : (t.installed ? "yellow" : "red")}`;
  document.getElementById("schedTelemStatus").textContent = t.status;
  document.getElementById("schedTelemLastRun").textContent = t.lastRunTime;
}

/* ==========================================================================
   9. LOG VIEWER PAGE
   ========================================================================== */

function bindLogsPage() {
  const categorySelect = document.getElementById("logsCategorySelect");
  const levelSelect = document.getElementById("logsLevelSelect");
  const searchInput = document.getElementById("logsSearchInput");
  const copyBtn = document.getElementById("logsCopyBtn");
  const clearViewBtn = document.getElementById("logsClearViewBtn");
  const openFolderBtn = document.getElementById("logsOpenFolderBtn");

  categorySelect.addEventListener("change", () => refreshLogs());
  levelSelect.addEventListener("change", () => refreshLogs());
  searchInput.addEventListener("input", () => refreshLogs());

  copyBtn.addEventListener("click", () => {
    const text = document.getElementById("logsTerminal").textContent;
    navigator.clipboard.writeText(text);
    showToast("Logs copied to clipboard!", "success");
  });

  clearViewBtn.addEventListener("click", () => {
    document.getElementById("logsTerminal").innerHTML = "";
    showToast("Log view cleared (Files on disk remain untouched).", "info");
  });

  openFolderBtn.addEventListener("click", async () => {
    await window.wareraApi.openLogFolder();
  });
}

async function refreshLogs() {
  const category = document.getElementById("logsCategorySelect").value;
  const levelFilter = document.getElementById("logsLevelSelect").value;
  const searchQuery = document.getElementById("logsSearchInput").value;

  const result = await window.wareraApi.readLogs(category, {
    levelFilter,
    searchQuery,
    limit: 250,
  });

  const terminal = document.getElementById("logsTerminal");
  if (result.lines.length === 0) {
    terminal.innerHTML = `<div class="log-line text-muted">No log entries found for this category and filter.</div>`;
    return;
  }

  terminal.innerHTML = result.lines.map((l) => `<div class="log-line">${escapeHtml(l)}</div>`).join("");
  terminal.scrollTop = terminal.scrollHeight;
}

/* ==========================================================================
   10. SETTINGS PAGE
   ========================================================================== */

function bindSettingsPage() {
  document.getElementById("settingsSaveBtn").addEventListener("click", async () => {
    const newSettings = {
      defaultBuyerStrategy: document.getElementById("settingsDefaultBuyerStrat").value,
      battleHpFloor: parseInt(document.getElementById("settingsBattleHpFloor").value, 10) || 10,
      defaultResellerMaxListings: parseInt(document.getElementById("settingsResellerMaxListings").value, 10) || 1,
      cdpUrl: document.getElementById("settingsCdpUrl").value,
      runInBackground: document.getElementById("settingsRunInBackground").checked,
    };

    await window.wareraApi.saveSettings(newSettings);
    state.settings = { ...state.settings, ...newSettings };
    showToast("Settings saved successfully.", "success");
  });

  document.getElementById("settingsUpdateTokenBtn").addEventListener("click", async () => {
    const token = document.getElementById("settingsDirectTokenInput").value;
    if (!token) return;

    try {
      const res = await window.wareraApi.updateToken(token);
      showToast(`Token updated! Expires in ${res.expiresInMinutes}m`, "success");
      document.getElementById("settingsDirectTokenInput").value = "";
      await refreshSettingsView();
    } catch (err) {
      showToast(`Invalid token: ${err.message}`, "error");
    }
  });

  document.getElementById("settingsLaunchBrowserBtn").addEventListener("click", async () => {
    showToast("Launching browser for authentication...", "info");
    const res = await window.wareraApi.launchBrowserLogin();
    if (res.success) {
      showToast("Authentication session updated!", "success");
      await refreshSettingsView();
    } else {
      showToast(`Login failed: ${res.error}`, "error");
    }
  });

  document.getElementById("settingsImportRepoBtn").addEventListener("click", async () => {
    try {
      const imported = await window.wareraApi.importRepoData({ overwriteTelemetry: false });
      showToast("Imported data from repository safely.", "success");
      document.getElementById("settingsMigrationStatus").textContent = `Import complete: Cookies=${imported.cookies}, Telemetry=${imported.telemetry}, Config=${imported.gameConfig}`;
    } catch (err) {
      showToast(`Import error: ${err.message}`, "error");
    }
  });
}

async function refreshSettingsView() {
  const auth = await window.wareraApi.getAuthStatus();
  document.getElementById("settingsMaskedToken").textContent = auth.maskedToken;
  document.getElementById("settingsExpiryText").textContent = auth.expiresAt ? `${new Date(auth.expiresAt).toLocaleString()} (${auth.expiresInMinutes}m remaining)` : "Expired / Missing";
  document.getElementById("settingsCookiesPath").textContent = auth.cookiesPath;

  const s = state.settings;
  if (s.defaultBuyerStrategy) document.getElementById("settingsDefaultBuyerStrat").value = s.defaultBuyerStrategy;
  if (s.battleHpFloor) document.getElementById("settingsBattleHpFloor").value = s.battleHpFloor;
  if (s.defaultResellerMaxListings) document.getElementById("settingsResellerMaxListings").value = s.defaultResellerMaxListings;
  if (s.cdpUrl) document.getElementById("settingsCdpUrl").value = s.cdpUrl;
  if (s.runInBackground !== undefined) document.getElementById("settingsRunInBackground").checked = s.runInBackground;
}

/* ==========================================================================
   UI UTILITIES (Confirmation Modal & Toasts)
   ========================================================================== */

function showConfirmModal(title, message, summaryHtml = "") {
  return new Promise((resolve) => {
    elements.confirmTitle.textContent = title;
    elements.confirmMessage.textContent = message;
    elements.confirmSummary.innerHTML = summaryHtml;
    elements.confirmSummary.style.display = summaryHtml ? "flex" : "none";
    elements.confirmModal.style.display = "flex";

    const onProceed = () => {
      cleanup();
      resolve(true);
    };

    const onCancel = () => {
      cleanup();
      resolve(false);
    };

    const cleanup = () => {
      elements.confirmModal.style.display = "none";
      elements.confirmProceedBtn.removeEventListener("click", onProceed);
      elements.confirmCancelBtn.removeEventListener("click", onCancel);
      elements.confirmCloseBtn.removeEventListener("click", onCancel);
    };

    elements.confirmProceedBtn.addEventListener("click", onProceed);
    elements.confirmCancelBtn.addEventListener("click", onCancel);
    elements.confirmCloseBtn.addEventListener("click", onCancel);
  });
}

function showToast(text, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type}`;
  toast.textContent = text;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.remove();
  }, 4000);
}

function escapeHtml(str) {
  if (!str) return "";
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
