import { bodyLimit } from 'hono/body-limit';
import type { Hono } from 'hono';

import { extractXmlTag } from '../lib/xml.ts';
import type { WecomCrypto } from '../lib/wecom-crypto.ts';
import type { Logger } from '../types.ts';

const MAX_BODY_BYTES = 1024 * 1024;

interface CallbackContext {
  req: { query(name: string): string | undefined };
}

export interface MessageSync {
  enqueue(input: { callbackToken: string; openKfId: string }): boolean;
}

function getCallbackParameters(
  context: CallbackContext,
  includeEchoString: boolean,
): {
  signature: string;
  timestamp: string;
  nonce: string;
  encrypted: string;
} {
  const parameters = {
    signature: context.req.query('msg_signature') || '',
    timestamp: context.req.query('timestamp') || '',
    nonce: context.req.query('nonce') || '',
    encrypted: '',
  };

  if (includeEchoString) {
    parameters.encrypted = context.req.query('echostr') || '';
  }

  return parameters;
}

function hasAuthenticationQuery(context: CallbackContext): boolean {
  return (
    context.req.query('msg_signature') !== undefined ||
    context.req.query('echostr') !== undefined
  );
}

export function registerWecomRoutes(
  app: Hono,
  {
    wecomCrypto,
    logger,
    messageProcessor,
  }: {
    wecomCrypto: WecomCrypto;
    logger: Logger;
    messageProcessor: MessageSync | null;
  },
): void {
  app.get('/', (context) => {
    if (!hasAuthenticationQuery(context)) {
      return context.text('hello world');
    }

    const parameters = getCallbackParameters(context, true);
    const { signature, timestamp, nonce, encrypted } = parameters;

    if (!signature || !timestamp || !nonce || !encrypted) {
      return context.text('missing callback parameters', 400);
    }

    if (!wecomCrypto.verifySignature(signature, timestamp, nonce, encrypted)) {
      return context.text('invalid signature', 403);
    }

    try {
      const { message } = wecomCrypto.decryptMessage(encrypted);
      logger.info('[wecom] callback URL verification succeeded');
      return context.text(message);
    } catch (error: unknown) {
      logger.error(
        `[wecom] callback URL verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return context.text('invalid encrypted payload', 400);
    }
  });

  app.post(
    '/',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (context) => context.text('request body is too large', 413),
    }),
    async (context) => {
      const parameters = getCallbackParameters(context, false);

      try {
        const body = await context.req.text();
        const encrypted = extractXmlTag(body, 'Encrypt');

        if (
          !parameters.signature ||
          !parameters.timestamp ||
          !parameters.nonce ||
          !encrypted
        ) {
          return context.text('invalid callback request', 400);
        }

        if (
          !wecomCrypto.verifySignature(
            parameters.signature,
            parameters.timestamp,
            parameters.nonce,
            encrypted,
          )
        ) {
          return context.text('invalid signature', 403);
        }

        const { message } = wecomCrypto.decryptMessage(encrypted);
        const event = extractXmlTag(message, 'Event') || 'unknown';
        const openKfId = extractXmlTag(message, 'OpenKfId') || 'unknown';
        const callbackToken = extractXmlTag(message, 'Token');

        logger.info(`[wecom] accepted callback event=${event}`);

        if (event === 'kf_msg_or_event' && messageProcessor) {
          if (callbackToken && openKfId !== 'unknown') {
            let accepted = false;
            try {
              accepted = messageProcessor.enqueue({ callbackToken, openKfId });
            } catch (error: unknown) {
              logger.error(
                `[wecom] callback sync registration failed: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
              return context.text('service unavailable', 503);
            }
            if (!accepted) return context.text('service unavailable', 503);
          } else {
            logger.warn?.(
              '[wecom] callback did not contain Token and OpenKfId; message sync skipped',
            );
          }
        }

        return context.text('success');
      } catch (error: unknown) {
        logger.error(
          `[wecom] callback processing failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return context.text('invalid callback request', 400);
      }
    },
  );
}
