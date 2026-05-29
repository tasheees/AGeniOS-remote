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

const BRIDGE_VERSION  = '1.5.0'; // W5: Command Palette + Menu Bar
const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const REMOTE_PASSWORD = process.env.REMOTE_PASSWORD || randomPassword();
const BRIDGE_PORT     = parseInt(process.env.BRIDGE_PORT || '9100', 10);
const CDP_HOST        = 'localhost';
// CDP_PORT: AG_CDP_PORT env var → DevToolsActivePort auto-detect → fallback 9222
function detectCdpPort() {
  if (process.env.AG_CDP_PORT) return parseInt(process.env.AG_CDP_PORT, 10);
  try {
    const devToolsFile = require('path').join(
      require('os').homedir(),
      'Library/Application Support/Antigravity/DevToolsActivePort'
    );
    const port = parseInt(require('fs').readFileSync(devToolsFile, 'utf8').split('\n')[0].trim(), 10);
    if (port > 0) { log(`[cdp] Auto-detected port ${port} from DevToolsActivePort`); return port; }
  } catch { /* not on macOS or file missing */ }
  return 9222;
}
let CDP_PORT = detectCdpPort();
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
    if ((_lastActions || []).length > 0 || _lastActionCount > 0) return; // dialog pending — don't interrupt
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
        // Strip Tailwind classes and inline styles — but PRESERVE semantic classes for PWA styling
        var _keepClass = /^(language-|files-changed|text-green|text-red|review-button|text-secondary|text-muted|truncate|rounded)/;
        Array.from(clone.querySelectorAll('[class]')).forEach(function(e){
          var kept = Array.from(e.classList).filter(function(c){ return _keepClass.test(c); });
          e.removeAttribute('class');
          kept.forEach(function(c){ e.classList.add(c); });
        });
        Array.from(clone.querySelectorAll('[style]')).forEach(function(e){ e.removeAttribute('style'); });
         Array.from(clone.querySelectorAll('img')).forEach(function(img){
           var src = img.getAttribute('src') || '';
           var alt = (img.getAttribute('alt') || '').trim();
           var sp = document.createElement('span');
           sp.textContent = alt || '\uD83D\uDCC4';
           var idx = src.lastIndexOf('/files/');
           if (idx >= 0) {
             var after = src.substring(idx + 7);
             var dot = after.indexOf('.');
             if (dot > 0) sp.setAttribute('data-file-icon', after.substring(0, dot).toLowerCase());
           }
           img.parentNode.replaceChild(sp, img);
         });
         // Strip data-* but PRESERVE data-state (open/closed collapsible state)
         Array.from(clone.querySelectorAll('*')).forEach(function(n){
           Array.from(n.attributes).filter(function(a){
             return a.name.startsWith('data-') && a.name !== 'data-state' && a.name !== 'data-file-icon';
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
        try {
          var rawTitle = document.title || 'AG';
          var activeName = rawTitle.replace(/&quot;/g, '"').replace(/&amp;/g, '&').trim();
          var currentId = (window.location.pathname.match(/\\/c\\/([a-f0-9-]+)/) || [])[1] || '';
          var pills = document.querySelectorAll('[data-testid^="convo-pill-"]');
          var convLinks = [];
          for (var i = 0; i < pills.length && i < 30; i++) {
            var el = pills[i];
            var testid = el.getAttribute('data-testid') || '';
            var id = testid.replace('convo-pill-', '');
            var text = (el.textContent || '').trim().replace(/\\n+/g, ' ').slice(0, 70);
            var isActive = id === currentId;
            // Find the row container
            var row = el.closest('[role="button"]');
            // Time indicator: small text like "2h", "6d", "3m"
            var time = '';
            if (row) {
              var spans = row.querySelectorAll('span, div');
              for (var t = 0; t < spans.length; t++) {
                var st = spans[t].textContent.trim();
                if (st && st.length <= 4 && /^[0-9]+[smhdw]$/.test(st)) { time = st; break; }
              }
            }
            // Spinner: any SVG with animate/animateTransform inside row
            var hasSpinner = false;
            if (row) {
              var svgs = row.querySelectorAll('svg');
              for (var s = 0; s < svgs.length; s++) {
                if (svgs[s].querySelector('animate, animateTransform') || (svgs[s].className.baseVal||'').indexOf('spin') >= 0) {
                  hasSpinner = true; break;
                }
              }
            }
            // Unread dot: pulsing badge
            var hasUnread = !!(row && row.querySelector('[class*="animate-unread"], [class*="bg-primary"][class*="rounded-full"]'));
            // Project name: walk up ancestors; project section has a header row as a direct child,
            // and the name div (class font-medium truncate m-0) is INSIDE that header row.
            // Fix 2026-05-29: use querySelectorAll within each direct child.
            var project = '';
            var ancestor = el;
            for (var d = 0; d < 15; d++) {
              ancestor = ancestor.parentElement;
              if (!ancestor) break;
              var header = null;
              var kids = Array.from(ancestor.children);
              for (var k = 0; k < kids.length; k++) {
                // Search WITHIN each direct child for the project name element
                var nameEls = kids[k].querySelectorAll ? Array.from(kids[k].querySelectorAll('div,span')) : [];
                var found = nameEls.find(function(ne) {
                  var c = (ne.className || '').toString();
                  return ne.children.length === 0 &&
                         c.includes('font-medium') && c.includes('truncate') && c.includes('m-0');
                });
                if (found) { header = found; break; }
              }
              if (header) {
                var pt = header.textContent.trim();
                if (pt && pt.length > 0 && pt.length < 50 &&
                    !/^(Conversations|Projects|Settings|New Conversation|Scheduled|See all|See less)/i.test(pt)) {
                  project = pt; break;
                }
              }
            }
            if (id && text) {
              convLinks.push({ id: id.slice(0, 36), text: text, isActive: isActive, hasSpinner: hasSpinner, time: time, project: project, hasUnread: hasUnread });
            }
          }

          // seeAllCounts: scan all "See all (N)" buttons and map each to nearest project name.
          // Confirmed via DOM: walk up from button to ancestor with className including 'group/section'
          // (2 children: header row + convs list) → header child[0] textContent = project name.
          var seeAllCounts = {};
          try {
            var allBtns = Array.from(document.querySelectorAll('button'));
            var seeAllBtns = allBtns.filter(function(b) {
              return /^See all \(\d+\)$/.test((b.innerText || b.textContent || '').trim());
            });
            for (var sa = 0; sa < seeAllBtns.length; sa++) {
              var sab = seeAllBtns[sa];
              var saText = (sab.innerText || sab.textContent || '').trim();
              var numMatch = saText.match(/\((\d+)\)/);
              if (!numMatch) continue;
              var count = parseInt(numMatch[1], 10);
              // Walk up to group/section ancestor
              var saEl = sab;
              var projName = '';
              for (var sd = 0; sd < 20; sd++) {
                saEl = saEl.parentElement;
                if (!saEl) break;
                if (saEl.children.length === 2 && (saEl.className || '').toString().includes('group/section')) {
                  var hdr = saEl.children[0];
                  var hdrAll = Array.from(hdr.querySelectorAll('*'));
                  var nameEl = hdrAll.find(function(h) {
                    var cls = (h.className || '').toString();
                    var ht = (h.textContent || '').trim();
                    return ht.length > 0 && ht.length < 60 &&
                      (cls.includes('font-semibold') || cls.includes('font-medium') || cls.includes('truncate')) &&
                      !/(see all|new|add|settings)/i.test(ht);
                  });
                  if (nameEl) { projName = nameEl.textContent.trim(); }
                  break;
                }
              }
              if (projName) seeAllCounts[projName] = count;
            }
          } catch(e2) { /* silent — seeAllCounts is best-effort */ }

          return { activeName: activeName, currentId: currentId.slice(0, 8), convLinks: convLinks, seeAllCounts: seeAllCounts };
        } catch(e) {
          return { activeName: 'AG-err', currentId: '', convLinks: [], seeAllCounts: {}, error: e.message };
        }
      })()
    `);
    if (result && result.error) log('[scrapeChatList] CDP error:', result.error);
    return result || { activeName: 'AG', currentId: '', convLinks: [], seeAllCounts: {} };
  } catch(e) {
    log('[scrapeChatList] JS error:', e.message);
    return { activeName: 'AG', currentId: '', convLinks: [], seeAllCounts: {} };
  }
}


async function scrapeRightPanel() {
  try {
    const result = await cdpEvaluate(`
      (function() {
        try {
          var main = document.querySelector('[style*="flex-grow: 1"]');
          var rp = main && main.children[0] && main.children[0].children[1];
          if (!rp || rp.offsetWidth < 10) return { open: false, width: 0, tabs: [], content: '' };
          
          var inner = rp.querySelector('.h-full.w-full.flex.flex-col');
          if (!inner) return { open: false, tabs: [], content: '' };
          
          var tabBar = inner.children[0];
          var contentArea = inner.children[1];
          
          // Scrape tabs
          var tabs = [];
          var tabBtns = tabBar ? tabBar.querySelectorAll('[data-tab-id]') : [];
          for (var i = 0; i < tabBtns.length; i++) {
            tabs.push({
              id: tabBtns[i].dataset.tabId || '',
              name: tabBtns[i].textContent.trim().slice(0, 50),
              active: tabBtns[i].className.indexOf('bg-secondary') >= 0
            });
          }
          
          // Scrape active content — strip classes/styles for clean HTML
          var contentHTML = '';
          if (contentArea) {
            var clone = contentArea.cloneNode(true);
            clone.querySelectorAll('style, script, svg, button').forEach(function(e) { e.remove(); });
            // Strip class and style attributes
            clone.querySelectorAll('*').forEach(function(e) {
              e.removeAttribute('class');
              e.removeAttribute('style');
              e.removeAttribute('tabindex');
            });
            // Replace file-icon imgs with badge spans; keep other images for base64 embedding
            clone.querySelectorAll('img').forEach(function(img) {
              var src = img.getAttribute('src') || '';
              var alt = (img.getAttribute('alt') || '').trim();
              var idx = src.lastIndexOf('/files/');
              if (idx >= 0) {
                // File icon — replace with badge span
                var sp = document.createElement('span');
                sp.textContent = alt || '';
                var after = src.substring(idx + 7);
                var dot = after.indexOf('.');
                if (dot > 0) sp.setAttribute('data-file-icon', after.substring(0, dot).toLowerCase());
                img.replaceWith(sp);
              } else if (src && !src.startsWith('data:')) {
                // Real image — mark for server-side base64 embedding
                img.setAttribute('data-local-src', src);
                img.removeAttribute('src');
                img.setAttribute('alt', alt || 'image');
              }
            });
            contentHTML = clone.innerHTML.slice(0, 30000);
          }
          
          var activeTab = tabs.find(function(t) { return t.active; });
          return {
            open: true,
            width: rp.offsetWidth,
            tabs: tabs,
            activeTabName: activeTab ? activeTab.name : '',
            content: contentHTML
          };
        } catch(e) {
          return { open: false, tabs: [], content: '', error: e.message };
        }
      })()
    `);
    return result || { open: false, tabs: [], content: '' };
  } catch(e) {
    return { open: false, tabs: [], content: '' };
  }
}

async function scrapeLeftPanel() {
  try {
    const result = await cdpEvaluate(`
      (function() {
        // Use checkVisibility() on the "New Conversation" button — the most reliable
        // detector. checkVisibility handles display:none, visibility:hidden, opacity:0,
        // and parent-level hiding. If the button is visible, the sidebar is open.
        var allBtns = Array.from(document.querySelectorAll('button'));
        var newConvBtn = allBtns.find(function(b) {
          return b.textContent && b.textContent.trim() === 'New Conversation';
        });
        if (newConvBtn) {
          var visible = typeof newConvBtn.checkVisibility === 'function'
            ? newConvBtn.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
            : newConvBtn.offsetWidth > 0;
          var w = visible ? Math.round(newConvBtn.getBoundingClientRect().right) : 0;
          return { open: visible, width: w };
        }
        // Fallback: bg-sidebar offsetWidth (original approach)
        var sidebar = document.querySelector('[class*="bg-sidebar"]');
        var w2 = sidebar ? sidebar.offsetWidth : 0;
        return { open: w2 > 50, width: w2 };
      })()
    `);
    return result || { open: true, width: 260 };
  } catch(e) {
    return { open: true, width: 260 };
  }
}

// Scrape AG input bar state: running tasks + current model.
// Selectors confirmed via live CDP probe 2026-05-29.
async function scrapeInputBar() {
  try {
    const result = await cdpEvaluate(`
      (function() {
        try {
          // ── Tasks ──────────────────────────────────────────────────────
          // AG shows a "N task(s) running" banner above the input box when tools run.
          // We search all elements for text matching /\d+ tasks? running/i
          // and collect task labels from sibling/child elements.
          var tasks = [];
          var count = 0;
          var all = Array.from(document.querySelectorAll('*'));
          for (var i = 0; i < all.length; i++) {
            var el = all[i];
            var t = (el.innerText || '').trim();
            if (/^\\d+ tasks? running$/i.test(t) && el.children.length < 15) {
              var m = t.match(/^(\\d+)/);
              if (m) {
                count = parseInt(m[1], 10);
                // Collect task labels from sibling rows (look for monospace-looking lines)
                var parent = el.parentElement;
                if (parent) {
                  var rows = Array.from(parent.querySelectorAll('*')).filter(function(r) {
                    var rt = (r.innerText || '').trim();
                    return rt.length > 3 && rt.length < 120 &&
                           r.children.length === 0 &&
                           !/^\\d+ tasks? running/i.test(rt);
                  });
                  tasks = rows.slice(0, 10).map(function(r) {
                    return { label: (r.innerText || '').trim().slice(0, 100) };
                  });
                }
              }
              break;
            }
          }

          // ── Current model ──────────────────────────────────────────────
          // Confirmed selector: button[aria-label^="Select model"]
          var modelBtn = document.querySelector('button[aria-label^="Select model"]');
          var currentModel = modelBtn ? (modelBtn.innerText || modelBtn.textContent || '').trim() : '';
          // Fallback: the no-focus-agent-input div contains the model name
          if (!currentModel) {
            var nfDiv = document.querySelector('.no-focus-agent-input');
            if (nfDiv) currentModel = (nfDiv.innerText || nfDiv.textContent || '').trim().slice(0, 60);
          }

          return { count: count, tasks: tasks, currentModel: currentModel };
        } catch(e) {
          return { count: 0, tasks: [], currentModel: '', error: e.message };
        }
      })()
    `);
    if (result && result.error) log('[scrapeInputBar] error:', result.error);
    return result || { count: 0, tasks: [], currentModel: '' };
  } catch(e) {
    log('[scrapeInputBar] JS error:', e.message);
    return { count: 0, tasks: [], currentModel: '' };
  }
}

// ─── Mention Suggestions (@ picker) — pure filesystem reads, no CDP ───────────
let _mentionCache = null;
let _mentionCacheAt = 0;
const MENTION_CACHE_TTL = 30000; // 30s

// Convert snake_case filename to Title Case display name
function filenameToTitle(name) {
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase())
    .trim();
}

async function scrapeMentionSuggestions(currentId8) {
  const now = Date.now();
  if (_mentionCache && now - _mentionCacheAt < MENTION_CACHE_TTL) return _mentionCache;

  const fs   = require('fs');
  const path = require('path');
  const HOME  = process.env.HOME || '/Users/marwantzenios';
  const BRAIN = path.join(HOME, '.gemini', 'antigravity', 'brain');

  // ── Rules: scan known rule file names in project dirs ─────────────────────
  const RULE_NAMES = ['CONTEXT.md', 'AGENTS.md', 'GEMINI.md', 'CLAUDE.md', '.cursorrules', 'RULES.md'];
  const SCAN_DIRS  = [
    path.join(HOME, 'projects', 'AGenIOS'),
    path.join(HOME, 'projects'),
    HOME,
  ];
  const rules = [];
  for (const dir of SCAN_DIRS) {
    try {
      for (const rname of RULE_NAMES) {
        const full = path.join(dir, rname);
        if (fs.existsSync(full)) rules.push({ name: rname, path: full });
      }
    } catch(e) { /* skip inaccessible */ }
  }

  // ── Conversation: read entire brain/<convId>/ dir (docs + images) ─────────
  const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.mp4', '.mov'];
  const DOC_EXTS   = ['.md', '.txt', '.pdf'];
  const media = [];

  try {
    const brainDirs = fs.readdirSync(BRAIN);
    const convDir   = brainDirs.find(d => currentId8 && d.startsWith(currentId8) && !d.startsWith('.'));
    if (convDir) {
      const convPath = path.join(BRAIN, convDir);

      // Helper: add files from a directory
      const addFiles = (dir) => {
        if (!fs.existsSync(dir)) return;
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith('.')) continue;
          const ext   = path.extname(f).toLowerCase();
          const isImg = IMAGE_EXTS.includes(ext);
          const isDoc = DOC_EXTS.includes(ext);
          if (!isImg && !isDoc) continue;

          const stat  = fs.statSync(path.join(dir, f));
          const base  = path.basename(f, ext);
          const isAnon = /^media[_-]/i.test(base);

          // Anonymous media_ → "Media (May 26 10:36 PM)" — clean timestamp like AG
          // Named files → "Implementation Plan", "Stitch Approval V2" etc.
          const displayName = isAnon ? 'Media' : filenameToTitle(base);

          media.push({
            name: displayName,
            rawFile: f,
            convId: convDir,
            mtime: stat.mtimeMs,
            isDoc,
            isAnon,
          });
        }
      };

      addFiles(convPath);                                    // named .md artifacts + named images
      addFiles(path.join(convPath, '.tempmediaStorage'));    // anonymous media (shown as "Media (timestamp)")

    }
  } catch(e) { log('[scrapeMentionSuggestions] media error:', e.message); }

  // Sort newest first — no cap (AG shows all)
  media.sort((a, b) => b.mtime - a.mtime);

  _mentionCache = { rules, media };
  _mentionCacheAt = now;
  return _mentionCache;
}


async function broadcastState() {
  const [chatDump, actions, chatList, cssVars, rightPanel, leftPanel, inputBar] = await Promise.all([
    scrapeChat(), scrapePendingActions(), scrapeChatList(), scrapeTheme(), scrapeRightPanel(), scrapeLeftPanel(), scrapeInputBar(),
  ]);
  const mentionSuggestions = await scrapeMentionSuggestions(chatList.currentId);
  log(`[broadcastState] convLinks=${chatList.convLinks?.length || 0} chatName=${chatList.activeName} rightPanel=${rightPanel.open ? rightPanel.activeTabName : 'closed'} leftPanel=${leftPanel.open ? 'open' : 'closed'} leftW=${leftPanel.width} rightW=${rightPanel.width} tasks=${inputBar.count} model=${inputBar.currentModel}`);
  _lastActions = actions;  // cache for use in HTTP handlers
  if (actions.length > 0) {
    log('⚠️  actions detected:', JSON.stringify(actions.map(a => ({type:a.type, text:(a.text||'').slice(0,50), opts:a.options?.length}))));
  }
  // Embed local images as base64 data URIs in right panel content
  if (rightPanel.content) {
    rightPanel.content = embedLocalImages(rightPanel.content);
  }
  broadcast('state', {
    chatDump,              // full AG HTML dump
    cssVars,               // AG CSS custom properties for theming
    actions,
    cdpConnected,
    chatName: chatList.activeName,
    conversations: chatList.convLinks,
    seeAllCounts: chatList.seeAllCounts || {},  // { 'AGenIOS': 7, 'genios': 22, ... }
    leftPanelOpen: leftPanel.open,             // AG left sidebar open/closed
    leftPanelWidth: leftPanel.width,            // AG left sidebar width in px
    rightPanel,            // right panel tabs + active content HTML
    tasks: { count: inputBar.count, tasks: inputBar.tasks },  // running tasks
    currentModel: inputBar.currentModel,       // e.g. "Claude Sonnet 4.6 (Thinking)"
    mentionSuggestions,                        // { rules: [{name,path}], media: [{name,convId,mtime}] }
  });
}

// Convert data-local-src attributes to base64 data URIs
function embedLocalImages(html) {
  const MIME = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
                 '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml' };
  const MAX_SIZE = 2 * 1024 * 1024; // 2MB limit
  return html.replace(/data-local-src="([^"]+)"/g, (match, filePath) => {
    try {
      const resolved = filePath.startsWith('file://') ? filePath.replace('file://', '') : filePath;
      const stat = fs.statSync(resolved);
      if (stat.size > MAX_SIZE) return 'alt="[image too large]"';
      const ext = path.extname(resolved).toLowerCase();
      const mime = MIME[ext];
      if (!mime) return 'alt="[unsupported format]"';
      const data = fs.readFileSync(resolved).toString('base64');
      return `src="data:${mime};base64,${data}"`;
    } catch(e) {
      return 'alt="📄"';
    }
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
  CDP_PORT = detectCdpPort(); // re-detect every attempt in case AG restarted
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
      broadcast('actions', { actions: _lastActions });
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

  // POST /cdp-eval — localhost-only CDP evaluation for Implementor inspection
  // Usage: curl -s -X POST http://localhost:9100/cdp-eval \
  //          -H 'Content-Type: application/json' \
  //          -d '{"expr":"document.title"}' | jq
  // NO auth required — localhost only. Never exposed via ngrok (ngrok uses auth).
  if (req.method === 'POST' && url.pathname === '/cdp-eval') {
    const isLocal = req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1';
    if (!isLocal) { res.writeHead(403); res.end(JSON.stringify({ error: 'localhost only' })); return; }
    const body = await parseBody(req);
    const expr = String(body.expr || '').trim();
    if (!expr) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'Missing expr' }));
      return;
    }
    try {
      const result = await cdpEvaluate(`(function(){ try { return JSON.stringify(${expr}); } catch(e) { return JSON.stringify({error: e.message}); } })()`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: e.message }));
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
    res.end(JSON.stringify({ ok: true, version: BRIDGE_VERSION, cdpConnected, tunnelUrl, clients: wsClients.size }));
    return;
  }

  // GET /debug-rp — dump right panel HTML for debugging (temporary)
  if (url.pathname === '/debug-rp') {
    try {
      const rp = await scrapeRightPanel();
      const c = rp.content || '';
      const embedded = embedLocalImages(c);
      const tags = {};
      embedded.replace(/<(\w+)/g, (m, t) => { tags[t] = (tags[t]||0)+1; });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tab: rp.activeTabName, len: c.length, embeddedLen: embedded.length, tags, sample: embedded.substring(0, 3000) }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
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
            var pill = document.querySelector('[data-testid="convo-pill-${convId}"]');
            if (pill) {
              var row = pill.closest('[role="button"]');
              if (row) { row.click(); return 'clicked'; }
              pill.click(); return 'clicked-pill';
            }
            return 'not found';
          })()
        `);
        // Wait for AG to load the conversation, then push updated state
        await new Promise(r => setTimeout(r, 1800));
        await broadcastState();
        break;
      }

      case 'navigate_tab': {
        const tabId = (msg.tabId || '').slice(0, 200);
        if (!tabId) break;
        log(`[navigate_tab] switching to tab: ${tabId.slice(0, 60)}`);
        await cdpEvaluate(`
          (function() {
            var btn = document.querySelector('[data-tab-id="` + tabId.replace(/"/g, '') + `"]');
            if (btn) { btn.click(); return 'clicked'; }
            return 'not found';
          })()
        `);
        await new Promise(r => setTimeout(r, 800));
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

      case 'toggle_ag_panel': {
        // Toggle AG panels via DOM button click or fallback to keyboard shortcuts
        // sidebar: ⌘B, auxiliary: ⇧⌘B
        const isAux = msg.panel === 'right';
        try {
          // Attempt DOM click first
          const clicked = await cdpEvaluate(`(function() {
            const btn = ${isAux ? 
              `document.querySelector('[data-testid="toggle-aux-sidebar"]') || document.querySelector('[data-testid="close-aux-pane"]')` : 
              `document.querySelector('[data-testid="sidebar-toggle"]')`
            };
            if (btn) {
              btn.click();
              return true;
            }
            return false;
          })()`);

          if (clicked) {
            log(`[toggle_ag_panel] toggled ${isAux ? 'right' : 'left'} panel via DOM click`);
          } else {
            log(`[toggle_ag_panel] DOM button not found, falling back to hotkey`);
            // Blur active element to avoid hotkey swallowing
            await cdpEvaluate('if (document.activeElement) document.activeElement.blur();');
            
            const modifiers = isAux ? 12 : 4; // 4=Meta (⌘B), 12=Meta+Shift (⇧⌘B)
            await cdpSend('Input.dispatchKeyEvent', {
              type: 'keyDown', key: 'b', code: 'KeyB',
              windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66,
              modifiers
            });
            await cdpSend('Input.dispatchKeyEvent', {
              type: 'keyUp', key: 'b', code: 'KeyB',
              windowsVirtualKeyCode: 66, nativeVirtualKeyCode: 66,
              modifiers
            });
            log(`[toggle_ag_panel] sent fallback hotkey ${isAux ? '⇧⌘B' : '⌘B'} to AG`);
          }

          // Dual-phase broadcast:
          // Phase 1: Fast update (200ms) so PWA layout updates immediately
          await new Promise(r => setTimeout(r, 200));
          await broadcastState();
          // Phase 2: Follow-up (600ms later) to capture dynamically mounted contents (artifacts/subagents)
          await new Promise(r => setTimeout(r, 600));
          await broadcastState();
        } catch(e) {
          log(`[toggle_ag_panel] error: ${e.message}`);
        }
        break;
      }

      case 'select_model': {
        // Click AG model selector button, wait for dropdown, then click target model
        const targetModel = (msg.model || '').trim();
        if (!targetModel) break;
        log(`[select_model] switching to: ${targetModel}`);
        try {
          // Step 1: click model selector to open dropdown
          await cdpEvaluate(`
            (function() {
              var btn = document.querySelector('button[aria-label^="Select model"]');
              if (btn) btn.click();
            })()
          `);
          await new Promise(r => setTimeout(r, 600));
          // Step 2: find and click the target model in the dropdown
          const clicked = await cdpEvaluate(`
            (function() {
              var items = Array.from(document.querySelectorAll('[role="option"], [role="menuitem"], [role="listitem"], button'));
              var target = items.find(function(el) {
                return (el.innerText || el.textContent || '').trim().includes(${JSON.stringify(targetModel)});
              });
              if (target) { target.click(); return true; }
              return false;
            })()
          `);
          log(`[select_model] clicked=${clicked}`);
          await new Promise(r => setTimeout(r, 400));
          await broadcastState();
        } catch(e) {
          log('[select_model] error:', e.message);
        }
        break;
      }

      case 'stop_task': {
        // Click stop on a running task (if taskId provided, match by label)
        const taskId = (msg.taskId || '').trim();
        log(`[stop_task] taskId: ${taskId || '(any)'}`);
        try {
          await cdpEvaluate(`
            (function(label) {
              // Find stop buttons near running task rows
              var allBtns = Array.from(document.querySelectorAll('button'));
              var stopBtns = allBtns.filter(function(b) {
                var al = (b.getAttribute('aria-label') || '').toLowerCase();
                var t = (b.innerText || b.textContent || '').trim().toLowerCase();
                return al.includes('stop') || al.includes('cancel') || t === 'stop' || t === 'cancel';
              });
              if (label) {
                // Try to click stop button near the matching task label
                var found = stopBtns.find(function(b) {
                  var parent = b.parentElement;
                  for (var d = 0; d < 5; d++) {
                    if (!parent) break;
                    if ((parent.innerText || '').includes(label)) { return true; }
                    parent = parent.parentElement;
                  }
                  return false;
                });
                if (found) { found.click(); return; }
              }
              // Fallback: click first stop button found
              if (stopBtns[0]) stopBtns[0].click();
            })(${JSON.stringify(taskId)})
          `);
          await new Promise(r => setTimeout(r, 500));
          await broadcastState();
        } catch(e) {
          log('[stop_task] error:', e.message);
        }
        break;
      }

      case 'open_context_menu': {
        // Click AG's + (Add context) button, then click the matching menu item
        // action: 'media' | 'mentions' | 'actions' | 'browser'
        const ACTION_MAP = {
          'media':    /media|photo|image|file/i,
          'mentions': /mention|@/i,
          'actions':  /action|☑/i,
          'browser':  /browser|🌐|web/i,
        };
        const action = (msg.action || '').toLowerCase();
        const actionRe = ACTION_MAP[action];
        log(`[open_context_menu] action: ${action}`);
        if (!actionRe) break;
        try {
          // Step 1: click Add context button
          await cdpEvaluate(`
            (function() {
              var btn = document.querySelector('button[aria-label="Add context"]');
              if (btn) btn.click();
            })()
          `);
          await new Promise(r => setTimeout(r, 500));
          // Step 2: click matching menu item
          const clicked = await cdpEvaluate(`
            (function(re) {
              var items = Array.from(document.querySelectorAll('[role="menuitem"], [role="option"], [role="listitem"], button'));
              var target = items.find(function(el) {
                return re.test((el.innerText || el.textContent || '').trim());
              });
              if (target) { target.click(); return true; }
              return false;
            })(/${actionRe.source}/${actionRe.flags})
          `);
          log(`[open_context_menu] clicked=${clicked}`);
          await new Promise(r => setTimeout(r, 300));
          await broadcastState();
        } catch(e) {
          log('[open_context_menu] error:', e.message);
        }
        break;
      }

      case 'open_ag_settings': {
        // CDP-click AG's settings gear by data-testid
        log('[open_ag_settings] clicking settings gear');
        try {
          const clicked = await cdpEvaluate(`
            (function() {
              var el = document.querySelector('[data-testid="settings-button"]');
              if (el) { el.click(); return true; }
              // Fallback: find by aria-label
              var byLabel = Array.from(document.querySelectorAll('button, [role="button"], a'))
                .find(function(b) { return /settings/i.test(b.getAttribute('aria-label') || ''); });
              if (byLabel) { byLabel.click(); return 'label'; }
              return false;
            })()
          `);
          log('[open_ag_settings] clicked:', clicked);
          await new Promise(r => setTimeout(r, 400));
          await broadcastState();
        } catch(e) {
          log('[open_ag_settings] error:', e.message);
        }
        break;
      }

      case 'new_conversation': {
        // Click AG's New Conversation button via CDP
        try {
          const clicked = await cdpEvaluate(`(function() {
            // Try sidebar New Conversation link / button by aria-label or text
            var candidates = Array.from(document.querySelectorAll('a, button'));
            var btn = candidates.find(el => {
              var label = (el.getAttribute('aria-label') || '').toLowerCase();
              var text  = (el.textContent || '').trim().toLowerCase();
              return label.includes('new conversation') || text === 'new conversation';
            });
            if (btn) { btn.click(); return true; }
            return false;
          })()`);
          if (clicked) {
            log('[new_conversation] clicked New Conversation button via CDP');
            await new Promise(r => setTimeout(r, 400));
            await broadcastState();
          } else {
            log('[new_conversation] New Conversation button not found in DOM');
          }
        } catch(e) {
          log('[new_conversation] error:', e.message);
        }
        break;
      }

      // ─── W5 Power Actions ────────────────────────────────────────────

      case 'ag_reload': {
        log('[ag_reload] sending ⌘R to AG');
        try {
          await cdpEvaluate('if (document.activeElement) document.activeElement.blur();');
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, modifiers: 4 });
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, modifiers: 4 });
        } catch(e) { log('[ag_reload] error:', e.message); }
        break;
      }

      case 'ag_force_reload': {
        log('[ag_force_reload] sending ⇧⌘R to AG');
        try {
          await cdpEvaluate('if (document.activeElement) document.activeElement.blur();');
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, modifiers: 12 });
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'r', code: 'KeyR', windowsVirtualKeyCode: 82, nativeVirtualKeyCode: 82, modifiers: 12 });
        } catch(e) { log('[ag_force_reload] error:', e.message); }
        break;
      }

      case 'ag_zoom_in': {
        log('[ag_zoom_in] sending ⌘= to AG');
        try {
          await cdpEvaluate('if (document.activeElement) document.activeElement.blur();');
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: '=', code: 'Equal', windowsVirtualKeyCode: 187, nativeVirtualKeyCode: 187, modifiers: 4 });
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp',   key: '=', code: 'Equal', windowsVirtualKeyCode: 187, nativeVirtualKeyCode: 187, modifiers: 4 });
        } catch(e) { log('[ag_zoom_in] error:', e.message); }
        break;
      }

      case 'ag_zoom_out': {
        log('[ag_zoom_out] sending ⌘- to AG');
        try {
          await cdpEvaluate('if (document.activeElement) document.activeElement.blur();');
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: '-', code: 'Minus', windowsVirtualKeyCode: 189, nativeVirtualKeyCode: 189, modifiers: 4 });
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp',   key: '-', code: 'Minus', windowsVirtualKeyCode: 189, nativeVirtualKeyCode: 189, modifiers: 4 });
        } catch(e) { log('[ag_zoom_out] error:', e.message); }
        break;
      }

      case 'ag_actual_size': {
        log('[ag_actual_size] sending ⌘0 to AG');
        try {
          await cdpEvaluate('if (document.activeElement) document.activeElement.blur();');
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, nativeVirtualKeyCode: 48, modifiers: 4 });
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp',   key: '0', code: 'Digit0', windowsVirtualKeyCode: 48, nativeVirtualKeyCode: 48, modifiers: 4 });
        } catch(e) { log('[ag_actual_size] error:', e.message); }
        break;
      }

      case 'ag_new_window': {
        log('[ag_new_window] sending ⇧⌘N to AG');
        try {
          await cdpEvaluate('if (document.activeElement) document.activeElement.blur();');
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78, modifiers: 12 });
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'n', code: 'KeyN', windowsVirtualKeyCode: 78, nativeVirtualKeyCode: 78, modifiers: 12 });
        } catch(e) { log('[ag_new_window] error:', e.message); }
        break;
      }

      case 'ag_close_window': {
        log('[ag_close_window] sending ⌘W to AG');
        try {
          await cdpEvaluate('if (document.activeElement) document.activeElement.blur();');
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, modifiers: 4 });
          await cdpSend('Input.dispatchKeyEvent', { type: 'keyUp',   key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, nativeVirtualKeyCode: 87, modifiers: 4 });
        } catch(e) { log('[ag_close_window] error:', e.message); }
        break;
      }

      case 'ag_switch_window': {
        // Activate next AG window via CDP Target.getTargets + Target.activateTarget
        log('[ag_switch_window] switching to next AG window');
        try {
          const targetsRaw = await cdpSend('Target.getTargets', {}, null);
          const targets = (targetsRaw?.targetInfos || []).filter(t => t.type === 'page' && !t.url.startsWith('devtools://'));
          if (targets.length > 1) {
            // Find current target, activate next one
            const curr = targets.findIndex(t => t.targetId === sessionId);
            const next = targets[(curr + 1) % targets.length];
            await cdpSend('Target.activateTarget', { targetId: next.targetId }, null);
            log(`[ag_switch_window] activated: ${next.url.slice(0, 60)}`);
          } else {
            log('[ag_switch_window] only one window found, nothing to switch to');
          }
        } catch(e) { log('[ag_switch_window] error:', e.message); }
        break;
      }
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
