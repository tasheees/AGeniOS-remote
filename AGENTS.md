# AGenIOS — Operational Roles
> Last updated: 2026-05-28 (v2 — Simplified governance)

AGenIOS is a small, focused project: a bridge + PWA remote control for Antigravity.
Governance is intentionally lean. One active chat handles everything.

---

## Chat Model

**Two chats. Studio is always open. Implementor is task-specific.**

| Chat | Name | ID | Role |
|:-----|:-----|:---|:-----|
| **AG Studio** | `AGenIOS Studio — no restrictions` | `23aba18b` | Strategy + governance + light implementation. Full authority. No restrictions. |
| **AG Implementor** | `Impl — [Task] · [Short description]` | TBD per task | Executes one registered task. Heavy isolated work only (e.g. full rewrites). |

> **When to spin an Implementor:** only when a task is large enough to pollute the
> Studio's context — estimated >10k tokens of file reads + deep reasoning.
> Example: S2 (full Python bridge rewrite) → `Impl — S2 · SDK Bridge Migration`.
> For everything else: Studio does it directly.

> **Naming convention:** `Impl — [ID] · [Short task description]` matching the exact
> AGENIOS_INDEX.md row the chat will execute.


---

## Session Start

Studio chats begin with:
```
── STUDIO SESSION START ──────────────────────────────────────────────
Role: AG Studio · no restrictions
First action: read AGENIOS_INDEX.md + git status
─────────────────────────────────────────────────────────────────────
```

Implementor chats begin with:
```
── IMPLEMENTOR SESSION START ─────────────────────────────────────────
Task: [exact AGENIOS_INDEX.md row ID + description]
First action: git status (must be clean)
─────────────────────────────────────────────────────────────────────
```

---

## Core Rules (applies to all chats)

1. **No detached plans.** All status and decisions go into `AGENIOS_INDEX.md` rows only.
2. **Atomic commits.** Code + INDEX update in the same `git commit`. Never separate.
3. **No new .md files without Marwan approval.** Notes go into INDEX rows.
4. **Push protocol.** Before `git push`: send_message to Console `a7a666a2`, wait for
   Marwan's confirmation. If Console is unreachable, report to Marwan directly.
5. **Verify before commit.** `node --check ag-bridge.js` + `curl localhost:9100/status`.

---

## Autonomy Boundary

| Local (autonomous) | Remote (Marwan approval required) |
|:-------------------|:----------------------------------|
| File writes / edits | `git push` |
| `git add` / `git commit` | `npm publish` |
| Syntax checks + smoke tests | Any production API mutation |
| `pm2 restart` (local) | |

---

## Key Files

| File | Purpose |
|:-----|:--------|
| `ag-bridge.js` | CDP bridge (PM2: `ag-bridge`, port 9100) |
| `telegram-daemon.js` | Telegram command executor (PM2: `telegram-daemon`) |
| `remote-ui/index.html` | Single-file PWA remote control |
| `cloud-api/` | Reference archive — Telegram routes still hosted on GeniOS |
| `ecosystem.config.js` | PM2 process definitions |
| `AGENIOS_INDEX.md` | **Source of truth — all tasks, status, decisions** |
| `GEMINI.md` | Technical operating manual |
