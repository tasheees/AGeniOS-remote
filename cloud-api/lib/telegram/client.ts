/**
 * src/lib/telegram/client.ts
 * AG Telegram Remote Control — raw Telegram Bot API wrapper (axios only, no framework)
 * §13.1 | GENIOS_INDEX.md
 */

import axios from 'axios';

const BASE = () => `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}`;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface InlineKeyboardMarkup {
  inline_keyboard: InlineKeyboardButton[][];
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

// ── Core message operations ───────────────────────────────────────────────────

export async function sendMessage(
  chatId: string | number,
  text: string,
  options?: {
    parseMode?: 'HTML' | 'MarkdownV2';
    replyMarkup?: InlineKeyboardMarkup;
  }
): Promise<{ message_id: number }> {
  const res = await axios.post(`${BASE()}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: options?.parseMode ?? 'HTML',
    reply_markup: options?.replyMarkup,
  });
  return res.data.result as { message_id: number };
}

export async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  parseMode: 'HTML' | 'MarkdownV2' = 'HTML'
): Promise<void> {
  await axios
    .post(`${BASE()}/editMessageText`, {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: parseMode,
    })
    .catch(() => {
      // Message may already be edited or deleted — safe to ignore
    });
}

export async function answerCallbackQuery(id: string, text?: string): Promise<void> {
  await axios
    .post(`${BASE()}/answerCallbackQuery`, { callback_query_id: id, text })
    .catch(() => {}); // Non-critical — safe to ignore on timeout
}

export async function sendDocument(
  chatId: string | number,
  content: Buffer,
  filename: string,
  caption?: string
): Promise<void> {
  // Node 22 native FormData + Blob
  const blob = new Blob([new Uint8Array(content)], { type: 'text/plain' });
  const fd = new FormData();
  fd.append('chat_id', String(chatId));
  fd.append('document', blob, filename);
  if (caption) fd.append('caption', caption);
  await axios.post(`${BASE()}/sendDocument`, fd);
}

// ── Bot setup (called once on /start or via setup script) ────────────────────

export async function setMyCommands(): Promise<void> {
  await axios.post(`${BASE()}/setMyCommands`, {
    commands: [
      { command: 'help',       description: 'List all commands' },
      { command: 'pending',    description: 'List pending approvals' },
      { command: 'approve',    description: 'Approve item — /approve [n]' },
      { command: 'reject',     description: 'Reject item — /reject [n]' },
      { command: 'status',     description: 'Recent AG session activity' },
      { command: 'chats',      description: 'List active AG conversations' },
      { command: 'transcript', description: 'Session summary — /transcript <chatId>' },
      { command: 'send',       description: 'Relay message — /send <chatId> <message>' },
    ],
  });
}

export async function setWebhook(url: string, secretToken: string): Promise<void> {
  await axios.post(`${BASE()}/setWebhook`, {
    url,
    secret_token: secretToken,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
}

// ── Inline keyboard factory ───────────────────────────────────────────────────

export function approvalKeyboard(id: string): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: `approve_${id}` },
      { text: '❌ Reject',  callback_data: `reject_${id}` },
    ]],
  };
}
