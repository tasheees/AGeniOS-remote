/**
 * scripts/ag-bridge.js
 *
 * §13.3 — GeniOS AG Remote Control Bridge
 *
 * Bridges the Antigravity desktop app (via Chrome DevTools Protocol) to a
 * mobile-friendly PWA served over a cloudflared tunnel.
 *
 * Architecture:
 *   Phone browser ─── HTTPS ──► cloudflared ──► HTTP :9100 (this server)
 *                                                  │
 *                               WebSocket :9100/ws ◄──── AG DOM events
 *                                                  │
 *                                              CDP ◄──── localhost:9222
 *                                                  │
 *                                         Antigravity.app (Electron/Chrome 146)
 *
 * CDP SELECTORS (discovered via chrome://inspect on AG 2.0.6 / Electron 41):
 *   ─────────────────────────────────────────────────────────────────────────
 *   NOTE: AG uses Electron/React. Selectors below are best-effort placeholders.
 *   To discover real selectors:
 *     1. Run: open -a "Antigravity" --args --remote-debugging-port=9222
 *     2. Open Chrome → chrome://inspect/#devices → inspect the AG window
 *     3. Use DevTools Elements panel to find actual data-testid / class names
 *     4. Update SELECTOR_* constants below with real values
 *   ─────────────────────────────────────────────────────────────────────────
 *   SELECTOR_MESSAGES  : '[data-testid="chat-message"]'   (message bubbles)
 *   SELECTOR_INPUT     : 'textarea[data-testid="chat-input"], textarea.chat-input, div[contenteditable="true"]'
 *   SELECTOR_SEND      : 'button[data-testid="send-button"], button[aria-label="Send"]'
 *   SELECTOR_ALLOW_BTN : 'button[data-testid="allow-button"], button:contains("Allow")'
 *
 * Environment (from .env.local):
 *   TELEGRAM_BOT_TOKEN  — for startup notification
 *   TELEGRAM_CHAT_ID    — authorized chat
 *   REMOTE_PASSWORD     — PWA login password (default: random 8-char)
 *
 * Usage:
 *   pm2 start ecosystem.config.js --only ag-bridge
 *   # Or: node scripts/ag-bridge.js
 *
 * Governance: GEMINI.md §2a — local process, no remote ops.
 */

'use strict';

require('dotenv').config({ path: '.env.local' });

const http      = require('http');
const https     = require('https');
const fs        = require('fs');
const path      = require('path');
const { exec, execSync, spawn } = require('child_process');
const { WebSocketServer, WebSocket } = require('ws');

// CDP evaluate expression for dialog detection — raw JS file, zero escape confusion
const DIALOG_SCRAPER_EXPR = fs.readFileSync(path.join(__dirname, '_dialog_scraper.js'), 'utf8');

// ─── Config ───────────────────────────────────────────────────────────────────

const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const REMOTE_PASSWORD = process.env.REMOTE_PASSWORD || randomPassword();
const BRIDGE_PORT     = parseInt(process.env.BRIDGE_PORT || '9100', 10);
const CDP_HOST        = 'localhost';
const CDP_PORT        = 9222;
const EOD_TIME        = process.env.EOD_TIME || '';  // e.g. "18:00" — auto EOD summary
// Seconds of Mac keyboard/mouse inactivity before treating user as "away"
// Below threshold → macActive=true → Telegram suppressed.
// Tune via IDLE_THRESHOLD env var. Default 90s (1.5 min).
const IDLE_THRESHOLD_S = parseInt(process.env.IDLE_THRESHOLD || '90', 10);
const SETTINGS_FILE    = path.join(process.env.HOME || '/tmp', '.agenios-settings.json');

// CDP selectors — CONFIRMED via live CDP probe of AG 2.0.6 / Electron 41 / Chrome 146
// Probed: 2026-05-26 — [role="article"] = 14 messages, div[aria-label="Message input"] = contenteditable
const SEL = {
  // AG 2.0 uses class-based bubbles: 'msg-bubble user' / 'msg-bubble ai'
  messages: '.msg-bubble',
  input:    'div[aria-label="Message input"]',
  send:     'button[aria-label="Send"]',
  allow:    null,
};

function randomPassword() {
  return Math.random().toString(36).slice(2, 10).toUpperCase();
}

// ─── State ────────────────────────────────────────────────────────────────────

let cdpWs        = null;   // WebSocket to CDP
let cdpConnected = false;
let cdpReconnectAttempts = 0;
const MAX_CDP_RECONNECTS = 20;

let pendingRequests = {};  // id → {resolve, reject}
let cdpMsgId = 1;
let sessionId = null;      // CDP session ID for the AG page

const wsClients = new Set(); // Connected PWA browsers

let tunnelUrl = null;

// ─── Notification suppression ─────────────────────────────────────────────────
// macActive          — true when Mac HID idle time < IDLE_THRESHOLD_S
// telegramMuted      — manual mute toggle
// tunnelMode         — 'ngrok' | 'cloudflare' (default: ngrok)
// activeTunnelProvider — which provider is currently supplying tunnelUrl
let macActive            = false;
let telegramMuted        = false;
let telegramForceUnmute  = false; // /unmute overrides macActive suppression
let tunnelMode           = 'ngrok';
let activeTunnelProvider = null;
let _lastDigestAt        = 0;
let _hadConnection            = false;
let _restoredLastConnectionAt = 0;
let _lastActions              = [];  // cache of last scraped pending actions — accessible to HTTP handlers
let _clickDebounce            = new Map(); // idx → timestamp, prevents double-tap duplicate clicks
// Suppressed when: manually muted, OR Mac is active and user hasn't force-unmuted
const isTelegramSuppressed     = () => telegramMuted || (macActive && !telegramForceUnmute);
const isTelegramSuppressedInfo = () => telegramMuted || macActive; // status/digest: always suppress when Mac active

// Persist settings across restarts
function saveSettings() {
  try { fs.writeFileSync(SETTINGS_FILE, JSON.stringify({
    telegramMuted, telegramForceUnmute, tunnelMode,
    lastDigestAt:     _lastDigestAt,
    lastConnectionAt: _hadConnection ? Date.now() : (_restoredLastConnectionAt || 0),
    authTokens:       [...AUTH_TOKENS],
  })); } catch {}
}
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (typeof saved.telegramForceUnmute === 'boolean') telegramForceUnmute = saved.telegramForceUnmute;
  if (saved.tunnelMode === 'ngrok' || saved.tunnelMode === 'cloudflare') tunnelMode = saved.tunnelMode;
} catch { /* first run — use defaults */ }

// ─── Logging ─────────────────────────────────────────────────────────────────

const log = (...args) => console.log(`[ag-bridge] ${new Date().toISOString()}`, ...args);

// ─── Telegram notification ────────────────────────────────────────────────────

