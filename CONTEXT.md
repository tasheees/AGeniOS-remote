# AGenIOS — Deep Technical Context Dump
> Written by GeniOS Sovereign Console (a7a666a2) on 2026-05-26
> This file captures the full investigation history, DOM findings, and engineering
> decisions made during the extraction period. Read this before touching any code.

---

## 1. Runtime Environment

| Item | Value |
|:-----|:------|
| Bridge process | PM2 `ag-bridge`, PID varies, port **9100** |
| AG CDP port | **9222** |
| CDP page ID | `62FFF415E659B47793214664A5CA9DFC` (changes on AG restart — rediscover via `GET localhost:9222/json`) |
| ngrok tunnel | PM2 `ngrok-tunnel`, port 4040 admin |
| Telegram daemon | PM2 `telegram-daemon` (stays in GeniOS, NOT in AGenIOS) |
| ngrok URL | Dynamic — sent to Telegram on bridge start. Last known: `https://703f-178-135-16-4.ngrok-free.app` |
| Bridge WS endpoint | `ws://localhost:9100/ws` (password-protected via cookie) |
| PWA URL | `http://localhost:9100/` |

### PM2 Start Command (from AGenIOS root)
```bash
pm2 start ecosystem.config.js
pm2 save
```

### How to Find CDP Page ID
```bash
node -e "require('http').get('http://localhost:9222/json', r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>console.log(JSON.parse(d).map(p=>({id:p.id,title:p.title?.slice(0,50)})))); })"
```

---

## 2. ag-bridge.js Architecture (1350 lines)

### Key Sections

| Lines | Purpose |
|:------|:--------|
| 1–100 | Config, env vars, CDP/WS setup |
| 60–80 | `AG_SELECTORS` — probed selectors for input, send button, article |
| 320–380 | `scrapeChat()` — DOM dump via CDP Runtime.evaluate |
| 380–480 | `scrapePendingActions()` — approval dialog detection (BROKEN — see §5) |
| 480–600 | `broadcastState()` — assembles state object, broadcasts to all WS clients |
| 600–750 | `scrapeAGState()` — detects typing/generating/idle state |
| 750–900 | HTTP server — `/`, `/auth`, `/status`, `/cmd` |
| 900–1180 | WebSocket server — handles `click`, `send_message`, `evaluate`, `refresh` |
| 1180–1345 | Poll loop (every 2s) + Telegram notification logic |

### scrapeChat() — How It Works

Runs this JS via `Runtime.evaluate` in AG's main page:

```javascript
// 1. Find the conversation container
var c = document.querySelector('div.relative.flex.flex-col.gap-y-3.px-4');

// 2. Clone it to avoid mutating AG's DOM
var clone = c.cloneNode(true);

// 3. Remove non-content elements
clone.querySelectorAll('textarea,input,[contenteditable],script,style,[role="dialog"],[role="alertdialog"],form').forEach(e=>e.remove());
clone.querySelectorAll('[aria-hidden="true"]').forEach(e=>e.remove());

// 4. Replace img elements with 📄 (local paths don't load over ngrok)
clone.querySelectorAll('img').forEach(img => {
  var sp = document.createElement('span');
  sp.textContent = img.getAttribute('alt') || '📄';
  img.parentNode.replaceChild(sp, img);
});

// 5. Strip class + style (Tailwind — meaningless in PWA)
clone.querySelectorAll('[class]').forEach(e => e.removeAttribute('class'));
clone.querySelectorAll('[style]').forEach(e => e.removeAttribute('style'));

// 6. Strip data-* BUT preserve data-state (open/closed collapsible)
clone.querySelectorAll('*').forEach(n => {
  Array.from(n.attributes)
    .filter(a => a.name.startsWith('data-') && a.name !== 'data-state')
    .forEach(a => n.removeAttribute(a.name));
});

// aria-* attributes are NOT stripped — aria-expanded is preserved for collapsibles
```

