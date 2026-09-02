import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { describe, it } from 'vitest';

import {
  accountPickerViewportTop,
  confirmIlinkAccountDeletion,
  IlinkPromptInterruptedError,
  pickIlinkAccount,
  sanitizeTerminalText,
  truncateTerminalText,
  type IlinkPickerTerminal,
} from '../../src/ilink/account-picker.ts';
import type { IlinkOperatorAccount } from '../../src/ilink/cli-login.ts';

class FakeInput extends EventEmitter {
  readonly isTTY = true;
  isRaw = false;
  paused = true;
  failRawEnable = false;

  isPaused(): boolean { return this.paused; }
  pause(): this { this.paused = true; return this; }
  resume(): this { this.paused = false; return this; }
  setRawMode(enabled: boolean): this {
    if (enabled && this.failRawEnable) throw new Error('simulated raw mode failure');
    this.isRaw = enabled;
    return this;
  }
}

class FakeOutput extends EventEmitter {
  readonly isTTY = true;
  columns = 64;
  rows = 16;
  readonly chunks: string[] = [];
  failNextWrite = false;

  write(text: string): boolean {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error('simulated terminal write failure');
    }
    this.chunks.push(text);
    return true;
  }
}

function terminal(): {
  readonly input: FakeInput;
  readonly output: FakeOutput;
  readonly value: IlinkPickerTerminal;
} {
  const input = new FakeInput();
  const output = new FakeOutput();
  return {
    input,
    output,
    value: { input, output } as unknown as IlinkPickerTerminal,
  };
}

function account(index: number, overrides: Partial<IlinkOperatorAccount> = {}): IlinkOperatorAccount {
  const digit = String(index % 10);
  return {
    accountKey: `ia_${digit.repeat(40)}`,
    generation: index + 1,
    incarnation: `ii_${digit.repeat(64)}`,
    providerAccountId: `bot-${index}@im.bot`,
    runtimeEnabled: index % 2 === 0,
    ...overrides,
  };
}

