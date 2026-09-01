import type { IlinkEnrollmentConfig } from '../config.ts';
import type { StatePersistence } from '../state/persistence.ts';
import type { Logger } from '../types.ts';
import { IlinkLoginManager } from './login-manager.ts';
import { IlinkClient } from './protocol/client.ts';
import {
  IlinkSecretBox,
  readOrCreateIlinkStorageKey,
} from './secret-box.ts';

export function createIlinkEnrollmentService({
  persistence,
  config,
  onAccountsChanged,
  logger = console,
}: {
  readonly persistence: StatePersistence;
  readonly config: IlinkEnrollmentConfig['ilink'];
  readonly onAccountsChanged?: () => void | Promise<void>;
  readonly logger?: Logger;
}) {
  const accounts = persistence.createIlinkStore();
  const secretBox = new IlinkSecretBox(
    config.storageKey || readOrCreateIlinkStorageKey(
      config.storageKeyFile,
      { allowCreate: !accounts.hasEncryptedState() },
    ),
  );
  const offers = persistence.createIlinkLoginStore({ secretBox });
  offers.cleanup();
  const manager = new IlinkLoginManager({
    offers,
    accounts,
    secretBox,
    baseUrl: config.baseUrl,
    maxAccounts: config.maxAccounts,
    logger,
    client: new IlinkClient({
      baseUrl: config.baseUrl,
      timeoutMs: config.apiTimeoutMs,
      longPollTimeoutMs: config.longPollTimeoutMs,
    }),
    ...(onAccountsChanged ? { onAccountsChanged } : {}),
  });
  return Object.freeze({ accounts, offers, secretBox, manager });
}
