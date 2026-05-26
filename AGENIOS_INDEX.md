# AGENIOS_INDEX.md
> AGenIOS — Task Registry & Source of Truth
> Last Sync: 2026-05-26T22:00+03:00 · Full extraction complete · Console a7a666a2

---

## Project Status

**Extracted:** 2026-05-26 from GeniOS §13.3
**GitHub:** https://github.com/tasheees/AGeniOS-remote (last commit: cfe7dd0)
**Home chat:** AGenIOS Studio (`23aba18b`)
**PM2:** Both `ag-bridge` + `telegram-daemon` running from `~/projects/AGenIOS/` ✅

---

## Implementation Status Summary

| Status | Count |
|:-------|:------|
| ✅ BUILT | 13 |
| 🔧 PARTIAL | 2 |
| ❌ MISSING | 1 |
| **TOTAL** | **16** |

---

## Task Registry

### ✅ BUILT — Core Bridge

| ID | Task | Status | Notes |
|:---|:-----|:-------|:------|
| B1 | CDP connection to AG (port 9222) | ✅ BUILT | Auto-reconnects on disconnect |
| B2 | Chat DOM scrape + broadcast every 2s | ✅ BUILT | strips class/style, preserves aria-* + data-state |
| B3 | HTTP server (port 9100) + cookie auth | ✅ BUILT | `REMOTE_PASSWORD` env var |
| B4 | WebSocket real-time state broadcast | ✅ BUILT | `state`, `status`, `ag_state` events |
| B5 | Button click relay | ✅ BUILT | `type: 'click'` → matchText find |
| B6 | Collapsible toggle relay | ✅ BUILT | aria-expanded selector (2026-05-26) |
| B7 | Telegram startup notification + tunnel URL | ✅ BUILT | One-way notify on bridge start |
| B8 | Delete button relay | ✅ BUILT | aria-label + dispatchEvent |

### ✅ BUILT — Project Setup (Completed 2026-05-26)

| ID | Task | Status | Notes |
|:---|:-----|:-------|:------|
| M1 | Migrate PM2 to AGenIOS root | ✅ BUILT | Both ag-bridge + telegram-daemon running from AGenIOS |
| M2 | GeniOS cleanup | ✅ BUILT | scripts/ag-bridge.js + remote-ui/ + telegram-daemon.js + stale logs deleted |
| M3 | Rebrand PWA: GeniOS Remote → AGenIOS Remote | ✅ BUILT | title, meta, manifest short_name |
| M4_setup | Git init + GitHub repo | ✅ BUILT | github.com/tasheees/AGeniOS-remote |

### 🔧 PARTIAL — In Progress

| ID | Task | Status | Notes |
|:---|:-----|:-------|:------|
| P1 | Approval dialog detection | ✅ BUILT | data-tooltip-id co-presence (Skip+Submit); commit 593c12c |
| P2 | Code syntax highlighting in PWA | 🔧 PARTIAL | Prism not re-applying after class strip |

### ❌ MISSING — Not Started

| ID | Task | Status | Notes |
|:---|:-----|:-------|:------|
| M4 | Approval option selection relay | 🔧 PARTIAL | permSubmit→submitSelector ✅; container walk fixed to extract all 4 options; pending live confirm |
| M5 | cloud-api migration to AGenIOS hosting | ❌ MISSING | Blocked by domain decision; cloud-api/ has reference copies |

---

## ✅ RESOLVED: Approval Dialog Detection (P1) — 2026-05-26

**Fix:** `data-tooltip-id` co-presence strategy. Commit: `593c12c`

**Root cause confirmed:** AG approval dialog has no `role`, no `aria-label`, no `data-testid`.
Only the Skip + Submit buttons carry `data-tooltip-id` — unique across all ~164 baseline buttons.

**Detection logic:**
```javascript
const tooltipBtns = document.querySelectorAll('button[data-tooltip-id]');
const skipBtn   = tooltipBtns.find(b => /^skip$/i.test(b.innerText.trim()));
const submitBtn = tooltipBtns.find(b => /^submit/i.test(b.innerText.trim()));
// Both present simultaneously → dialog is visible
```

**Why previous attempts failed:**
- `role="dialog"` — not present
- `/^submit$/i` — text is `"Submit\n↵"` (child span breaks exact match)
- `/submit/i` loose — still `[]` because `data-tooltip-id` buttons weren't in the query scope

**Next:** Live test of M4 — relay option selection + Submit click through PWA.

---

## cloud-api — GeniOS-Hosted Dependency

The 4 Next.js Telegram API routes + `src/lib/telegram/` remain deployed
on GeniOS at `app.collegeelysee.com`. They are logically AGenIOS but
require a public HTTPS domain to migrate.

Reference copies in: `~/projects/AGenIOS/cloud-api/`
See: `cloud-api/README.md` for migration plan.
Task: M5 above.

**Do NOT delete from GeniOS** until AGenIOS has its own domain.

---

## Migration Checklist

- [x] Copy ag-bridge.js → AGenIOS root
- [x] Copy remote-ui/index.html → AGenIOS/remote-ui/
- [x] Copy telegram-daemon.js → AGenIOS root
- [x] Create AGENTS.md
- [x] Create GEMINI.md
- [x] Create AGENIOS_INDEX.md
- [x] Create CONTEXT.md (full technical context + investigation history)
- [x] Create package.json + install deps (dotenv, ws, firebase-admin)
- [x] Create ecosystem.config.js (ag-bridge + telegram-daemon)
- [x] Create .env.example
- [x] Create README.md
- [x] Git init + first commit
- [x] GitHub repo: github.com/tasheees/AGeniOS-remote
- [x] Rebrand PWA → AGenIOS Remote
- [x] Switch PM2 to AGenIOS root (both processes)
- [x] GeniOS cleanup (scripts deleted, logs deleted, ecosystem emptied)
- [x] cloud-api/ reference archive created
- [x] GENIOS_INDEX.md §13 updated

---

*Last updated: 2026-05-26T22:38+03:00 by AGenIOS Studio 23aba18b — options container walk fixed*
