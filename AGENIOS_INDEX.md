# AGENIOS_INDEX.md
> AGenIOS — Task Registry & Source of Truth
> Last Sync: 2026-05-28T10:00+03:00 · Studio 23aba18b

---

## Project Status

**Extracted:** 2026-05-27 from AGenIOS §13.4
**GitHub:** https://github.com/tasheees/AGeniOS-remote (last commit: 4e033ed)
**Home chat:** AGenIOS Studio (`23aba18b`)
**PM2:** Both `ag-bridge` + `telegram-daemon` running from `~/projects/AGenIOS/` ✅

---

## Implementation Status Summary

| Status | Count |
|:-------|:------|
| ✅ BUILT | 14 |
| 🔧 PARTIAL | 1 |
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
| P2 | Code syntax highlighting in PWA | ✅ DONE | language-* classes now preserved through bridge class strip; Prism 1.29 + autoloader; commit 3aea822 |
| ID | Task | Status | Notes |
|:---|:-----|:-------|:------|
| M4 | Approval option selection relay | 🔧 PARTIAL | permSubmit→submitSelector ✅; container walk fixed to extract all 4 options; pending live confirm |
| M5 | cloud-api migration to AGenIOS hosting | ❌ MISSING | Blocked by domain decision; cloud-api/ has reference copies |

### ✅ DONE TODAY — 2026-05-27

| Commit | What |
|:-------|:-----|
| `7984b3b` | `/restart` command — restarts daemon or bridge from Telegram |
| `734abf7` | `/ask` reply fixed — event-driven resolver, actually returns AG response |
| `f27b0f9` | Bridge crash fix — `setTunnel` moved to module level (was crashing 39×) |
| `abafb21` | `/wpa` fixed — no-tunnel vs bridge-down distinction; ngrok added to PM2 |
| `3aea822` | Syntax highlighting — `language-*` classes preserved through bridge class strip |
| `4e033ed` | Conversations tab — fully wired with tappable navigation to any AG conversation |

### ✅ DONE TODAY — 2026-05-28

| Commit | What |
|:-------|:-----|
| `2a86ede` | Telegram poll: exponential backoff on ECONNRESET (2s→30s max) — fixes bulk-delayed replies |

---

## 🗺️ PWA Refactor Roadmap

> Design direction locked 2026-05-28. Mobile-first. AG 2.0 spirit × Codex/Linear/Warp polish.
> Design system: violet `#7c3aed`, near-black `#0d0d0f`, Geist font, frosted glass drawer.

### W1 — Structure + Navigation
| ID | Task | Status |
|:---|:-----|:-------|
| W1.1 | Remove tab bar → breadcrumb header (Project / Chat name) | [ ] |
| W1.2 | Left drawer (65% partial, frosted glass, AG 2.0 structure) — edge swipe right | [ ] |
| W1.3 | Right panel (Phase 1: Artifacts list + git status) — edge swipe left | [ ] |
| W1.4 | Settings at bottom of left drawer (gear icon row, exact AG 2.0) | [ ] |
| W1.5 | Zoom toggle — ON=pinch-zoom / OFF=2-finger swipe for chat navigation | [ ] |

### W2 — Chat Panel Redesign
| ID | Task | Status |
|:---|:-----|:-------|
| W2.1 | Violet palette + Geist Mono code blocks with syntax highlighting | [ ] |
| W2.2 | Approval modal as bottom sheet overlay (not separate panel) | [ ] |
| W2.3 | Input bar: mic inside field left + send icon right + command pill row | [ ] |
| W2.4 | Tap code block → full-screen expand modal, swipe down to dismiss | [ ] |
| W2.5 | Status indicators in drawer rows: green dot / blue dot / spinner | [ ] |

### W3 — Chats Drawer (requires CDP research first)
| ID | Task | Status |
|:---|:-----|:-------|
| W3.1 | CDP research: what AG DOM exposes for projects/conversation list | [ ] RESEARCH |
| W3.2 | Bridge: /api/chats endpoint with project+conversation data | [ ] |
| W3.3 | Drawer populated dynamically from bridge (not hardcoded) | [ ] |
| W3.4 | Swipe-left on conversation row → quick actions (archive, copy link) | [ ] |
| W3.5 | Long-press breadcrumb → inline chat picker popup | [ ] |

### W4 — Right Panel Expansion (research phase)
| ID | Task | Status |
|:---|:-----|:-------|
| W4.1 | CDP research: AG right panel DOM (Subagents, Artifacts, Background Tasks) | [ ] RESEARCH |
| W4.2 | Implement full Overview/Artifacts replication if feasible | [ ] |

---

## 🔭 Strategic Roadmap (Long-term)

### S1 — Native Mobile App (iOS + Android)
| ID | Task | Status |
|:---|:-----|:-------|
| S1.1 | Research: Capacitor.js wrapper around existing PWA | [ ] FUTURE |
| S1.2 | Native push notifications — bypass web push iOS limits | [ ] FUTURE |
| S1.3 | App Store + Play Store submission | [ ] FUTURE |
| S1.4 | Native biometric auth (Face ID / fingerprint) | [ ] FUTURE |

> Rationale: Web Push on iOS requires 16.4+ and home screen install. A Capacitor wrapper
> unlocks true native push, background delivery, and App Store distribution.

### S2 — Antigravity SDK Integration (Major Refactor)
| ID | Task | Status |
|:---|:-----|:-------|
| S2.1 | Research: Does AG expose an official SDK, API, or plugin interface? | [ ] RESEARCH |
| S2.2 | Research: AG extension/plugin model — can we hook natively? | [ ] RESEARCH |
| S2.3 | If SDK exists: replace CDP scraping with native SDK calls | [ ] FUTURE |
| S2.4 | If no SDK: propose to AG team / contribute to AG core | [ ] FUTURE |

> Rationale: CDP bridge is a clever workaround. An official AG SDK would give us stable APIs
> (not DOM-dependent), native event streams for approvals/artifacts/status, and proper auth.
> Potential massive leap — research before any implementation.

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

## ✅ RESOLVED: Options Extraction Overshoot (2026-05-27)

**Fix:** Replace threshold walk with `ancestor.contains(submitBtn)` — first common
ancestor of Skip + Submit IS the dialog root. Applied to both `scrapePendingActions()`
and `scrapeChat()`. Commit: see morning session 2026-05-27.

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

*Last updated: 2026-05-27T10:10+03:00 by AGenIOS Studio 23aba18b — overshoot bug fixed*
