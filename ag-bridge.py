#!/usr/bin/env python3
"""
ag-bridge.py — AGenIOS Python SDK Bridge
Replaces ag-bridge.js (Node.js + CDP) with native google-antigravity SDK hooks.

Architecture:
  AG 2.0 Desktop ─── SQLite DB ─── ag-bridge.py (Python SDK)
                                     ├── OnInteractionHook  → PWA approval relay
                                     ├── PostTurnHook       → content streaming
                                     ├── PreToolCallDecide  → policy gate (log only)
                                     ├── PostToolCallHook   → tool log
                                     ├── HTTP :9100         → serves PWA + /status
                                     ├── WebSocket /ws      → real-time events
                                     └── ngrok/cloudflare   → mobile tunnel

WebSocket event schema is backward-compatible with ag-bridge.js so the PWA
and telegram-daemon require no changes for core features.

New SDK-native events emitted (ignored gracefully by current PWA):
  {type: 'token', text}            — streaming token
  {type: 'tool_call', name, args} — tool dispatched
  {type: 'tool_result', name, result} — tool completed

Usage:
  python3 ag-bridge.py
"""

import asyncio
import json
import logging
import os
import pathlib
import secrets
import subprocess
import sys
import time
from typing import Optional

import uvicorn
import websockets
from dotenv import load_dotenv
from starlette.applications import Starlette
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.routing import Route, WebSocketRoute
from starlette.websockets import WebSocket, WebSocketDisconnect

from google.antigravity import Agent, LocalAgentConfig
from google.antigravity.hooks import (
    on_interaction,
    on_session_start,
    post_tool_call,
    post_turn,
    pre_tool_call_decide,
)
from google.antigravity.types import (
    AskQuestionInteractionSpec,
    HookResult,
    QuestionHookResult,
    QuestionResponse,
    ToolCall,
    ToolResult,
)

# ─── Config ───────────────────────────────────────────────────────────────────

# Load .env.local first, then .env (so .env.local takes precedence)
_root = pathlib.Path(__file__).parent
for _f in ['.env.local', '.env']:
    _p = _root / _f
    if _p.exists():
        load_dotenv(_p, override=True)

BRIDGE_PORT      = int(os.environ.get('BRIDGE_PORT', 9100))
REMOTE_PASSWORD  = os.environ.get('REMOTE_PASSWORD', '')
TELEGRAM_TOKEN   = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID', '')
SETTINGS_FILE    = pathlib.Path.home() / '.agenios-settings.json'
CONVERSATIONS_DIR = pathlib.Path.home() / '.gemini' / 'antigravity' / 'conversations'

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [bridge] %(message)s',
    datefmt='%H:%M:%S',
)
log = logging.getLogger('ag-bridge')


# ─── Global state ─────────────────────────────────────────────────────────────

# Auth tokens (session-persistent)
auth_tokens: set[str] = set()

# Active WebSocket clients (PWA connections)
ws_clients: set[WebSocket] = set()

# Tunnel URL
tunnel_url: Optional[str] = None

# Mute/notify settings
telegram_muted: bool = False
telegram_force_unmute: bool = False
tunnel_mode: str = 'cloudflare'  # 'cloudflare' or 'ngrok'
active_tunnel_provider: Optional[str] = None

# SDK state
sdk_connected: bool = False
current_conversation_id: Optional[str] = None
agent_instance: Optional[Agent] = None

# Approval relay: pending approval asyncio.Future keyed by request id
_pending_approval: Optional[asyncio.Future] = None
_pending_approval_id: Optional[str] = None

# Last known agent state
_last_ag_state: str = 'unknown'


# ─── Settings persistence ──────────────────────────────────────────────────────

