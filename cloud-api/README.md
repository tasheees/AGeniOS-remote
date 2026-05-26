# cloud-api — AGenIOS Cloud Component (Hosted on GeniOS)

> These files are the **cloud-side** of AGenIOS's Telegram integration.
> They are currently **deployed on GeniOS infrastructure** at `app.collegeelysee.com`
> because AGenIOS does not yet have its own domain/hosting.
>
> **Do NOT delete them from GeniOS** until AGenIOS has its own public HTTPS endpoint.
> This folder is a reference archive for the eventual migration.

---

## What These Files Do

### `api/webhook/telegram/route.ts`
Receives ALL Telegram bot updates (webhook mode).
Telegram calls `POST https://app.collegeelysee.com/api/webhook/telegram` for every
message/callback Marwan sends to the bot.
Registered once via `setWebhook()` after deploy.

### `api/telegram/notify.ts`
AG chats call this to push notifications to Marwan's Telegram.
```bash
curl -X POST https://app.collegeelysee.com/api/telegram/notify \
  -H "Authorization: Bearer $CRON_SECRET" \
  -d '{"text": "tsc passed", "type": "info"}'
```

### `api/telegram/approval.ts`
AG requests a gate approval (git push, firebase deploy, etc.).
Creates a Firestore pending item + sends Telegram message with ✅/❌ inline buttons.
Returns `{ id }` which AG uses to poll status.

### `api/telegram/approval-status.ts`
AG polls this to check if Marwan approved or rejected.
```bash
curl "https://app.collegeelysee.com/api/telegram/approval/$ID" \
  -H "Authorization: Bearer $CRON_SECRET"
# Returns: { status: 'pending'|'approved'|'rejected' }
```

### `lib/telegram/`
Shared TypeScript library:
- `client.ts` — `sendMessage()`, `sendWithButtons()`
- `commands.ts` — handles `/status`, `/approve`, `/reject` bot commands
- `pending.ts` — Firestore CRUD for pending approvals
- `types.ts` — `TelegramUpdate`, `PendingApproval` types

---

## Migration Plan (Future)

When AGenIOS gets its own domain/hosting:
1. Rewrite routes as Express handlers in `ag-bridge.js`
2. Use ngrok or a dedicated domain for the Telegram webhook URL
3. Re-register webhook: `setWebhook(newUrl)`
4. Delete from GeniOS

Currently tracked as: `AGENIOS_INDEX.md` task M5
