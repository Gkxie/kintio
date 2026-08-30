const path = require('node:path');

const instanceRoot = path.resolve(process.env.KINTIO_HOME || __dirname);
const configFile = path.resolve(
  process.env.KINTIO_CONFIG_FILE || path.join(instanceRoot, '.env'),
);
const killTimeout = Number(process.env.KINTIO_KILL_TIMEOUT_MS || 127000);
if (!Number.isInteger(killTimeout) || killTimeout < 8000 || killTimeout > 127000) {
  throw new Error('KINTIO_KILL_TIMEOUT_MS must be an integer between 8000 and 127000');
}

module.exports = {
  apps: [
    {
      name: 'kintio',
      script: path.join(__dirname, 'dist/index.js'),
      cwd: instanceRoot,
      interpreter: process.execPath,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      min_uptime: '5s',
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: killTimeout,
      merge_logs: true,
      time: true,
      env: {
        ...process.env,
        NODE_ENV: 'production',
        KINTIO_HOME: instanceRoot,
        KINTIO_CONFIG_FILE: configFile,
        KINTIO_START_TOKEN: process.env.KINTIO_START_TOKEN,
        PATH: process.env.PATH,
      },
    },
  ],
};