def load_settings():
    global telegram_muted, telegram_force_unmute, tunnel_mode, auth_tokens
    try:
        data = json.loads(SETTINGS_FILE.read_text())
        telegram_muted = data.get('telegramMuted', False)
        telegram_force_unmute = data.get('telegramForceUnmute', False)
        tunnel_mode = data.get('tunnelMode', 'cloudflare')
        saved_tokens = data.get('authTokens', [])
        for t in saved_tokens:
            auth_tokens.add(t)
        log.info(f'Settings loaded: muted={telegram_muted}, tokens={len(auth_tokens)}')
    except Exception:
        pass


def save_settings():
    try:
        SETTINGS_FILE.write_text(json.dumps({
            'telegramMuted': telegram_muted,
            'telegramForceUnmute': telegram_force_unmute,
            'tunnelMode': tunnel_mode,
            'authTokens': list(auth_tokens),
        }))
    except Exception as e:
        log.warning(f'save_settings error: {e}')


# ─── WebSocket broadcast ──────────────────────────────────────────────────────

async def broadcast(msg_type: str, data: dict):
    """Send a JSON message to all connected PWA clients."""
    if not ws_clients:
        return
    payload = json.dumps({'type': msg_type, 'data': data})
    dead = set()
    for ws in list(ws_clients):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.add(ws)
    for ws in dead:
        ws_clients.discard(ws)


async def broadcast_status():
    await broadcast('status', {
        'sdkConnected': sdk_connected,
        'tunnelUrl': tunnel_url,
        'conversationId': current_conversation_id,
    })


async def broadcast_settings():
    await broadcast('settings', {
        'telegramMuted': telegram_muted,
        'telegramForceUnmute': telegram_force_unmute,
        'tunnelMode': tunnel_mode,
        'tunnelUrl': tunnel_url,
    })


# ─── Telegram notification ─────────────────────────────────────────────────────

async def telegram_notify(text: str):
    """Send a Telegram message (non-blocking, fire-and-forget)."""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        return
    if telegram_muted and not telegram_force_unmute:
        log.debug('Telegram muted — suppressing notification')
        return
    try:
        import urllib.request
        url = f'https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage'
        payload = json.dumps({
            'chat_id': TELEGRAM_CHAT_ID,
            'text': text,
            'parse_mode': 'Markdown',
        }).encode()
        req = urllib.request.Request(url, data=payload,
                                     headers={'Content-Type': 'application/json'})
        urllib.request.urlopen(req, timeout=5)
    except Exception as e:
        log.warning(f'Telegram notify failed: {e}')


def schedule_telegram_notify(text: str):
    """Schedule a fire-and-forget Telegram notification on the event loop."""
    try:
        loop = asyncio.get_event_loop()
        loop.create_task(telegram_notify(text))
    except Exception:
        pass


# ─── SDK conversation discovery ───────────────────────────────────────────────

def get_active_conversation_id() -> Optional[str]:
    """Return the conversation_id of the most recently modified .db file."""
    try:
        db_files = list(CONVERSATIONS_DIR.glob('*.db'))
        if not db_files:
            return None
        newest = max(db_files, key=lambda p: p.stat().st_mtime)
        return newest.stem  # filename without .db extension
    except Exception as e:
        log.warning(f'Could not find active conversation: {e}')
        return None


# ─── SDK hooks ────────────────────────────────────────────────────────────────

@on_session_start
async def handle_session_start():
    global sdk_connected
    sdk_connected = True
    log.info('✅ SDK session started')
    asyncio.get_event_loop().create_task(broadcast_status())
    asyncio.get_event_loop().create_task(
        broadcast('ag_state', {'state': 'idle'})
    )


@post_turn
async def handle_post_turn(text: str):
    """Fires after each agent turn. Broadcast the full response."""
    log.info(f'PostTurn: {len(text)} chars')
    asyncio.get_event_loop().create_task(
        broadcast('state', {
            'agState': 'idle',
            'lastResponse': text,
            'html': f'<p>{text}</p>',  # simple fallback for now
        })
    )
    asyncio.get_event_loop().create_task(
        broadcast('ag_state', {'state': 'idle'})
    )