describe('iLink account picker terminal contract', () => {
  it('sanitizes terminal controls and keeps viewport/truncation bounded', () => {
    assert.equal(sanitizeTerminalText(' bot\u001b[31m\n\u202eevil '), 'bot evil');
    assert.equal(truncateTerminalText('abcdef', 4), 'abc…');
    assert.equal(truncateTerminalText('中文账号', 5), '中文…');
    assert.equal(accountPickerViewportTop(0, 0, 1_000, 8), 0);
    assert.equal(accountPickerViewportTop(9, 0, 1_000, 8), 2);
    assert.equal(accountPickerViewportTop(999, 2, 1_000, 8), 992);
  });

  it('moves, filters, selects, and restores raw mode and prior listeners', async () => {
    const io = terminal();
    let priorCalls = 0;
    let onceCalls = 0;
    const prior = () => { priorCalls += 1; };
    io.input.on('data', prior);
    io.input.once('data', () => { onceCalls += 1; });
    const selected = pickIlinkAccount({
      accounts: [account(0), account(1), account(2)],
      command: 'start',
      runtimeActive: true,
      signal: new AbortController().signal,
      terminal: io.value,
    });
    assert.equal(io.input.isRaw, true);
    assert.equal(io.input.listeners('data').includes(prior), false);
    io.input.emit('data', Buffer.from([0x1b]));
    io.input.emit('data', Buffer.from('[B'));
    io.input.emit('data', '\r');
    assert.equal((await selected)?.providerAccountId, 'bot-1@im.bot');
    assert.equal(io.input.isRaw, false);
    assert.equal(io.input.paused, true);
    assert.equal(io.input.listeners('data').includes(prior), true);
    io.input.emit('data', 'after');
    io.input.emit('data', 'again');
    assert.equal(priorCalls, 2);
    assert.equal(onceCalls, 1);
    assert.match(io.output.chunks.join(''), /\u001b\[\?1049h[\s\S]+\u001b\[\?1049l/u);

    const filteredIo = terminal();
    const filtered = pickIlinkAccount({
      accounts: [account(0), account(1), account(2)],
      command: 'stop',
      runtimeActive: true,
      signal: new AbortController().signal,
      terminal: filteredIo.value,
    });
    filteredIo.input.emit('data', 'stopped\r');
    assert.equal((await filtered)?.providerAccountId, 'bot-1@im.bot');
  });

  it('cancels on Esc or EOF and reports Ctrl-C or AbortSignal as interruption', async () => {
    for (const event of ['escape', 'eof'] as const) {
      const io = terminal();
      const picked = pickIlinkAccount({
        accounts: [account(0)],
        command: 'delete',
        runtimeActive: false,
        signal: new AbortController().signal,
        terminal: io.value,
      });
      if (event === 'escape') io.input.emit('data', '\u001b');
      else io.input.emit('end');
      assert.equal(await picked, null);
      assert.equal(io.input.isRaw, false);
    }

    const interruptedIo = terminal();
    const interrupted = pickIlinkAccount({
      accounts: [account(0)],
      command: 'start',
      runtimeActive: false,
      signal: new AbortController().signal,
      terminal: interruptedIo.value,
    });
    interruptedIo.input.emit('data', '\u0003');
    await assert.rejects(interrupted, IlinkPromptInterruptedError);
    assert.equal(interruptedIo.input.isRaw, false);

    const abortedIo = terminal();
    const controller = new AbortController();
    const aborted = pickIlinkAccount({
      accounts: [account(0)],
      command: 'start',
      runtimeActive: false,
      signal: controller.signal,
      terminal: abortedIo.value,
    });
    controller.abort();
    await assert.rejects(aborted, (error: unknown) =>
      error instanceof Error && error.name === 'AbortError');
    assert.equal(abortedIo.input.isRaw, false);

    const controlD = terminal();
    const endedByKey = pickIlinkAccount({
      accounts: [account(0)],
      command: 'start',
      runtimeActive: false,
      signal: new AbortController().signal,
      terminal: controlD.value,
    });
    controlD.input.emit('data', '\u0004');
    assert.equal(await endedByKey, null);
  });

  it('decodes fragmented UTF-8 in a narrow terminal and cleans partial setup failures', async () => {
    const narrow = terminal();
    narrow.output.columns = 10;
    narrow.output.rows = 4;
    const selected = pickIlinkAccount({
      accounts: [account(0, { providerAccountId: '中文账号@im.bot' })],
      command: 'start',
      runtimeActive: false,
      signal: new AbortController().signal,
      terminal: narrow.value,
    });
    const bytes = Buffer.from('中');
    narrow.input.emit('data', bytes.subarray(0, 1));
    narrow.input.emit('data', bytes.subarray(1));
    narrow.input.emit('data', '\r');
    assert.equal((await selected)?.providerAccountId, '中文账号@im.bot');

    const failed = terminal();
    let restored = 0;
    failed.input.once('data', () => { restored += 1; });
    failed.input.failRawEnable = true;
    await assert.rejects(() => pickIlinkAccount({
      accounts: [account(0)],
      command: 'start',
      runtimeActive: false,
      signal: new AbortController().signal,
      terminal: failed.value,
    }), /simulated raw mode failure/u);
    failed.input.emit('data', 'after');
    failed.input.emit('data', 'again');
    assert.equal(restored, 1);
    assert.equal(failed.input.isRaw, false);

    const writeFailed = terminal();
    writeFailed.output.failNextWrite = true;
    await assert.rejects(() => pickIlinkAccount({
      accounts: [account(0)],
      command: 'start',
      runtimeActive: false,
      signal: new AbortController().signal,
      terminal: writeFailed.value,
    }), /simulated terminal write failure/u);
    assert.equal(writeFailed.input.isRaw, false);
  });

  it('renders hostile account text without reproducing its control sequence', async () => {
    const io = terminal();
    const picked = pickIlinkAccount({
      accounts: [account(0, { providerAccountId: 'safe\u001b[31m\n\u202ename' })],
      command: 'start',
      runtimeActive: false,
      signal: new AbortController().signal,
      terminal: io.value,
    });
    io.input.emit('data', '\u001b');
    await picked;
    const rendered = io.output.chunks.join('');
    assert.doesNotMatch(rendered, /safe\u001b\[31m/u);
    assert.match(rendered, /safe name/u);
  });
});

describe('iLink deletion confirmation', () => {
  it('defaults to No, accepts y, and restores terminal state', async () => {
    const no = terminal();
    const rejected = confirmIlinkAccountDeletion({
      account: account(0),
      signal: new AbortController().signal,
      terminal: no.value,
    });
    no.input.emit('data', '\r');
    assert.equal(await rejected, false);
    assert.equal(no.input.isRaw, false);

    const yes = terminal();
    const accepted = confirmIlinkAccountDeletion({
      account: account(0),
      signal: new AbortController().signal,
      terminal: yes.value,
    });
    yes.input.emit('data', 'yes');
    assert.equal(await accepted, true);
    assert.match(yes.output.chunks.join(''), /Delete "bot-0@im\.bot"/u);

    const modified = terminal();
    const ctrlY = confirmIlinkAccountDeletion({
      account: account(0),
      signal: new AbortController().signal,
      terminal: modified.value,
    });
    modified.input.emit('data', '\u0019');
    modified.input.emit('data', '\r');
    assert.equal(await ctrlY, false);
  });

  it('treats EOF as No and Ctrl-C as interruption', async () => {
    const eof = terminal();
    const ended = confirmIlinkAccountDeletion({
      account: account(0),
      signal: new AbortController().signal,
      terminal: eof.value,
    });
    eof.input.emit('end');
    assert.equal(await ended, false);

    const interrupted = terminal();
    const pending = confirmIlinkAccountDeletion({
      account: account(0),
      signal: new AbortController().signal,
      terminal: interrupted.value,
    });
    interrupted.input.emit('data', '\u0003');
    await assert.rejects(pending, IlinkPromptInterruptedError);

    const escaped = terminal();
    const cancelled = confirmIlinkAccountDeletion({
      account: account(0),
      signal: new AbortController().signal,
      terminal: escaped.value,
    });
    escaped.input.emit('data', '\u001b');
    assert.equal(await cancelled, false);

    const controlD = terminal();
    const endedByKey = confirmIlinkAccountDeletion({
      account: account(0),
      signal: new AbortController().signal,
      terminal: controlD.value,
    });
    controlD.input.emit('data', '\u0004');
    assert.equal(await endedByKey, false);

    const aborted = terminal();
    const controller = new AbortController();
    const aborting = confirmIlinkAccountDeletion({
      account: account(0),
      signal: controller.signal,
      terminal: aborted.value,
    });
    controller.abort();
    await assert.rejects(aborting, (error: unknown) =>
      error instanceof Error && error.name === 'AbortError');
  });
});