function telegramNotify(text) {
  if (!BOT_TOKEN || !ALLOWED_CHAT_ID) return;
  const body = JSON.stringify({ chat_id: ALLOWED_CHAT_ID, text, parse_mode: 'Markdown' });
  const opts = {
    hostname: 'api.telegram.org',
    path: `/bot${BOT_TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  };
  const req = https.request(opts, (res) => { res.resume(); });
  req.on('error', (err) => log('Telegram notify error:', err.message));
  req.write(body);
  req.end();
}

// Broadcast current notification settings to all PWA clients
function broadcastSettings() {
  saveSettings();
  broadcast('settings', { macActive, telegramMuted, telegramForceUnmute, tunnelMode, activeTunnelProvider, tunnelUrl });
}

// ─── Smart channel router ─────────────────────────────────────────────────────
// Priority order (first match wins):
//   1. alwaysTelegram=true  → always send (startup URL, EOD summary)
//   2. macActive=true       → suppress (you’re at your Mac)
//   3. telegramMuted=true   → suppress (manual toggle)
//   4. PWA open             → WS broadcast only
//   5. fallback             → Telegram

function smartNotify(text, { alwaysTelegram = false } = {}) {
  const pwaOpen = wsClients.size > 0;
  if (alwaysTelegram) {
    telegramNotify(text);
    return;
  }
  if (isTelegramSuppressed()) {
    // Mac is active or manually muted — WS only (or silent if no PWA)
    if (pwaOpen) broadcast('notification', { text });
    log(`[smartNotify] suppressed (macActive=${macActive} muted=${telegramMuted}): ${text.slice(0, 60)}`);
    return;
  }
  if (pwaOpen) {
    broadcast('notification', { text });
  } else {
    telegramNotify(text);
  }
}

// ─── Telegram inline keyboard helper ─────────────────────────────────────────
function telegramNotifyInline(text, buttons = []) {
  if (!BOT_TOKEN || !ALLOWED_CHAT_ID) return;
  const body = {
    chat_id:    ALLOWED_CHAT_ID,
    text,
    parse_mode: 'Markdown',
  };
  if (buttons.length > 0) {
    // Accept flat Button[] (one row) or Button[][] (multi-row) already structured
    const keyboard = Array.isArray(buttons[0]) ? buttons : [buttons];
    body.reply_markup = { inline_keyboard: keyboard };
  }
  const bodyStr = JSON.stringify(body);
  const req = require('https').request({
    hostname: 'api.telegram.org',
    path:     `/bot${BOT_TOKEN}/sendMessage`,
    method:   'POST',
    headers:  { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(bodyStr) },
  }, () => {});
  req.on('error', () => {});
  req.write(bodyStr);
  req.end();
}

// ─── Background Watch: action inline buttons ──────────────────────────────────
function sendActionToTelegram(action) {
  if (!BOT_TOKEN || !ALLOWED_CHAT_ID) return;
  if (isTelegramSuppressed()) return;
  const title = (action.title || action.text || 'Approval needed').slice(0, 200);
  const cmd   = (action.command || action.context || '').trim().slice(0, 300);
  const idx   = action.occurrenceIndex ?? action.index ?? 0;
  const opts  = action.options || [];

  // ── Message layout (mirrors AG dialog) ──────────────────────────────────
  // Section 1: bold title
  let body = `*${title}*`;

  // Section 2: description (the "why") + separator + value/URL/command (the "what")
  const desc = (action.description || '').trim();
  const val  = (action.value || action.command || '').trim().slice(0, 300);
  if (desc) body += `\n\n${desc}`;
  if (val)  body += `\n\`\`\`\n${val}\n\`\`\``;  // always in a distinct code block

  // Section 3: options (verbatim)
  if (opts.length) {
    body += '\n\n' + opts.map(o => o.text).join('\n');
  }

  // Build inline keyboard:
  // 2 options  → one row: ✅ Allow | ❌ Reject
  // 3+ options → rows of 2, each button = verbatim option text (truncated to 28 chars)
  let keyboard;
  if (opts.length <= 2) {
    keyboard = [[
      { text: '✅ Allow',  callback_data: `ag_opt:${idx}:0` },
      { text: '❌ Reject', callback_data: `ag_opt:${idx}:${Math.max(opts.length - 1, 1)}` },
    ]];
  } else {
    // Each option gets its own full-width row — maximises visible text before Telegram truncates
    keyboard = opts.map(o => ([{
      text: o.text.slice(0, 40),
      callback_data: `ag_opt:${idx}:${o.index}`,
    }]));
  }

  telegramNotifyInline(`⚠️ *AG needs approval*\n\n${body}`, keyboard);
}

// ─── Background Watch: idle digest ───────────────────────────────────────────
let _digestPending = false;
// _lastDigestAt declared at module scope (line 112)
function scheduleIdleDigest(lastSnippet) {
  if (_digestPending) return;
  const now = Date.now();
  if (now - _lastDigestAt < 5 * 60 * 1000) return; // max one digest per 5 min
  _digestPending = true;
  setTimeout(async () => {
    _digestPending = false;
    if (wsClients.size > 0) return;      // PWA open — skip
    if (isTelegramSuppressedInfo()) return;  // Mac active or muted — no digest needed
    if (actions.length > 0 || _lastActionCount > 0) return; // dialog pending — don't interrupt
    try {
      const { exec } = require('child_process');
      exec(
        'cd /Users/marwantzenios/projects/AGenIOS && git log --oneline -3',
        { timeout: 5000 },
        (err, stdout) => {
          _lastDigestAt = Date.now();
          saveSettings(); // persist cooldown so restarts don't reset the 5-min window
          const gitInfo = (stdout || '').trim().slice(0, 300);
          const snippet = (lastSnippet || '').slice(0, 200);
          const msg =
            `📋 *AG finished*\n\n` +
            (snippet ? `_Last: ${snippet}_\n\n` : '') +
            (gitInfo  ? `\`\`\`\n${gitInfo}\n\`\`\`` : '');
          telegramNotifyInline(msg, []);
        }
      );
    } catch {}
  }, 3000);
}

// ─── Local command executor ───────────────────────────────────────────────────
// Whitelist of safe read/local commands executable directly from the bridge.
// Remote ops (git push, firebase deploy) still require Sovereign Console approval.

const CMD_WHITELIST = {
  '/status':  () => new Promise((resolve) => {
    exec('pm2 jlist', (err, stdout) => {
      if (err) return resolve('❌ pm2 status error');
      try {
        const procs = JSON.parse(stdout);
        const lines = procs.map(p => `${p.name}: ${p.pm2_env.status} ↺${p.pm2_env.restart_time}`);
        const notifState = telegramMuted   ? '🔕 Muted manually'
                         : telegramForceUnmute ? '🔔 Force-unmuted (Mac-active override)'
                         : macActive          ? '🖥️ Mac active — Telegram suppressed'
                                              : '🔔 Active';
        resolve(`📊 *PM2 Status*\n${lines.join('\n')}\n\n${notifState}`);
      } catch { resolve(stdout.slice(0, 400)); }
    });
  }),
  '/mute':    () => { telegramMuted = true; telegramForceUnmute = false; saveSettings(); broadcastSettings(); return '🔕 Telegram muted. Use /unmute to re-enable.'; },
  '/restart': (arg) => new Promise((resolve) => {
    const target = (arg || '').trim().toLowerCase() === 'bridge' ? 'ag-bridge' : 'telegram-daemon';
    resolve(`🔄 Restarting *${target}*…`);
    setTimeout(() => { exec(`pm2 restart ${target}`, () => {}); }, 300);
  }),
  '/tunnel':  (arg) => {
    const newMode = (arg || '').trim().toLowerCase();
    if (newMode === 'ngrok' || newMode === 'cloudflare') {
      tunnelMode = newMode;
      saveSettings();
      broadcastSettings();
      return `📡 *Tunnel default set to* \`${tunnelMode}\`\nTakes full effect on next bridge restart.`;
    }
    const activeInfo = tunnelUrl
      ? `${activeTunnelProvider || '?'}: ${tunnelUrl}`
      : 'No tunnel active';
    return `📡 *Tunnel Status*\nActive: ${activeInfo}\nDefault: \`${tunnelMode}\` ⭐\n\nChange default:\n/tunnel ngrok\n/tunnel cloudflare`;
  },
  '/unmute':  () => { telegramMuted = false; telegramForceUnmute = true; saveSettings(); broadcastSettings(); return '🔔 Telegram unmuted — Mac-active suppression overridden. Use /mute to silence again.'; },
  '/notify':  () => {
    const state = macActive ? '🖥️ Mac active (auto-suppressed)'
                : telegramMuted ? '🔕 Manually muted'
                : '🔔 Telegram notifications ON';
    return `*Notification status*\n${state}\n\nCommands: /mute • /unmute`;
  },
  '/tsc':     () => new Promise((resolve) => {
    exec('cd /Users/marwantzenios/projects/genios && npx tsc --noEmit 2>&1', { timeout: 60000 }, (err, stdout, stderr) => {
      const out = (stdout + stderr).trim().slice(0, 800);
      resolve(err ? `❌ TSC errors:\n${out}` : '✅ tsc: 0 errors');
    });
  }),
  '/logs':    () => new Promise((resolve) => {
    exec('pm2 logs --lines 20 --nostream 2>&1', { timeout: 10000 }, (err, stdout) => {
      resolve('📋 *Recent logs*\n```\n' + stdout.slice(-600) + '\n```');
    });
  }),
  '/pending': async () => {
    const actions = await scrapePendingActions();
    if (!actions.length) return '✅ No pending approvals';
    return '⏳ *Pending approvals:*\n' + actions.map(a => {
      const cmd = (a.command || '').trim();
      return `• ${a.text}${cmd ? '\n  `' + cmd.slice(0, 100) + '`' : ''}`;
    }).join('\n');
  },
  '/eod':     async () => {
    // Inject EOD summary prompt into AG, capture response, send to Telegram
    const prompt = `Please give me a concise end-of-day summary for today's session:
- What was completed (bullet points)
- What is in progress
- Next steps / open items
Keep it under 15 bullets. Use plain text, no markdown headers.`;
    _lastCurrentText = '';
    await typeIntoInput(prompt);
    await new Promise(r => setTimeout(r, 300));
    await clickSend();
    log('EOD prompt injected, waiting for AG response...');

    const summary = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        _pendingAskResolvers = _pendingAskResolvers.filter(r => r !== resolve);
        resolve('');
      }, 90_000);
      const wrapped = (txt) => { clearTimeout(timer); resolve(txt); };
      _pendingAskResolvers.push(wrapped);
    });

    if (!summary) return '⚠️ EOD: AG did not respond in time. Check the PWA.';

    const now = new Date().toLocaleString('fr-FR', { timeZone: 'Asia/Beirut', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
    const msg = `📋 *EOD Summary — ${now}*\n\n${summary.slice(0, 3500)}`;
    telegramNotify(msg);  // Always send to Telegram regardless of PWA state
    return '✅ EOD summary sent to Telegram';
  },
  '/ask': async (arg) => {
    if (!arg || !arg.trim()) return '❌ Usage: /ask <message to AG>';
    const text = arg.trim();

    // Reset last captured text so we pick up the fresh response
    _lastCurrentText = '';

    // Send to AG
    await typeIntoInput(text);
    await new Promise(r => setTimeout(r, 300));
    await clickSend();
    log('[/ask] sent to AG:', text.slice(0, 60));

    // Event-driven reply: resolver fires from the state-polling interval when AG goes idle
    const replyText = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        _pendingAskResolvers = _pendingAskResolvers.filter(r => r !== resolve);
        resolve('');
      }, 90_000);
      const wrappedResolve = (txt) => { clearTimeout(timer); resolve(txt); };
      _pendingAskResolvers.push(wrappedResolve);
    });

    if (replyText) {
      telegramNotifyInline(
        `🤖 *AG replied:*\n\n${replyText.slice(0, 3800)}` +
        (replyText.length > 800 ? '\n\n_… (truncated — see PWA for full message)_' : ''),
        []
      );
    } else {
      telegramNotifyInline('⏱ AG is still thinking — follow up in PWA.', []);
    }

    return `✅ *Sent to AG:* \`${text.slice(0, 80)}${text.length > 80 ? '…' : ''}\`\n⏳ Watching for reply…`;
  },
};