**What the dump preserves:**
- `aria-expanded` — collapsible state (true/false)
- `data-state` — Radix UI open/closed state
- `role` — semantic roles (article, button, etc.)
- `aria-label` — button labels

**What is stripped:**
- All `class` attributes (Tailwind utility classes)
- All `style` attributes
- All `data-*` except `data-state`
- `img` elements (replaced with emoji)
- `[role="dialog"]` and `[role="alertdialog"]` elements

### AG_SELECTORS (probed live 2026-05-26)

```javascript
const AG_SELECTORS = {
  article:  '[role="article"]',                    // 14 messages
  input:    'div[aria-label="Message input"]',     // contenteditable div
  send:     'button[aria-label="Send"]',
};
```

---

## 3. remote-ui/index.html Architecture (2694 lines)

### Key Sections

| Lines | Purpose |
|:------|:--------|
| 1–500 | CSS — dark glassmorphic theme, Inter + JetBrains Mono fonts |
| 500–1000 | CSS continued — message bubbles, code blocks, collapsibles, perm-modal |
| 1000–1200 | HTML structure — header, tabs, chat panel, perm-modal, input bar |
| 1200–1600 | JS — WebSocket connect/reconnect, state handlers |
| 1600–1900 | JS — `postProcessDump()` — transforms raw DOM dump into styled PWA output |
| 1900–2200 | JS — click relay, collapsible toggle, approval modal render |
| 2200–2694 | JS — login form, slash commands, Telegram relay |

### postProcessDump() — Key Transformations

1. **Message bubbles** — `[role="article"]` elements get `.ag-message` class
2. **User messages** — `[aria-label="User message"]` gets `.user-message` styling
3. **Code blocks** — `<pre><code>` get copy button + language label
4. **Collapsibles** — Headers with `aria-expanded` get click handler (relay via CDP)
5. **Perm-modal** — Rendered separately (NOT from dump) when `actions.length > 0`

### Perm-Modal (Approval Dialog in PWA)

```javascript
// Rendered when state.actions has entries
function renderPermModal(actions) {
  const action = actions[0];
  // Shows: title, command, numbered options, Skip + Submit buttons
  // On Submit: sends {type: 'evaluate', expression: clickOptionScript}
}
```

**Current state:** Modal renders correctly IF `actions` is populated.
The problem is `scrapePendingActions()` always returns `[]` (see §5).

### Click Relay Logic

```javascript
// Button clicks
ws.send({type: 'click', selector: 'button', matchText: elText, occurrenceIndex: idx});

// Collapsible toggles (aria-expanded elements)
ws.send({type: 'evaluate', expression:
  `[...document.querySelectorAll('[aria-expanded]')]
   .find(e => e.innerText.trim().startsWith(needle))?.click()`
});

// Delete buttons (CSS-hidden, needs dispatchEvent not .click())
ws.send({type: 'evaluate', expression:
  `document.querySelector('[aria-label="Delete message"],[aria-label="Remove"]')
   ?.dispatchEvent(new MouseEvent('click', {bubbles:true, cancelable:true}))`
});
```

---

## 4. AG DOM Structure (Confirmed Facts)

Probed via `Runtime.evaluate` on 2026-05-26.

### Roles Present in AG's Main Page
```
navigation, button, article, combobox, region, listbox
```
**Notable absences:** `dialog`, `alertdialog`, `menu`, `menuitem`, `tooltip`

### Conversation Container Selector
```css
div.relative.flex.flex-col.gap-y-3.px-4
```
This is a Tailwind class combo. **Fragile** — may change on AG update.
If broken, probe with:
```javascript
// Find the container that holds [role="article"] elements
document.querySelector('[role="article"]')?.closest('[class]')
```

### Message Articles
```javascript
document.querySelectorAll('[role="article"]') // returns 14+ messages
// User messages: [aria-label="User message"]
// AG messages: no aria-label (they are [role="article"]:not([aria-label]))
```

