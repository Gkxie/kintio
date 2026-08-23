import { bodyLimit } from 'hono/body-limit';

import { extractXmlTag } from '../lib/xml.js';

const MAX_BODY_BYTES = 1024 * 1024;

function getCallbackParameters(context, includeEchoString) {
  const parameters = {
    signature: context.req.query('msg_signature') || '',
    timestamp: context.req.query('timestamp') || '',
    nonce: context.req.query('nonce') || '',
  };

  if (includeEchoString) {
    parameters.encrypted = context.req.query('echostr') || '';
  }

  return parameters;
}

function hasAuthenticationQuery(context) {
  return (
    context.req.query('msg_signature') !== undefined ||
    context.req.query('echostr') !== undefined
  );
}

export function registerWecomRoutes(
  app,
  { wecomCrypto, logger, messageProcessor },
) {
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
    } catch (error) {
      logger.error(`[wecom] callback URL verification failed: ${error.message}`);
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

        logger.info(`[wecom] accepted callback event=${event} open_kfid=${openKfId}`);

        if (event === 'kf_msg_or_event' && messageProcessor) {
          if (callbackToken && openKfId !== 'unknown') {
            void messageProcessor.enqueue({ callbackToken, openKfId });
          } else {
            logger.warn?.(
              '[wecom] callback did not contain Token and OpenKfId; message sync skipped',
            );
          }
        }

        return context.text('success');
      } catch (error) {
        logger.error(`[wecom] callback processing failed: ${error.message}`);
        return context.text('invalid callback request', 400);
      }
    },
  );
}