// EOD auto-schedule: fires once per day at EOD_TIME ("HH:MM" local Beirut time)
let eodFiredToday = '';
async function checkEODSchedule() {
  if (!EOD_TIME) return;
  const now = new Date();
  const beirut = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Beirut' }));
  const hhmm = `${String(beirut.getHours()).padStart(2,'0')}:${String(beirut.getMinutes()).padStart(2,'0')}`;
  const today = beirut.toDateString();
  if (hhmm === EOD_TIME && eodFiredToday !== today) {
    eodFiredToday = today;
    log(`EOD auto-schedule firing at ${hhmm}`);
    try {
      const result = await CMD_WHITELIST['/eod']();
      log('EOD auto-result:', result);
    } catch (e) {
      log('EOD auto-error:', e.message);
    }
  }
}

// Remote ops — always require Sovereign Console approval
const CMD_REMOTE = ['/push', '/deploy', '/gcloud'];


async function executeCommand(cmd) {
  const parts = cmd.trim().split(/\s+/);
  const key   = parts[0].toLowerCase();
  const arg   = parts.slice(1).join(' ');

  if (CMD_REMOTE.some(r => key.startsWith(r))) {
    return `🔒 *Remote op blocked*\n\`${cmd}\` requires Sovereign Console approval.\nSend to Console chat manually.`;
  }

  const handler = CMD_WHITELIST[key];
  if (handler) {
    try { return await handler(arg); }
    catch (e) { return `❌ Error: ${e.message}`; }
  }

  return `❓ Unknown command: \`${cmd}\`\nAvailable: ${Object.keys(CMD_WHITELIST).join(' ')}`;
}

// ─── CDP client ───────────────────────────────────────────────────────────────


function cdpSend(method, params = {}, sid = sessionId) {
  return new Promise((resolve, reject) => {
    if (!cdpWs || cdpWs.readyState !== WebSocket.OPEN) {
      return reject(new Error('CDP not connected'));
    }
    const id = cdpMsgId++;
    pendingRequests[id] = { resolve, reject };
    const msg = { id, method, params };
    if (sid) msg.sessionId = sid;
    cdpWs.send(JSON.stringify(msg));
    // Timeout after 10s
    setTimeout(() => {
      if (pendingRequests[id]) {
        delete pendingRequests[id];
        reject(new Error(`CDP timeout: ${method}`));
      }
    }, 10_000);
  });
}