@pre_tool_call_decide
async def handle_pre_tool_call(tool_call: ToolCall) -> HookResult:
    """Policy gate — auto-allow all, but log and broadcast."""
    name = getattr(tool_call, 'name', str(tool_call))
    args = getattr(tool_call, 'args', {})
    log.info(f'PreToolCall: {name}')
    asyncio.get_event_loop().create_task(
        broadcast('tool_call', {'name': name, 'args': args})
    )
    asyncio.get_event_loop().create_task(
        broadcast('ag_state', {'state': 'running'})
    )
    return HookResult(allow=True)


@post_tool_call
async def handle_post_tool_call(result: ToolResult):
    """Fires after tool completes. Log and broadcast."""
    name = getattr(result, 'tool_name', getattr(result, 'name', 'unknown'))
    res  = getattr(result, 'result', '')
    if isinstance(res, str):
        res = res[:500]  # truncate long results
    log.info(f'PostToolCall: {name}')
    asyncio.get_event_loop().create_task(
        broadcast('tool_result', {'name': name, 'result': res})
    )


@on_interaction
async def handle_on_interaction(spec: AskQuestionInteractionSpec) -> QuestionHookResult:
    """
    Fires when AG asks a question / needs approval (STATE_WAITING_FOR_USER).
    Suspends agent execution. Broadcasts approval_request to PWA.
    Awaits approval_response from any PWA client OR Telegram.
    Returns QuestionHookResult to resume AG.
    """
    global _pending_approval, _pending_approval_id

    questions = spec.questions if hasattr(spec, 'questions') else []
    if not questions:
        log.warning('OnInteraction: no questions in spec — auto-skipping')
        return QuestionHookResult(responses=[], cancelled=True)

    first_q = questions[0]
    title   = first_q.question if hasattr(first_q, 'question') else 'Question'
    options = [
        {'id': opt.id, 'text': opt.text}
        for opt in (first_q.options if hasattr(first_q, 'options') else [])
    ]

    # Create an asyncio.Future that will be resolved by a PWA/Telegram response
    loop = asyncio.get_event_loop()
    future: asyncio.Future = loop.create_future()
    approval_id = secrets.token_hex(8)
    _pending_approval    = future
    _pending_approval_id = approval_id

    log.info(f'OnInteraction: "{title}" — {len(options)} options. Waiting for PWA/Telegram…')

    # Broadcast to PWA
    loop.create_task(broadcast('new_actions', {
        'actions': [{
            'id':      approval_id,
            'type':    'question',
            'title':   title,
            'text':    title,
            'options': options,
        }]
    }))

    # Also send to Telegram
    if options:
        opt_text = '\n'.join(f'{i+1}. {o["text"]}' for i, o in enumerate(options))
        schedule_telegram_notify(
            f'❓ *AG needs input*\n\n*{title}*\n\n{opt_text}\n\n'
            f'_Reply via PWA or use /pending command_'
        )

    # Wait for response (timeout: 5 minutes)
    try:
        selected_ids = await asyncio.wait_for(future, timeout=300)
    except asyncio.TimeoutError:
        log.warning('OnInteraction: timeout — skipping')
        _pending_approval    = None
        _pending_approval_id = None
        return QuestionHookResult(responses=[], cancelled=True)

    _pending_approval    = None
    _pending_approval_id = None

    # Build response — selected_ids is a list of option id strings
    loop.create_task(broadcast('action_resolved', {'source': 'PWA'}))

    responses = [QuestionResponse(selected_option_ids=selected_ids)]
    return QuestionHookResult(responses=responses)


# ─── HTTP handlers ─────────────────────────────────────────────────────────────

async def route_index(request: Request) -> Response:
    """Serve the PWA or login page."""
    # Auth check
    token_cookie = request.cookies.get('ag_token', '')
    token_param  = request.query_params.get('token', '')
    authed = (token_cookie in auth_tokens) or (token_param in auth_tokens)

    if not authed:
        return HTMLResponse(login_html(), status_code=200)

    # Redirect to embed token in URL (iOS WebKit WS fix)
    if not token_param:
        tok = token_cookie or token_param
        return Response(status_code=302, headers={'Location': f'/?token={tok}'})

    index_path = _root / 'remote-ui' / 'index.html'
    if not index_path.exists():
        return Response('remote-ui/index.html not found', status_code=404)
    return HTMLResponse(index_path.read_text(), status_code=200)


