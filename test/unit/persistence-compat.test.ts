import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

import { beforeAll, test } from 'vitest';

import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import {
  canonicalJson,
  stableAttemptKey,
  stableClientMessageId,
  stableMessageKey,
} from '../../src/state/compat.ts';
import type { ChatChannel } from '../../src/types.ts';

interface Fixture {
  readonly stableIds: readonly {
    readonly channel: ChatChannel;
    readonly accountKey: string;
    readonly providerMessageId: string;
    readonly sendIndex: number;
    readonly messageKey: string;
    readonly clientMessageId: string;
    readonly attemptId: string;
  }[];
  readonly canonicalJson: readonly {
    readonly input: unknown;
    readonly encoded: string;
  }[];
  readonly canonicalNumbers: readonly {
    readonly input: string;
    readonly encoded: string;
  }[];
  readonly secretBox: {
    readonly key: string;
    readonly scope: {
      readonly secretKind: string;
      readonly accountId: string;
      readonly peerId: string;
      readonly generation: number;
    };
    readonly secret: string;
    readonly envelope: {
      readonly nonce: string;
      readonly ciphertext: string;
      readonly authTag: string;
    };
  };
}

let fixture: Fixture;

beforeAll(async () => {
  fixture = JSON.parse(await fs.readFile(
    new URL('../fixtures/persistence-compat-v1.json', import.meta.url),
    'utf8',
  )) as Fixture;
});

test('stable persistence identifiers remain byte-compatible', () => {
  for (const vector of fixture.stableIds) {
    const messageKey = stableMessageKey(
      vector.channel,
      vector.accountKey,
      vector.providerMessageId,
    );
    assert.equal(messageKey, vector.messageKey);
    assert.equal(
      stableClientMessageId(messageKey, vector.sendIndex),
      vector.clientMessageId,
    );
    assert.equal(
      stableAttemptKey(messageKey, vector.sendIndex),
      vector.attemptId,
    );
  }
});

test('canonical JSON preserves JavaScript ordering and number bytes', () => {
  for (const vector of fixture.canonicalJson) {
    assert.equal(canonicalJson(vector.input), vector.encoded);
  }
  for (const vector of fixture.canonicalNumbers) {
    assert.equal(canonicalJson(Number(vector.input)), vector.encoded);
  }
  assert.equal(
    canonicalJson({ omitted: undefined, kept: null, array: [undefined] }),
    '{"array":[null],"kept":null}',
  );
  assert.throws(() => canonicalJson(Number.NaN), /numbers must be finite/u);
});

test('the deterministic AES-GCM fixture opens in the production TypeScript box', () => {
  const box = new IlinkSecretBox(fixture.secretBox.key);
  assert.ok(
    box.open(fixture.secretBox.envelope, fixture.secretBox.scope) ===
      fixture.secretBox.secret,
    'the compatibility fixture must decrypt to the expected secret',
  );

  const fresh = box.seal(fixture.secretBox.secret, fixture.secretBox.scope);
  assert.ok(
    box.open(fresh, fixture.secretBox.scope) === fixture.secretBox.secret,
    'a fresh envelope must round-trip without exposing its plaintext',
  );

  const utf8Boundary = {
    ...fixture.secretBox.scope,
    accountId: '😀'.repeat(128),
  };
  assert.doesNotThrow(() => box.seal('boundary', utf8Boundary));
  assert.throws(
    () => box.seal('boundary', { ...utf8Boundary, accountId: '😀'.repeat(129) }),
    /Invalid iLink secret scope/u,
  );
  assert.doesNotThrow(() => box.seal('boundary', {
    ...fixture.secretBox.scope,
    secretKind: `a${'b'.repeat(63)}`,
  }));
  assert.throws(
    () => box.seal('boundary', {
      ...fixture.secretBox.scope,
      secretKind: `a${'b'.repeat(64)}`,
    }),
    /Invalid iLink secret scope/u,
  );
});
