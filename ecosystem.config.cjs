const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'kintio',
      script: path.join(__dirname, 'dist/index.js'),
      cwd: __dirname,
      interpreter: process.execPath,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      min_uptime: '5s',
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 20000,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PATH: process.env.PATH,
      },
    },
  ],
};