async def route_status(request: Request) -> JSONResponse:
    """Health check endpoint — used by telegram-daemon."""
    return JSONResponse({
        'ok': True,
        'sdkConnected': sdk_connected,
        'tunnelUrl': tunnel_url,
        'conversationId': current_conversation_id,
        'clients': len(ws_clients),
        'bridge': 'python',
    })


async def route_tunnel_url(request: Request) -> JSONResponse:
    """Return current tunnel URL + password. Called by telegram-daemon /wpa."""
    return JSONResponse({'tunnelUrl': tunnel_url, 'password': REMOTE_PASSWORD})


async def route_auth(request: Request) -> Response:
    """Password check — returns token on success."""
    body = await request.json()
    if body.get('password') == REMOTE_PASSWORD:
        token = secrets.token_urlsafe(24)
        auth_tokens.add(token)
        save_settings()
        response = JSONResponse({'ok': True, 'token': token})
        response.set_cookie('ag_token', token, httponly=True, samesite='lax')
        return response
    return JSONResponse({'ok': False, 'error': 'Invalid password'}, status_code=401)


async def route_action_response(request: Request) -> JSONResponse:
    """
    POST /action-response — Telegram daemon routes approval choices here.
    Body: {optionIndex: int, approvalId?: str}
    """
    global _pending_approval, _pending_approval_id
    body = await request.json()
    opt_idx    = body.get('optionIndex', -1)
    opt_id     = body.get('optionId', None)

    log.info(f'[action-response] optionIndex={opt_idx}, optionId={opt_id}')

    if _pending_approval and not _pending_approval.done():
        if opt_id:
            _pending_approval.set_result([opt_id])
        elif opt_idx >= 0:
            # We need to look up the id from the index — stored in the broadcast
            # For now, pass the index as a string (agent handles it)
            _pending_approval.set_result([str(opt_idx)])
        else:
            # Cancelled/skipped
            _pending_approval.set_result([])
        return JSONResponse({'ok': True})

    return JSONResponse({'ok': False, 'error': 'No pending approval'}, status_code=404)


async def route_cmd(request: Request) -> JSONResponse:
    """
    POST /cmd — Telegram daemon sends commands here.
    Body: {command: '/status'|'/mute'|...}
    """
    global telegram_muted, telegram_force_unmute

    is_local = request.client and request.client.host in ('127.0.0.1', '::1')
    if not is_local:
        tok = request.cookies.get('ag_token', '')
        if tok not in auth_tokens:
            return Response(status_code=401)

    body = await request.json()
    cmd  = str(body.get('command', '')).strip()
    if not cmd:
        return JSONResponse({'ok': False, 'error': 'Missing command'}, status_code=400)

    result = await execute_command(cmd)
    # Async: return 200 immediately, result will come via Telegram
    return JSONResponse({'ok': True, 'queued': True, 'result': result})


