/**
 * API Route: POST /api/webhook/telegram
 *            GET  /api/webhook/telegram
 *
 * Inbound Telegram webhook — receives all bot updates from Telegram.
 * Registered once via setWebhook() after deploy.
 *
 * Auth:  X-Telegram-Bot-Api-Secret-Token header (set at registration time)
 * Guard: Only processes updates from TELEGRAM_CHAT_ID — all other senders silently ignored.
 *
 * Always returns HTTP 200. Telegram retries on any non-2xx response.
 *
 * §13.1 | GENIOS_INDEX.md
 */

import { NextRequest, NextResponse } from 'next/server';
import { handleCommand, handleCallback } from '@/lib/telegram/commands';
import type { TelegramUpdate } from '@/lib/telegram/types';

export async function POST(req: NextRequest): Promise<NextResponse> {
  // ── Auth — validate Telegram webhook secret ───────────────────────────────
  const secretToken = req.headers.get('x-telegram-bot-api-secret-token') ?? '';
  if (secretToken !== process.env.TELEGRAM_WEBHOOK_SECRET) {
    console.warn('[telegram/webhook] Invalid secret token — ignoring update');
    return NextResponse.json({ ok: true }); // Always 200
  }

  const allowedChatId = process.env.TELEGRAM_CHAT_ID;
  if (!allowedChatId) {
    console.error('[telegram/webhook] TELEGRAM_CHAT_ID not configured');
    return NextResponse.json({ ok: true });
  }

  // ── Parse update ──────────────────────────────────────────────────────────
  let update: TelegramUpdate;
  try {
    update = (await req.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true }); // Malformed payload — ignore
  }

  // ── Guard — only Marwan's chat ────────────────────────────────────────────
  const fromId =
    update.message?.from?.id ??
    update.callback_query?.from?.id;

  if (String(fromId) !== String(allowedChatId)) {
    console.warn(`[telegram/webhook] Ignored update from unauthorized id: ${fromId}`);
    return NextResponse.json({ ok: true });
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────
  try {
    if (update.callback_query) {
      const { id, data, message } = update.callback_query;
      await handleCallback(id, data ?? '', message?.message_id ?? 0);
    } else if (update.message?.text) {
      await handleCommand(update.message.text);
    }
  } catch (err) {
    console.error('[telegram/webhook] Handler error:', err);
    // Do not propagate — always return 200
  }

  return NextResponse.json({ ok: true });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    ok: true,
    service: 'AG Telegram Remote Control',
    status: 'webhook active',
  });
}
