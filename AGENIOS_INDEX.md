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
| ✅ BUILT | 12 |
| 🔧 PARTIAL | 2 |
| ❌ MISSING | 2 |
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
| P1 | Approval dialog detection | 🔧 PARTIAL | role=dialog absent in AG DOM; need live button delta probe |
| P2 | Code syntax highlighting in PWA | 🔧 PARTIAL | Prism not re-applying after class strip |

### ❌ MISSING — Not Started

| ID | Task | Status | Notes |
|:---|:-----|:-------|:------|
| M4 | Approval option selection relay | ❌ MISSING | Blocked by P1 |
| M5 | cloud-api migration to AGenIOS hosting | ❌ MISSING | Blocked by domain decision; cloud-api/ has reference copies |

---

## Open Investigation: Approval Dialog Detection (P1)

**Problem:** `scrapePendingActions` always returns `[]` even when dialog is visible.

**What has been tried:**
- Text regex on innerText — failed (container too large, > 2000 chars)
- Submit+Skip exact button text match — failed (`/^submit$/i` misses `Submit ↵`)
- Submit+Skip loose match — still returned `[]`
- `role="dialog"` / `role="alertdialog"` — NOT present in AG's DOM

**Confirmed DOM facts (2026-05-26):**
- Roles present: `navigation, button, article, combobox, region, listbox` — NO `dialog`
- No Shadow DOM, no iframe — full CDP access
- macOS system notification appears alongside inline HTML dialog
- The AG approval dialog uses NO ARIA role

**Next step:**
Live CDP button delta probe — connect directly to CDP WS, poll
`document.querySelectorAll('button')` every 200ms, capture new buttons
when approval dialog appears. Get fresh page ID first:
```bash
node -e "require('http').get('http://localhost:9222/json', r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(JSON.parse(d).map(p=>p.id+' '+p.title?.slice(0,40))))})"
```

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

*Last updated: 2026-05-26T22:00+03:00 by Sovereign Console a7a666a2*
