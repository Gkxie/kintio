import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

import { WecomCrypto } from './lib/wecom-crypto.ts';
import { registerWecomRoutes } from './routes/wecom.ts';
import type { AppConfig } from './config.ts';
import type { MessageSync } from './routes/wecom.ts';
import type { Logger } from './types.ts';

export function createApp({
  config,
  logger = console,
  messageProcessor = null,
  acceptIngress = () => true,
}: {
  config: AppConfig;
  logger?: Logger;
  messageProcessor?: MessageSync | null;
  acceptIngress?: () => boolean;
}): Hono {
  const app = new Hono();

  app.use('*', secureHeaders());
  app.use('*', async (context, next) => {
    await next();
    context.header('Cache-Control', 'no-store');
  });

  if (config.wecom.callbackToken && config.wecom.encodingAesKey) {
    app.use('/', async (context, next) => {
      if (context.req.method === 'POST' && !acceptIngress()) {
        return context.text('service unavailable', 503);
      }
      return await next();
    });
    registerWecomRoutes(app, {
      wecomCrypto: new WecomCrypto(config.wecom),
      logger,
      messageProcessor,
    });
  } else {
    app.get('/', (context) => context.text('hello world'));
  }

  app.notFound((context) => context.text('not found', 404));
  app.onError((error, context) => {
    logger.error(`[server] unhandled request error: ${error.message}`);
    return context.text('internal server error', 500);
  });

  return app;
}
