/**
 * src/lib/telegram/pending.ts
 * AG Telegram Remote Control — Firestore CRUD for telegram_pending + telegram_sessions
 * §13.1 | GENIOS_INDEX.md
 */

import { getDb } from '@/lib/firebase-admin';
import type { TelegramPendingItem, TelegramApprovalStatus, TelegramSession } from './types';

const PENDING_COL  = 'telegram_pending';
const SESSIONS_COL = 'telegram_sessions';

// ── telegram_pending ──────────────────────────────────────────────────────────

export async function createPending(
  data: Pick<TelegramPendingItem, 'message' | 'agConversationId'>
): Promise<string> {
  const db = getDb();
  const doc = await db.collection(PENDING_COL).add({
    message:           data.message,
    agConversationId:  data.agConversationId ?? null,
    status:            'pending' as TelegramApprovalStatus,
    createdAt:         new Date().toISOString(),
    telegramMessageId: null,
    resolvedAt:        null,
  });
  return doc.id;
}

export async function updatePendingMessageId(id: string, telegramMessageId: number): Promise<void> {
  const db = getDb();
  await db.collection(PENDING_COL).doc(id).update({ telegramMessageId });
}

export async function resolvePending(
  id: string,
  status: 'approved' | 'rejected'
): Promise<TelegramPendingItem | null> {
  const db = getDb();
  const ref = db.collection(PENDING_COL).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return null;
  const resolvedAt = new Date().toISOString();
  await ref.update({ status, resolvedAt });
  return { id, ...snap.data() as Omit<TelegramPendingItem, 'id'>, status, resolvedAt };
}

export async function getPending(id: string): Promise<TelegramPendingItem | null> {
  const db = getDb();
  const snap = await db.collection(PENDING_COL).doc(id).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() as Omit<TelegramPendingItem, 'id'> };
}

/**
 * List pending items ordered by createdAt desc.
 * In-memory status filter to avoid requiring a composite Firestore index.
 */
export async function listPending(
  statusFilter?: TelegramApprovalStatus
): Promise<TelegramPendingItem[]> {
  const db = getDb();
  const snap = await db
    .collection(PENDING_COL)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();
  const items = snap.docs.map(
    d => ({ id: d.id, ...d.data() as Omit<TelegramPendingItem, 'id'> })
  );
  return statusFilter ? items.filter(i => i.status === statusFilter) : items;
}

// ── telegram_sessions ─────────────────────────────────────────────────────────

export async function upsertSession(chatId: string, summary: string): Promise<void> {
  const db = getDb();
  await db.collection(SESSIONS_COL).doc(chatId).set(
    { chatId, lastActive: new Date().toISOString(), summary },
    { merge: true }
  );
}

export async function listSessions(): Promise<TelegramSession[]> {
  const db = getDb();
  const snap = await db
    .collection(SESSIONS_COL)
    .orderBy('lastActive', 'desc')
    .limit(10)
    .get();
  return snap.docs.map(d => d.data() as TelegramSession);
}
