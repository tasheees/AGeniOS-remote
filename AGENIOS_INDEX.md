# AGENIOS_INDEX.md
> AGenIOS — Task Registry & Source of Truth
> Last Sync: 2026-05-29T08:15+03:00 · Studio 23aba18b

---

## Project Status

**Extracted:** 2026-05-27 from AGenIOS §13.4
**GitHub:** https://github.com/tasheees/AGeniOS-remote (last commit: 4e033ed)
**Home chat:** AGenIOS Studio (`23aba18b`)
**PM2:** Both `ag-bridge` + `telegram-daemon` running from `~/projects/AGenIOS/` ✅

---

## 🎨 Brand & Logo

> **Not a logo file.** The AGeniOS Remote wordmark is assembled in code — no `.svg`, `.png`, or design file exists.
> It can be exported to SVG/PNG/vector at any time from the recipe below.
>
> **Origin:** Directly adapted from the GeniOS logo (see `GENIOS_INDEX.md §Brand & Logo`).
> Same Lucide Zap icon, same Geist Bold font, same construction technique — recolored violet for AGeniOS Remote.

### Construction

| Element | Value |
|:--------|:------|
| Icon | Lucide `Zap` — outline stroke, no fill — **same path as GeniOS** |
| Icon size | `24×24px` |
| Font | **Geist Bold** (`font-weight: 700`) for "AGeniOS" |
| Font size | `18px` "AGeniOS" · `9px` regular "remote" |
| Color | Bolt + "AGeniOS" = `#7c3aed` (violet) · "remote" = `#6b7280` grey |
| Layout | `display:flex; align-items:center; gap:10px` — bolt centers with "AGeniOS" only |
| "remote" | `position:absolute; top:100%; margin-top:-3px; line-height:1` — out of flex flow so bolt doesn't shift down |
| Accent line | `::after` violet underline `28px` wide, `2px` below "remote" — marks approx AG letter-width |

### Exact SVG Path (Lucide Zap v0.563.0 — identical to GeniOS)

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"
     fill="none" stroke="#7c3aed" stroke-width="2"
     stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>
</svg>
```

### Full Reproducible HTML+CSS Lockup

```html
<div class="brand-lockup">
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
       stroke="#7c3aed" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>
  </svg>
  <div class="brand-lockup-text">
    <span class="brand-lockup-name">AGeniOS</span>
    <span class="brand-lockup-sub">remote</span>
  </div>
