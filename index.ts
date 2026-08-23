import { serve } from '@hono/node-server';

import { createApp } from './src/app.ts';
import { loadConfig } from './src/config.ts';

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

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log(`Received ${signal}; shutting down`);
  const listenerClosed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  let timeout: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timeout = setTimeout(
      () => reject(new Error('Graceful shutdown timed out')),
      config.state.shutdownTimeoutMs,
    );
    timeout.unref?.();
  });

  try {
    await Promise.race([
      (async () => {
        await listenerClosed;
        app.stopAccepting();
        await app.shutdown();
      })(),
      timedOut,
    ]);
    clearTimeout(timeout);
    process.exit(0);
  } catch (error: unknown) {
    clearTimeout(timeout);
    console.error(error);
    (server as { closeAllConnections?: () => void }).closeAllConnections?.();
    await app.abort().catch(() => {});
    process.exit(1);
  }
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