### Input Area
```javascript
document.querySelector('div[aria-label="Message input"]') // contenteditable div
document.querySelector('button[aria-label="Send"]') // send button
```

### Collapsible Tool Blocks
```javascript
// Trigger element (confirmed by Deep Research):
document.querySelectorAll('button[aria-expanded], div[aria-expanded]')
// State: aria-expanded="true" (open) or aria-expanded="false" (closed)
// Content: linked via aria-controls → id of content area
```

### Stop Button (while AG is generating)
```javascript
// Multiple detection strategies used:
b.getAttribute('aria-label')?.toLowerCase().includes('stop')
b.getAttribute('aria-label')?.toLowerCase() === 'stop'
// Also: document.querySelector('[data-state="loading"]')
```

---

## 5. Approval Dialog Investigation (UNRESOLVED — P1)

### The Problem
`scrapePendingActions()` always returns `[]` even when the approval dialog is clearly
visible in AG's UI. The PWA shows "Waiting for user input" but no modal appears.

### What the Dialog Looks Like
- Dark card appearing inline in the AG conversation
- Title: "Allow running this command?" or similar
- Shows the command in a code block
- 4 numbered options: "1 Yes, allow this time", "2 No", "3 Always allow", "4 Always deny"
- Two action buttons at bottom: "Skip" and "Submit ↵"
- macOS system notification also appears (top-right) simultaneously

### Detection Attempts Chronology

#### Attempt 1 — PERM_RE text match
```javascript
const PERM_RE = /allow (running|this)|grant permission|approve this/i;
// Find smallest div containing this text
```
**Failed:** The approval dialog's text exists within the conversation container
whose `innerText` exceeds 2000 chars. No unique small container found.

#### Attempt 2 — Submit+Skip exact match
```javascript
const submitBtn = allBtns.find(b => /^submit$/i.test(b.innerText.trim()));
const skipBtn   = allBtns.find(b => /^skip$/i.test(b.innerText.trim()));
```
**Failed:** Submit button text is "Submit ↵" (with keyboard shortcut glyph) — exact
match `/^submit$/i` never matched.

#### Attempt 3 — Submit loose match
```javascript
const submitBtn = allBtns.find(b => /submit/i.test(b.innerText.trim().slice(0,20)));
```
**Failed:** Still returned `[]`. The Submit button may not be in the DOM at all,
or may be in a different execution context.

#### Attempt 4 — role="dialog" (Deep Research recommendation)
```javascript
const dialog = document.querySelector('[role="dialog"], [role="alertdialog"]');
```
**Failed:** CONFIRMED that `role="dialog"` does NOT exist in AG's DOM.
The roles present are only: `navigation, button, article, combobox, region, listbox`.

### Current Theory
The approval dialog may be rendered as an **Electron main process native dialog**
or as a React component that is **outside the main conversation DOM tree** — possibly
at the `document.body` level but with no ARIA role.

### Next Steps to Try
1. **Live button monitoring** — Poll `document.querySelectorAll('button')` every 300ms.
   When new buttons appear, capture their text. This will reveal the actual button text
   when the dialog renders.
   ```javascript
   // Run this probe via CDP while triggering an approval:
   const ws = new WebSocket('ws://localhost:9222/devtools/page/<PAGE_ID>');
   // Poll every 300ms, capture new buttons, log them
   ```

2. **Full body text scan** — When `document.body.innerText` changes significantly
   (delta > 200 chars), dump the full text to identify what the dialog adds.

3. **MutationObserver injection** — Inject a persistent observer that fires when
   new nodes are added to `document.body`. This would capture the dialog the instant
   it appears. Risk: may interfere with AG's React rendering.

4. **Check for React fiber** — Access `__reactFiber` or `_reactRootContainer` on
   the root element to inspect the React component tree directly.

---

