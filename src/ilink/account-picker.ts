import process from 'node:process';
import { emitKeypressEvents, type Key } from 'node:readline';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

import type { IlinkOperatorAccount } from './cli-login.ts';

type InputListener = (...args: unknown[]) => void;

interface IlinkPickerInput {
  readonly isTTY?: boolean;
  readonly isRaw?: boolean;
  isPaused?(): boolean;
  on(event: string, listener: InputListener): unknown;
  once(event: string, listener: InputListener): unknown;
  pause(): unknown;
  rawListeners(event: string): InputListener[];
  removeAllListeners(event: string): unknown;
  removeListener(event: string, listener: InputListener): unknown;
  resume(): unknown;
  setRawMode?(enabled: boolean): unknown;
}

interface IlinkPickerOutput {
  readonly columns?: number;
  readonly isTTY?: boolean;
  readonly rows?: number;
  on(event: string, listener: InputListener): unknown;
  removeListener(event: string, listener: InputListener): unknown;
  write(text: string): unknown;
}

interface SavedDataListener {
  readonly listener: InputListener;
  readonly once: boolean;
}

export interface IlinkPickerTerminal {
  readonly input: IlinkPickerInput;
  readonly output: IlinkPickerOutput;
}

export class IlinkPromptInterruptedError extends Error {
  constructor() {
    super('iLink account selection was interrupted');
    this.name = 'IlinkPromptInterruptedError';
  }
}

