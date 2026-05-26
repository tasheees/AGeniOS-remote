module.exports = {
  apps: [
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
  ],
};
