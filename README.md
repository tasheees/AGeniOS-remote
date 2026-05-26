# AGenIOS Remote

> Remote control bridge for [Antigravity](https://antigravity.dev) — control your AI coding assistant from your phone.

## What It Does

- Mirrors the AG conversation to a PWA on your phone in real-time
- Relay messages, clicks, and collapsible toggles back to AG
- Shows approval dialogs so you can allow/deny AG terminal commands remotely
- Sends a Telegram notification with the PWA URL on startup

## Stack

- **ag-bridge.js** — Node.js bridge: CDP client + HTTP + WebSocket server + ngrok tunnel
- **remote-ui/index.html** — Single-file PWA: chat mirror + approval modal + input bar

## Requirements

- Antigravity running with `--remote-debugging-port=9222`
- Node.js 18+
- PM2 (`npm install -g pm2`)
- ngrok (for remote access over HTTPS)

## Setup

```bash
# 1. Clone
git clone https://github.com/your-org/agenios.git
cd agenios

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your REMOTE_PASSWORD, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID

# 4. Start
npm start

# 5. Check logs
npm run logs
```

## Environment Variables

| Variable | Required | Description |
|:---------|:---------|:------------|
| `REMOTE_PASSWORD` | ✅ | PWA login password |
| `TELEGRAM_BOT_TOKEN` | ✅ | Telegram bot token for startup notification |
| `TELEGRAM_CHAT_ID` | ✅ | Your Telegram chat ID |
| `AG_CDP_PORT` | Optional | AG debug port (default: 9222) |

## Architecture

```
Antigravity (Electron)
  └── CDP :9222
        └── ag-bridge.js :9100
              ├── GET /          → PWA (remote-ui/index.html)
              ├── WS  /ws        → Real-time state
              └── ngrok tunnel   → HTTPS on phone
```

## Governance

See [AGENTS.md](AGENTS.md) and [GEMINI.md](GEMINI.md).
Task registry: [AGENIOS_INDEX.md](AGENIOS_INDEX.md).

## License

MIT
