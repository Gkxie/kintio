import crypto from 'node:crypto';

function removePkcs7Padding(buffer: Buffer): Buffer {
  if (buffer.length === 0) {
    throw new Error('The decrypted payload is empty');
  }

  const paddingLength = buffer.at(-1);

  if (
    paddingLength === undefined ||
    paddingLength < 1 ||
    paddingLength > 32 ||
    paddingLength > buffer.length
  ) {
    throw new Error('The decrypted payload has invalid PKCS#7 padding');
  }

  for (let index = buffer.length - paddingLength; index < buffer.length; index += 1) {
    if (buffer[index] !== paddingLength) {
      throw new Error('The decrypted payload has invalid PKCS#7 padding');
    }
  }

  return buffer.subarray(0, buffer.length - paddingLength);
}

function signaturesMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual || '', 'utf8');
  const expectedBuffer = Buffer.from(expected, 'utf8');

  return (
    actualBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export class WecomCrypto {
  readonly callbackToken: string;
  readonly expectedReceiveId: string;
  readonly aesKey: Buffer;

  constructor({
    callbackToken,
    encodingAesKey,
    expectedReceiveId = '',
  }: {
    callbackToken: string;
    encodingAesKey: string;
    expectedReceiveId?: string;
  }) {
    this.callbackToken = callbackToken;
    this.expectedReceiveId = expectedReceiveId;
    this.aesKey = Buffer.from(`${encodingAesKey}=`, 'base64');

    if (this.aesKey.length !== 32) {
      throw new Error('WECOM_ENCODING_AES_KEY must decode to 32 bytes');
    }
  }

  calculateSignature(
    timestamp: string,
    nonce: string,
    encrypted: string,
  ): string {
    return crypto
      .createHash('sha1')
      .update([this.callbackToken, timestamp, nonce, encrypted].sort().join(''), 'utf8')
      .digest('hex');
  }

  verifySignature(
    signature: string,
    timestamp: string,
    nonce: string,
    encrypted: string,
  ): boolean {
    return signaturesMatch(
      signature,
      this.calculateSignature(timestamp, nonce, encrypted),
    );
  }

  decryptMessage(encrypted: string): { message: string; receiveId: string } {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted || '')) {
      throw new Error('The encrypted payload is not valid Base64');
    }

    const decipher = crypto.createDecipheriv(
      'aes-256-cbc',
      this.aesKey,
      this.aesKey.subarray(0, 16),
    );
    decipher.setAutoPadding(false);

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]);
    const plaintext = removePkcs7Padding(decrypted);

    if (plaintext.length < 20) {
      throw new Error('The decrypted payload is too short');
    }

    const messageLength = plaintext.readUInt32BE(16);
    const messageStart = 20;
    const messageEnd = messageStart + messageLength;

    if (messageEnd > plaintext.length) {
      throw new Error('The decrypted payload contains an invalid message length');
    }

    const message = plaintext.subarray(messageStart, messageEnd).toString('utf8');
    const receiveId = plaintext.subarray(messageEnd).toString('utf8');

    if (this.expectedReceiveId && receiveId !== this.expectedReceiveId) {
      throw new Error('The callback receive ID does not match WECOM_RECEIVE_ID');
    }

    return { message, receiveId };
  }
}
