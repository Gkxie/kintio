import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';

import { WecomCrypto } from './lib/wecom-crypto.ts';
import { registerWecomRoutes } from './routes/wecom.ts';
import { createRuntime } from './runtime.ts';
import type { AppConfig } from './config.ts';
import type { MessageSync } from './routes/wecom.ts';
import type { Logger } from './types.ts';

type WechatApp = Hono & {
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
  const runtime = messageProcessor === undefined
    ? createRuntime({ config, logger })
    : undefined;
  const activeMessageProcessor =
    runtime?.messageProcessor ?? messageProcessor ?? null;

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

  app.stopAccepting = () => runtime?.stopAccepting();
  app.shutdown = () => runtime ? runtime.close() : Promise.resolve();
  app.abort = () => runtime ? runtime.abort() : Promise.resolve();

  return app;
}
