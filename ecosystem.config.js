module.exports = {
  apps: [
    // ── Python SDK Bridge (S2) ── replaces ag-bridge.js once verified ──────────
    {
      name: 'ag-bridge-py',
      script: 'ag-bridge.py',
      interpreter: '/opt/homebrew/bin/python3',
      cwd: '/Users/marwantzenios/projects/AGenIOS',
      restart_delay: 5000,
      max_restarts: 10,
      out_file:   './logs/ag-bridge-py-out.log',
      error_file: './logs/ag-bridge-py-err.log',
      // NOTE: ag-bridge-py serves on port 9100 — stop ag-bridge first
      //       pm2 stop ag-bridge && pm2 start ag-bridge-py
      autorestart: true,
    },
    // ── Node.js CDP Bridge (DEPRECATED after S2 verified) ────────────────────
    // DEPRECATED — 2026-05-28: kept for parallel safety during S2 validation.
    // Remove after ag-bridge-py smoke test passes. ag-bridge.js marked deprecated.
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