async def execute_command(cmd: str) -> str:
    """Handle bridge slash commands (subset of what ag-bridge.js handled)."""
    global telegram_muted, telegram_force_unmute, tunnel_mode

    if cmd == '/status':
        return (
            f'🐍 ag-bridge.py (Python SDK)\n'
            f'SDK connected: {sdk_connected}\n'
            f'Conversation: {current_conversation_id or "none"}\n'
            f'Tunnel: {tunnel_url or "none"}\n'
            f'PWA clients: {len(ws_clients)}'
        )
    elif cmd == '/mute':
        telegram_muted = True
        telegram_force_unmute = False
        save_settings()
        asyncio.get_event_loop().create_task(broadcast_settings())
        return '🔕 Telegram muted.'
    elif cmd == '/unmute':
        telegram_muted = False
        telegram_force_unmute = True
        save_settings()
        asyncio.get_event_loop().create_task(broadcast_settings())
        return '🔔 Telegram unmuted.'
    elif cmd == '/tunnel':
        return f'🌐 Tunnel: {tunnel_url or "not connected"} ({active_tunnel_provider or "none"})'
    elif cmd.startswith('/ask '):
        msg = cmd[5:].strip()
        if agent_instance and msg:
            try:
                response = await agent_instance.chat(msg)
                text = ''
                async for token in response:
                    text += token
                    asyncio.get_event_loop().create_task(
                        broadcast('token', {'text': token})
                    )
                return text[:1000] if text else '(no response)'
            except Exception as e:
                return f'❌ Error: {e}'
        return '❌ Agent not ready or empty message.'
    elif cmd == '/pending':
        if _pending_approval and not _pending_approval.done():
            return f'⏳ Pending approval: {_pending_approval_id}'
        return '✅ No pending approvals.'
    elif cmd == '/wpa':
        if tunnel_url:
            return f'🌐 PWA: {tunnel_url}\n🔑 Password: {REMOTE_PASSWORD}'
        return '❌ No tunnel active.'
    else:
        return f'❓ Unknown command: {cmd}'


# ─── WebSocket handler ─────────────────────────────────────────────────────────

async def ws_endpoint(websocket: WebSocket):
    """PWA WebSocket connection handler."""
    # Auth check
    token_cookie = websocket.cookies.get('ag_token', '')
    token_param  = websocket.query_params.get('token', '')
    if token_cookie not in auth_tokens and token_param not in auth_tokens:
        await websocket.accept()
        await websocket.send_text(json.dumps({'type': 'auth_failed'}))
        await websocket.close(code=4001)
        return

    await websocket.accept()
    ws_clients.add(websocket)
    log.info(f'PWA connected. Total: {len(ws_clients)}')

    # Send initial state
    await websocket.send_text(json.dumps({'type': 'status', 'data': {
        'sdkConnected': sdk_connected,
        'tunnelUrl': tunnel_url,
        'conversationId': current_conversation_id,
    }}))
    await websocket.send_text(json.dumps({'type': 'settings', 'data': {
        'telegramMuted': telegram_muted,
        'telegramForceUnmute': telegram_force_unmute,
        'tunnelMode': tunnel_mode,
    }}))

    # Send any pending approval
    if _pending_approval and not _pending_approval.done() and _pending_approval_id:
        await websocket.send_text(json.dumps({'type': 'new_actions', 'data': {
            'actions': [{'id': _pending_approval_id, 'type': 'question'}]
        }}))

    try:
        while True:
            raw = await websocket.receive_text()
            msg = json.loads(raw)
            await handle_ws_message(websocket, msg)
    except WebSocketDisconnect:
        pass
    except Exception as e:
        log.warning(f'WS error: {e}')
    finally:
        ws_clients.discard(websocket)
        log.info(f'PWA disconnected. Total: {len(ws_clients)}')


