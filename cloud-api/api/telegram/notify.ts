/**
 * API Route: POST /api/telegram/notify
 *
 * Internal — any AG chat pushes a notification to Marwan's Telegram phone.
 *
 * Auth:   Bearer CRON_SECRET
 * Body:   { text: string, type?: 'info'|'warning'|'approval'|'report', agChatId?: string }
 * Returns:{ ok: true, messageId: number }
 *
 * Usage from AG chat (bash):
 *   curl -X POST https://app.collegeelysee.com/api/telegram/notify \
 *     -H "Authorization: Bearer $CRON_SECRET" \
 *     -H "Content-Type: application/json" \
 *     -d '{"text": "tsc passed. Ready to push.", "type": "info", "agChatId": "abc123"}'
 *
 * §13.1 | GENIOS_INDEX.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { sendMessage }   from '@/lib/telegram/client';
import { upsertSession } from '@/lib/telegram/pending';
import type { TelegramNotifyPayload } from '@/lib/telegram/types';

const TYPE_EMOJI: Record<string, string> = {
  info:     'ℹ️',
  warning:  '⚠️',
  approval: '🔐',
  report:   '📋',
};

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
  let body: TelegramNotifyPayload;
  try {
    body = (await req.json()) as TelegramNotifyPayload;
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const { text, type = 'info', agChatId } = body;
  if (!text?.trim()) {
    return NextResponse.json({ error: '`text` is required' }, { status: 400 });
  }

  // ── Send to Telegram ──────────────────────────────────────────────────────
  const emoji     = TYPE_EMOJI[type] ?? 'ℹ️';
  const chatSuffix = agChatId ? ` · <code>${agChatId.slice(0, 8)}</code>` : '';
  const formatted  = `${emoji} <b>AG Notification${chatSuffix}</b>\n\n${text}`;

  const result = await sendMessage(chatId, formatted);

  // Track session activity in telegram_sessions
  if (agChatId) {
    await upsertSession(agChatId, text.slice(0, 120)).catch(() => {});
  }

  return NextResponse.json({ ok: true, messageId: result.message_id });
}
