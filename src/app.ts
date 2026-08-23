import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

import { WecomCrypto } from './lib/wecom-crypto.js';
import { registerWecomRoutes } from './routes/wecom.js';
import { createRuntime } from './runtime.js';
import type { AppConfig } from './config.js';
import type { MessageSync } from './routes/wecom.js';
import type { Logger } from './types.js';

export type WechatApp = Hono & {
  stopAccepting(): void;
  shutdown(): Promise<void>;
  abort(): Promise<void>;
};

export function createApp({
  config,
  logger = console,
  messageProcessor,
}: {
  config: AppConfig;
  logger?: Logger;
  messageProcessor?: MessageSync | null;
}): WechatApp {
  const app = new Hono() as WechatApp;
  const wecomCrypto = new WecomCrypto(config.wecom);
  const runtime =
    messageProcessor === undefined ? createRuntime({ config, logger }) : null;
  const activeMessageProcessor =
    messageProcessor === undefined
      ? runtime!.messageProcessor
      : messageProcessor;

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

  app.stopAccepting = () => runtime?.stopAccepting?.();
  app.shutdown = () => Promise.resolve(runtime?.close());
  app.abort = () => Promise.resolve(runtime?.abort());

  return app;
}
