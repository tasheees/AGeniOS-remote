# AGENIOS_INDEX.md
> AGenIOS — Task Registry & Source of Truth
> Last Sync Signature: 2026-05-26 · Extracted from GeniOS §13.3 · Console a7a666a2

---

## Project Status

**Extracted:** 2026-05-26 from GeniOS §13.3 (Telegram Remote Control)
**Home chat:** Establishing AGenIOS Remote Bridge (`23aba18b`)
**PM2 process:** `ag-bridge` → currently running from GeniOS; migrate to AGenIOS root

---

## Implementation Status Summary

| Status | Count |
|:-------|:------|
| ✅ BUILT | 8 |
| 🔧 PARTIAL | 2 |
| ❌ MISSING | 4 |
| **TOTAL** | **14** |

---

## Task Registry

### ✅ BUILT — Core Bridge

| ID | Task | Status | Notes |
|:---|:-----|:-------|:------|
| B1 | CDP connection to AG (port 9222) | ✅ BUILT | Auto-reconnects on disconnect |
| B2 | Chat DOM scrape + broadcast every 2s | ✅ BUILT | strips class/style, preserves aria-* |
| B3 | HTTP server (port 9100) + cookie auth | ✅ BUILT | `REMOTE_PASSWORD` env var |
| B4 | WebSocket real-time state broadcast | ✅ BUILT | `state`, `status`, `ag_state` events |
| B5 | Button click relay | ✅ BUILT | `type: 'click'` → matchText find |
| B6 | Collapsible toggle relay | ✅ BUILT | aria-expanded selector (2026-05-26) |
| B7 | Telegram startup notification + ngrok URL | ✅ BUILT | One-way notify on bridge start |
| B8 | Delete button relay | ✅ BUILT | aria-label + dispatchEvent |

### 🔧 PARTIAL — In Progress

| ID | Task | Status | Notes |
|:---|:-----|:-------|:------|
| P1 | Approval dialog detection | 🔧 PARTIAL | role=dialog not found in AG DOM; need live DOM probe |
| P2 | Code syntax highlighting in PWA | 🔧 PARTIAL | Prism not re-applying after class strip |

### ❌ MISSING — Not Started

| ID | Task | Status | Notes |
|:---|:-----|:-------|:------|
| M1 | Migrate PM2 to AGenIOS root | ❌ MISSING | Still pointing at GeniOS scripts/ |
| M2 | GeniOS cleanup (remove scripts/ag-bridge.js + remote-ui/) | ❌ MISSING | After M1 confirmed stable |
| M3 | Rebrand PWA: GeniOS Remote → AGenIOS Remote | ❌ MISSING | index.html title + headers |
| M4 | Approval option selection relay (perm-modal → numbered option → Submit) | ❌ MISSING | Blocked by P1 |

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
- The AG approval dialog may NOT use any ARIA role

**Next step:**
Live DOM probe: monitor `document.querySelectorAll('button')` every 300ms via CDP.
Capture exact button text when new buttons appear during approval.
CDP page ID: `62FFF415E659B47793214664A5CA9DFC` (may change on AG restart).

---

## Migration Checklist

- [x] Copy ag-bridge.js → AGenIOS root
- [x] Copy remote-ui/index.html → AGenIOS/remote-ui/
- [x] Create AGENTS.md
- [x] Create GEMINI.md
- [x] Create AGENIOS_INDEX.md (this file)
- [ ] Create package.json
- [ ] Create ecosystem.config.js
- [ ] Create .env.example
- [ ] Create README.md
- [ ] Git init + first commit
- [ ] Rebrand PWA
- [ ] Switch PM2 to AGenIOS root
- [ ] GeniOS cleanup

---

*Last updated: 2026-05-26 by Sovereign Console a7a666a2*
