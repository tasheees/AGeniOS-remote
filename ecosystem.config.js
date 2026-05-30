module.exports = {
  apps: [
    // ── PRIMARY: Node.js CDP Bridge ── GUI control, PWA, Telegram events ────
    // PERMANENT — ag-bridge.js is the sole GUI/CDP bridge. Not deprecated.
    // ag-bridge.py runs as a separate sidecar (see below). Both are permanent.
    {
      name: 'ag-bridge',
      script: 'ag-bridge.js',
      cwd: '/Users/marwantzenios/projects/AGenIOS',
      env: {
        NODE_ENV: 'production',
      },
      restart_delay: 3000,
      max_restarts: 20,
    },
    // ── SIDECAR: Python SDK Bridge ── headless SDK sessions, future cloud ───
    // PERMANENT — ag-bridge.py is the SDK sidecar (Google Sidecar pattern).
    // Serves SDK headless agent sessions. Does NOT replace ag-bridge.js.
    // Future: RemoteAgentConfig for cloud sessions (S3), Triggers (S2.11).
    {
      name: 'ag-bridge-py',
      script: 'ag-bridge.py',
      interpreter: '/opt/homebrew/bin/python3',
      cwd: '/Users/marwantzenios/projects/AGenIOS',
      env: {
        BRIDGE_PORT: 9101,   // ag-bridge.js owns :9100 — py sidecar uses :9101
      },
      restart_delay: 5000,
      max_restarts: 10,
      out_file:   './logs/ag-bridge-py-out.log',
      error_file: './logs/ag-bridge-py-err.log',
      autorestart: true,
    },
    {
      name: 'telegram-daemon',
      script: 'telegram-daemon.js',
      cwd: '/Users/marwantzenios/projects/AGenIOS',
      env: {
        NODE_ENV: 'production',
      },
      restart_delay: 3000,
      max_restarts: 20,
      out_file: './logs/telegram-daemon-out.log',
      error_file: './logs/telegram-daemon-err.log',
    },
    {
      name: 'ngrok',
      script: '/usr/local/bin/ngrok',
      args: 'http 9100',
      cwd: '/Users/marwantzenios/projects/AGenIOS',
      restart_delay: 5000,
      max_restarts: 10,
      autorestart: true,
    },
  ],
};