async def handle_ws_message(ws: WebSocket, msg: dict):
    """Handle incoming messages from PWA."""
    global telegram_muted, telegram_force_unmute, tunnel_mode, _pending_approval

    msg_type = msg.get('type', '')

    if msg_type == 'send_message':
        text = msg.get('text', '').strip()
        if text and agent_instance:
            log.info(f'send_message: {text[:80]}')
            asyncio.get_event_loop().create_task(send_to_agent(text))

    elif msg_type == 'approval_response':
        # PWA tapped an approval option
        option_id  = msg.get('optionId')
        option_idx = msg.get('optionIndex', -1)
        if _pending_approval and not _pending_approval.done():
            if option_id:
                _pending_approval.set_result([option_id])
            elif option_idx >= 0:
                _pending_approval.set_result([str(option_idx)])
            else:
                _pending_approval.set_result([])  # skip

    elif msg_type == 'set_telegram_muted':
        telegram_muted = bool(msg.get('value', False))
        save_settings()
        asyncio.get_event_loop().create_task(broadcast_settings())

    elif msg_type == 'set_tunnel_mode':
        val = msg.get('value', '')
        if val in ('ngrok', 'cloudflare'):
            tunnel_mode = val
            save_settings()
            asyncio.get_event_loop().create_task(broadcast_settings())

    elif msg_type == 'refresh':
        await broadcast_status()

    # Legacy compat: some PWA messages still use 'click'/'evaluate' 
    # These don't apply in SDK mode — log and ignore gracefully
    elif msg_type in ('click', 'evaluate', 'stop', 'navigate_conversation'):
        log.debug(f'Legacy CDP message {msg_type!r} received — ignored in SDK mode')

    elif msg_type == 'action_source':
        pass  # PWA signals action source — not needed in SDK mode


async def send_to_agent(text: str):
    """Send a message to the active AG agent and stream response."""
    if not agent_instance:
        log.warning('send_to_agent: no agent instance')
        return
    try:
        await broadcast('ag_state', {'state': 'running'})
        response = await agent_instance.chat(text)
        full_text = ''
        async for token in response:
            full_text += token
            await broadcast('token', {'text': token})
        await broadcast('state', {
            'agState': 'idle',
            'lastResponse': full_text,
            'html': f'<p>{full_text}</p>',
        })
        await broadcast('ag_state', {'state': 'idle'})
    except Exception as e:
        log.error(f'send_to_agent error: {e}')
        await broadcast('ag_state', {'state': 'error'})


# ─── Tunnel helpers ────────────────────────────────────────────────────────────

def set_tunnel(url: str, provider: str):
    global tunnel_url, active_tunnel_provider
    tunnel_url = url
    active_tunnel_provider = provider
    log.info(f'✅ Tunnel URL ({provider}): {url}')
    asyncio.get_event_loop().create_task(broadcast_status())
    asyncio.get_event_loop().create_task(broadcast_settings())
    # Notify Telegram after 60s if no PWA connected yet
    asyncio.get_event_loop().call_later(60, lambda: asyncio.get_event_loop().create_task(
        _maybe_notify_tunnel(url)
    ))


async def _maybe_notify_tunnel(url: str):
    if not ws_clients:
        await telegram_notify(
            f'🌐 *AG Bridge online (Python SDK)*\n\nURL: {url}\n\nType /wpa anytime to get the link again.'
        )


def start_cloudflared():
    """Start cloudflared tunnel as a subprocess, parse URL from output."""
    log.info('Starting cloudflared tunnel...')
    proc = subprocess.Popen(
        ['cloudflared', 'tunnel', '--url', f'http://localhost:{BRIDGE_PORT}'],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True,
    )

    import re
    cf_pattern = re.compile(r'https://[a-z0-9]+-[a-z0-9-]+\.trycloudflare\.com')

    def reader(stream):
        for line in stream:
            m = cf_pattern.search(line)
            if m and not tunnel_url:
                set_tunnel(m.group(0), 'cloudflare')

    import threading
    threading.Thread(target=reader, args=(proc.stdout,), daemon=True).start()
    threading.Thread(target=reader, args=(proc.stderr,), daemon=True).start()

    return proc


def poll_ngrok_url(loop: asyncio.AbstractEventLoop):
    """Poll ngrok API (port 4040) in a thread to get the tunnel URL."""
    import time
    import urllib.request

    for _ in range(12):  # 12 x 5s = 60s
        time.sleep(5)
        if tunnel_url:
            return
        try:
            r = urllib.request.urlopen('http://localhost:4040/api/tunnels', timeout=2)
            data = json.loads(r.read())
            url  = data.get('tunnels', [{}])[0].get('public_url')
            if url:
                loop.call_soon_threadsafe(lambda u=url: set_tunnel(u, 'ngrok'))
                return
        except Exception:
            pass
    # Ngrok not found — start cloudflare fallback
    log.info('[tunnel] ngrok not found — starting cloudflare fallback')
    loop.call_soon_threadsafe(start_cloudflared)