</div>
```

```css
.brand-lockup      { display:flex; align-items:center; gap:10px; }
.brand-lockup-text { position:relative; display:block; }
.brand-lockup-name { display:block; font-size:18px; font-weight:700; color:#fff; line-height:1.15; }
.brand-lockup-sub  { position:absolute; top:100%; left:0; margin-top:-3px;
                     font-size:9px; line-height:1; color:#6b7280; white-space:nowrap; }
.brand-lockup-sub::after { content:''; position:absolute; bottom:-2px; left:0;
                           width:28px; height:1px; background:rgba(124,58,237,0.5); }
```

### Source File

- **Live implementation:** [`remote-ui/index.html`](remote-ui/index.html) — search `.brand-lockup`

### How to Export as Real Logo File

Copy the SVG block above into a `.svg` file. Add "AGeniOS" in Geist Bold `18px #ffffff`
and "remote" in Geist Regular `9px #6b7280`, left-aligned below "AGeniOS".
Open in Figma, Illustrator, or Inkscape to export PNG/vector at any resolution.

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

### ✅ DONE TODAY — 2026-05-29

| Commit | What |
|:-------|:-----|
| `pending` | **Bug fix:** Synchronized PWA right drawer open/closed state directly with real AG auxiliary pane state to fix out-of-sync placeholder states. |
| `pending` | **W1-W4 Sidebar Interactions (Phases 1-5):** AG-style project grouping (folder icon right, chevron rotate), desktop hover actions (gear+new-conv on project rows; archive📦/pin📌/⋯ dropdown on chat rows), 6-chat limit + See all(N)/See less (bold, accent-violet hover), mobile long-press → frosted bottom sheets for conv+project, swipe-left → 3-button action strip (Pin/Archive/Delete) with 60%-auto-trigger. All implemented in remote-ui/index.html only. |

### ✅ DONE TODAY — 2026-05-28

| Commit | What |
|:-------|:-----|
| `2a86ede` | Telegram poll: exponential backoff on ECONNRESET (2s→30s max) — fixes bulk-delayed replies |
| `pending` | **Bug fix:** `↩️ Handled in AG` notification now respects mute/notify state — was bypassing suppression entirely. Force-sends only when action originated from Telegram. |
| `pending` | SDK Deep Research complete — `google-antigravity==0.1.0` fully mapped. `sdk_research.md` + `Antigravity SDK Deep Dive.pdf` added to repo. Architecture validated for S2. |
| `pending` | **S2.3-S2.8** — `ag-bridge.py` written (Starlette+uvicorn, SDK hooks, backward-compat WS schema). `ecosystem.config.js` updated with `ag-bridge-py` process. Syntax ✅ imports ✅. |
| `6134005` | **W1-W4 PWA Refactor:** full PWA refactor — drawer nav, violet palette, input redesign, gestures, picker |
| `pending` | **Bug fix:** Fixed ReferenceError in `ag-bridge.js` (undefined actions variable in /cmd response dismissal). |
| `pending` | **Bug fix:** Corrected CDP modifier bitmasks, implemented DOM click targeting with active element blurring, and added hotkey fallbacks to prevent panel toggle swallowing. |

---

## 🗺️ PWA Refactor Roadmap

> Design direction locked 2026-05-28. Mobile-first. AG 2.0 spirit × Codex/Linear/Warp polish.
> Design system: violet `#7c3aed`, near-black `#0d0d0f`, Geist font, frosted glass drawer.
>
> **✅ APPROVED BY MARWAN 2026-05-28** — Execution order: S2 first (engine), then W1-W4 (UI).
> Rationale: S2 replaces fragile CDP/DOM layer with native AG SDK hooks — stable foundation
> before UI rebuild. W1-W4 is frontend-only and decoupled; can run in parallel if needed.
> Both tracks may run concurrently via AG Implementor. No implementation begins without
> INDEX row status `[ ] NEXT` and a clean git tree.

### W1 — Structure + Navigation
| ID | Task | Status |
|:---|:-----|:-------|
| W1.1 | Remove tab bar → breadcrumb header (Project / Chat name) | [x] |
| W1.2 | Left drawer (65% partial, frosted glass, AG 2.0 structure) — edge swipe right | [x] |
| W1.3 | Right panel (Phase 1: Artifacts list + git status) — edge swipe left | [x] |
| W1.4 | Settings at bottom of left drawer (gear icon row, exact AG 2.0) | [x] |
| W1.5 | Zoom toggle — ON=pinch-zoom / OFF=2-finger swipe for chat navigation | [x] |
| W1.6 | Fix right/left panel toggle keyboard modifiers in bridge | [x] | DOM button click (`data-testid`) with active element blur & keyboard event fallback |

### W2 — Chat Panel Redesign
| ID | Task | Status |
|:---|:-----|:-------|
| W2.1 | Violet palette + Geist Mono code blocks with syntax highlighting | [x] |
| W2.2 | Approval modal as bottom sheet overlay (not separate panel) | [x] |
| W2.3 | Input bar: mic inside field left + send icon right + command pill row | [x] |
| W2.4 | Tap code block → full-screen expand modal, swipe down to dismiss | [x] |
| W2.5 | Status indicators in drawer rows: green dot / blue dot / spinner | [x] |

### W3 — Chats Drawer (requires CDP research first)
| ID | Task | Status |
|:---|:-----|:-------|
| W3.1 | CDP research: what AG DOM exposes for projects/conversation list | [x] |
| W3.2 | Bridge: /api/chats endpoint with project+conversation data | [ ] |
| W3.3 | Drawer populated dynamically from bridge (not hardcoded) | [x] |
| W3.4 | Swipe-left on conversation row → quick actions (archive, copy link) | [x] Enhanced: now Pin📌 + Archive📦 + Delete🗑 with 60% auto-trigger |
| W3.5 | Long-press breadcrumb → inline chat picker popup | [x] |
| W3.6 | AG-style project grouping: folder icon right, chevron rotation, collapse/expand | [x] DONE 2026-05-29 |
| W3.7 | Desktop hover actions: ⚙️+new on project row; archive/pin/⋯ on chat row | [x] DONE 2026-05-29 |
| W3.8 | 6-chat limit per project + See all(N) / See less (bold, accent-violet hover) | [x] DONE 2026-05-29 |
| W3.9 | Mobile long-press → frosted bottom sheet (conv: unread/rename/pin/archive/delete; project: settings/new/rename) | [x] DONE 2026-05-29 |
| W3.10 | Project row gear icon: settings/rename/new conversation context menu for project-level actions | [ ] FUTURE |

### W4 — Right Panel Expansion (research phase)
| ID | Task | Status |
|:---|:-----|:-------|
| W4.1 | CDP research: AG right panel DOM (Subagents, Artifacts, Background Tasks) | [x] |
| W4.2 | Implement full Overview/Artifacts replication if feasible | [ ] |

### W5 — Login Screen Redesign
> Design via Stitch MCP first (same Obsidian Deep system, same spirit as main PWA).
> Keep it simple — just beautiful. Single field + submit. No clutter.

| ID | Task | Status |
|:---|:-----|:-------|
| W5.1 | Stitch MCP: design login screen matching PWA aesthetic (violet, Geist, frosted card) | [ ] |
| W5.2 | Implement login screen in index.html — replace current basic overlay auth with redesigned form | [ ] |

### W6 — Onboarding & Gesture Hints
> First-run transparent overlay that teaches gesture navigation professionally.
> Show once, persist dismissal in localStorage. Non-blocking — tap anywhere to skip.
> Style: frosted glass cards with animated arrows, same dark/violet palette.

| ID | Task | Status |
|:---|:-----|:-------|
| W6.1 | Stitch MCP: design onboarding hint overlay (animated gesture arrows, frosted cards, skip button) | [ ] |
| W6.2 | Implement first-run onboarding: 3-step coach marks — left swipe hint, right swipe hint, tab pill hint | [ ] |
| W6.3 | Animated drawer-tab pulse (draws attention on first load, fades after first tap) | [ ] |
| W6.4 | Persistent localStorage flag — `ag_onboarded=true` — never show again after first dismiss | [ ] |

### W7 — Sovereign Remote Mode
> **Depends on:** S2 (Python SDK bridge reading conversations independently)

| ID | Task | Status |
|:---|:-----|:-------|
| W7.1 | Settings toggle: Mirror (PWA controls AG nav) vs Sovereign (PWA independent viewer) | [ ] FUTURE |
| W7.2 | Sovereign mode: PWA reads conversation content via SDK, doesn't navigate AG desktop | [ ] FUTURE (blocked by S2) |
| W7.3 | Mirror mode toast: "Switching to [chat name]…" confirmation UX | [ ] |

### W8 — Tool Action Card Rendering
> AG shows "Editing JS ag-bridge.js +0 -0" as styled cards. PWA shows raw text. Fix.

| ID | Task | Status |
|:---|:-----|:-------|
| W8.1 | CSS for tool action cards: language icon badge, file name, +N/-N diff counts, spinner | [ ] |
| W8.2 | Parse AG tool action DOM structure and render as styled cards in PWA | [ ] |

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

### S2 — Antigravity SDK Bridge Migration (ag-bridge.py)

> **Research complete 2026-05-28. SDK confirmed.** See `sdk_research.md` in repo root.
> `google-antigravity==0.1.0` installed. Architecture fully validated.

**Core findings:**
- SDK attaches to LIVE AG 2.0 session via `conversation_id` (same SQLite DB, same harness)
- `OnInteractionHook` = native `STATE_WAITING_FOR_USER` → replaces our DOM approval hack
- `PreToolCallDecideHook` = approve/deny tool calls before execution, with full typed args
- `PostTurnHook` + streaming → replaces 2s DOM polling for conversation content
- `MODEL_PLACEHOLDER_M35` = Claude Sonnet 4.6 (1M ctx), `M26` = Claude Opus 4.6
- Cloud `RemoteAgentConfig` coming → `Local` → `Remote` swap, zero code changes

| ID | Task | Status |
|:---|:-----|:-------|
| S2.1 | Research AG SDK existence and capabilities | [x] DONE |
| S2.2 | Install `google-antigravity` and inspect source | [x] DONE 2026-05-28 |
| S2.3 | Write `ag-bridge.py` (FastAPI + WebSocket, Python) | [x] DONE 2026-05-28 · Starlette+uvicorn+websockets |
| S2.4 | Implement `OnInteractionHook` → PWA approval relay | [x] DONE 2026-05-28 · asyncio.Future suspend/resume |
| S2.5 | Implement `PostTurnHook` + token streaming → PWA | [x] DONE 2026-05-28 · async for token in response |
| S2.6 | Implement `PreToolCallDecideHook` → policy gate | [x] DONE 2026-05-28 · auto-allow + broadcast |
| S2.7 | Emit same WS event schema as current `ag-bridge.js` | [x] DONE 2026-05-28 · backward-compat + new SDK events |
| S2.8 | Update `ecosystem.config.js` → run `ag-bridge.py` via PM2 | [x] DONE 2026-05-28 · ag-bridge-py added, ag-bridge kept for safety |
| S2.9 | Deprecate `ag-bridge.js` + `_dialog_scraper.js` | [x] DONE — ag-bridge.js restored as primary. ag-bridge.py specialized as sidecar. |
| S2.10 | Update Telegram daemon to consume new Python bridge events | [x] N/A — Telegram daemon stays on ag-bridge.js events. Sidecar architecture finalized. |
| S2.14 | Port conflict: ag-bridge.js owns :9100 — ag-bridge.py must run on :9101 (or configurable via env) | [ ] NEXT |
| S2.15a | CDP WebSocket frame interception — intercept `Network.webSocketFrameReceived` on port 9222 to get native `STATE_WAITING_FOR_USER`, token streams, tool call events without SDK | [ ] NEXT (after W1-W4) |
| S2.15b | `.pb` log file watcher — AG Desktop writes `.pb` payloads to `.system_generated/logs/`; tail + decode via SDK protobuf schemas for read-only token streaming | [ ] FUTURE |
| S2.15c | `agy` CLI investigation — DeepMind released `agy` CLI with Session Export (terminal→Desktop); assess for headless bridge use cases | [ ] FUTURE |
| S2.11 | Add `Triggers` support: scheduled check-ins via `every()` | [ ] FUTURE |
| S2.12 | Add `PreToolCallDecideHook` → Telegram approval for headless approvals | [ ] FUTURE |
| S2.13 | Swap `LocalAgentConfig` → `RemoteAgentConfig` when GA (zero code change) | [ ] FUTURE |

> **Architecture finalized 2026-05-28:** SDK cannot attach to AG Desktop sessions.
> Incompatibility is fundamental and intentional (Desktop=SQLite for relational UI,
> SDK=.pb for headless ML workflows). No CLI flag exists to change this. Confirmed by
> two independent deep research passes (Gemini + secondary AI). See `agenios_bridge_research.html`.
>
> **S2.15a is the prize:** CDP `Network.webSocketFrameReceived` on port 9222 intercepts
> the internal JSON-RPC between AG's Electron UI and its compiled harness binary.
> This gives native `STATE_WAITING_FOR_USER`, token streams, tool call events —
> everything the SDK hooks promised, via our existing CDP connection. Zero Python needed.
>
> **ag-bridge.py remains valid** as sidecar for headless/cloud sessions (S3 future).
> ag-bridge.js remains sole GUI/CDP bridge permanently.

**Finalized hybrid architecture:**
```
AG 2.0 Desktop (GUI) ──── CDP :9222 ──── ag-bridge.js (PRIMARY — permanent)
                            │                ├── PWA serve :9100 + WebSocket /ws
                            │                ├── Telegram daemon events
                            │                ├── Approval relay (DOM scraping)
                            │                └── ngrok/cloudflare tunnel
                            │
                            └── S2.15a (future): Network.webSocketFrameReceived
                                 → native approval events + token streaming

ag-bridge.py (SIDECAR — headless/cloud only)
  ├── OnInteractionHook  → future: headless agent approvals
  ├── PostTurnHook       → future: SDK agent response streaming
  ├── PreToolCallDecide  → future: policy gate
  └── Future: swap to RemoteAgentConfig (S3 cloud)

Research artifacts (in repo root):
  agenios_bridge_research.html   — CDP shadowing deep research
  agenios_sdk_knowledge_brief.html — SDK capability mapping
  sdk_research.md                — SDK install + source inspection
  Antigravity SDK Deep Dive.pdf  — original deep dive
```

### S3 — Distribution, Onboarding & Monetization
> **FUTURE — strategy decided 2026-05-28. No implementation yet.**
> SDK supports `LocalAgentConfig(api_key=USER_KEY)` → fully isolated headless agent.
> Multi-tenant: each user gets their own sandboxed SQLite + WebSocket loop.
> When `RemoteAgentConfig` lands → scale to cloud with zero code changes.
>
> **⚠️ PRIVATE — remove this section before any public open-source release.**

**Monetization strategy (decided 2026-05-28):**
- Model: value-based, no artificial limits. Product earns donations/subscriptions by being genuinely useful.
- Local version: free forever, open source (MIT or AGPL). Strongest privacy guarantee: local-first = data never leaves user's machine.
- Donation nudge: tasteful banner after 30min active use. "☕ Support AGenIOS — $1". Dismiss immediately. Reappears once/day. No blocking.
- AGenIOS Cloud (premium service): you run the bridge/tunnel infrastructure. Stable URL, zero setup, multi-device. Can't be bypassed — it's a service. Target $1-5/month or one-time donation.
- Premium add-ons: permanent tunnel URL (ngrok/Cloudflare partnership), push notifications, multi-device sync.
- Reference models: WinRAR honor system, Ko-fi/GitHub Sponsors, open-core (Linear, GitLab).
- Privacy pitch: "AGenIOS cannot steal your data — the bridge runs on your machine. Your code never leaves your computer."

**Distribution & Onboarding Spec (Decided 2026-05-28):**
- **Control Channel**: User-Owned Bot + Direct Long-Polling (Model B).
  - **Zero-Server Setup**: Local Mac bridge uses long-polling (`getUpdates`) directly to Telegram to receive commands and send alerts. No central server is needed.
  - **Friction Reduction**:
    - **Step-by-Step CLI/UI Wizard**: Guides the user with direct deep links to open `@BotFather` and name their bot.
    - **Automated Chat ID Detection**: The user just pastes the bot token. The bridge starts listening, instructs the user to tap "Start" in their bot, automatically extracts their `chat_id` from the incoming request, and saves it. The user never has to look up their ID.
- **Data Channel**: Local-first direct tunnels. User choice during setup:
  - **ngrok (Priority/Primary)**: Prompt user for their free ngrok authtoken during setup. Provides the most stable/prioritized link.
  - **Cloudflare (Secondary/Fallback)**: Quick Tunnel (`trycloudflare.com`) with zero signup/zero config if user has no ngrok token.
- **PWA Serving**: Local bridge serves PWA files over the tunnel. No central static hosting needed.
- **Future Expansion**: Scale to Shared Bot + Cloud Relay (Model A) as a premium cloud add-on later.

| ID | Task | Status |
|:---|:-----|:-------|
| S3.1 | Research standalone SDK mode (no AG 2.0) | [x] DONE 2026-05-28 |
| S3.2 | Design multi-tenant architecture | [ ] FUTURE |
| S3.3 | Implement user-specific `api_key` + isolated agent instances | [ ] FUTURE |
| S3.4 | Swap `LocalAgentConfig` → `RemoteAgentConfig` (cloud harness) | [ ] FUTURE |
| S3.5 | AGenIOS Cloud infrastructure (stable URL, managed tunnel, billing) | [ ] FUTURE |
| S3.6 | Donation nudge UI (tasteful banner, Ko-fi/GitHub Sponsors integration) | [ ] FUTURE |
| S3.7 | Native app (Capacitor.js) for push notifications + App Store | [ ] FUTURE |
| S3.8 | npx agenios zero-install package + interactive first-run wizard (guided Model B bot creation + auto chat_id lookup + ngrok/Cloudflare tunnel selection) | [ ] FUTURE |



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

## 🏛️ Proposed Governance Addition (pending Marwan approval)

> **Proposed by:** Studio 23aba18b · 2026-05-28
> **Trigger:** Impl — S2 used multiple `python3 -c` one-liners for SDK research,
> each generating a separate approval dialog — a Marwan Interface Rule violation.
> **Proposed fix:** Add Rule 6 to GEMINI.md §5 Standing Rules.

### Proposed GEMINI.md §5 Rule 6 — Research Scripts

> **Rule 6 — Batch research into a single script.**
> Never use multiple `python3 -c "..."` one-liners for inspection or research.
> Each one-liner triggers a separate approval dialog, violating the Marwan Interface Rule.
> **Correct pattern:**
> 1. Write one script file (e.g. `inspect_sdk.py`) with all research logic
> 2. Run it once — one approval, all results
> 3. Delete it immediately after (`rm inspect_sdk.py`)
> 4. Commit without the script
> This applies to: SDK inspection, import checks, module dumps, attribute listing, any exploratory code.

**Status:** `[x] DONE 2026-05-28 — Added to GEMINI.md §5 Rule 6`

---

### W-Input — Input Bar & Settings
| ID | Task | Status |
|:---|:-----|:-------|
| W-Input.1 | Bridge: scrapeInputBar() + seeAllCounts + 4 WS handlers | [x] DONE (620e2a0) |
| W-Input.2 | PWA: Tasks panel + Add Context menu + seeAllCounts render | [x] DONE (7ab866a + bridge fix) |
| W-Input.3 | PWA: Model drop-up selector | [x] DONE + bug fix (exact match + correct IDs) |
| W-Input.4 | PWA + Bridge: Settings dual-icon (PWA Settings + AG Settings) | [x] DONE (this commit) |
| W-Input.5 | PWA textarea: `/` → slash picker + `@` → mention picker (Rules + Media from filesystem — no CDP) | [x] DONE (6b5757c + f26db63 + f1babf3) |
| W-Input.5a | PWA `@` picker: fix section headers — Rules + Conversation separate (not single CONVERSATIONS header) | [x] DONE (f1babf3) |
| W-Input.5b | Left panel bidirectional sync: bg-sidebar selector fix + every-broadcast mirror + openDrawer/closeDrawer WS toggle | [x] DONE (0a617fd) |
| W-Input.5c | Left panel toggle regression fix: clear inline style.width on close (was blocking CSS width:0); getBoundingClientRect for sidebar detection; 3s toggle lock | [x] DONE (c54d244, 05f7ef0) |
| W-Input.5d | AG→PWA width sync: change-only (_lastAgLeftW/_lastAgRightW tracks) — no snap-back on PWA resize; right panel also fixed | [x] DONE (05f7ef0) |
| W-Input.5e | Right panel header alignment: tabs-first in DOM (actions container was pushing +20px); rp-tab height:28px matches center header (54px total) | [x] DONE (50af223, c787b39) |
| W-Input.6 | PWA `/` picker: add MCP tools section (read from ~/.gemini/antigravity/mcp/) above slash commands — AG shows 8+ total | [ ] NEXT |

### W6 — PWA Visual Refresh (2026-05-30)
| ID | Task | Status |
|:---|:-----|:-------|
| W6.0 | Drawer backgrounds unified (both rgba(10,8,18,0.92)) | [x] DONE |
| W6.1 | Design token refresh (bg, text, surface tokens; removed --user-bubble/--ai-bubble; added --surface-glass/--border-subtle) | [x] DONE |
| W6.2 | Chat message quality (AI card subtle tray, user bubble gradient, msg-text sizing, msg-meta opacity) | [x] DONE |
| W6.3 | Input bar refinement (glass wrap, focus ring, glass quick-btns, bottom-bar blur, placeholder color) | [x] DONE |
| W6.4 | Header refinement (glass background, backdrop-filter, lighter border, adjusted padding, bc-chip border) | [x] DONE |
| W6.5 | Code block header restructure (flex header above code, SVG icon-only copy btn, language class on code el) | [x] DONE |
| W6.6 | Micro-polish (animation-fill-mode, quick-btn:active scale, panel-toggle 0.12s, pre/inline-code glass, chat scrollbar) | [x] DONE |

*Last updated: 2026-05-30T10:40+03:00 by Impl — W6 · PWA Visual Refresh*


*Changes this session (2026-05-29):*
- *Commit 1 (in progress): ag-bridge.js — scrapeInputBar() with confirmed selectors (button[aria-label^="Select model"], button[aria-label="Add context"], data-testid="settings-button"); seeAllCounts via group/section ancestor walk; broadcastState() now emits tasks + currentModel + seeAllCounts; WS handlers: select_model, stop_task, open_context_menu, open_ag_settings.*

### W-Panel — Right Panel UI Fidelity

| ID | Task | Status | Notes |
|:---|:-----|:-------|:------|
| W-Panel.1 | Right panel tab bar redesign — AG-style pills, hover brighten, colored file-type badges (M↓/JS/TS/</>), □ close btn, no separate drawer-header | [x] DONE (this commit) |
| W-Panel.2 | Review sub-toolbar — "Review Changes" header + ⊞ Split / ⇕ Expand / 🔍 Search icons, live search highlight | [x] DONE (this commit) |
| W-Panel.3 | Review toolbar JS — `_rtbToggle` + `_rtbSearch` wired to toolbar buttons | [x] DONE (this commit) |

### W5 — Command Palette + Menu Bar (Power Actions)

| ID | Task | Status | Notes |
|:---|:-----|:-------|:------|
| W5.1 | Mobile: Command Palette — ⌘ button in header → bottom-sheet overlay, searchable, grouped actions | [x] | ⌘⚡ btn, slideUp sheet, live search, grouped rows |
| W5.2 | Desktop: Menu Bar — File · View · Window dropdowns in header (AG-style), keyboard shortcuts shown | [x] | @media ≥600px, glassmorphism dropdowns, outside-click close |
| W5.3 | CDP backend: ag-bridge.js WS handlers for reload, force-reload, zoom-in/out/actual, new-window, close-window, switch-window | [x] | Input.dispatchKeyEvent with correct VK codes + modifiers |
| W5.4 | About AGenIOS section — version, bridge status, GitHub link | [x] | Fetches /status → version field; shown at palette bottom + Window menu |
| W5.5 | Close Window: confirmation dialog before executing | [x] | Inline confirm row in palette + palette-on-confirm from desktop menu |
| W5.6 | Index + governance update on completion | [x] | This commit |

*Last updated: 2026-05-29T17:15+03:00 by AG Studio*