async function cdpEvaluate(expression, sid = sessionId) {
  const result = await cdpSend('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  }, sid);
  return result?.result?.result?.value;
}

// ─── Scrape AG chat ───────────────────────────────────────────────────────────

async function scrapeChat() {
  try {
    const result = await cdpSend('Runtime.evaluate', {
      expression: `(function(){
        var c = document.querySelector('div.relative.flex.flex-col.gap-y-3.px-4');
        if (!c) return {dump:'', count:0};
        var clone = c.cloneNode(true);
        // Remove non-content elements
        Array.from(clone.querySelectorAll('textarea,input,[contenteditable],script,style,[role="dialog"],[role="alertdialog"],form')).forEach(function(e){e.remove();});
        Array.from(clone.querySelectorAll('[aria-hidden="true"]')).forEach(function(e){e.remove();});
        // Strip approval dialog — AG has no role="dialog" so detect by data-tooltip-id co-presence
        // (Skip + Submit buttons both carry data-tooltip-id — unique to the approval dialog)
        var tipBtns = Array.from(clone.querySelectorAll('button[data-tooltip-id]'));
        var skipEl   = tipBtns.find(function(b){ return /^skip$/i.test((b.innerText||'').trim()); });
        var submitEl = tipBtns.find(function(b){ return /^submit/i.test((b.innerText||'').trim()); });
        if (skipEl && submitEl) {
          // Walk up from Skip to the first ancestor that also contains Submit = dialog root
          var dlgNode = skipEl.parentElement;
          while (dlgNode && dlgNode !== clone) {
            if (dlgNode.contains(submitEl)) break;
            dlgNode = dlgNode.parentElement;
          }
          if (dlgNode && dlgNode !== clone) dlgNode.remove();
        }
        // Remove AG input placeholder text nodes
        Array.from(clone.querySelectorAll('*')).forEach(function(e){
          if (e.children.length===0 && /^(Ask anything|Message AG|@ to mention)/.test((e.textContent||'').trim())) e.remove();
        });
        // Strip Tailwind classes and inline styles — but PRESERVE language-* on <code> for Prism
        Array.from(clone.querySelectorAll('[class]')).forEach(function(e){
          if (e.tagName === 'CODE') {
            var kept = Array.from(e.classList).filter(function(c){ return /^language-/.test(c); });
            e.removeAttribute('class');
            kept.forEach(function(c){ e.classList.add(c); });
          } else {
            e.removeAttribute('class');
          }
        });
        Array.from(clone.querySelectorAll('[style]')).forEach(function(e){ e.removeAttribute('style'); });
         // Replace images with emoji — img.src paths are local/relative, never load in PWA
         Array.from(clone.querySelectorAll('img')).forEach(function(img){
           var sp = document.createElement('span');
           sp.textContent = img.getAttribute('alt') || '\uD83D\uDCC4';
           img.parentNode.replaceChild(sp, img);
         });
         // Strip data-* but PRESERVE data-state (open/closed collapsible state)
         Array.from(clone.querySelectorAll('*')).forEach(function(n){
           Array.from(n.attributes).filter(function(a){
             return a.name.startsWith('data-') && a.name !== 'data-state';
           }).forEach(function(a){ n.removeAttribute(a.name); });
         });
        return {dump: clone.innerHTML, count: c.children.length};
      })()`,
      returnByValue: true,
      awaitPromise: false,
    }, sessionId);
    const val = result?.result?.result?.value;
    const exc = result?.result?.exceptionDetails;
    if (exc) log('scrapeChat exception:', exc.exception?.description?.slice(0, 120));
    else if (val) log('scrapeChat OK: dump', val.dump.length, 'chars,', val.count, 'turns');
    return val?.dump || '';
  } catch (err) {
    log('scrapeChat error:', err.message);
    return '';
  }
}

async function scrapeTheme() {
  try {
    const result = await cdpSend('Runtime.evaluate', {
      expression: `(function(){
        var s = getComputedStyle(document.documentElement);
        var vars = {};
        ['--background','--foreground','--muted','--muted-foreground','--primary',
         '--secondary','--secondary-foreground','--border','--card','--accent',
         '--accent-foreground','--ring'].forEach(function(v){
          var val = s.getPropertyValue(v).trim();
          if(val) vars[v] = val;
        });
        return vars;
      })()`,
      returnByValue: true, awaitPromise: false,
    }, sessionId);
    return result?.result?.result?.value || {};
  } catch { return {}; }
}

// Click the Nth option button in AG's approval dialog, then click Submit
async function clickAction(optionIndex) {
  const expr = `(function(N) {
    // Find all numbered option buttons (not Skip/Submit)
    var allBtns = Array.from(document.querySelectorAll('button'));
    var optBtns = allBtns.filter(function(b) {
      var t = (b.innerText || '').trim();
      return /^[1-9]/.test(t) && !b.dataset.tooltipId;
    });
    var btn = optBtns[N];
    if (btn) btn.click();
    // Click Submit after a short delay
    setTimeout(function() {
      var submit = document.querySelector('button[data-tooltip-id]');
      // find the Submit (not Skip) by checking innerText
      var submitBtns = Array.from(document.querySelectorAll('button[data-tooltip-id]'));
      var s = submitBtns.find(function(b){ return /submit/i.test(b.innerText) || /↵/.test(b.innerText); });
      if (s) s.click();
    }, 200);
    return !!btn;
  })(${optionIndex})`;
  await cdpEvaluate(expr);
}

async function scrapePendingActions() {
  try {
    // DIALOG_SCRAPER_EXPR loaded from _dialog_scraper.js at startup — pure JS file,
    // no Node.js escape processing, Chrome receives it exactly as written.
    const result = await cdpSend('Runtime.evaluate', {
      expression:    DIALOG_SCRAPER_EXPR,
      returnByValue: true,
      awaitPromise:  false,
    }, sessionId);

    const raw = result?.result?.result;
    const exc = result?.result?.exceptionDetails;
    if (exc) { log('scrapePendingActions EXCEPTION:', exc.exception?.description?.slice(0, 200)); return []; }
    if (!raw?.value) return [];

    // ── All parsing in Node.js — no browser-side complexity ─────────────────
    const { fullText, command, skipId, submitId, debug } = raw.value;
    // Strip CSS lines leaking from shadow DOM <style> tags
    const CSS_RE = /^(@keyframes|@media|from[\s{]|to[\s{]|}$|[a-z-]+\s*:\s*.+;\s*$)/i;
    const lines = fullText.split('\n').map(l => l.trim()).filter(l => l && !CSS_RE.test(l));
    log('[dialog-lines]', JSON.stringify(lines));

    // BUTTON_RE: only matches the actual Skip/Submit/Enter button labels.
    // Do NOT include 'no', 'yes', 'allow', 'deny' — those are valid option texts.
    const BUTTON_RE = /^(skip|submit|cancel|close|\u21b5)$/i;
    // Title: first substantive line that is not a button label, not a bare digit, and not an option text.
    // We do a two-pass: first collect options to know what to exclude, but we need title first…
    // Safe heuristic: skip lines that are bare single digits or start with digit+space (option prefixes)
    const dialogTitle = lines.find(l =>
      !BUTTON_RE.test(l) &&
      !/^[1-9][\. ]/.test(l) &&   // not "1 Yes…" or "1. Yes…"
      !/^[1-9]$/.test(l) &&       // not bare "1"
      l.length > 4
    ) || 'Approval required';

    // Extract numbered options — "1 text", "1. text", or digit alone then text on next line
    const seen = new Set();
    const rawOpts = [];
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (/^[1-9]$/.test(l) && i + 1 < lines.length) {
        const next = lines[i + 1];
        if (!BUTTON_RE.test(next) && next.length > 1) { rawOpts.push(l + ' ' + next); i++; continue; }
      }
      if (/^[1-9][ .]/.test(l) && l.length > 4 && l.length < 300) rawOpts.push(l);
    }
    const options = rawOpts
      .filter(t => { if (seen.has(t)) return false; seen.add(t); return true; })
      .map((t, i) => ({ index: i, text: t, isDefault: i === 0 }));

    // Split context into two distinct parts:
    // description = longer sentence/reason line (e.g. "DOM debug test — approve from AG directly.")
    // value       = shorter URL/command line  (e.g. "crates.io" or "git push")
    const optSet     = new Set(rawOpts);
    const optTextSet = new Set(rawOpts.map(t => t.replace(/^\d+[\. ]+/, '').trim()));
    const contextLines = lines.filter(l =>
      l !== dialogTitle &&
      !BUTTON_RE.test(l) &&
      !optSet.has(l) &&
      !optTextSet.has(l) &&
      !/^[1-9]$/.test(l) &&
      l.length > 2 && l.length < 400
    ).slice(0, 5);

    // Value: short URL/command-like line — no spaces, matches URL/path/domain pattern
    // Intentionally strict: avoids matching sentences that happen to contain "/" (e.g. "test 2/3")
    const VALUE_RE = /^[\w./:@-]{1,120}$/;  // URL, domain, command — no spaces
    const valueLines = contextLines.filter(l => l.length <= 80 && VALUE_RE.test(l) && !l.includes(' '));
    const descLines  = contextLines.filter(l => !valueLines.includes(l));

    // command field from scraper takes priority for value
    const value       = command.trim() || valueLines[0] || '';
    const description = descLines.join('\n').trim();
    const context     = [description, value].filter(Boolean).join('\n') || contextLines.join('\n');

    log('dialog — title:', dialogTitle, '| opts:', options.length, '| ctx:', context.slice(0, 80));

    return [{
      type:            'dialog',
      occurrenceIndex: 0,
      title:           dialogTitle,
      command:         command.trim(),
      value,            // the URL / command being approved
      description,      // the reason / description text
      context:         context.trim(),
      options,
      hasSubmit:       true,
      hasSkip:         true,
      submitSelector:  'button[data-tooltip-id="' + submitId + '"]',
      skipSelector:    'button[data-tooltip-id="' + skipId   + '"]',
      selector:        'button',
      matchText:       options[0]?.text || 'Yes, allow this time',
      text:            dialogTitle,
    }];
  } catch (err) {
    log('scrapePendingActions CATCH:', err.message);
    return [];
  }
}


// ─── Broadcast to PWA clients ─────────────────────────────────────────────────

function broadcast(type, data) {
  const payload = JSON.stringify({ type, data, ts: Date.now() });
  for (const client of wsClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

async function scrapeChatList() {
  try {
    const result = await cdpEvaluate(`
      (function() {
        // Active chat name from page title
        const rawTitle = document.title || 'AG';
        const activeName = rawTitle.replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();

        // Current conversation ID from URL
        const currentId = (window.location.pathname.match(/\/c\/([a-f0-9-]+)/) || [])[1] || '';

        // Conversation pills: span[data-testid="convo-pill-{UUID}"]
        const convLinks = [...document.querySelectorAll('[data-testid^="convo-pill-"]')]
          .map(el => {
            const testid = el.getAttribute('data-testid') || '';
            const id = testid.replace('convo-pill-', '');
            const text = (el.textContent || '').trim().replace(/\n+/g, ' ').slice(0, 70);
            const isActive = id === currentId;
            const container = el.closest('[class]') || el.parentElement;
            const hasSpinner = !!(container && container.querySelector('svg[class*="spin"], [class*="generating"]'));
            let project = '';
            let parent = el.parentElement;
            for (let i = 0; i < 8 && parent; i++) {
              const h = parent.querySelector && parent.querySelector('h2, h3');
              if (h && h !== el) { project = (h.textContent || '').trim().slice(0, 30); break; }
              parent = parent.parentElement;
            }
            return { id: id.slice(0, 36), text, isActive, hasSpinner, time: '', project };
          })
          .filter(c => c.text && c.id)
          .slice(0, 30);

        return { activeName, currentId: currentId.slice(0, 8), convLinks };
      })()
    `);
    return result || { activeName: 'AG', currentId: '', convLinks: [] };
  } catch {
    return { activeName: 'AG', currentId: '', convLinks: [] };
  }
}

async function broadcastState() {
  const [chatDump, actions, chatList, cssVars] = await Promise.all([
    scrapeChat(), scrapePendingActions(), scrapeChatList(), scrapeTheme(),
  ]);
  _lastActions = actions;  // cache for use in HTTP handlers
  if (actions.length > 0) {
    log('⚠️  actions detected:', JSON.stringify(actions.map(a => ({type:a.type, text:(a.text||'').slice(0,50), opts:a.options?.length}))));
  }
  broadcast('state', {
    chatDump,          // full AG HTML dump
    cssVars,           // AG CSS custom properties for theming
    actions,
    cdpConnected,
    chatName: chatList.activeName,
    conversations: chatList.convLinks,
  });
}

// ─── AG state detection (typing indicator) ─────────────────────────────────

let lastAgState   = 'idle';
let lastPwaActivity = 0; // epoch ms of last PWA WebSocket message
let _lastArticleCount = 0;
let _lastArticleLen   = 0;
let _growthTicks      = 0;    // consecutive polls where text is growing

async function scrapeAGState() {
  try {
    const result = await cdpEvaluate(`
      (function() {
        const metaSpans = [...document.querySelectorAll('span.text-secondary-foreground')];
        const thinkingSpan = metaSpans.find(s => /^Thinking for\s*\d/i.test((s.innerText||'').trim()));
        const hasStop = !!thinkingSpan;
        const thinkingText = thinkingSpan ? (thinkingSpan.innerText||'').trim() : '';

        const toolSpans = [...document.querySelectorAll('span.truncate.inline-block.text-sm.text-left')];
        const lastTool = toolSpans.length ? (toolSpans[toolSpans.length-1].innerText||'').trim() : '';

        let snippet = thinkingText;
        if (lastTool && lastTool !== thinkingText) {
          snippet = thinkingText ? thinkingText + '  ·  ' + lastTool : lastTool;
        }

        // AI content: p elements NOT inside the input area or sidebar
        const inputArea = document.querySelector('[contenteditable]');
        const paras = [...document.querySelectorAll('p')].filter(p => {
          const t = (p.innerText||'').trim();
          if (t.length < 10) return false;
          if (inputArea && inputArea.contains(p)) return false;
          if (p.closest('.sr-only')) return false;
          return true;
        });
        const lastPara = paras.length ? (paras[paras.length-1].innerText||'').trim() : '';

        const inputEl = document.querySelector('[contenteditable]');
        const isInputBusy =
          (inputEl && inputEl.getAttribute('contenteditable') === 'false') ||
          (inputEl && inputEl.getAttribute('aria-disabled') === 'true') ||
          !!document.querySelector('[aria-busy="true"]');

        return { hasStop, isInputBusy, snippet, thinkingText, lastTool,
                 lastParaLen: lastPara.length, currentText: lastPara.slice(0, 800) };
      })()
    `);
    if (!result) return { state: 'idle', label: '' };

    const { hasStop, isInputBusy, snippet, thinkingText, lastTool, lastParaLen, currentText } = result;
    if (hasStop || isInputBusy) log(`[scrape] thinking="${thinkingText}" tool="${lastTool}" paraLen=${lastParaLen}`);

    if (hasStop) {
      if (lastParaLen < 30) return { state: 'thinking', label: 'Thinking…', snippet, currentText };
      return { state: 'writing', label: 'Writing…', snippet: lastTool || snippet, currentText };
    }
    if (isInputBusy) {
      return { state: 'thinking', label: 'Thinking…', snippet: snippet || 'Working on it…', currentText };
    }

    if (lastParaLen > _lastArticleLen + 5) _growthTicks = 8;
    else if (_growthTicks > 0) _growthTicks--;
    _lastArticleLen = lastParaLen;

    if (_growthTicks > 0) return { state: 'writing', label: 'Writing…', snippet: lastTool || '', currentText };
    return { state: 'idle', label: '', snippet: '', currentText: '' };
  } catch (err) {
    log('scrapeAGState error:', err.message);
    return { state: 'idle', label: '' };
  }
}


// Fast 500ms interval just for typing indicator
let _tickCount = 0;
let _lastSnippetSeen  = '';
let _lastCurrentText  = '';  // last non-empty currentText from scrapeAGState — actual response
let _pendingAskResolvers = []; // resolvers waiting for next AG idle transition
let _macCheckTick = 0;
setInterval(async () => {
  if (!cdpConnected) return;  // run even if no PWA, for background watch
  const hasClients = wsClients.size > 0;
  if (!hasClients && lastAgState === 'idle') return; // nothing to track
  _tickCount++;
  if (_tickCount % 10 === 1) log(`[tick] #${_tickCount} clients=${wsClients.size} lastState=${lastAgState}`);


  try {
    const agStateData = await scrapeAGState();
    if (agStateData.snippet)      _lastSnippetSeen = agStateData.snippet;
    if (agStateData.currentText)  _lastCurrentText  = agStateData.currentText;
    if (agStateData.state !== 'idle' || lastAgState !== 'idle') {
      log(`[state] ${lastAgState}\u2192${agStateData.state} ticks=${_growthTicks}`);
    }
    if (agStateData.state !== lastAgState) {
      const prev = lastAgState;
      lastAgState = agStateData.state;
      if (hasClients) broadcast('ag_state', agStateData);
      log(`[broadcast] ag_state=${agStateData.state}`);
      // When AG finishes (writing/thinking → idle): push full message list + fire /ask resolvers
      if (agStateData.state === 'idle' && (prev === 'writing' || prev === 'thinking')) {
        broadcastState().catch(() => {}); // push updated chat messages
        scheduleIdleDigest(_lastSnippetSeen);
        // Fire any pending /ask resolvers with the last captured response text
        if (_pendingAskResolvers.length > 0) {
          const resolvers = _pendingAskResolvers.splice(0);
          const replyText = _lastCurrentText || _lastSnippetSeen || '';
          for (const r of resolvers) r(replyText);
          log(`[/ask] fired ${resolvers.length} resolver(s) — text length: ${replyText.length}`);
        }
      }
    } else if (hasClients && agStateData.state !== 'idle') {
      // Still writing/thinking — stream currentText to ghost bubble every tick
      broadcast('ag_state', agStateData);
    }
  } catch(e) { log('[interval-err]', e.message); }
}, 500);

// ─── Mac Presence Detection ──────────────────────────────────────────────────
// Independent 5s interval — runs regardless of AG state or PWA connection.
// HIDIdleTime = seconds since last keyboard/mouse input on the Mac.
setInterval(() => {
  exec("ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF/1000000000; exit}'",
    { timeout: 2000 },
    (err, stdout) => {
      if (err) return;
      const idleSec = parseFloat(stdout.trim());
      if (isNaN(idleSec)) return;
      const prev = macActive;
      macActive = idleSec < IDLE_THRESHOLD_S;
      if (macActive !== prev) {
        log(`[macActive] ${prev} → ${macActive} (idle=${idleSec.toFixed(1)}s, threshold=${IDLE_THRESHOLD_S}s)`);
        broadcastSettings();
      }
    }
  );
}, 5000);

// ─── Action Sync: clear PWA actions when resolved on Mac ─────────────────────
// Runs every 1s when PWA clients are connected.
// broadcastState() only fires on AG state transitions, so if a dialog is
// approved on Mac while AG is already idle, the PWA would never know.
// ─── Action resolution tracking ────────────────────────────────────────────
let _pendingActionSource = null; // 'PWA' | 'Telegram' | null (null = Mac)

function broadcastActionResolved(source) {
  log(`[action-resolved] source=${source}`);
  broadcast('action_resolved', { source });
  // Notify Telegram about modals that were alerted there but resolved elsewhere
  // Only send if: (a) action came from Telegram originally, OR (b) notifications not suppressed
  if (source !== 'Telegram' && _alertedActionMap.size > 0) {
    const resolvedIn = source === 'PWA' ? 'PWA' : 'AG';
    if (!isTelegramSuppressedInfo()) {
      for (const [key, info] of _alertedActionMap) {
        const label = info.val ? `${info.title}\n\`${info.val}\`` : info.title;
        telegramNotifyInline(`↩️ *Handled in ${resolvedIn}* — ${label}`, []);
      }
    }
    _alertedActionMap.clear();
  }
  if (!isTelegramSuppressedInfo()) {
    let msg;
    if (source === 'Telegram') msg = '✅ *Confirmed — AG dialog resolved*';
    else if (source === 'PWA')  msg = '📱 *Action resolved from PWA*';
    else                        msg = '🖥️ *Action resolved from Mac*';
    telegramNotifyInline(msg, []);
  }
  _pendingActionSource = null;
  _lastActionCount = 0;   // prevent 3s interval from also firing a duplicate resolution
}

// ─── Sync actions to PWA while open ────────────────────────────────────────
let _lastActionSig = '';
setInterval(async () => {
  if (!cdpConnected || wsClients.size === 0) return;
  try {
    const acts = await scrapePendingActions();
    const sig = acts.map(a => a.occurrenceIndex + ':' + (a.text || '').slice(0, 30)).join('|');
    if (sig !== _lastActionSig) {
      const hadActions = _lastActionSig !== '';
      _lastActionSig = sig;
      log(`[action-sync] changed → ${acts.length} actions`);
      if (hadActions && sig === '') {
        // Actions cleared — broadcast resolution and immediately reset dedup set
        // so the next identical-looking modal is treated as a new notification
        _alertedActionKeys.clear();
        broadcastActionResolved(_pendingActionSource || 'Mac');
      }
      broadcastState().catch(() => {});
    }
  } catch { /* silent */ }
}, 1000);

// Background Watch: push new actions to Telegram (runs regardless of PWA state)
let _lastActionCount = 0;
let _alertedActionKeys = new Set(); // dedup — don't spam same action
let _alertedActionMap  = new Map(); // key → {title, val} for AG-resolution notice
setInterval(async () => {
  if (!cdpConnected) return;
  try {
    const acts = await scrapePendingActions();
    const currentKeys = new Set();
    // Notify Telegram for any new actions not yet alerted
    for (const a of acts) {
      // Key must distinguish same-title dialogs with different commands/URLs
      const key = [
        (a.text    || '').slice(0, 50),
        (a.context || a.command || '').slice(0, 50),
        (a.options || []).map(o => o.text).join('|').slice(0, 40),
      ].join('§');
      currentKeys.add(key);
      if (!_alertedActionKeys.has(key)) {
        _alertedActionKeys.add(key);
        _alertedActionMap.set(key, {
          title:   (a.title || a.text || 'Action').slice(0, 60),
          val:     (a.value || a.command || '').slice(0, 60),
          options: a.options || [],
        });
        sendActionToTelegram(a);
      }
    }

    // Detect alerted modals that disappeared without Telegram action → notify correct source
    // Only send if notifications are not suppressed (mute/notify state respected)
    if (_pendingActionSource !== 'Telegram' && !isTelegramSuppressedInfo()) {
      const resolvedIn = _pendingActionSource === 'PWA' ? 'PWA' : 'AG';
      for (const [key, info] of _alertedActionMap) {
        if (!currentKeys.has(key)) {
          const label = info.val ? `${info.title}\n\`${info.val}\`` : info.title;
          telegramNotifyInline(`↩️ *Handled in ${resolvedIn}* — ${label}`, []);
          _alertedActionMap.delete(key);
        }
      }
    } else if (_pendingActionSource !== 'Telegram') {
      // Suppressed — still clean up the map silently
      for (const [key] of _alertedActionMap) {
        if (!currentKeys.has(key)) _alertedActionMap.delete(key);
      }
    }

    // Track count for resolution detection (fallback for PWA-closed case)
    if (acts.length !== _lastActionCount) {
      if (acts.length === 0 && _lastActionCount > 0 && wsClients.size === 0) {
        // PWA closed — call broadcastActionResolved which now handles all sources
        broadcastActionResolved(_pendingActionSource || 'Mac');
      }
      if (acts.length === 0) {
        _alertedActionKeys.clear();
        _alertedActionMap.clear();
      }
      _lastActionCount = acts.length;
    }
  } catch { /* ignore */ }
}, 3000);


// ─── CDP click/input injection ────────────────────────────────────────────────

async function clickElement(selector, occurrenceIndex = 0, matchText = null) {
  await cdpEvaluate(`
    (function() {
      let els = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
      // If matchText provided, filter by button text (for allow buttons)
      if (${JSON.stringify(matchText)}) {
        els = els.filter(el => (el.innerText || el.textContent || '').trim().includes(${JSON.stringify(matchText)}));
      }
      if (els[${occurrenceIndex}]) els[${occurrenceIndex}].click();
    })()
  `);
}

async function typeIntoInput(text) {
  // Step 1: Focus the contenteditable div via JS
  await cdpEvaluate(`
    (function() {
      const el = document.querySelector('div[aria-label="Message input"]') ||
                 document.querySelector('div[contenteditable="true"]');
      if (!el) return false;
      el.focus();
      // Clear any existing content
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('delete', false);
      return true;
    })()
  `);
  await new Promise(r => setTimeout(r, 100));
  // Step 2: Use CDP Input.insertText — works natively with React contenteditable
  await cdpSend('Input.insertText', { text }, null);
  await new Promise(r => setTimeout(r, 100));
}

async function clickSend() {
  // Use CDP Input.dispatchKeyEvent with Enter — native keypress, React handles it
  await cdpSend('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  }, null);
  await new Promise(r => setTimeout(r, 50));
  await cdpSend('Input.dispatchKeyEvent', {
    type: 'keyUp',
    key: 'Enter',
    code: 'Enter',
    windowsVirtualKeyCode: 13,
    nativeVirtualKeyCode: 13,
  }, null);
}

// ─── CDP connection ───────────────────────────────────────────────────────────

function getCdpPageList() {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://${CDP_HOST}:${CDP_PORT}/json`, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('CDP timeout')); });
  });
}

async function connectCDP() {
  try {
    log('Getting CDP page list...');
    const pages = await getCdpPageList();
    log(`CDP: ${pages.length} page(s) found`);

    // Find the main AG window (not devtools, not extensions)
    const page = pages.find(p =>
      p.type === 'page' &&
      !p.url.startsWith('devtools://') &&
      !p.url.startsWith('chrome-extension://')
    ) || pages[0];

    if (!page?.webSocketDebuggerUrl) {
      throw new Error('No suitable CDP page found');
    }

    log('Connecting to CDP page:', page.title, page.url);

    cdpWs = new WebSocket(page.webSocketDebuggerUrl);

    cdpWs.on('open', async () => {
      log('✅ CDP connected');
      cdpConnected = true;
      cdpReconnectAttempts = 0;
      sessionId = null; // Direct connection, no session

      // Enable required CDP domains
      await cdpSend('Page.enable');
      await cdpSend('DOM.enable');
      await cdpSend('Runtime.enable');

      log('CDP domains enabled. Scraping initial state...');
      await broadcastState();
    });

    cdpWs.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      // Resolve pending requests
      if (msg.id && pendingRequests[msg.id]) {
        const { resolve, reject } = pendingRequests[msg.id];
        delete pendingRequests[msg.id];
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg);
        return;
      }

      // Handle DOM events → re-scrape
      if (msg.method === 'DOM.documentUpdated' || msg.method === 'Page.loadEventFired') {
        log('DOM updated — re-scraping...');
        await broadcastState();
      }
    });

    cdpWs.on('close', () => {
      log('CDP connection closed');
      cdpConnected = false;
      sessionId = null;
      broadcast('status', { cdpConnected: false });
      scheduleReconnect();
    });

    cdpWs.on('error', (err) => {
      log('CDP error:', err.message);
      cdpConnected = false;
    });

  } catch (err) {
    log('CDP connect failed:', err.message);
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (cdpReconnectAttempts >= MAX_CDP_RECONNECTS) {
    log('Max CDP reconnects reached. Giving up.');
    return;
  }
  cdpReconnectAttempts++;
  const delay = 5000;
  log(`CDP reconnect in ${delay}ms (attempt ${cdpReconnectAttempts}/${MAX_CDP_RECONNECTS})`);
  setTimeout(connectCDP, delay);
}

