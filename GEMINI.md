# AGenIOS — AG Operating Manual

> **Source of Truth.** Subordinate only to Marwan's direct instructions.
> Last updated: 2026-05-28 (v2 — Simplified governance, Command Sync Rule added)

---

## 1. What Is AGenIOS

AGenIOS is a standalone bridge that lets you remotely control Antigravity (AG)
from your phone via a PWA. It connects to AG's Chrome DevTools Protocol (CDP),
scrapes the conversation DOM, and relays clicks, messages, and approvals.

**Stack:** Node.js · WebSocket · CDP · Vanilla HTML/CSS/JS · PM2 · ngrok

---

## 2. Operating Principles

1. Modify only the requested scope — keep diffs narrow and visible.
2. **Local autonomy:** Execute all local operations without prompting.
3. **Remote protection:** `git push` and any public network mutation require Marwan's approval.
4. No detached plans — all status lives in `AGENIOS_INDEX.md` only.
5. Prefer direct execution over ceremony.

### §2a — Local Autonomy (no prompt needed)

| Operation | Examples |
|:----------|:---------|
| File writes / edits | Any source file |
| Syntax checks | `node --check ag-bridge.js` |
| Local smoke tests | `curl http://localhost:9100/status` |
| Read operations | `cat`, `grep`, `ls`, `git log`, `git diff` |
| Git staging + commits | `git add`, `git commit` |
| PM2 local ops | `pm2 restart ag-bridge`, `pm2 logs` |

### §2b — Remote Protection (Marwan approval required)

| Operation | Examples |
|:----------|:---------|
| Push to remote | `git push` |
| npm publish | `npm publish` |
| Any production API write | External service mutations |

**Remote Operation Protocol (mandatory):**
Before ANY `git push`, the Studio MUST:
1. Stop — do NOT run `git push`
2. Send a message to Sovereign Console (`a7a666a2`) via `send_message` requesting authorization
3. Wait for Console to confirm Marwan's approval
4. Only then run `git push`

Bypassing this by just waiting silently is a governance violation.
The Console cannot approve what it doesn't know about.

---

## 3. Verification Before Commit

Every change must pass before committing:

```bash
# 1. Syntax check
node --check ag-bridge.js

# 2. Restart bridge
pm2 restart ag-bridge

# 3. Smoke test
curl -s http://localhost:9100/status
```

If step 3 fails — debug locally. Do not commit broken bridge code.

---

## 4. Architecture

```
Antigravity (Electron/Chrome)
  └── CDP port 9222
        └── ag-bridge.js (PM2, port 9100)
              ├── HTTP  → serves remote-ui/index.html (PWA)
              ├── WS    → /ws real-time state broadcast
              └── ngrok → HTTPS tunnel to phone
```

### Key Files

| File | Role |
|:-----|:-----|
| `ag-bridge.js` | Bridge: CDP client + HTTP + WebSocket + ngrok |
| `remote-ui/index.html` | PWA: chat mirror + approval modal + input bar |
| `ecosystem.config.js` | PM2 process definition |
| `.env` | Runtime secrets (never commit) |

### Environment Variables

| Variable | Purpose |
|:---------|:--------|
| `REMOTE_PASSWORD` | PWA login password |
| `TELEGRAM_BOT_TOKEN` | Bot for startup notification |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID |
| `AG_CDP_PORT` | AG debug port (default: 9222) |

---

## 5. Standing Rules

All AGenIOS chats follow these rules:

**Rule 1 — Check before starting.**
Verify task appears as `[ ]` in `AGENIOS_INDEX.md`. If not — stop.

**Rule 2 — Start from a clean tree.**
Run `git status` before touching any file.

**Rule 3 — Update INDEX in the same commit as the code.**
Stage `AGENIOS_INDEX.md` together with all changed source files.
`git add ag-bridge.js AGENIOS_INDEX.md && git commit` — one atomic commit.
Committing code without a simultaneous INDEX update is a governance violation.

