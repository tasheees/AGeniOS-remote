# AGenIOS — Operational Roles
> Last updated: 2026-05-28 (v2 — Simplified governance)

AGenIOS is a small, focused project: a bridge + PWA remote control for Antigravity.
Governance is intentionally lean. One active chat handles everything.

---

## Chat Model

**Two chats. Studio is always open. Implementor is area-specific.**

| Chat | Name | ID | Role |
|:-----|:-----|:---|:-----|
| **AG Studio** | `AGenIOS Studio — no restrictions` | `23aba18b` | Strategy + governance + light implementation. Full authority. No restrictions. |
| **AG Implementor** | `Impl — [Area]` | TBD per area | Executes all tasks within one area until context grows heavy, then retire. |

> **When to spin an Implementor:** only for large, multi-task areas that would pollute
> the Studio's context — e.g. S2 (full Python bridge rewrite, 10+ sub-tasks) or
> W1-W4 (full PWA refactor). Simple fixes and small tasks: Studio does them directly.

> **Implementor lifespan:** One chat covers all tasks within its area. Retire after
> 3–4 heavy sessions (context too large). Spin a fresh one with the same area name + v2.
> Example: `Impl — S2` → retire → `Impl — S2 v2` for remaining tasks.

> **Naming convention:** `Impl — [Area ID] · [Short readable description]`
> Examples: `Impl — S2 · Python SDK Bridge`, `Impl — W1-W4 · PWA Refactor`, `Impl — M4 · Approval Relay`.


---

## Studio Naming Duty

The Studio is responsible for:
1. **Reminding Marwan** when a new Implementor is needed (before work begins on a
   heavy area that shouldn't run in the Studio).
2. **Recommending the chat name** by reading open `[ ]` rows in `AGENIOS_INDEX.md`
   and matching the name to the area being executed.
3. **Finding the new chat's ID** after Marwan creates it:
   ```bash
   ls -lt ~/.gemini/antigravity/brain/ | head -5
   ```
4. **Sending the task directive** to the Implementor via `send_message(impl_id)`.
5. **Receiving the Sovereign Report** from the Implementor and relaying status to Marwan.

> The Studio never executes heavy implementation tasks itself — context preservation.
> If Marwan asks the Studio to implement something that belongs in an Implementor,
> the Studio must say so and name the chat before any work begins.

---

## Studio Pre-Task Routing Check (mandatory)

**Before starting ANY task**, the Studio must answer these 3 questions out loud:

```
1. Will this require reading >3 files?
2. Will this require >50 lines of code changes across multiple files?
3. Is this part of a registered area (S2, W1-W4) with 5+ sub-tasks remaining?
```

**If YES to any one → stop. Do not start. Say:**
> "This belongs in `Impl — [Area]`. Create that chat first."

**If NO to all three → proceed directly in the Studio.**

**Hard triggers (always Implementor, no assessment needed):**
- Any task tagged S2.x (Python bridge rewrite)
- Any task tagged W1.x–W4.x (PWA refactor)
- Any task requiring installing new dependencies + multi-file refactor

> This check is NOT optional. A Studio that skips it and dives into heavy work
> is burning context it cannot recover. By the time context is heavy, it is too
> late — the Studio cannot spawn its own successor.
> **The check costs 10 seconds. A bloated Studio costs a full chat restart.**

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
