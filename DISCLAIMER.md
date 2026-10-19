# Disclaimer & Terms of Service Notice

## Unofficial Project

**WarEra Tools** is an independent, open-source project developed for educational and personal optimization purposes. It is **not** affiliated with, endorsed by, sponsored by, or associated in any way with War Era, its creators, or its affiliates.

All trademarks, game assets, and service names are the property of their respective owners.

---

## Game Rules & Terms of Service Warning

Using third-party automation tools, bots, scrapers, or market assistants may violate the **War Era Terms of Service (ToS)** or community rules. 

> [!WARNING]
> Use of this software carries an inherent risk of in-game penalties, including character resets or permanent account bans. The authors and maintainers of this repository assume **no responsibility or liability** for any disciplinary action, loss of virtual assets, or account suspension incurred as a result of using this software.

---

## Safety Safeguards & Safe Defaults

To protect users against unintended mutations or catastrophic financial loss:

1. **Dry-Run by Default:** All tools (`equipment_buyer.mjs`, `equipment_reseller.mjs`, `daily_automator.mjs --mode=battles`) default to **read-only / dry-run analysis**. No gold is spent, no market listings are created, and no combat hits are submitted unless explicitly confirmed with `--execute` or interactive prompts.
2. **Double Confirmation Guards:** Market purchases and item listings require explicit typed confirmation or deliberate UI checkbox opt-in.
3. **Preflight Revalidation:** Market offers are frozen and re-evaluated immediately prior to execution to guard against price slippage and offer disappearance.
4. **Offline Deterministic Testing:** The test suite does not connect to live game servers or interact with real user accounts.

Use this software responsibly and at your own discretion.
