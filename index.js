import { serve } from '@hono/node-server';

import { createApp } from './src/app.js';
import { loadConfig } from './src/config.js';

const config = loadConfig();
const app = createApp({ config });

const server = serve(
  {
    fetch: app.fetch,
    port: config.port,
  },
  ({ port }) => {
    console.log(`Hono server is listening on port ${port}`);
  },
);

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);

  const forceExitTimer = setTimeout(() => {
    console.error('Graceful shutdown timed out');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  try {
    await app.shutdown?.();
  } catch (error) {
    console.error(error);
  }

  server.close((error) => {
    clearTimeout(forceExitTimer);

    if (error) {
      console.error(error);
      process.exit(1);
    }

    process.exit(0);
  });
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
