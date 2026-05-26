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
  ],
};
