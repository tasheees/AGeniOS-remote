# AGenIOS — Operational Roles
> Last updated: 2026-05-26 (v1 — Extracted from GeniOS §13.3)

AGenIOS is a standalone open-source project: a CDP bridge + PWA remote control for
the Antigravity AI coding assistant. Governance is intentionally lighter than GeniOS.

---

## Roles

- **Marwan** is the sovereign reviewer. Sets direction, approves all remote operations.

- **AG Studio** (`23aba18b`) is the primary chat for AGenIOS. No role restrictions.
  Handles strategy, implementation, debugging, and governance simultaneously.
  This is the AGenIOS equivalent of the GeniOS Sovereign Console.

- **AG Implementor** is spun up for large, scoped tasks. Executes only tasks
  explicitly directed by Marwan or the AG Studio. Follows §9 of GEMINI.md.

> ⚠️ **No-Role-No-Writes Rule:** A chat with no declared role MUST NOT execute any
> file writes, git operations, or terminal commands. Its first message must be a
> session start card, or a request for one from Marwan.

---

## Session Start Cards

```
── STUDIO SESSION START ──────────────────────────────────────────────
Role: AG Studio (GEMINI.md §2)
Constraint: No restrictions. Strategy + implementation + governance.
First action: Read AGENIOS_INDEX.md open [ ] rows + git status.
Confirm with: "Studio mode active. Ready."
──────────────────────────────────────────────────────────────────────

── IMPLEMENTOR SESSION START ─────────────────────────────────────────
[CHAT NAME — e.g. Impl — Bridge · Approval modal detection]
Role: AG Implementor (GEMINI.md §9)
Constraint: Execute only tasks registered in AGENIOS_INDEX.md.
First action: git status. Confirm clean tree.
Confirm with: "Implementor mode active. Awaiting task."
──────────────────────────────────────────────────────────────────────
```

---

## Operating Principles

1. Modify only the requested scope — keep diffs narrow and visible.
2. **Local operations** execute autonomously — no prompt required.
3. **Remote operations** (git push, npm publish) always require Marwan's approval.
4. No detached plans — all implementation status goes into `AGENIOS_INDEX.md` rows only.
5. Prefer direct execution over process ceremony.
6. **Model Law:** AI model for any chat is fixed at creation. Create a new chat if you
   need a different model.

---

## Autonomy Boundary

| Local (autonomous)              | Remote (approval required) |
|:--------------------------------|:--------------------------|
| File writes / edits             | `git push`                |
| `git add` / `git commit`        | `npm publish`             |
| `node --check` / syntax checks  | Any production API call   |
| Local smoke tests (`curl localhost`) | PM2 remote operations |
| `pm2 restart` (local)          |                           |

---

## Key Files

| File | Purpose |
|:-----|:--------|
| `ag-bridge.js` | CDP bridge process (PM2: `ag-bridge`, port 9100) |
| `remote-ui/index.html` | Single-file PWA remote control |
| `ecosystem.config.js` | PM2 process definition |
| `AGENIOS_INDEX.md` | Source of truth for all tasks and status |
| `GEMINI.md` | Operating manual (this file's sibling) |
| `.env.example` | Required environment variables |
