# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-10-19

### Added

- **Automated Daily Routine (`daily_automator.mjs`)**
  - Modular Playwright task runner covering resource inspection, company production, training, energy and entrepreneurship work.
  - Safe health recovery workflows consuming Bread when available with health threshold floors.
  - Military Unit coordination (assisting unit members and requesting help).
  - Windows Task Scheduler integration for automated, resilient 10-minute background execution.
  - Strict anti-civil-war and domestic unrest safety barriers.

- **Battle Mode & Strategic Automation (`battles.mjs`)**
  - Ordered battle participation aligned with Country and Military Unit battle priorities.
  - Health threshold floors and pre-hit combat state revalidation to prevent wasted resources.
  - Fail-closed logic when battle orders conflict or when battles conclude mid-execution.
  - Combat debuff detection and automatic pacing adjustments.

- **Smart Equipment Buyer (`equipment_buyer.mjs`)**
  - 3-strategy Pareto evaluation framework: Best Value, Best Performance, and Cheapest Upgrade.
  - Stat-to-gold valuation metrics across roll ranges.
  - Preflight listing re-verification to protect against price slippage and phantom purchases.
  - Safe dry-run defaults with explicit interactive `--execute` requirement.
  - Strictly non-intrusive: never modifies or auto-equips active loadouts.

- **Stat-Aware Equipment Reseller (`equipment_reseller.mjs`)**
  - Automated inventory scanning with comparable market price curve fitting.
  - Intelligent item retention protecting max-roll attributes, top percentiles, and high critical-damage gear.
  - Structured audit reports with conservative, competitive, and aggressive pricing presets.
  - Safe dry-run mode by default with explicit listing confirmation gates.

- **Build & Damage Analyzer (`analyze.mjs`, `analyzer/`)**
  - Full theoretical combat model calculating damage output, hit efficiency, and combat survivability.
  - Skill point investment ROI analyzer for optimal respec allocations.
  - Level-by-level build simulation and gear comparison utilities.

- **Battle Availability Telemetry Recorder (`battle_telemetry.mjs`)**
  - Autonomous background daemon logging qualifying battle intervals and order consensus.
  - Cross-host atomic process locking with stale-PID recovery.
  - Schema v2 telemetry formats capturing full active battle matrices, damage bonuses, and bounty rates.
  - Windows Task Scheduler XML generator with automatic logon and boot recovery triggers.

- **Desktop Electron GUI (`gui/`)**
  - Standalone desktop dashboard with real-time resource monitors and quick actions.
  - Integrated views for daily automation, equipment buyer, reseller, build analyzer, and telemetry heatmaps.
  - Secure credential and session management with secret masking.
  - One-click Windows Task Scheduler installation and daemon process management.
  - Support for standalone portable Windows executables (`WarEraTools.exe`).

- **Isolated Authentication (`login.mjs`)**
  - Sandboxed browser login workflow storing session data in dedicated cookie storage.
  - Complete isolation from personal system browser profiles and system keychains.
  - Session validation and headless token import capabilities.

- **Deterministic Offline Test Suite**
  - Comprehensive test suites covering all major subsystems with 100% offline network isolation.
  - Synthetic test fixtures exercising both Schema v1 and Schema v2 telemetry models without external dependencies.
