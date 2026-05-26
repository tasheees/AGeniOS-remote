/**
 * src/lib/telegram/commands.ts
 * AG Telegram Remote Control — bot command handlers
 * §13.1 | GENIOS_INDEX.md
 *
 * All commands validate TELEGRAM_CHAT_ID at the webhook layer before
 * reaching here, so no additional auth check is needed per-command.
 */

import { sendMessage, editMessageText, answerCallbackQuery, setMyCommands } from './client';
import { listPending, resolvePending, listSessions } from './pending';
import { getDb } from '@/lib/firebase-admin';

const CHAT_ID = () => process.env.TELEGRAM_CHAT_ID!;

// ── Entry point: text command dispatch ────────────────────────────────────────

export async function handleCommand(text: string): Promise<void> {
  // Strip /cmd@BotUsername suffix, split on whitespace
  const [rawCmd, ...args] = text.trim().split(/\s+/);
  const cmd = rawCmd.toLowerCase().replace(/^\//, '').split('@')[0];

  switch (cmd) {
    case 'start':      return handleStart();
    case 'help':       return handleHelp();
    case 'pending':    return handlePending();
    case 'approve':    return handleResolve('approved', args[0]);
    case 'reject':     return handleResolve('rejected', args[0]);
    case 'status':     return handleStatus();
    case 'chats':      return handleChats();
    case 'transcript': return handleTranscript(args[0]);
    case 'send':       return handleSend(args[0], args.slice(1).join(' '));
    default:
      await sendMessage(
        CHAT_ID(),
        `Unknown command: <code>/${cmd}</code>\n\nSend /help for the full list.`
      );
  }
}

// ── Entry point: inline button callback dispatch ──────────────────────────────

export async function handleCallback(
  callbackId: string,
  data: string,
  originalMessageId: number
): Promise<void> {
  await answerCallbackQuery(callbackId);

  if (data.startsWith('approve_')) {
    await resolveAndEdit(data.slice('approve_'.length), 'approved', originalMessageId);
  } else if (data.startsWith('reject_')) {
    await resolveAndEdit(data.slice('reject_'.length), 'rejected', originalMessageId);
  }
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function handleStart(): Promise<void> {
  await sendMessage(CHAT_ID(), [
    '🤖 <b>GeniOS AG Remote Control</b>',
    '',
    'You are connected. AG approval requests and notifications will arrive here.',
    '',
    'Send /help to see all available commands.',
  ].join('\n'));
  await setMyCommands().catch(() => {});
}

async function handleHelp(): Promise<void> {
  await sendMessage(CHAT_ID(), [
    '🤖 <b>AG Remote Control — Commands</b>',
    '',
    '/pending — List all waiting approvals',
    '/approve [n] — Approve item #n (or latest)',
    '/reject [n]  — Reject item #n (or latest)',
    '/status      — Recent AG session activity',
    '/chats       — List active AG conversations',
    '/transcript &lt;chatId&gt; — Get session summary',
    '/send &lt;chatId&gt; &lt;message&gt; — Relay message to AG chat',
    '/help        — This list',
  ].join('\n'));
}

async function handlePending(): Promise<void> {
  const items = await listPending('pending');

  if (items.length === 0) {
    await sendMessage(CHAT_ID(), '✅ No pending approvals.');
    return;
  }

  const lines = items.map((item, i) => {
    const ageMin = Math.round(
      (Date.now() - new Date(item.createdAt).getTime()) / 60_000
    );
    const chatSuffix = item.agConversationId
      ? ` · <code>${item.agConversationId.slice(0, 8)}</code>`
      : '';
    return `${i + 1}. ${item.message}\n   <i>${ageMin}m ago${chatSuffix}</i>`;
  });

  await sendMessage(CHAT_ID(), [
    `⏳ <b>${items.length} pending approval${items.length > 1 ? 's' : ''}:</b>`,
    '',
    ...lines,
    '',
    'Use /approve [n] or /reject [n] to resolve.',
  ].join('\n'));
}

async function handleResolve(
  action: 'approved' | 'rejected',
  arg?: string
): Promise<void> {
  const items = await listPending('pending');

  if (items.length === 0) {
    await sendMessage(CHAT_ID(), '✅ No pending items to resolve.');
    return;
  }

  let target = items[0]; // default: most recent
  if (arg !== undefined) {
    const n = parseInt(arg, 10);
    if (isNaN(n) || n < 1 || n > items.length) {
      await sendMessage(
        CHAT_ID(),
        `❌ Invalid index. Use a number between 1 and ${items.length}.`
      );
      return;
    }
    target = items[n - 1];
  }

  const resolved = await resolvePending(target.id, action);
  if (!resolved) {
    await sendMessage(CHAT_ID(), `❌ Could not resolve item <code>${target.id}</code>.`);
    return;
  }

  const emoji = action === 'approved' ? '✅' : '❌';
  const verb  = action === 'approved' ? 'Approved' : 'Rejected';
  await sendMessage(CHAT_ID(), `${emoji} <b>${verb}:</b> ${target.message}`);

  // Edit the original approval message if we have its Telegram message ID
  if (target.telegramMessageId) {
    await editMessageText(
      CHAT_ID(),
      target.telegramMessageId,
      `${emoji} <b>${verb}</b>\n\n${target.message}\n\n<i>${new Date().toLocaleString('en-GB', { timeZone: 'Asia/Beirut' })} Beirut</i>`
    );
  }
}

async function handleStatus(): Promise<void> {
  const sessions = await listSessions();

  if (sessions.length === 0) {
    await sendMessage(CHAT_ID(), '📭 No AG session activity recorded yet.');
    return;
  }

  const lines = sessions.slice(0, 5).map(s => {
    const ageMin = Math.round(
      (Date.now() - new Date(s.lastActive).getTime()) / 60_000
    );
    return `• <code>${s.chatId.slice(0, 8)}</code> — ${s.summary}\n  <i>${ageMin}m ago</i>`;
  });

  await sendMessage(CHAT_ID(), [
    '📊 <b>Recent AG Activity:</b>',
    '',
    ...lines,
  ].join('\n'));
}

async function handleChats(): Promise<void> {
  const sessions = await listSessions();

  if (sessions.length === 0) {
    await sendMessage(CHAT_ID(), '📭 No AG chats have reported in yet.');
    return;
  }

  const lines = sessions.map((s, i) => {
    const ageMin = Math.round(
      (Date.now() - new Date(s.lastActive).getTime()) / 60_000
    );
    return `${i + 1}. <code>${s.chatId}</code>\n   ${s.summary} — <i>${ageMin}m ago</i>`;
  });

  await sendMessage(CHAT_ID(), [
    '🤖 <b>Active AG Conversations:</b>',
    '',
    ...lines,
  ].join('\n'));
}

async function handleTranscript(chatId?: string): Promise<void> {
  if (!chatId) {
    await sendMessage(CHAT_ID(), '❌ Usage: /transcript &lt;chatId&gt;');
    return;
  }

  const sessions = await listSessions();
  const session  = sessions.find(s => s.chatId.startsWith(chatId));

  if (!session) {
    await sendMessage(
      CHAT_ID(),
      `❌ No session found for: <code>${chatId}</code>\n\nSend /chats to see active conversations.`
    );
    return;
  }

  await sendMessage(CHAT_ID(), [
    `📋 <b>Session: <code>${session.chatId.slice(0, 8)}</code></b>`,
    '',
    session.summary,
    '',
    `<i>Last active: ${session.lastActive}</i>`,
    '',
    '<i>Full JSONL transcript (local only):</i>',
    `<code>~/.gemini/antigravity/brain/${session.chatId}/.system_generated/logs/transcript.jsonl</code>`,
  ].join('\n'));
}

async function handleSend(chatId?: string, message?: string): Promise<void> {
  if (!chatId || !message) {
    await sendMessage(CHAT_ID(), '❌ Usage: /send &lt;chatId&gt; &lt;message&gt;');
    return;
  }

  // Write to telegram_relay — AG chat polls on wakeup
  const db = getDb();
  await db.collection('telegram_relay').add({
    targetChatId: chatId,
    message,
    sentAt:       new Date().toISOString(),
    status:       'queued',
  });

  await sendMessage(CHAT_ID(), [
    `📨 Message queued for <code>${chatId.slice(0, 8)}</code>:`,
    '',
    `<i>${message}</i>`,
    '',
    'The AG chat will receive it on next wakeup.',
  ].join('\n'));
}

// ── Internal helper ───────────────────────────────────────────────────────────

async function resolveAndEdit(
  id: string,
  action: 'approved' | 'rejected',
  originalMessageId: number
): Promise<void> {
  const resolved = await resolvePending(id, action);

  if (!resolved) {
    await sendMessage(
      CHAT_ID(),
      `❌ Approval request <code>${id}</code> not found or already resolved.`
    );
    return;
  }

  const emoji = action === 'approved' ? '✅' : '❌';
  const verb  = action === 'approved' ? 'Approved' : 'Rejected';
  const ts    = new Date().toLocaleString('en-GB', { timeZone: 'Asia/Beirut' });

  await editMessageText(
    CHAT_ID(),
    originalMessageId,
    `${emoji} <b>${verb}</b>\n\n${resolved.message}\n\n<i>${ts} Beirut</i>`
  );
}
