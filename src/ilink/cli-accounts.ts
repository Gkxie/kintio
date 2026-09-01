import fs from 'node:fs';

import type { IlinkEnrollmentConfig } from '../config.ts';
import {
  openIlinkOperatorControl,
  type IlinkOperatorAccount,
  type IlinkOperatorControl,
} from './cli-login.ts';

export type IlinkAccountCommand = 'list' | 'start' | 'stop' | 'delete';

export interface IlinkAccountCommandResult {
  readonly startForeground: boolean;
  readonly runningCount: number;
}

function choices(
  accounts: readonly IlinkOperatorAccount[],
  runtimeActive: boolean,
): string {
  return accounts.map((account, index) =>
    `  ${index + 1}. ${JSON.stringify(account.providerAccountId)} ` +
    `${account.accountKey} [` +
    `${runtimeActive && account.runtimeEnabled ? 'running' : 'stopped'}]`
  ).join('\n');
}

function selectAccount(
  accounts: readonly IlinkOperatorAccount[],
  selector: string | undefined,
  runtimeActive: boolean,
): IlinkOperatorAccount {
  if (accounts.length === 0) {
    throw new Error('No iLink account is enrolled; run "kintio ilink login" first');
  }
  if (!selector) {
    if (accounts.length === 1) return accounts[0]!;
    throw new Error(
      `Multiple iLink accounts are enrolled; use --account with one choice:\n` +
      choices(accounts, runtimeActive),
    );
  }
  const matches = accounts.filter((account) =>
    account.accountKey === selector || account.providerAccountId === selector);
  if (matches.length !== 1) {
    throw new Error(
      `Unknown or ambiguous iLink account ${JSON.stringify(selector)}:\n` +
      choices(accounts, runtimeActive),
    );
  }
  return matches[0]!;
}

export async function runIlinkAccountCommand({
  command,
  selector,
  confirmed = false,
  config,
  packageRoot,
  signal,
  stdout,
  openControl,
}: {
  readonly command: IlinkAccountCommand;
  readonly selector?: string;
  readonly confirmed?: boolean;
  readonly config: Pick<IlinkEnrollmentConfig, 'state' | 'ilink'>;
  readonly packageRoot: string;
  readonly signal: AbortSignal;
  readonly stdout: (text: string) => void;
  readonly openControl?: () => Promise<IlinkOperatorControl>;
}): Promise<IlinkAccountCommandResult> {
  if (!openControl && !fs.existsSync(config.state.databaseFile)) {
    if (command === 'list') {
      stdout('No iLink accounts enrolled.\n');
      return { startForeground: false, runningCount: 0 };
    }
    throw new Error('No iLink account is enrolled; run "kintio ilink login" first');
  }
  const control = await (openControl?.() ||
    openIlinkOperatorControl(config, packageRoot, signal));
  try {
    const accounts = await control.listAccounts();
    const runtimeActive = control.mode === 'runtime';
    if (command === 'list') {
      stdout(accounts.length
        ? `${choices(accounts, runtimeActive)}\n`
        : 'No iLink accounts enrolled.\n');
      return {
        startForeground: false,
        runningCount: accounts.filter((account) => account.runtimeEnabled).length,
      };
    }
    const account = selectAccount(accounts, selector, runtimeActive);
    if (command === 'delete' && !confirmed) {
      throw new Error(
        `Deleting ${JSON.stringify(account.providerAccountId)} permanently removes the account, ` +
        'credentials, conversations, messages, media, send records, and audit records; ' +
        'repeat with --yes',
      );
    }
    const result = command === 'delete'
      ? await control.deleteAccount(account.accountKey)
      : await control.setAccountRuntime(account.accountKey, command === 'start');
    stdout(
      `${command === 'delete' ? 'Deleted' : command === 'start' ? 'Started' : 'Stopped'} ` +
      `${JSON.stringify(account.providerAccountId)}.\n`,
    );
    return {
      startForeground: command === 'start' && control.mode === 'standalone',
      runningCount: result.runningCount,
    };
  } finally {
    await control.close();
  }
}