## 6. Code Syntax Highlighting (PARTIAL — P2)

### The Problem
AG shows syntax-highlighted code (JSON in pink/purple) but the PWA shows plain white text.

### Root Cause
`scrapeChat()` strips ALL `class` attributes. Code elements lose `language-json`,
`hljs`, and other highlighting classes. Prism.js in the PWA can't re-highlight
without knowing the language.

### What's Preserved
The language label ("json", "bash", "javascript") appears as text ABOVE the code block
in AG's UI. This text IS in the dump.

### Fix Approach (not yet implemented)
In `postProcessDump()`:
1. Find code blocks (`<pre><code>`)
2. Look for a preceding sibling text node containing a language name
3. Apply `class="language-X"` to the `<code>` element
4. Run `Prism.highlightElement(codeEl)`

Prism.js needs to be loaded in index.html:
```html
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/themes/prism-tomorrow.min.css">
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/prism.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/prism/1.29.0/components/prism-json.min.js"></script>
<!-- add more language components as needed -->
```

---

## 7. GeniOS Cleanup (M2 — NOT YET DONE)

After PM2 is confirmed running from AGenIOS root, clean GeniOS:

```bash
cd /Users/marwantzenios/projects/genios

# Remove bridge files
rm scripts/ag-bridge.js
rm -rf scripts/remote-ui/

# Update ecosystem.config.js — remove ag-bridge entry, keep telegram-daemon only
# Update GENIOS_INDEX.md §13.3 — mark as extracted
# Commit
git add -A
git commit -m "chore: extract ag-bridge + remote-ui to AGenIOS standalone project"
```

---

## 8. PM2 Migration (M1 — NOT YET DONE)

Currently `ag-bridge` runs from GeniOS. Migration steps:

```bash
# 1. Stop current process
pm2 stop ag-bridge
pm2 delete ag-bridge

# 2. Start from AGenIOS
cd /Users/marwantzenios/projects/AGenIOS
pm2 start ecosystem.config.js

# 3. Persist
pm2 save

# 4. Verify
pm2 status
curl http://localhost:9100/status
```

---

## 9. Debugging Tips

### Check Bridge Logs
```bash
pm2 logs ag-bridge --lines 30 --nostream
```

### Check scrapePendingActions Output (debug logging active)
```bash
pm2 logs ag-bridge --lines 20 --nostream | grep "scrapePending"
# Should show: "scrapePendingActions raw type: object value: []"
# When working: "scrapePendingActions raw type: object value: [{type:'dialog'...}]"
```

### Connect to AG CDP Directly
```bash
node -e "
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:9222/devtools/page/<PAGE_ID>');
ws.on('open', () => {
  ws.send(JSON.stringify({id:1, method:'Runtime.evaluate', params:{
    expression: 'document.querySelectorAll(\"button\").length',
    returnByValue: true
  }}));
});
ws.on('message', d => { console.log(JSON.parse(d)?.result?.result); ws.close(); });
"
```

### Smoke Test Bridge
```bash
curl -s http://localhost:9100/status
# Expected: {"status":"ok","cdpConnected":true,...}
```

---

## 10. Key Decisions Made

| Decision | Rationale |
|:---------|:----------|
| Single-file PWA (index.html) | Simplicity — no build step, instant iteration |
| Strip all classes | Tailwind utility classes are meaningless outside AG's stylesheet |
| Preserve aria-* attributes | Needed for collapsible detection + semantic relay |
| Preserve data-state | Radix UI open/closed state for collapsibles |
| Replace img with 📄 | Local paths never resolve over ngrok tunnel |
| dispatchEvent for delete | CSS-hidden elements ignore .click() but respond to dispatched events |
| aria-expanded for collapsibles | Most stable selector (confirmed by Deep Research) |
| 2s poll interval | Balance between responsiveness and CDP load |
| Cookie auth (not Bearer) | PWA can't set Authorization header on WS connection |
