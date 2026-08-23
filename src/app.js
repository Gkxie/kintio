import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

import { WecomCrypto } from './lib/wecom-crypto.js';
import { registerWecomRoutes } from './routes/wecom.js';
import { createRuntime } from './runtime.js';

export function createApp({ config, logger = console, messageProcessor }) {
  const app = new Hono();
  const wecomCrypto = new WecomCrypto(config.wecom);
  const runtime =
    messageProcessor === undefined ? createRuntime({ config, logger }) : null;
  const activeMessageProcessor =
    messageProcessor === undefined ? runtime.messageProcessor : messageProcessor;

  app.use('*', secureHeaders());
  app.use('*', async (context, next) => {
    await next();
    context.header('Cache-Control', 'no-store');
  });

  app.get('/healthz', (context) => context.text('ok'));
  registerWecomRoutes(app, {
    wecomCrypto,
    logger,
    messageProcessor: activeMessageProcessor,
  });

  app.notFound((context) => context.text('not found', 404));
  app.onError((error, context) => {
    logger.error(`[server] unhandled request error: ${error.message}`);
    return context.text('internal server error', 500);
  });

  app.shutdown = async () => {
    await runtime?.messageProcessor?.close?.();
  };

  return app;
}
