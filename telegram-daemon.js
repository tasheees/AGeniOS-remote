/**
 * scripts/telegram-daemon.js
 *
 * §13.2 — GeniOS Telegram Local Daemon
 *
 * A pm2-managed long-polling daemon that lets Marwan control the MacBook
 * from Telegram. Receives commands → executes whitelisted shell operations
 * → streams output back to the bot.
 *
 * Architecture:
 *   §13.1 web routes  = OUTBOUND only (AG → Telegram, Cloud Run)
 *   §13.2 this daemon = INBOUND only  (Telegram → Mac shell, local)
 *
 * Security model:
 *   - Only processes messages from TELEGRAM_CHAT_ID (hard guard, ignores all others)
 *   - Whitelisted commands only (no arbitrary shell unless ALLOW_ARBITRARY_RUN=true)
 *   - ALLOW_ARBITRARY_RUN defaults to false
 *
 * Requires in .env.local:
 *   TELEGRAM_BOT_TOKEN=<bot token>
 *   TELEGRAM_CHAT_ID=<your numeric chat id>
 *   GOOGLE_SERVICE_ACCOUNT_KEY=<JSON string of service account>
 *   ALLOW_ARBITRARY_RUN=false   (optional, default false)
 *
 * Usage:
 *   pm2 start ecosystem.config.js
 *   pm2 save
 *
 * Governance: GEMINI.md §2a — local autonomous process, no remote ops.
 */

'use strict';

require('dotenv').config({ path: '.env.local' });

const https   = require('https');
const { exec } = require('child_process');
const admin   = require('firebase-admin');

// ─── Config ───────────────────────────────────────────────────────────────────

const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const ALLOWED_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const ALLOW_ARBITRARY = process.env.ALLOW_ARBITRARY_RUN === 'true';
const PROJECT_DIR     = '/Users/marwantzenios/projects/genios';

if (!BOT_TOKEN)       { console.error('[daemon] ❌ TELEGRAM_BOT_TOKEN not set in .env.local'); process.exit(1); }
if (!ALLOWED_CHAT_ID) { console.error('[daemon] ❌ TELEGRAM_CHAT_ID not set in .env.local');   process.exit(1); }

// ─── Firebase Admin ───────────────────────────────────────────────────────────

let db = null;
try {
  const keyRaw = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (keyRaw) {
    const serviceAccount = JSON.parse(keyRaw);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    db = admin.firestore();
    console.log('[daemon] ✅ Firestore connected');
  } else {
    console.warn('[daemon] ⚠️  GOOGLE_SERVICE_ACCOUNT_KEY not set — Firestore commands disabled');
  }
} catch (err) {
  console.error('[daemon] ⚠️  Firestore init failed:', err.message);
}

// ─── Command whitelist ────────────────────────────────────────────────────────

// Only commands the daemon handles via shell — everything else forwarded to ag-bridge
const WHITELIST = {
  '/deploy': `cd ${PROJECT_DIR} && firebase deploy --only hosting`,
  '/push':   `cd ${PROJECT_DIR} && git push origin main`,
  '/tsc':    `cd ${PROJECT_DIR} && npx tsc --noEmit 2>&1 | tail -30`,
};

// ─── Telegram API ─────────────────────────────────────────────────────────────