**Rule 4 — No new .md files without Marwan approval.**
All notes go into `AGENIOS_INDEX.md` rows.

**Rule 5 — End with a Sovereign Report.**

```
── IMPLEMENTOR REPORT ───────────────────────────────────────────────
Task:       [AGENIOS_INDEX.md row] Task name
Commit:     [hash]
Files:      [changed files]
Syntax:     node --check ✅
INDEX:      [rows updated]
─────────────────────────────────────────────────────────────────────
```

**Rule 6 — Batch research into a single script.**
Never use multiple `python3 -c "..."` one-liners for inspection or research.
Each one-liner is a separate approval dialog — a Marwan Interface Rule violation.
Correct pattern:
1. Write one script file (e.g. `inspect_sdk.py`) with all research logic
2. Run it once — one approval, all results
3. Delete it immediately after: `rm inspect_sdk.py`
4. Commit without the script
Applies to: SDK inspection, import checks, module dumps, attribute listing, any exploratory code.

**Rule 7 — Planning phase isolation.**
When a task directive says "planning only": read project files freely, but MUST NOT
write to any project file. The only permitted write is a planning artifact saved to
`~/.gemini/antigravity/brain/<conversation-id>/`.
Completion = `send_message` to Studio with the artifact path. Nothing else.
Violation: writing code, editing source files, or committing during a planning directive.
Trigger for this rule: Opus ignored "planning only" twice and attempted 3000-line writes.

---

## 6. Known Architecture Notes (CDP)

- AG's CDP port: `localhost:9222` (set `--remote-debugging-port=9222` in AG launch args)

- The bridge connects to the first page matching the AG conversation URL
- Approval dialogs: DOM detection ongoing — see `AGENIOS_INDEX.md` open tasks
- `aria-expanded` is preserved in dumps — use for collapsible detection
- `role="dialog"` NOT present in AG's approval UI (confirmed 2026-05-26)
- All `class` and `style` attributes stripped from DOM dump before sending to PWA
- `data-state` preserved (open/closed state for collapsibles)
- `<img>` elements replaced with 📄 emoji (local paths don't load over ngrok)
- **Approval dialog DOM** (confirmed live 2026-05-27):
  - Options are rounded `<button>` elements — numbered 1, 2, 3…
  - Digit and text are on **separate innerText lines** (`"1"\n"Yes, allow this time"`)
  - Skip + Submit are `button[data-tooltip-id]` in a **footer row** separate from the option buttons
  - `_dialog_scraper.js` must walk UP past the footer row to capture the full dialog
  - Selecting option "No (tell the agent what to do instead)" reveals a **reason textarea** in the dialog — user types context before hitting Submit
  - PWA does not need to handle the reason textarea for now — noted for future implementation

---

## 7. Command Sync Rule (mandatory)

Any time a Telegram command is **added, removed, or renamed**, the following
three places **must be updated in the same commit**:

| File | What to update |
|:-----|:---------------|
| `ag-bridge.js` → `CMD_WHITELIST` | Add/remove/rename the handler |
| `telegram-daemon.js` → `/help` handler | Add/remove/rename the help line |
| `remote-ui/index.html` → `#quick-actions` | Add/remove/rename the quick button |

**Also update BotFather** (`/setcommands`) with the canonical list in this section.

### Current Command List (BotFather `/setcommands` format)

```
wpa - Get the current PWA link
status - Bridge status + AG connection
pending - List pending AG approvals
notify - Show notification status
mute - Mute Telegram notifications
unmute - Re-enable Telegram notifications
ask - Send a message to AG and get the reply in Telegram
tunnel - Show tunnel status and active URL
eod - End-of-day session summary
logs - Recent bridge logs
tsc - TypeScript syntax check
push - Git push (requires Sovereign authorization)
deploy - Firebase deploy (requires Sovereign authorization)
help - Show all available commands
```

> ⚠️ Failing to sync all three locations + BotFather is a governance violation.