# ─── HTML helpers ──────────────────────────────────────────────────────────────

def login_html() -> str:
    return '''<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AGenIOS Remote — Login</title>
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
  <h1>🔒 AGenIOS Remote</h1>
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
      location.href = '/?token=' + encodeURIComponent(data.token || '');
    } else { document.getElementById('err').style.display = 'block'; }
  }
</script>
</body>
</html>'''


# ─── Starlette app ─────────────────────────────────────────────────────────────

routes = [
    Route('/',              route_index),
    Route('/index.html',    route_index),
    Route('/status',        route_status),
    Route('/tunnel-url',    route_tunnel_url),
    Route('/auth',          route_auth,            methods=['POST']),
    Route('/action-response', route_action_response, methods=['POST']),
    Route('/cmd',           route_cmd,             methods=['POST']),
    WebSocketRoute('/ws',   ws_endpoint),
]

app = Starlette(routes=routes)


# ─── SDK agent loop ────────────────────────────────────────────────────────────

async def run_sdk_session():
    """
    Attach to the active AG 2.0 session via SDK and run the hook loop.
    Auto-detects the newest conversation .db file.
    """
    global agent_instance, current_conversation_id, sdk_connected

    while True:
        conv_id = get_active_conversation_id()
        if not conv_id:
            log.warning('No active AG conversation found. Retrying in 10s…')
            await asyncio.sleep(10)
            continue

        if conv_id != current_conversation_id:
            log.info(f'Attaching to conversation: {conv_id}')
            current_conversation_id = conv_id

        config = LocalAgentConfig(
            conversation_id=conv_id,
            hooks=[
                handle_session_start,
                handle_post_turn,
                handle_pre_tool_call,
                handle_post_tool_call,
                handle_on_interaction,
            ],
        )

        try:
            async with Agent(config) as agent:
                agent_instance = agent
                log.info('✅ SDK Agent session active — waiting for turns…')
                # The agent loop runs via hooks; we just keep the context alive
                # until the conversation changes or an error occurs.
                while True:
                    await asyncio.sleep(5)
                    # Check if a newer conversation exists
                    newest = get_active_conversation_id()
                    if newest and newest != current_conversation_id:
                        log.info(f'Conversation changed: {current_conversation_id} → {newest}')
                        break
        except Exception as e:
            sdk_connected = False
            agent_instance = None
            log.error(f'SDK session error: {e}. Retrying in 15s…')
            await asyncio.get_event_loop().create_task(broadcast_status())
            await asyncio.sleep(15)


# ─── Main ──────────────────────────────────────────────────────────────────────

async def main():
    global tunnel_mode

    log.info('═══════════════════════════════════════════════')
    log.info('AGenIOS Python SDK Bridge starting')
    log.info(f'HTTP/WS port: {BRIDGE_PORT}')
    log.info(f'Python: {sys.version}')
    log.info('═══════════════════════════════════════════════')

    load_settings()

    # Start tunnel
    loop = asyncio.get_event_loop()
    if tunnel_mode == 'ngrok':
        log.info('[tunnel] Mode: ngrok (polling)')
        import threading
        threading.Thread(target=poll_ngrok_url, args=(loop,), daemon=True).start()
    else:
        log.info('[tunnel] Mode: cloudflare')
        start_cloudflared()

    # Start SDK session in background
    loop.create_task(run_sdk_session())

    # Start HTTP/WS server
    config = uvicorn.Config(
        app,
        host='0.0.0.0',
        port=BRIDGE_PORT,
        log_level='warning',
        access_log=False,
    )
    server = uvicorn.Server(config)
    log.info(f'Listening on http://0.0.0.0:{BRIDGE_PORT}')
    await server.serve()


if __name__ == '__main__':
    asyncio.run(main())