function telegramRequest(method, params) {
  return new Promise((resolve, reject) => {
    const body    = JSON.stringify(params);
    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/${method}`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error: ' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function sendMessage(chatId, text, extra = {}) {
  // Split into 4096-char chunks (Telegram limit)
  for (let i = 0; i < text.length; i += 4000) {
    const chunk = text.slice(i, i + 4000);
    try {
      await telegramRequest('sendMessage', { chat_id: chatId, text: chunk, ...extra });
    } catch (err) {
      console.error('[daemon] sendMessage error:', err.message);
    }
  }
}

// ─── Shell runner ─────────────────────────────────────────────────────────────

async function runShell(chatId, command) {
  await sendMessage(chatId, '⏳ Running...');
  return new Promise((resolve) => {
    exec(command, { timeout: 300_000, maxBuffer: 1024 * 1024 * 10 }, async (error, stdout, stderr) => {
      const raw    = (stdout + stderr).trim();
      const output = raw || (error ? error.message : '(no output)');
      const text   = '```\n' + output.slice(0, 3800) + (output.length > 3800 ? '\n...(truncated)' : '') + '\n```';
      await sendMessage(chatId, text, { parse_mode: 'Markdown' });
      resolve();
    });
  });
}

// ─── Firestore: pending approvals ────────────────────────────────────────────

async function handlePending(chatId) {
  if (!db) { await sendMessage(chatId, '❌ Firestore not initialized.'); return; }
  try {
    const snap = await db.collection('telegram_pending').where('status', '==', 'pending').get();
    if (snap.empty) { await sendMessage(chatId, '✅ No pending approvals.'); return; }
    for (const doc of snap.docs) {
      const d = doc.data();
      const desc = d.description || d.action || JSON.stringify(d).slice(0, 200);
      await telegramRequest('sendMessage', {
        chat_id: chatId,
        text: `📋 *${doc.id}*\n${desc}`,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Approve', callback_data: `approve:${doc.id}` },
            { text: '❌ Reject',  callback_data: `reject:${doc.id}` },
          ]],
        },
      });
    }
  } catch (err) {
    await sendMessage(chatId, '❌ Firestore error: ' + err.message);
  }
}

async function handleApproval(chatId, docId, action, callbackQueryId) {
  if (!db) { await sendMessage(chatId, '❌ Firestore not initialized.'); return; }
  try {
    await db.collection('telegram_pending').doc(docId).update({
      status:      action,
      resolved_at: new Date().toISOString(),
    });
    if (callbackQueryId) {
      await telegramRequest('answerCallbackQuery', {
        callback_query_id: callbackQueryId,
        text: action === 'approved' ? '✅ Approved' : '❌ Rejected',
      });
    }
    const emoji = action === 'approved' ? '✅' : '❌';
    await sendMessage(chatId, `${emoji} \`${docId}\` marked **${action}**.`, { parse_mode: 'Markdown' });
  } catch (err) {
    await sendMessage(chatId, '❌ Firestore error: ' + err.message);
  }
}

// ─── Command dispatcher ───────────────────────────────────────────────────────

