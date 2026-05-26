/**
 * probe-buttons.js
 *
 * P1 — Live CDP button delta probe.
 *
 * Connects directly to AG's CDP WebSocket and polls
 * document.querySelectorAll('button') every 200ms.
 * When new buttons appear (delta > 0), prints:
 *   - count before / after
 *   - exact text of each new button
 *   - full outerHTML of each new button (for selector clues)
 *
 * Usage:
 *   node probe-buttons.js
 *
 * Then trigger an approval dialog in AG (e.g. ask AG to run a shell command).
 * Watch this terminal for the delta output.
 *
 * Ctrl+C to stop.
 */

'use strict';

const { WebSocket } = require('ws');

const PAGE_ID  = '62FFF415E659B47793214664A5CA9DFC';
const CDP_URL  = `ws://localhost:9222/devtools/page/${PAGE_ID}`;
const INTERVAL = 200; // ms

let msgId = 1;
const pending = {};

const ws = new WebSocket(CDP_URL);

ws.on('open', () => {
  console.log('✅ Connected to AG CDP');
  console.log(`Polling document.querySelectorAll('button') every ${INTERVAL}ms`);
  console.log('─'.repeat(60));
  console.log('⏳ Trigger an approval dialog in AG now...');
  console.log('─'.repeat(60));

  // Enable Runtime domain
  send('Runtime.enable', {});

  // Start polling
  let lastButtons = [];

  setInterval(async () => {
    try {
      const result = await evaluate(`
        (function() {
          const btns = Array.from(document.querySelectorAll('button'));
          return btns.map(b => ({
            text:  (b.innerText || b.textContent || '').trim().slice(0, 120),
            label: b.getAttribute('aria-label') || '',
            html:  b.outerHTML.slice(0, 400),
          }));
        })()
      `);

      if (!result || !Array.isArray(result)) return;

      // Detect new buttons (by text not seen in last snapshot)
      const lastTexts = new Set(lastButtons.map(b => b.text));
      const newBtns   = result.filter(b => !lastTexts.has(b.text));

      if (newBtns.length > 0) {
        const ts = new Date().toISOString().slice(11, 23);
        console.log(`\n[${ts}] ⚡ DELTA: ${lastButtons.length} → ${result.length} buttons (+${newBtns.length} new)`);
        newBtns.forEach((b, i) => {
          console.log(`\n  [NEW BUTTON ${i + 1}]`);
          console.log(`  text:  ${JSON.stringify(b.text)}`);
          console.log(`  label: ${JSON.stringify(b.label)}`);
          console.log(`  html:  ${b.html}`);
        });
        console.log('\n' + '─'.repeat(60));
      }

      lastButtons = result;

    } catch (err) {
      // Suppress — CDP may briefly disconnect
    }
  }, INTERVAL);
});

ws.on('message', (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (msg.id && pending[msg.id]) {
    const { resolve, reject } = pending[msg.id];
    delete pending[msg.id];
    if (msg.error) reject(new Error(msg.error.message));
    else resolve(msg?.result?.result?.value);
  }
});

ws.on('close', () => console.log('\n🔌 CDP connection closed'));
ws.on('error', (e) => console.error('CDP error:', e.message));

function send(method, params) {
  const id = msgId++;
  return new Promise((resolve, reject) => {
    pending[id] = { resolve, reject };
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => {
      if (pending[id]) { delete pending[id]; reject(new Error(`timeout: ${method}`)); }
    }, 8000);
  });
}

function evaluate(expression) {
  return send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: false,
  });
}