// ─── Launch AG if needed ──────────────────────────────────────────────────────

async function ensureAGRunning() {
  // Check if CDP port is already open
  try {
    execSync(`lsof -ti :${CDP_PORT}`, { stdio: 'pipe' });
    log(`Port ${CDP_PORT} already open — connecting to existing AG instance`);
    return; // Already running with debug port
  } catch {
    // Port not open — need to launch AG
  }

  log('Launching Antigravity with remote debugging port...');
  exec(`open -a "Antigravity" --args --remote-debugging-port=${CDP_PORT}`, (err) => {
    if (err) log('Launch warning:', err.message);
  });

  log('Waiting 6s for AG to start...');
  await new Promise(r => setTimeout(r, 6000));
}

// ─── HTTP server (PWA + auth) ─────────────────────────────────────────────────

const AUTH_TOKENS = new Set(); // Active session tokens
// Restore saved sessions (survives bridge restarts — ngrok URL stays same)
try {
  const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (Array.isArray(saved.authTokens)) saved.authTokens.forEach(t => AUTH_TOKENS.add(t));
  log(`[auth] restored ${AUTH_TOKENS.size} session token(s) from disk`);
} catch { /* no saved tokens yet */ }

function generateToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

function parseBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { resolve({}); }
    });
  });
}