async function processUpdate(update) {
  // ── Inline button callback ─────────────────────────────────────────────────
  if (update.callback_query) {
    const cq     = update.callback_query;
    const chatId = String(cq.message?.chat?.id || cq.from.id);
    if (chatId !== ALLOWED_CHAT_ID) return;
    const colonIdx = cq.data.indexOf(':');
    if (colonIdx === -1) return;
    const action = cq.data.slice(0, colonIdx);
    const docId  = cq.data.slice(colonIdx + 1);

    // AG bridge action approval (ag_allow / ag_reject)
    if (action === 'ag_allow' || action === 'ag_reject') {
      try {
        const https = require('https');
        const body  = JSON.stringify({ idx: docId, decision: action === 'ag_allow' ? 'allow' : 'reject' });
        const rReq  = require('http').request({
          hostname: 'localhost', port: 9100, path: '/action-response',
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
        }, () => {});
        rReq.on('error', () => {});
        rReq.write(body); rReq.end();
        await telegramRequest('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: action === 'ag_allow' ? '✅ Allowed' : '❌ Rejected',
        });
        await sendMessage(chatId, action === 'ag_allow' ? '✅ Action allowed — AG continues.' : '❌ Action rejected.');
      } catch(e) {
        await sendMessage(chatId, '❌ Bridge error: ' + e.message);
      }
      return;
    }

    // Firestore approval (approve / reject)
    if (action === 'approve') await handleApproval(chatId, docId, 'approved', cq.id);
    else if (action === 'reject') await handleApproval(chatId, docId, 'rejected', cq.id);
    return;
  }

  // ── Text message ───────────────────────────────────────────────────────────
  if (!update.message?.text) return;

  const chatId = String(update.message.chat.id);
  const text   = update.message.text.trim();

  // Hard guard
  if (chatId !== ALLOWED_CHAT_ID) {
    console.log(`[daemon] Ignored message from unauthorized chat ${chatId}`);
    return;
  }

  const spaceIdx = text.indexOf(' ');
  const cmd  = spaceIdx === -1 ? text : text.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();

  console.log(`[daemon] cmd=${cmd} args=${args} from=${chatId}`);

  // /help
  if (cmd === '/help' || cmd === '/start') {
    const lines = [
      '🤖 *AGenIOS — Commands*',
      '',
      '`/wpa` — get the current PWA link',
      '`/status` — bridge status + AG connection',
      '`/pending` — list pending AG approvals',
      '`/notify` — show notification status',
      '`/mute` — mute Telegram notifications',
      '`/unmute` — re-enable Telegram notifications',
      '`/tunnel` — show tunnel status + active URL',
      '`/tunnel ngrok` — set default tunnel to ngrok',
      '`/tunnel cloudflare` — set default tunnel to cloudflare',
      '`/eod` — end-of-day session summary',
      '`/logs` — recent bridge logs',
      '`/tsc` — TypeScript syntax check',
      '`/push` — git push (requires Sovereign authorization)',
      '`/deploy` — firebase deploy (requires Sovereign authorization)',
    ];
    await sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    return;
  }

  // /wpa — get current PWA link (auto-retries while bridge warms up)
  if (cmd === '/wpa') {
    if (wpaLock) { await sendMessage(chatId, '⏳ Already checking… wait a moment.'); return; }
    wpaLock = true;
    async function fetchTunnel() {
      return new Promise((resolve, reject) => {
        const req = require('http').get('http://localhost:9100/tunnel-url', (res) => {
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(3000, () => { req.destroy(); reject(new Error('timeout')); });
      });
    }
    let sent = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const result = await fetchTunnel();
        if (result.tunnelUrl) {
          await sendMessage(chatId,
            `🌐 *PWA Link*\n\nURL: ${result.tunnelUrl}\nPassword: \`${result.password}\``,
            { parse_mode: 'Markdown' }
          );
          sent = true;
          break;
        }
        // No URL yet — wait and retry
        if (attempt === 0) await sendMessage(chatId, '⏳ Bridge starting, checking in 8s…');
        await new Promise(r => setTimeout(r, 8000));
      } catch {
        if (attempt === 0) await sendMessage(chatId, '⏳ Bridge starting, checking in 8s…');
        await new Promise(r => setTimeout(r, 8000));
      }
    }
    if (!sent) await sendMessage(chatId, '❌ Bridge not reachable. Try: `/status`', { parse_mode: 'Markdown' });
    wpaLock = false;
    return;
  }


  // Whitelisted shell commands
  if (WHITELIST[cmd]) {
    await runShell(chatId, WHITELIST[cmd]);
    return;
  }

  // /pending — forward to bridge (bridge scrapes AG live, Firestore path retired)
  // falls through to bridge forward below

  // /approve <id>
  if (cmd === '/approve') {
    if (!args) { await sendMessage(chatId, '❌ Usage: /approve <id>'); return; }
    await handleApproval(chatId, args, 'approved', null);
    return;
  }

  // /reject <id>
  if (cmd === '/reject') {
    if (!args) { await sendMessage(chatId, '❌ Usage: /reject <id>'); return; }
    await handleApproval(chatId, args, 'rejected', null);
    return;
  }

  // /run (arbitrary — disabled by default)
  if (cmd === '/run') {
    if (!ALLOW_ARBITRARY) {
      await sendMessage(chatId, '❌ Arbitrary shell disabled. Set ALLOW_ARBITRARY_RUN=true in .env.local to enable.');
      return;
    }
    if (!args) { await sendMessage(chatId, '❌ Usage: /run <command>'); return; }
    await runShell(chatId, args);
    return;
  }

  // Forward all other commands to ag-bridge /cmd endpoint
  // This covers /mute, /unmute, /notify, /eod, and any future bridge commands
  try {
    const http = require('http');
    const body = JSON.stringify({ command: text });
    await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost', port: 9100, path: '/cmd',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
                   'Authorization': 'Bearer ' + (process.env.REMOTE_PASSWORD || '') },
      }, (res) => { res.resume(); resolve(); });
      req.on('error', reject);
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('timeout')); });
      req.write(body); req.end();
    });
    // Bridge will send the reply back via Telegram itself — no need to reply here
  } catch (e) {
    await sendMessage(chatId, `❓ Unknown command: \`${cmd}\`\nType /help for available commands.`, { parse_mode: 'Markdown' });
  }
}

// ─── Long-polling loop ────────────────────────────────────────────────────────

let offset = 0;
let wpaLock = false;

async function poll() {
  try {
    const res = await telegramRequest('getUpdates', {
      offset,
      timeout:         30,
      allowed_updates: ['message', 'callback_query'],
    });

    if (res.ok && Array.isArray(res.result) && res.result.length > 0) {
      for (const update of res.result) {
        offset = update.update_id + 1;
        processUpdate(update).catch((err) => {
          console.error('[daemon] Unhandled error in processUpdate:', err);
        });
      }
    }
  } catch (err) {
    console.error('[daemon] Poll error:', err.message);
    // Back off 5 seconds on network error
    await new Promise((r) => setTimeout(r, 5000));
  }

  // Re-schedule immediately — long-poll timeout handles the 30s wait server-side
  setTimeout(poll, 100);
}

console.log('[daemon] ═══════════════════════════════════════════════');
console.log('[daemon] GeniOS Telegram Daemon §13.2 starting...');
console.log('[daemon] Authorized chat ID:', ALLOWED_CHAT_ID);
console.log('[daemon] Firestore:', db ? 'connected' : 'disabled');
console.log('[daemon] Arbitrary run:', ALLOW_ARBITRARY);
console.log('[daemon] ═══════════════════════════════════════════════');

poll();
