/**
 * API Route: POST /api/telegram/approval
 *
 * AG requests a gate approval from Marwan.
 * Writes a Firestore pending item + sends Telegram message with ✅/❌ inline buttons.
 *
 * Auth:    Bearer CRON_SECRET
 * Body:    { message: string, agConversationId?: string }
 * Returns: { ok: true, id: string }
 *
 * AG stores the returned `id` and polls GET /api/telegram/approval/{id} to check result.
 *
 * Usage from AG chat (bash):
 *   RESULT=$(curl -s -X POST https://app.collegeelysee.com/api/telegram/approval \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"message":"git push — feat(centaur): XAI Layer 3","agConversationId":"d125b171"}')
 *   ID=$(echo $RESULT | jq -r '.id')
 *   # AG goes idle (schedule tool) → Marwan approves on Telegram → AG polls status
 *
 * §13.1 | GENIOS_INDEX.md
 */

import { NextRequest, NextResponse }                      from 'next/server';
import { sendMessage, approvalKeyboard }                  from '@/lib/telegram/client';
import { createPending, updatePendingMessageId }          from '@/lib/telegram/pending';
import type { TelegramApprovalRequest }                   from '@/lib/telegram/types';

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth ──────────────────────────────────────────────────────────────────
  const bearer = req.headers.get('authorization') ?? '';
  if (bearer !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json(
      { error: 'Unauthorized — CRON_SECRET required' },
      { status: 401 }
    );
  }

  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!chatId) {
    return NextResponse.json(
      { error: 'TELEGRAM_CHAT_ID not configured' },
      { status: 500 }
    );
  }

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: TelegramApprovalRequest;
  try {
    body = (await req.json()) as TelegramApprovalRequest;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { message, agConversationId } = body;
  if (!message?.trim()) {
    return NextResponse.json({ error: '`message` is required' }, { status: 400 });
  }

  // ── Write pending item to Firestore ───────────────────────────────────────
  const id = await createPending({ message, agConversationId });

  // ── Send Telegram message with inline ✅/❌ buttons ───────────────────────
  const chatSuffix = agConversationId
    ? ` · <code>${agConversationId.slice(0, 8)}</code>`
    : '';

  const text = [
    `🔐 <b>AG Approval Required${chatSuffix}</b>`,
    '',
    message,
    '',
    `<i>ID: <code>${id}</code></i>`,
    `<i>Tap a button below, or use /approve · /reject</i>`,
  ].join('\n');

  const sent = await sendMessage(chatId, text, { replyMarkup: approvalKeyboard(id) });

  // Store Telegram message ID so we can edit it after resolution
  await updatePendingMessageId(id, sent.message_id).catch(() => {});

  return NextResponse.json({ ok: true, id });
}
