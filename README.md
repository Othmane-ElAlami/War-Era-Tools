# WarEra Tools

A comprehensive, production-grade automation, market intelligence, build optimizer, and telemetry analytics suite for the [War Era](https://app.warera.io) browser game.

---

## Features

- **Automated Daily Routine:** Headless task execution via CDP/Playwright covering work, train, recover, eat, and national battle participation with strict HP floors and civil war / unrest guards.
- **Smart Equipment Buyer:** Evaluates live market gear and weapons across discrete roll position intervals using a 3-strategy Pareto framework:
  - **Best Value:** Maximizes stat gain per gold spent ($`\text{StatValue} / \text{BuyerPrice}`$).
  - **Best Performance:** Targets peak raw theoretical combat stats regardless of price.
  - **Cheapest Upgrade:** Finds the lowest acquisition cost upgrade for budget loadouts.
- **Stat-Aware Equipment Reseller:** Prices surplus inventory against live comparable market curves while automatically preserving max-stat rolls and high-crit gear (**KEEP** invariants).
- **Battle Availability Telemetry:** Autonomous daemon monitoring qualifying battles with cross-host atomic PID locking, bounded exponential backoff, and Schema v2 analytics.
- **Build & Damage Analyzer:** Theoretical combat model calculating expected damage, hit efficiency, skill investment ROI, and respec optimization.
- **Desktop Electron GUI:** Standalone GUI dashboard featuring real-time resource monitors, market analyzers, log viewers, secret masking, and Windows Task Scheduler controls.

---

## Safety & Invariants

WarEra Tools is engineered with strict financial and account safety invariants:

| Invariant | Implementation |
| :--- | :--- |
| **Dry-Run by Default** | All market purchase, listing, and combat modules default to **dry-run mode** unless explicitly confirmed with `--execute` or interactive confirmation. |
| **No Auto-Equip** | Purchased gear is never automatically equipped; your active equipment configuration is strictly preserved. |
| **Isolated Profile** | Browser automation operates within an isolated directory (`~/.warera/browser_profile`), never accessing your personal browser profile or system keychains. |
| **Preflight Revalidation** | Target listings are re-fetched immediately before transaction submission to prevent price slippage or phantom buys. |
| **Anti-Civil War Guard** | Combat automation strictly refuses hits in civil wars or domestic unrest battles. |
| **Offline Test Suite** | All unit and integration test suites run 100% offline with zero live requests to War Era servers. |

---

## Installation

### Prerequisites

- [Node.js](https://nodejs.org/) v18.0.0 or higher
- Microsoft Edge, Google Chrome, or Chromium-based browser (auto-detected)

### Clone & Install

```bash
git clone https://github.com/Othmane-ElAlami/War-Era-Tools.git
cd War-Era-Tools
npm install
```

### Configuration (Optional)

Copy the environment template to create a `.env` file:

```bash
cp .env.example .env
```

All parameters are optional. If omitted, safe default values are used and account identity is resolved dynamically from your active session.

---

## Authentication

WarEra Tools authenticates via session cookies managed in an isolated environment.

### Interactive Browser Login

Launch the interactive login flow:

```bash
npm run login
```

A clean, isolated browser instance will launch. Log in with your War Era credentials. Once authenticated, session cookies will be safely saved to `cookies.json` (which is excluded from Git).

### Check Session Status

```bash
npm run login:status
```

### Direct Token Import (Headless)

If running in a headless server environment, you can update your session directly using your JWT token:

```bash
npm run login -- --token "<your-jwt-token>"
```

---

## CLI Usage

### Daily Automator

Executes routine tasks (working, training, health recovery, and ordered battle hits):

```bash
# Run daily routine in dry-run mode
npm run daily

# Run live daily routine (headless)
npm run daily -- --headless

# Run in battle mode
npm run daily -- --mode=battles --dry-run
```

#### Windows Task Scheduler Integration

Install the automator as a resilient 10-minute Windows background scheduled task:

```bash
npm run daily:install
npm run daily:status
npm run daily:uninstall
```

---

### Equipment Buyer

Analyze the market to find optimal gear upgrades:

```bash
# Analyze Green (uncommon) gear using Best-Value strategy
node equipment_buyer.mjs --rarity=green

# Target a specific slot with Best-Performance strategy
node equipment_buyer.mjs --rarity=blue --include=weapon --strategy=best-performance

# Analyze with a strict budget cap
node equipment_buyer.mjs --rarity=purple --budget=100.0 --strategy=cheapest

# Live interactive purchase mode
node equipment_buyer.mjs --rarity=green --execute
```

---

### Equipment Reseller

Audit your inventory and price items against live market offers:

```bash
# Dry-run audit of inventory with competitive pricing
node equipment_reseller.mjs --pricing=competitive

# Scan inventory without analyzing market
node equipment_reseller.mjs --scan-only

# Execute live listings (requires interactive confirmation)
node equipment_reseller.mjs --execute
```

---

### Build & Damage Analyzer

Evaluate your character's combat profile and skill allocation:

```bash
# Analyze current character build
npm run analyze

# Benchmark a specific level
node analyze.mjs --level=50 --objective=damage
```

---

### Battle Telemetry Recorder

Record battle availability and consensus orders over time:

```bash
# Run telemetry daemon directly
npm run battle-telemetry

# Install as a background Windows scheduled task
npm run battle-telemetry:install
npm run battle-telemetry:status
```

---

## Desktop GUI

Launch the desktop Electron dashboard for graphical control:

```bash
npm run gui
```

Build a standalone, portable Windows executable:

```bash
npm run gui:portable
```

The resulting binary will be output to `dist/WarEraTools.exe`.

---

## Screenshots

<!-- UI and CLI preview screenshots will be placed here -->
_Screenshots and UI walkthroughs will be published with release packages._

---

## Project Structure

```
.
├── analyzer/              # Pareto buyer, reseller pricing, and theoretical combat model
├── assets/                # Application icons and visual assets
├── data/                  # Game balance configurations and local directory structures
├── gui/                   # Desktop Electron dashboard (main, preload, services, and renderer)
├── tests/                 # Synthetic fixtures and 100% offline verification test suites
├── analyze.mjs            # Build analysis and benchmark CLI entry point
├── battle_telemetry.mjs   # Telemetry recorder CLI and Windows task installer
├── battles.mjs            # Combat engine, order consensus, and hit execution logic
├── config.mjs             # Environment resolution and configuration management
├── daily_automator.mjs    # Daily task automator (work, train, heal, and battle)
├── equipment_buyer.mjs    # Pareto 3-strategy market equipment acquisition CLI
├── equipment_reseller.mjs # Inventory valuation and marketplace listing CLI
└── login.mjs              # Isolated browser session authentication utility
```

---

## Testing

Run the complete offline test suite (all external endpoints mocked):

```bash
npm test
```

Or run individual test modules:

```bash
npm run test:battles      # Battle selection, order consensus, HP safety
npm run test:buyer        # Pareto loadout optimization, slippage guards
npm run test:reseller     # Stat-aware pricing curves, KEEP rules
npm run test:telemetry    # Host lock recovery, Schema v2 invariants
npm run test:recorder     # Daemon reliability, backoff, outage recovery
npm run test:task         # Windows Task Scheduler XML & VBS runner
npm run test:gui          # GUI service isolation, auth masking, dashboard
```

---

## Contributing & Security

- **Security Inquiries:** Please review [SECURITY.md](SECURITY.md) before reporting vulnerabilities.
- **Terms of Service:** Please review [DISCLAIMER.md](DISCLAIMER.md) regarding automation risks and game rules.

---

## License

This project is licensed under the [MIT License](LICENSE).