function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie || '';
  header.split(';').forEach(c => {
    const [k, ...v] = c.trim().split('=');
    if (k) cookies[k.trim()] = decodeURIComponent(v.join('='));
  });
  return cookies;
}

function isAuthenticated(req) {
  const cookies = parseCookies(req);
  return AUTH_TOKENS.has(cookies.ag_token);
}

const httpServer = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost`);

  // GET /tunnel-url — daemon calls this for /wpa command (localhost only, no auth needed)
  if (req.method === 'GET' && url.pathname === '/tunnel-url') {
    // If cloudflared has a URL, return it immediately
    if (tunnelUrl) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tunnelUrl, password: REMOTE_PASSWORD }));
      return;
    }
    // Fallback: check ngrok API (port 4040) in case ngrok is running
    try {
      const ngrokData = await new Promise((resolve, reject) => {
        const r = require('http').get('http://localhost:4040/api/tunnels', (resp) => {
          let d = ''; resp.on('data', c => d += c);
          resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        r.on('error', reject);
        r.setTimeout(500, () => { r.destroy(); reject(new Error('timeout')); });
      });
      const ngrokUrl = ngrokData?.tunnels?.[0]?.public_url || null;
      if (ngrokUrl) tunnelUrl = ngrokUrl; // cache it
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tunnelUrl: ngrokUrl, password: REMOTE_PASSWORD }));
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tunnelUrl: null, password: REMOTE_PASSWORD }));
    }
    return;
  }

  // POST /action-response — Telegram inline button callback routed via daemon
  if (req.method === 'POST' && url.pathname === '/action-response') {
    const body = await parseBody(req);
    const { idx, optionIndex, decision } = body;
    _pendingActionSource = 'Telegram';
    const optIdx = typeof optionIndex !== 'undefined' ? Number(optionIndex) : (decision === 'allow' ? 0 : -1);
    if (optIdx >= 0) {
      // Debounce: ignore duplicate taps on the same modal within 5s
      const lastClick = _clickDebounce.get(String(idx)) || 0;
      if (Date.now() - lastClick < 5000) {
        log(`[action-response] debounced duplicate tap for idx=${idx}`);
        res.writeHead(200); res.end(JSON.stringify({ ok: true, debounced: true }));
        return;
      }
      _clickDebounce.set(String(idx), Date.now());
      setTimeout(() => _clickDebounce.delete(String(idx)), 6000);
      // Find the action so we can report which option text was clicked
      const act     = _lastActions.find(a => String(a.occurrenceIndex) === String(idx));
      // Fallback: look up options stored in _alertedActionMap at notification time
      const mapEntry = Array.from(_alertedActionMap.values()).find(m => m.options?.[optIdx]);
      const optText  = act?.options?.[optIdx]?.text?.replace(/^\d+[. ]+/, '').slice(0, 60)
                    || mapEntry?.options?.[optIdx]?.text?.replace(/^\d+[. ]+/, '').slice(0, 60)
                    || `option ${optIdx + 1}`;
      try {
        await clickAction(optIdx);
        log(`[action-response] clicked option ${optIdx} — "${optText}"`);
        telegramNotifyInline(`⏳ *Clicking:* ${optText}`, []);
        setTimeout(() => telegramNotifyInline(`✅ *Done* — AG resumed`, []), 2500);
      } catch(e) {
        log('[action-response] clickAction error:', e.message);
        telegramNotifyInline(`❌ Click failed: ${e.message}`, []);
      }
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    } else {
      // Dismiss locally
      _lastActions = _lastActions.filter(a => a.occurrenceIndex !== Number(idx));
      broadcast('actions', { actions });
      if (!isTelegramSuppressed()) telegramNotifyInline(`❌ *Dismissed* — AG skips this action`, []);
      res.writeHead(200); res.end(JSON.stringify({ ok: true }));
    }
    return;
  }

  // POST /auth — password check

  if (req.method === 'POST' && url.pathname === '/auth') {
    const body = await parseBody(req);
    if (body.password === REMOTE_PASSWORD) {
      const token = generateToken();
      AUTH_TOKENS.add(token);
      saveSettings(); // persist so bridge restart doesn't invalidate this session
      res.writeHead(200, {
        'Set-Cookie': `ag_token=${token}; Path=/; HttpOnly; SameSite=Lax`,
        'Content-Type': 'application/json',
      });
      res.end(JSON.stringify({ ok: true, token })); // token returned so PWA can embed in WS URL
    } else {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Invalid password' }));
    }
    return;
  }

  // GET /debug — raw CDP snapshot for state detection troubleshooting
  if (req.method === 'GET' && url.pathname === '/debug') {
    if (!isAuthenticated(req)) { res.writeHead(401); res.end(); return; }
    try {
      const snap = await cdpEvaluate(`(function(){
        const articles = document.querySelectorAll('[role="article"]');
        const inputEl  = document.querySelector('[contenteditable]');
        const stopBtns = [...document.querySelectorAll('button')].filter(b =>
          (b.getAttribute('aria-label')||'').toLowerCase().includes('stop') ||
          (b.innerText||'').trim().toLowerCase() === 'stop'
        );
        const ariaBusy = document.querySelector('[aria-busy="true"]');
        const dataLoad = document.querySelector('[data-state="loading"]');
        return {
          articleCount: articles.length,
          lastArticleLen: (articles[articles.length-1]?.innerText||'').trim().length,
          contenteditable: inputEl?.getAttribute('contenteditable'),
          ariaDisabled:    inputEl?.getAttribute('aria-disabled'),
          ariaBusy:        !!ariaBusy,
          dataLoading:     !!dataLoad,
          stopBtnCount:    stopBtns.length,
          stopBtnLabels:   stopBtns.map(b => b.getAttribute('aria-label')||b.innerText).slice(0,3),
          pageTitle:       document.title.slice(0,60),
        };
      })()`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(snap, null, 2));
    } catch(e) {
      res.writeHead(500); res.end(e.message);
    }
    return;
  }

  // POST /cmd — smart routing

  // PWA open  → execute locally, return result to PWA WebSocket only
  // PWA closed → execute locally, return result via Telegram
  // Remote ops → always blocked, require Sovereign Console approval
  if (req.method === 'POST' && url.pathname === '/cmd') {
    const isLocal = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1';
    if (!isLocal && !isAuthenticated(req)) { res.writeHead(401); res.end(); return; }
    const body = await parseBody(req);
    const cmd  = String(body.command || '').trim();
    if (!cmd) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Missing command' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, queued: true }));
    executeCommand(cmd).then(result => {
      // Telegram-originated commands (from daemon on localhost) always reply via Telegram.
      // PWA-originated commands use smartNotify (routes to PWA or Telegram based on state).
      if (isLocal) telegramNotifyInline(result, []);
      else smartNotify(result);
    }).catch(err => {
      if (isLocal) telegramNotifyInline(`❌ Command error: ${err.message}`, []);
      else smartNotify(`❌ Command error: ${err.message}`);
    });
    return;
  }

  // GET / — serve PWA (auth required)
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    const htmlPath = path.join(__dirname, 'remote-ui', 'index.html');
    if (!isAuthenticated(req)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(loginHtml());
      return;
    }
    // If no token in URL, redirect with the cookie token embedded
    // — fixes iOS WebKit not sending HttpOnly cookies on WS upgrade requests
    if (!url.searchParams.get('token')) {
      const cookies = parseCookies(req);
      const token = cookies.ag_token;
      res.writeHead(302, { 'Location': `/?token=${encodeURIComponent(token)}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    try {
      const html = fs.readFileSync(htmlPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end('remote-ui/index.html not found');
    }
    return;
  }

  // GET /status — health check
  if (url.pathname === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, cdpConnected, tunnelUrl, clients: wsClients.size }));
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

function loginHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeniOS Remote — Login</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #0f0f13; color: #e2e8f0; font-family: -apple-system, sans-serif;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; }
  .card { background: #1a1a2e; border: 1px solid #2d2d4e; border-radius: 16px;
          padding: 32px; width: 320px; text-align: center; }
  h1 { font-size: 20px; margin-bottom: 8px; color: #a78bfa; }
  p  { font-size: 13px; color: #64748b; margin-bottom: 24px; }
  input { width: 100%; padding: 12px 16px; background: #0f0f1a; border: 1px solid #2d2d4e;
          border-radius: 8px; color: #e2e8f0; font-size: 16px; letter-spacing: 2px; margin-bottom: 16px; }
  input:focus { outline: none; border-color: #7c3aed; }
  button { width: 100%; padding: 12px; background: #7c3aed; border: none; border-radius: 8px;
           color: white; font-size: 16px; font-weight: 600; cursor: pointer; }
  button:hover { background: #6d28d9; }
  .err { color: #f87171; font-size: 13px; margin-top: 12px; display: none; }
</style>
</head>
<body>
<div class="card">
  <h1>🔒 GeniOS Remote</h1>
  <p>Enter your remote access password</p>
  <input type="password" id="pw" placeholder="••••••••" autocomplete="current-password">
  <button onclick="login()">Unlock</button>
  <div class="err" id="err">Incorrect password</div>
</div>
<script>
  document.getElementById('pw').addEventListener('keydown', e => e.key === 'Enter' && login());
  async function login() {
    const pw = document.getElementById('pw').value;
    const r = await fetch('/auth', { method: 'POST', headers: {'Content-Type':'application/json'},
                                      body: JSON.stringify({ password: pw }) });
    if (r.ok) {
      const data = await r.json();
      // Redirect with token in URL — bypasses iOS WebKit SameSite cookie issues on WS
      location.href = '/?token=' + encodeURIComponent(data.token || '');
    } else { document.getElementById('err').style.display = 'block'; }
  }
</script>
</body>
</html>`;
}

// ─── WebSocket server ─────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

wss.on('connection', (ws, req) => {
  // Auth check via cookie
  const cookies = parseCookies(req);
  if (!AUTH_TOKENS.has(cookies.ag_token)) {
    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token');
    if (!AUTH_TOKENS.has(token)) {
      // Send auth_failed message first (close codes stripped by ngrok)
      try { ws.send(JSON.stringify({ type: 'auth_failed' })); } catch {}
      setTimeout(() => ws.close(4001, 'Unauthorized'), 100);
      return;
    }
  }

  log('PWA client connected. Total:', wsClients.size + 1);
  _hadConnection = true; // suppress startup notification from now on
  wsClients.add(ws);
  lastPwaActivity = Date.now();
  ws.send(JSON.stringify({ type: 'status',   data: { cdpConnected, tunnelUrl } }));
  ws.send(JSON.stringify({ type: 'settings', data: { macActive, telegramMuted } }));

  // Send initial state + any pending actions immediately on connect
  broadcastState().catch(() => {});
  scrapePendingActions().then(acts => {
    if (acts.length > 0) {
      ws.send(JSON.stringify({ type: 'actions', data: { actions: acts } }));
      log(`[connect] pushed ${acts.length} pending action(s) to new PWA client`);
    }
  }).catch(() => {});

  ws.on('message', async (raw) => {
    lastPwaActivity = Date.now(); // track activity
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'click':
        // Click a specific element by selector + occurrence index
        await clickElement(msg.selector || 'button', msg.occurrenceIndex ?? 0, msg.matchText);
        await new Promise(r => setTimeout(r, 500));
        await broadcastState();
        break;

      case 'send_message':
        // Type text into AG input and send
        if (msg.text) {
          log('send_message received:', msg.text.slice(0, 80));
          try {
            await typeIntoInput(msg.text);
            await new Promise(r => setTimeout(r, 300));
            await clickSend();
            log('send_message: injected + Enter sent');
            await new Promise(r => setTimeout(r, 1500));
            await broadcastState();
          } catch (err) {
            log('send_message error:', err.message);
          }
        }
        break;

      case 'stop':
        // Click the AG Stop button via CDP
        log('stop requested from PWA');
        await cdpEvaluate(`
          (function() {
            const btn = [...document.querySelectorAll('button')].find(b =>
              (b.getAttribute('aria-label') || '').toLowerCase() === 'stop' ||
              (b.innerText || b.textContent || '').trim().toLowerCase() === 'stop'
            );
            if (btn) { btn.click(); return true; }
            return false;
          })()
        `);
        await new Promise(r => setTimeout(r, 500));
        await broadcastState();
        break;

      case 'refresh':
        // Immediate state re-broadcast — used by PWA after interactions
        await broadcastState();
        break;

      case 'set_telegram_muted':
        telegramMuted = !!msg.value;
        log(`[settings] telegramMuted → ${telegramMuted} (from PWA)`);
        saveSettings();
        broadcastSettings();
        break;

      case 'set_tunnel_mode':
        if (msg.value === 'ngrok' || msg.value === 'cloudflare') {
          tunnelMode = msg.value;
          log(`[settings] tunnelMode → ${tunnelMode} (from PWA)`);
          saveSettings();
          broadcastSettings();
        }
        break;

      case 'navigate_conversation': {
        const convId = (msg.id || '').replace(/[^a-f0-9-]/g, '').slice(0, 36);
        if (!convId) break;
        log(`[navigate] switching to conversation ${convId}`);
        await cdpEvaluate(`
          (function() {
            var link = document.querySelector('a[href*="/c/${convId}"]');
            if (link) { link.click(); return 'clicked'; }
            return 'not found';
          })()
        `);
        // Wait for AG to load the conversation, then push updated state
        await new Promise(r => setTimeout(r, 1800));
        await broadcastState();
        break;
      }

      case 'action_source':
        // PWA signals it is about to take action — set source so resolution detector knows
        if (msg.source === 'PWA') _pendingActionSource = 'PWA';
        break;

      case 'evaluate':
        // Execute JS in AG DOM, then immediately re-broadcast state so
        // collapsible toggles and other interactions feel near-instant.
        if (msg.expression) {
          const val = await cdpEvaluate(msg.expression);
          ws.send(JSON.stringify({ type: 'eval_result', data: val }));
          await new Promise(r => setTimeout(r, 350));
          await broadcastState();
        }
        break;
    }
  });

  ws.on('close', () => {
    wsClients.delete(ws);
    log('PWA client disconnected. Total:', wsClients.size);
  });
});

// ─── Poll for DOM changes + pending action alerts ────────────────────────────

let lastAlertedActions = new Set(); // Avoid spamming Telegram for same action

setInterval(async () => {
  if (!cdpConnected) return;

  // Always check AG state for typing indicator
  const agStateData = await scrapeAGState();
  if (agStateData.state !== lastAgState) {
    lastAgState = agStateData.state;
    broadcast('ag_state', agStateData);
  }

  // EOD auto-schedule check (once per minute is fine since interval is 2s)
  checkEODSchedule().catch(() => {});

  if (wsClients.size > 0) {
    broadcastState().catch(() => {});
  } else {
    // PWA closed — scrape actions for resolution detection only (Telegram handled by 3s interval)
    try {
      const acts = await scrapePendingActions();
      if (acts.length === 0) lastAlertedActions.clear();
    } catch { /* silent */ }
  }
}, 2000);

// ─── Tunnel helpers ──────────────────────────────────────────────────────────

function setTunnel(url, provider) {
  tunnelUrl = url;
  activeTunnelProvider = provider;
  log(`✅ Tunnel URL (${provider}):`, url);
  broadcast('status', { cdpConnected, tunnelUrl });
  broadcastSettings();
  setTimeout(() => {
    const recentActivity = _hadConnection ||
      (Date.now() - _restoredLastConnectionAt < 30 * 60 * 1000); // active in last 30 min
    if (wsClients.size === 0 && !recentActivity && !isTelegramSuppressedInfo()) {
      telegramNotifyInline(
        `🌐 *AG Bridge online*\n\nURL: ${tunnelUrl}\n\nType /wpa anytime to get the link again.`,
        []
      );
    }
  }, 60_000);
}

function getNgrokUrlOnce() {
  return new Promise((resolve, reject) => {
    const r = require('http').get('http://localhost:4040/api/tunnels', (resp) => {
      let d = ''; resp.on('data', c => d += c);
      resp.on('end', () => { try { resolve(JSON.parse(d)?.tunnels?.[0]?.public_url || null); } catch(e) { reject(e); } });
    });
    r.on('error', reject);
    r.setTimeout(2000, () => { r.destroy(); reject(new Error('timeout')); });
  });
}

// ─── cloudflared tunnel ───────────────────────────────────────────────────────

let cloudflareEnabled = false;

function startCloudflared() {
  cloudflareEnabled = true;
  log('Starting cloudflared tunnel...');
  const cf = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${BRIDGE_PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  function parseTunnelUrl(data) {
    const str = data.toString();
    const match = str.match(/https:\/\/[a-z0-9]+-[a-z0-9-]+\.trycloudflare\.com/);
    if (match && !tunnelUrl) {
      setTunnel(match[0], 'cloudflare');
    }
  }

  cf.stdout.on('data', parseTunnelUrl);
  cf.stderr.on('data', parseTunnelUrl);

  cf.on('close', (code) => {
    if (!cloudflareEnabled) {
      log('cloudflared closed — not restarting (ngrok mode active)');
      return;
    }
    if (activeTunnelProvider === 'cloudflare') tunnelUrl = null;
    const delay = 45_000 + Math.random() * 15_000;
    log(`cloudflared exited (${code}). Restarting in ${Math.round(delay / 1000)}s…`);
    setTimeout(startCloudflared, delay);
  });

  cf.on('error', (err) => {
    log('cloudflared error:', err.message);
    log('Is cloudflared installed? Run: brew install cloudflared');
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  log('═══════════════════════════════════════════════');
  log('GeniOS AG Remote Control Bridge §13.3 starting');
  log(`HTTP/WS port: ${BRIDGE_PORT}`);
  log(`Remote password: ${REMOTE_PASSWORD}`);
  log('═══════════════════════════════════════════════');

  httpServer.listen(BRIDGE_PORT, () => {
    log(`Server listening on http://localhost:${BRIDGE_PORT}`);
  });

  await ensureAGRunning();
  await connectCDP();

  if (tunnelMode === 'cloudflare') {
    log('[tunnel] Mode: cloudflare (primary)');
    startCloudflared();
  } else {
    log('[tunnel] Mode: ngrok (primary), cloudflare (fallback)');
    // Poll ngrok API every 5s for up to 60s
    let ngrokPollCount = 0;
    const ngrokPollTimer = setInterval(async () => {
      try {
        const url = await getNgrokUrlOnce();
        if (url && !tunnelUrl) {
          clearInterval(ngrokPollTimer);
          setTunnel(url, 'ngrok');
        }
      } catch { /* ngrok not ready yet */ }
      if (++ngrokPollCount >= 12) clearInterval(ngrokPollTimer); // stop after 60s
    }, 5_000);
    // Cloudflare fallback if ngrok not found after 60s
    setTimeout(() => {
      clearInterval(ngrokPollTimer);
      if (!tunnelUrl) {
        log('[tunnel] Ngrok not found — starting cloudflare fallback');
        startCloudflared();
      }
    }, 62_000);
  }

  // ─── ngrok URL watcher ─────────────────────────────────────────────────────
  // Polls ngrok API every 10s. When the URL changes (e.g. after ngrok restart),
  // auto-notifies Telegram so Marwan always has the current link.
  let _lastNgrokUrl = null;
  setInterval(async () => {
    try {
      const data = await new Promise((resolve, reject) => {
        const r = require('http').get('http://localhost:4040/api/tunnels', (resp) => {
          let d = ''; resp.on('data', c => d += c);
          resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        r.on('error', reject);
        r.setTimeout(1000, () => { r.destroy(); reject(new Error('timeout')); });
      });
      const url = data?.tunnels?.[0]?.public_url || null;
      if (!url) return;
      if (url !== _lastNgrokUrl) {
        _lastNgrokUrl = url;
        if (!tunnelUrl || tunnelUrl === url.replace(/\/$/, '')) {
          tunnelUrl = url;
        }
        log('📡 ngrok URL changed →', url);
        // Silent update only — /wpa is the sole Telegram trigger
        broadcast('status', { cdpConnected, tunnelUrl: url });
      }
    } catch { /* ngrok not running */ }
  }, 10_000);

  // Ngrok fallback: if cloudflared has no URL after 3 min, check ngrok API
  // (PM2 manages ngrok — never spawn a second instance)
  setTimeout(async () => {
    if (tunnelUrl) return; // already have a URL
    try {
      const data = await new Promise((resolve, reject) => {
        const r = require('http').get('http://localhost:4040/api/tunnels', (resp) => {
          let d = ''; resp.on('data', c => d += c);
          resp.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
        });
        r.on('error', reject);
        r.setTimeout(1000, () => { r.destroy(); reject(new Error('timeout')); });
      });
      const url = data?.tunnels?.[0]?.public_url || null;
      if (url) { tunnelUrl = url; log('✅ Ngrok fallback URL (from API):', url); }
    } catch { log('Ngrok fallback: API not reachable'); }
  }, 3 * 60 * 1000);
}

main().catch((err) => {
  log('Fatal error:', err);
  process.exit(1);
});
