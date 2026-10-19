# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.0.x   | :white_check_mark: |

---

## Authentication & Token Safety

WarEra Tools interacts with War Era game endpoints on behalf of the user. Security and privacy of user sessions are top priorities:

1. **Isolated Browser Profiles:**
   - Automation and login flows NEVER touch your personal browser profiles, system keychains, or DPAPI credentials.
   - Browser automation uses a dedicated, isolated profile stored in `~/.warera/browser_profile`.

2. **Session Storage:**
   - Active session cookies are stored locally in `cookies.json`.
   - `cookies.json` and `.env` are strictly excluded from source control via `.gitignore`.
   - **Never commit `cookies.json` or `.env` to a repository.**

3. **Masking & Sanitization:**
   - The application masks tokens and authorization secrets in logs, terminal output, and GUI dashboards (`eyJhbGci••••••••3456`).
   - Detailed payload claims containing private player hashes are never printed in public telemetry or debug streams.

4. **Credential Revocation:**
   - If you ever suspect your session token has been exposed, log out of your War Era account from the official web client (`https://app.warera.io`) to immediately invalidate your active JWT session.

---

## Reporting a Vulnerability

If you discover a security issue or credential exposure risk:

- **Do NOT** open a public GitHub issue.
- Please report vulnerabilities directly via GitHub Private Vulnerability Reporting or contact the maintainers confidentially.
- Include detailed reproduction steps, network traces (redacted of personal JWTs/cookies), and expected vs. actual behavior.
- Valid reports will be acknowledged and patched promptly.
