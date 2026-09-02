# CLI Update and Interactive iLink Lifecycle Plan

Status: accepted for implementation  
Tracking: [#74](https://github.com/Gkxie/kintio/issues/74)  
Date: 2026-09-02

## Goal

Make the installed Kintio CLI maintainable with one explicit update command and
make ordinary iLink lifecycle commands usable without copying internal account
identifiers. Preserve deterministic non-interactive behavior and never interrupt
active Agent work merely to install a new package.

## Delivery strategy

The work is delivered in two sequential pull requests. Both features touch the
root CLI, but their failure domains are independent and should remain separately
reviewable and reversible.

### Priority 0 — managed CLI update

One atomic pull request contains the complete updater boundary:

1. Add equivalent `kintio update` and `kintio upgrade` commands.
2. Add an authenticated daemon/worker `stop-if-idle` protocol.
3. Detect the package manager that owns the running global installation.
4. Install one Registry-resolved exact version into the same global location.
5. Verify the new CLI without consulting `PATH`.
6. Restore the selected instance in its previous `service` or `ilink` mode.
7. Make ordinary `kintio restart` preserve an existing mode.

The protocol and updater cannot be split: an updater shipped without the worker
gate would either race new work or depend on an incompatible intermediate
protocol.

### Priority 1 — interactive iLink lifecycle

A second pull request adds:

1. First-time interactive `ilink start` calls login once and continues start.
2. Multiple accounts are selected through a bounded searchable terminal picker.
3. Interactive deletion uses an explicit default-deny confirmation.
4. Account snapshots are closed before any human wait.
5. The mutation revalidates the selected account generation.
6. Existing `--account` and `--yes` inputs remain the automation contract.

### Priority 2 — release and physical verification

1. Run all local and GitHub test projects on Linux, macOS, and Windows.
2. After publication, install the previous public version in an isolated global
   prefix, run its updater, and verify the newly published version.
3. Verify the interactive picker in a real terminal and the update path against
   an actual global npm installation.

## Priority 0 design

### Command contract

```text
kintio update
kintio upgrade
```

The commands are aliases with identical output and exit status. They require no
setup and accept the existing `--home` and `--config` options only to identify the
Runtime instance that may need to be stopped and restored.

The first version has no `--force`, `--check`, downgrade, prerelease, automatic,
or scheduled mode. Unknown arguments fail before any network or process mutation.

### Installation ownership

Only a positively identified global npm or pnpm installation is mutable.

For npm:

- require package name `@kin-tio/cli`;
- accept the scoped package only below the platform's canonical global
  `node_modules` layout;
- derive and pin the owning npm prefix;
- verify the candidate package root resolves to the currently running package.

For pnpm:

- query the active `pnpm` executable for its global package and bin roots;
- match the stable global package path to the current package through real paths;
- pin the same global package and bin locations during installation;
- preserve the stable logical package root instead of a versioned store path.

Source checkouts, local dependencies, `npm link`, transient `npx`, Yarn, Bun,
Homebrew, standalone binaries, ambiguous layouts, and a package manager pointing
at another global root fail closed. The updater never invokes `sudo` and never
guesses a prefix.

### Version resolution and installation

1. Query the official npm Registry `latest` metadata with a bounded timeout and
   response size.
2. Require package identity `@kin-tio/cli` and a canonical stable `X.Y.Z` version.
3. Compare it with the baked `KINTIO_VERSION`.
4. If it is not newer, exit successfully before acquiring lifecycle locks.
5. Install `@kin-tio/cli@X.Y.Z`, not the mutable `latest` tag.
6. Pass arguments directly through `cross-spawn`; never interpolate a shell.
7. Run package managers from a stable user directory with a minimal environment
   that contains tool resolution, proxy, CA, temporary-directory, and package
   manager settings but excludes Kintio channel and Agent credentials.
8. Disable package lifecycle scripts because Kintio does not require them.

### Atomic idle gate

A SQLite snapshot or separate `ping` and `stop` calls cannot authorize an update:
active work lives partly in memory and new work can enter between two requests.

The control protocol gains one authenticated `stop-if-idle` operation:

1. CLI sends one request to the daemon.
2. Daemon forwards a request with a bounded request ID to its exact Worker.
3. Worker synchronously checks all conversation queues, recoveries, background
   tasks, active conversations, waiters, startup/deferred drains, Agent work, and
   active terminal login work.
4. Busy returns a negative response and changes no ingress, listener, queue, or
   Runtime state.
5. Idle atomically closes admission in the same event-loop turn, acknowledges the
   daemon, and cannot accept a new conversation afterward.
6. Daemon acknowledges the CLI and enters the existing graceful shutdown path.
7. CLI waits for daemon metadata and its lock to disappear before installation.

Polling without a customer conversation is not busy. A starting Worker, an
unreachable Worker, a mismatched response, or an unprovable state fails closed.
A failed/backoff daemon with no Worker may stop directly.

### Update transaction

```text
resolve exact target
  -> acquire installation update lock
  -> acquire selected instance lifecycle lock
  -> validate daemon ownership/config
  -> atomically stop only if idle
  -> install exact version
  -> run new <stable-package-root>/bin/kintio.js --version
  -> restore the previous mode and wait for ready
```

If no daemon was running, the command updates only the CLI and does not start a
new Runtime. A foreground Runtime or standalone login owns the instance lock but
has no daemon control plane, so the updater refuses before installation.

The daemon record supplies the pre-update mode and normalized state paths. The
running daemon keeps a versioned identity of its effective Runtime configuration
and inherited host-Agent environment in memory; the atomic idle request must
match it before shutdown. No credential digest is persisted. Restoration must
use the new stable package root returned by installation ownership detection,
not the old process's possibly versioned real path, and stable record identities
are verified again before success is reported.

### Failure semantics

- Registry, ownership, lock, busy, or preflight failure: no stop and no install.
- Install failure: return nonzero; if a valid installed CLI remains, best-effort
  restore the previous mode and still report the update failure.
- Version verification failure: do not claim success; attempt the same recovery.
- Install success plus Runtime restoration failure: report that the package was
  updated but the Runtime is stopped; never claim complete success.
- Never downgrade automatically after a new Runtime may have opened or migrated
  state.
- SIGINT/SIGTERM release owned locks and must not print a success result.
- Package-manager interruption terminates and confirms the whole process tree;
  if that cannot be proven, the Runtime remains stopped.

### Multi-instance scope

The package update is installation-wide, while Kintio permits arbitrary instance
homes. Kintio currently has no installation-level registry that can discover all
homes or other operating-system users.

This version guarantees only the selected `--home` instance. Operators running
multiple homes from one global installation must stop the other instances before
updating. Installation-wide instance registration and coordinated rolling update
are a separate future design; this release does not claim that guarantee.

## Priority 1 design

### Interaction boundary

Human input must never be awaited while a standalone SQLite writer lock or a live
operator MCP control is held.

The lifecycle is:

```text
open control -> read account snapshot -> close control
  -> optional login
  -> refresh and close snapshot
  -> optional account picker
  -> optional delete confirmation
  -> reopen control -> revalidate account and generation -> mutate -> close
```

Provider account IDs are display values. Internal `ia_*` keys remain accepted for
automation but are not shown as the primary interactive label.

### Behavior matrix

| Situation | Result |
| --- | --- |
| Interactive `start`, no accounts, no selector | Login once, refresh, then start |
| Non-TTY `start`, no accounts | Fail immediately; instruct explicit login |
| Explicit selector, no matching account | Fail deterministically; never open login |
| One account, no selector | Select it automatically |
| Multiple accounts, interactive | Show account picker |
| Multiple accounts, non-TTY | Require `--account` |
| Explicit `--account` | Bypass picker in every terminal |
| Interactive delete without `--yes` | Confirm with default No |
| Non-TTY delete without `--yes` | Require `--yes` |
| Explicit `--yes` | Bypass confirmation |

Login failure, expiry, cancellation, EOF, Esc, Ctrl-C, or signal does not start a
daemon or mutate account state. Login success followed by start failure preserves
the enrolled credentials and prints a retryable command.

### Picker behavior

The picker is an iLink-scoped component with no new dependency. It supports:

- stdin and stdout TTY gating;
- Up/Down and Ctrl-P/Ctrl-N movement;
- incremental filtering by provider ID and status;
- Enter selection;
- Esc cancellation and Ctrl-C signal semantics;
- a bounded viewport for long account lists;
- display-width truncation;
- control-character sanitization;
- complete raw-mode, listener, cursor, and alternate-screen restoration.

It does not implement Botmux's submenu tree or a readline fallback. Non-TTY input
uses explicit command parameters instead of hidden prompts.

### Stale selection protection

The account snapshot includes the account generation. Start, stop, and especially
delete carry the expected generation through operator MCP/local control. A login
rotation or delete/re-enroll that occurs while the picker or confirmation is open
causes a generation conflict instead of mutating the new credentials.

## Test plan

### Unit

- npm/pnpm ownership and command construction on POSIX and Windows;
- exact semver parsing/comparison and malformed Registry metadata;
- secret-free child environment and argument-array spawning;
- update/upgrade alias routing and unknown-argument rejection;
- idle gate request IDs, ACK/NACK, timeout, stale response, and no-state-change;
- mode-preserving restart and restoration output;
- account snapshot closes control before prompting;
- zero/one/many account orchestration;
- picker navigation, filtering, viewport, sanitization, and cleanup;
- delete Yes/No/`--yes` and generation conflict.

### Integration and recovery

- active Agent work rejects update and remains reachable;
- a message arriving at the gate boundary cannot start after idle acceptance;
- idle service and iLink daemons stop, install through a fake owning manager,
  verify, and restore the same mode;
- install, verification, and restart failures have distinct observable results;
- foreground ownership and concurrent update/start/stop fail safely;
- interactive login and mutation never overlap standalone writers;
- running operator MCP and standalone account paths produce the same result;
- crash/recovery tests leave no update, lifecycle, daemon, or instance lock.

### Full verification

```text
pnpm test
pnpm exec tsc -p tsconfig.test.json
KNIP_DISABLE_RAW_TRANSFER=1 pnpm exec knip
pnpm run build
git diff --check
```

All required GitHub checks must pass on Linux, macOS, and Windows. Real Codex
validation is not required: these changes alter host lifecycle and terminal UX,
which a model smoke test cannot physically validate.

## Completion criteria

- PR 1 merges with updater protocol, update/upgrade, mode-preserving restart, and
  complete tests.
- PR 2 merges with automatic first login, picker, confirmation, generation
  revalidation, and complete tests.
- Issue #74 closes only after both slices merge.
- Public docs show the two new update aliases and parameter-free interactive
  iLink lifecycle without expanding unrelated architecture documentation.
