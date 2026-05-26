# AGenIOS — AG Operating Manual

> **Source of Truth.** Subordinate only to Marwan's direct instructions.
> Last updated: 2026-05-26 (v1 — Extracted from GeniOS §13.3)

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

## 5. Implementor Standing Rules

All AG Implementor chats follow these rules:

**Rule 1 — Check before starting.**
Verify task appears as `[ ]` in `AGENIOS_INDEX.md`. If not — stop.

**Rule 2 — Start from a clean tree.**
Run `git status` before touching any file.

**Rule 3 — Update INDEX before committing.**
Update task row + Last Sync Signature in `AGENIOS_INDEX.md`.

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