export function sanitizeTerminalText(value: string): string {
  return stripVTControlCharacters(String(value || ''))
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

function characterWidth(character: string): number {
  if (/^[\p{Mark}\u200d\ufe0e\ufe0f]$/u.test(character)) return 0;
  const code = character.codePointAt(0) || 0;
  return (
    /\p{Extended_Pictographic}/u.test(character) ||
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  ) ? 2 : 1;
}

function displayWidth(value: string): number {
  return [...value].reduce((width, character) => width + characterWidth(character), 0);
}

export function truncateTerminalText(value: string, maximum: number): string {
  const safe = sanitizeTerminalText(value);
  if (maximum <= 0) return '';
  if (displayWidth(safe) <= maximum) return safe;
  if (maximum === 1) return '…';
  let output = '';
  let width = 0;
  for (const character of safe) {
    const size = characterWidth(character);
    if (width + size > maximum - 1) break;
    output += character;
    width += size;
  }
  return `${output}…`;
}

export function accountPickerViewportTop(
  cursor: number,
  currentTop: number,
  count: number,
  capacity: number,
): number {
  if (count <= capacity) return 0;
  let top = currentTop;
  if (cursor < top) top = cursor;
  if (cursor >= top + capacity) top = cursor - capacity + 1;
  return Math.min(Math.max(0, top), count - capacity);
}

function defaultTerminal(): IlinkPickerTerminal {
  return {
    input: process.stdin as unknown as IlinkPickerInput,
    output: process.stdout as unknown as IlinkPickerOutput,
  };
}

function saveDataListeners(input: IlinkPickerInput): readonly SavedDataListener[] {
  return input.rawListeners('data').map((raw) => {
    const listener = (raw as InputListener & { listener?: InputListener }).listener;
    return { listener: listener || raw, once: Boolean(listener) };
  });
}

function restoreDataListeners(
  input: IlinkPickerInput,
  listeners: readonly SavedDataListener[],
): void {
  for (const saved of listeners) {
    if (saved.once) input.once('data', saved.listener);
    else input.on('data', saved.listener);
  }
}

function completeCleanup(operations: readonly (() => unknown)[]): void {
  const errors: unknown[] = [];
  for (const operation of operations) {
    try { operation(); } catch (error: unknown) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'Unable to restore the terminal');
}

function abortError(): Error {
  const error = new Error('iLink account selection was aborted');
  error.name = 'AbortError';
  return error;
}

function printable(value: string): boolean {
  return value.length > 0 && [...value].every((character) => {
    const code = character.codePointAt(0) || 0;
    return code >= 0x20 && code !== 0x7f &&
      !(code >= 0x80 && code <= 0x9f) &&
      !/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(character);
  });
}

export function pickIlinkAccount({
  accounts,
  command,
  runtimeActive,
  signal,
  terminal = defaultTerminal(),
}: {
  readonly accounts: readonly IlinkOperatorAccount[];
  readonly command: 'start' | 'stop' | 'delete';
  readonly runtimeActive: boolean;
  readonly signal: AbortSignal;
  readonly terminal?: IlinkPickerTerminal;
}): Promise<IlinkOperatorAccount | null> {
  const { input, output } = terminal;
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Interactive iLink account selection requires stdin and stdout TTYs');
  }
  if (signal.aborted) return Promise.reject(abortError());
  if (accounts.length === 0) return Promise.resolve(null);

  let query = '';
  let cursor = 0;
  let top = 0;
  let filtered = accounts.map((_account, index) => index);
  const status = (account: IlinkOperatorAccount): 'running' | 'stopped' =>
    runtimeActive && account.runtimeEnabled ? 'running' : 'stopped';
  const refilter = (): void => {
    const needle = query.toLocaleLowerCase();
    filtered = accounts.flatMap((account, index) =>
      `${account.providerAccountId} ${status(account)}`.toLocaleLowerCase().includes(needle)
        ? [index]
        : []);
    cursor = Math.min(cursor, Math.max(0, filtered.length - 1));
    top = accountPickerViewportTop(cursor, top, filtered.length, 8);
  };
  const render = (): void => {
    const rows = Math.max(1, output.rows || 24);
    const capacity = Math.max(1, Math.min(8, rows - 3));
    top = accountPickerViewportTop(cursor, top, filtered.length, capacity);
    const end = Math.min(filtered.length, top + capacity);
    const columns = Math.max(1, output.columns || 80);
    const title = truncateTerminalText(`Select an iLink account to ${command}`, columns);
    const help = truncateTerminalText(
      'Type to filter · ↑/↓ move · Enter select · Esc cancel',
      columns,
    );
    const filter = truncateTerminalText(
      `Filter: ${sanitizeTerminalText(query) || '(all)'} ` +
      `(${filtered.length ? cursor + 1 : 0}/${filtered.length})`,
      columns,
    );
    output.write('\u001b[H\u001b[J');
    output.write(`\u001b[1m${title}\u001b[0m\n`);
    output.write(`\u001b[2m${help}\u001b[0m\n`);
    output.write(`${filter}\n`);
    if (filtered.length === 0) {
      output.write(
        `\u001b[2m${truncateTerminalText('No matching accounts', columns)}` +
        '\u001b[0m\n',
      );
      return;
    }
    for (let row = top; row < end; row += 1) {
      const account = accounts[filtered[row]!]!;
      const selected = row === cursor;
      const accountStatus = status(account);
      const showStatus = columns >= 18;
      const labelWidth = Math.max(1, columns - (showStatus ? accountStatus.length + 5 : 2));
      const label = truncateTerminalText(account.providerAccountId, labelWidth);
      const spacing = showStatus
        ? ' '.repeat(Math.max(1, columns - displayWidth(label) - accountStatus.length - 3))
        : '';
      output.write(
        `${selected ? '\u001b[36m❯\u001b[0m' : ' '} ` +
        `${selected ? '\u001b[7m' : ''}${label}${selected ? '\u001b[0m' : ''}` +
        `${showStatus ? `${spacing}\u001b[2m${accountStatus}\u001b[0m` : ''}\n`,
      );
    }
  };

  return new Promise<IlinkOperatorAccount | null>((resolve, reject) => {
    const previousDataListeners = saveDataListeners(input);
    const previousRawMode = Boolean(input.isRaw);
    const wasPaused = input.isPaused?.() ?? false;
    const keys = new PassThrough();
    emitKeypressEvents(keys);
    let settled = false;
    let alternateScreen = false;
    const cleanup = (): void => completeCleanup([
      () => input.removeListener('data', onData as InputListener),
      () => input.removeListener('end', onEnd),
      () => input.removeListener('error', onError),
      () => output.removeListener('resize', onResize),
      () => output.removeListener('error', onError),
      () => signal.removeEventListener('abort', onAbort),
      () => keys.removeAllListeners(),
      () => keys.destroy(),
      () => input.setRawMode?.(previousRawMode),
      () => restoreDataListeners(input, previousDataListeners),
      () => wasPaused ? input.pause() : input.resume(),
      () => alternateScreen && output.write('\u001b[?25h\u001b[?1049l'),
    ]);
    const finish = (
      result: IlinkOperatorAccount | null,
      error?: Error,
    ): void => {
      if (settled) return;
      settled = true;
      try { cleanup(); } catch (cleanupError: unknown) {
        reject(cleanupError);
        return;
      }
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = (): void => finish(null, abortError());
    const onEnd = (): void => finish(null);
    const onError = (error: unknown): void =>
      finish(null, error instanceof Error ? error : new Error(String(error)));
    const onResize = (): void => {
      try { render(); } catch (error: unknown) {
        finish(null, error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onKeypress = (text: string | undefined, key: Key): void => {
      if (key.ctrl && key.name === 'c') {
        finish(null, new IlinkPromptInterruptedError());
        return;
      }
      if (key.name === 'escape' || (key.ctrl && key.name === 'd')) {
        finish(null);
        return;
      }
      if (key.name === 'up' || (key.ctrl && key.name === 'p')) {
        if (filtered.length) cursor = (cursor - 1 + filtered.length) % filtered.length;
      } else if (key.name === 'down' || (key.ctrl && key.name === 'n')) {
        if (filtered.length) cursor = (cursor + 1) % filtered.length;
      } else if (key.name === 'return' || key.name === 'enter') {
        if (filtered.length) finish(accounts[filtered[cursor]!]!);
        return;
      } else if (key.name === 'backspace') {
        query = [...query].slice(0, -1).join('');
        cursor = 0;
        refilter();
      } else if (text && printable(text) && [...query].length < 128) {
        query += text;
        cursor = 0;
        refilter();
      } else {
        return;
      }
      onResize();
    };
    const onData = (chunk: unknown): void => {
      if (Buffer.isBuffer(chunk) || typeof chunk === 'string') keys.write(chunk);
    };

    try {
      input.removeAllListeners('data');
      input.setRawMode?.(true);
      input.resume();
      keys.on('keypress', onKeypress);
      keys.on('error', onError);
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('error', onError);
      output.on('resize', onResize);
      output.on('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
      alternateScreen = true;
      output.write('\u001b[?1049h\u001b[?25l');
      render();
    } catch (error: unknown) {
      finish(null, error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export function confirmIlinkAccountDeletion({
  account,
  signal,
  terminal = defaultTerminal(),
}: {
  readonly account: IlinkOperatorAccount;
  readonly signal: AbortSignal;
  readonly terminal?: IlinkPickerTerminal;
}): Promise<boolean> {
  const { input, output } = terminal;
  if (!input.isTTY || !output.isTTY) {
    throw new Error('Interactive iLink deletion confirmation requires stdin and stdout TTYs');
  }
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<boolean>((resolve, reject) => {
    const previousDataListeners = saveDataListeners(input);
    const previousRawMode = Boolean(input.isRaw);
    const wasPaused = input.isPaused?.() ?? false;
    const keys = new PassThrough();
    emitKeypressEvents(keys);
    let settled = false;
    const cleanup = (): void => completeCleanup([
      () => input.removeListener('data', onData as InputListener),
      () => input.removeListener('end', onEnd),
      () => input.removeListener('error', onError),
      () => output.removeListener('error', onError),
      () => signal.removeEventListener('abort', onAbort),
      () => keys.removeAllListeners(),
      () => keys.destroy(),
      () => input.setRawMode?.(previousRawMode),
      () => restoreDataListeners(input, previousDataListeners),
      () => wasPaused ? input.pause() : input.resume(),
      () => output.write('\n'),
    ]);
    const finish = (result: boolean, error?: Error): void => {
      if (settled) return;
      settled = true;
      try { cleanup(); } catch (cleanupError: unknown) {
        reject(cleanupError);
        return;
      }
      if (error) reject(error);
      else resolve(result);
    };
    const onAbort = (): void => finish(false, abortError());
    const onEnd = (): void => finish(false);
    const onError = (error: unknown): void =>
      finish(false, error instanceof Error ? error : new Error(String(error)));
    const onKeypress = (_text: string | undefined, key: Key): void => {
      if (key.ctrl && key.name === 'c') {
        finish(false, new IlinkPromptInterruptedError());
        return;
      }
      if (
        key.name === 'escape' ||
        key.name === 'return' ||
        key.name === 'enter' ||
        (key.ctrl && key.name === 'd') ||
        key.name === 'n'
      ) {
        finish(false);
        return;
      }
      if (key.name === 'y' && !key.ctrl && !key.meta) finish(true);
    };
    const onData = (chunk: unknown): void => {
      if (Buffer.isBuffer(chunk) || typeof chunk === 'string') keys.write(chunk);
    };

    try {
      input.removeAllListeners('data');
      input.setRawMode?.(true);
      input.resume();
      keys.on('keypress', onKeypress);
      keys.on('error', onError);
      input.on('data', onData);
      input.on('end', onEnd);
      input.on('error', onError);
      output.on('error', onError);
      signal.addEventListener('abort', onAbort, { once: true });
      output.write(
        `Delete ${JSON.stringify(sanitizeTerminalText(account.providerAccountId))} ` +
        'and all scoped Kintio data? [y/N] ',
      );
    } catch (error: unknown) {
      finish(false, error instanceof Error ? error : new Error(String(error)));
    }
  });
}
