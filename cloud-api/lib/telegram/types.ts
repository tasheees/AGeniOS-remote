/**
 * src/lib/telegram/types.ts
 * AG Telegram Remote Control — TypeScript types
 * §13.1 | GENIOS_INDEX.md
 */

export type TelegramApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface TelegramPendingItem {
  id: string;
  message: string;
  status: TelegramApprovalStatus;
  createdAt: string;           // ISO 8601
  resolvedAt?: string;         // ISO 8601
  telegramMessageId?: number;  // for editMessage after resolve
  agConversationId?: string;   // which AG chat requested this
}

export interface TelegramSession {
  chatId: string;      // AG conversation ID
  lastActive: string;  // ISO 8601
  summary: string;     // short description of last task
}

export interface TelegramNotifyPayload {
  text: string;
  type?: 'info' | 'warning' | 'approval' | 'report';
  agChatId?: string;
}

export interface TelegramApprovalRequest {
  message: string;
  agConversationId?: string;
}

// ── Telegram Bot API inbound types ────────────────────────────────────────────

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramInboundMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramInboundMessage {
  message_id: number;
  from?: TelegramUser;
  chat: { id: number; type: string };
  date: number;
  text?: string;
}

export interface TelegramUser {
  id: number;
  first_name: string;
  username?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramInboundMessage;
  data?: string;
}
