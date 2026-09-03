# Native Rust Runtime Migration

## Objective

Replace the Kintio TypeScript and Node.js runtime with one native Rust binary while
preserving public commands, existing instances, provider protocols, Agent behavior,
and crash semantics. The final runtime must not require Node.js. The npm package may
remain as an optional installation coordinator, but a standalone native installer is
the primary Node-free path.

This is a behavioral migration, not a line-by-line translation. The TypeScript
implementation remains the production Oracle until the native binary passes an
entire vertical slice. Rust and TypeScript must never write the same live instance.

## Baseline

- 60 TypeScript source modules and about 25,490 source lines.
- 91 default test files and 634 tests across unit, integration, recovery, and security.
- SQLite schema version 24 with migrations from versions 11 through 23.
- Two channel adapters: Weixin iLink and WeChat KF API.
- One host-managed Codex CLI integration using app-server JSONL and stdio MCP.
- Linux, macOS, and Windows behavior currently gated in CI.

## Architecture decisions

### One crate until a real split exists

Begin with one non-published `kintio-native` package and ordinary Rust modules. A
multi-crate workspace would add manifests, dependency edges, and release policy before
any component has an independent consumer. Split a crate only when reuse, compile
isolation, or a separately versioned protocol makes the boundary concrete.

The final binary owns internal modes rather than publishing separate entry files:

```text
kintio
kintio __daemon
kintio __worker service
kintio __worker ilink
kintio __mcp-relay
```

During migration the executable is named `kintio-rs`; it cannot replace the public
command accidentally.

### Preserve external contracts, simplify internals

The following are compatibility boundaries:

- CLI commands, options, important output, cancellation, signals, and exit codes.
- `~/.kintio`, explicit home/config selection, file ownership and permissions.
- SQLite schema 24, stable IDs, timestamps, canonical JSON, transactions, and recovery.
- AES-GCM envelopes and exact AAD bytes for stored iLink secrets.
- WeChat encryption/XML and iLink HTTP/media protocols.
- Codex app-server requests, notifications, steering, thread recovery, and capability modes.
- MCP tool names, schemas, receipts, session scoping, and private local transport.
- accepted/failed/uncertain delivery semantics and the prohibition on blind retries.
- upgrade from the last TypeScript release without losing service or iLink mode.

Node parent/worker message shapes are temporary internals and may be replaced when the
native daemon and worker move together.

### Serial ownership of mutable state

One dedicated actor owns one `rusqlite::Connection`; there is no connection pool and no
repository object per table. Runtime admission, active work, and stop-if-idle are also
decided by one serial owner. Distributed atomics must not replace the ordering that the
Node event loop currently provides.

Tokio is the sole asynchronous runtime. Network calls never hold SQLite transactions.

## Migration slices

### 1. Foundation and setup

- Pin Rust 1.98.0 and Rust 2024 Edition.
- Add `kintio-rs` without changing the public npm entry.
- Implement help, setup, instance paths, private files, and managed Skill embedding.
- Run TypeScript and Rust setup against separate temporary homes and compare results.
- Add Rust format, Clippy, and tests to all supported operating-system gates.

Exit gate: Rust setup produces the same config and Skill, preserves an existing config,
and rejects unsafe paths with equivalent exit semantics.

### 2. Persistence and cryptographic compatibility

- Freeze fixtures for every supported starting schema from 11 through 24.
- Port stable identifiers, canonical JSON, reply windows, capabilities, and send states.
- Port AES-GCM envelopes using byte-identical AAD and base64url encoding.
- Test TypeScript writes read by Rust and Rust writes read by TypeScript.
- Keep schema version 24 during the first native release.

Exit gate: copied production-shaped databases can be opened, recovered, mutated, and
reopened by either implementation without schema or ciphertext drift.

### 3. iLink local account lifecycle

- Port account enrollment, QR lifecycle, list/delete, picker, persisted secrets, and
  account generation/incarnation rules.
- Prove terminal and non-terminal login behavior against provider replays.

Exit gate: TypeScript and Rust can alternately read and operate on a copied account store
without changing identities, trust provenance, or ciphertext.

### 4. iLink foreground conversation

- Port start/stop, protocol client, long polling, media, and the 24-hour/10-send window.
- Port the scheduler, Codex app-server client, iLink MCP tools, and archived memory needed
  for one foreground conversation.
- Add an opt-in real iLink validation; replay tests remain the deterministic default.

Exit gate: `kintio-rs ilink start --foreground` completes real and simulated conversations
with identical persisted and delivery outcomes.

### 5. Callback service and combined runtime

- Replace Hono with Axum while retaining exact public routes, limits, and status codes.
- Port WeChat crypto, callback parsing, synchronization, media, authorization, and tools.
- Verify combined callback plus iLink operation, steering, and live-over-backlog priority.

Exit gate: both adapters pass black-box HTTP/provider fixtures and full conversation tests.

### 6. Native lifecycle

- Port daemon control, readiness, restart backoff, logs, locks, and process-tree ownership.
- Use Unix process groups and Windows Job Objects; plain child kill is insufficient.
- Prove stop-if-idle is atomic and a busy response changes no runtime state.

Exit gate: background lifecycle and forced-crash recovery pass on Linux, macOS, and Windows.

### 7. Updater and distribution

One Rust executable has two distribution channels. GitHub Releases are the source of native
assets and the only Node-free installation path. npm remains an optional coordinator for
machines that already have Node.js; installing through npm does not become Node-free merely
because the payload is native.

#### Supported artifacts

| Host | Rust target | GitHub Release asset | npm dependency alias | Platform version |
| --- | --- | --- | --- | --- |
| Linux x64 | `x86_64-unknown-linux-musl` | `kintio-x86_64-unknown-linux-musl.tar.gz` | `@kin-tio/cli-linux-x64` | `X.Y.Z-linux-x64` |
| Linux arm64 | `aarch64-unknown-linux-musl` | `kintio-aarch64-unknown-linux-musl.tar.gz` | `@kin-tio/cli-linux-arm64` | `X.Y.Z-linux-arm64` |
| macOS x64 | `x86_64-apple-darwin` | `kintio-x86_64-apple-darwin.tar.gz` | `@kin-tio/cli-darwin-x64` | `X.Y.Z-darwin-x64` |
| macOS arm64 | `aarch64-apple-darwin` | `kintio-aarch64-apple-darwin.tar.gz` | `@kin-tio/cli-darwin-arm64` | `X.Y.Z-darwin-arm64` |
| Windows x64 | `x86_64-pc-windows-msvc` | `kintio-x86_64-pc-windows-msvc.zip` | `@kin-tio/cli-win32-x64` | `X.Y.Z-win32-x64` |
| Windows arm64 | `aarch64-pc-windows-msvc` | `kintio-aarch64-pc-windows-msvc.zip` | `@kin-tio/cli-win32-arm64` | `X.Y.Z-win32-arm64` |

Every archive contains exactly `bin/kintio` or `bin/kintio.exe`. One Release also contains
`kintio_SHA256SUMS`, `install.sh`, and `install.ps1`. macOS notarization and Windows
Authenticode signing happen before checksums; GitHub artifact attestations cover the final
archives. The npm platform variants reuse those exact signed binary bytes rather than
compiling again.

The six platform variants use npm aliases to prerelease versions of the existing
`@kin-tio/cli` package, following the native Codex package topology. They publish first to
dedicated `linux-x64`, `darwin-arm64`, and equivalent dist-tags. The portable `X.Y.Z` package
with optional aliases publishes last and is the only artifact that advances `latest`. This
keeps one package identity and one Trusted Publisher rather than creating six registry
projects.

#### Standalone ownership

The installers own version directories and one stable command path; they do not start, stop,
or restart a Kintio Runtime:

```text
~/.kintio/packages/standalone/
  releases/X.Y.Z-target/bin/kintio
  current -> releases/X.Y.Z-target
~/.local/bin/kintio -> ~/.kintio/packages/standalone/current/bin/kintio
```

Windows uses versioned executables below
`%USERPROFILE%\.kintio\packages\standalone\releases` and an installer-owned `current`
directory junction. Its stable command directory lives below
`%LOCALAPPDATA%\Programs\Kintio`: its `bin` directory is itself an installer-owned junction
to `%USERPROFILE%\.kintio\packages\standalone\current\bin`, and only that stable parent is
added to PATH. Stage 6 must prove a replace-without-gap junction switch using native Windows
semantics before this layout is accepted; deleting the old junction and then creating a new
one is not an atomic update.
Filesystems or policies that cannot provide the required junction semantics fail closed; the
installer must not fall back to copying over a stable executable.

The installer and native updater share one installation lock and compare-and-swap contract.
Each operation records the exact initial `current` target before downloading. After acquiring
the lock it must still observe that target, and a latest-version install must not replace a
newer semantic version. Rollback may replace `current` only when it still points to the exact
candidate installed by that operation. A changed pointer is concurrent ownership, not
permission to overwrite another operation.

`install.sh` and `install.ps1` execute the same transaction:

1. Resolve `latest` once to an exact `vX.Y.Z` tag and use immutable URLs afterward.
2. Map the host to exactly one of the six targets; reject every unknown OS or architecture.
3. Download only the matching archive and checksum with bounded redirects, size, and time.
4. Require exactly one matching checksum entry before extraction or execution.
5. Extract the one fixed archive member into a random staging directory; reject extra
   members, links, absolute paths, and traversal.
6. Verify platform signatures and require candidate `--version` output to equal `X.Y.Z`.
7. Acquire the shared installation lock, revalidate the initial pointer and monotonic version,
   atomically commit the version directory, then compare-and-swap the installer-owned
   `current` symlink or junction.
8. Treat an existing version as idempotent only when its bytes match; never overwrite an
   unowned path, link, junction, or file.
9. Update PATH only when ownership is unambiguous. Otherwise print one exact command instead
   of guessing which shell profile to edit.

#### Native update and transition

`kintio update` selects behavior from installation ownership:

- npm or pnpm installations invoke their owning package manager and never edit
  `node_modules` directly;
- standalone installations download and validate while the Runtime remains live, then use
  the existing stop-if-idle gate, switch `current`, and restore the exact prior service or
  iLink mode from the new executable;
- a failed restore stops the candidate process, atomically restores the old pointer, and
  starts the old executable by its exact real path, but only if `current` still names this
  operation's candidate; a concurrent pointer change or uncertain process tree fails closed.

The first native npm package keeps transition-only `bin/kintio.js` and `dist/daemon.js`
because every existing updater hard-codes those paths and installs with scripts disabled.
Compatibility is process-level, not just filename-level: the shims must preserve daemon PID
ownership, readiness, signal forwarding, exit status, stop-if-idle, and rollback handles.
On POSIX the daemon shim replaces itself with the native daemon so its PID remains stable. On
Windows it stays resident, passes its validated launcher PID to the native daemon, forwards
signals, mirrors exit status, and never spawns then exits. During that one compatibility
launch the native daemon writes the launcher PID as legacy `record.daemonPid`, implements the
old record/control/update-identity protocol itself, and exits if its launcher disappears. The
old updater's child handle and `record.daemonPid` therefore identify the same lifecycle owner
for wait, stop, and rollback; the next native restart uses the pure native PID model. The
shims contain no business behavior and remain only for the documented historical direct-
upgrade window.

At cutover, `Cargo.toml` becomes the sole version authority and release staging generates npm
metadata from it; `build.rs` must no longer read the deleted `src/version.ts`. The Release DAG
is: build and test six targets, sign, checksum and attest once, assemble npm variants from the
same bytes, and create a draft GitHub Release containing those candidate assets. Publish all
platform prereleases to target-specific tags, verify their exact Registry versions, then test
the portable local tarball through clean npm and pnpm installs that resolve those exact alias
dependencies. Authenticated draft-asset standalone installs must pass at the same point. The
portable version then publishes once through npm Trusted Publishing directly to `latest`,
followed by a clean public Registry install, before the draft GitHub Release becomes public.
The post-publish Registry smoke is verification rather than a rollback boundary: npm OIDC
does not authorize a later `dist-tag add`, and Kintio will not reintroduce a long-lived npm
token merely to simulate a transaction the Registry does not provide. A failed public smoke
leaves the GitHub Release draft, reports an incident, and resumes only after the exact npm
integrity is understood. Every step records artifact integrity and is idempotently resumable
because the two final external state changes cannot be atomic. Immediately before publishing
the draft, the workflow must re-read every asset name and digest and match them against the
recorded build manifest; draft assets are not assumed immutable merely because smoke tests
ran earlier.

Exit gate: all six assets execute natively; standalone setup/start/update work with Node
absent; npm and pnpm installs work with lifecycle scripts disabled; missing optional packages,
checksum/archive attacks, signal and exit propagation, Windows running-EXE replacement,
power-loss stages, and rollback are tested; and every public legacy updater can skip directly
to the native release without losing service or iLink mode.

### 8. Cutover and removal

- Switch the public `kintio` entry only after every previous gate passes.
- Delete all maintained `*.ts`, `tsconfig`, TypeScript, Vitest, Knip, Node production
  dependencies, and JavaScript business/runtime entry files in the same cutover series.
- A minimal npm compatibility or installation shim may remain only while historical direct
  upgrade support requires it; it must contain no Kintio behavior.

Exit gate: the standalone-installed production command runs with Node absent from `PATH`, and
no legacy business implementation or duplicate behavior test remains to maintain. The npm
coordination path may retain a transition-only JavaScript launcher while its historical
upgrade window is supported. The release candidate must also record successful real Codex
start/steer/resume/MCP, real WeChat callback/send, real iLink login/poll/send/media, and native
lifecycle/update on Linux, macOS, and Windows.

## Test strategy

Tests describe behavior and are migrated by contract, not translated mechanically.

1. Black-box fixtures first: CLI, HTTP, daemon JSONL, MCP schemas, Codex JSONL, and providers.
2. Golden data from the current implementation: SQLite, stable IDs, encrypted envelopes,
   media metadata, and delivery receipts.
3. Differential tests execute TypeScript and Rust only against separate temporary state.
4. Every Rust-owned behavior receives a Rust test before its TypeScript test is removed.
5. Real Codex and provider checks stay opt-in during ordinary development and protected by
   the existing approval model; they are mandatory evidence for the cutover Release.
6. One default verification command remains after cutover: `cargo test --locked`.

## Known high-risk details

- WeChat padding is 1–32 bytes and cannot use AES block-size PKCS#7 helpers unchanged.
- The published Rust Codex protocol crate trails the installed CLI; use local narrow DTOs
  and version-generated JSON Schema canaries instead.
- Rustls must explicitly preserve proxy, system CA, and extra CA behavior.
- Windows npm Codex may resolve to a `.cmd`; quoting requires native Windows tests.
- The current TypeScript updater assumes `bin/kintio.js` and `dist/daemon.js`; users may
  skip any compatibility release, so the first native npm artifact itself must keep working
  shims for every historical updater or provide an external migration path.
- Windows Job Objects may require a narrowly audited platform module or a safe crate. The
  initial global unsafe-code ban may only be relaxed for that concrete need, never as a
  general escape hatch.
- JavaScript strings can contain lone UTF-16 surrogates while Rust strings cannot. Keep the
  TypeScript compatibility Oracle unchanged during byte-level migration, then preflight
  persisted JSON and introduce any Unicode rejection as a separately versioned contract.
- The TypeScript baseline limits Windows state to the current profile but does not audit
  arbitrary DACLs or bind writes to verified directory handles. Before `kintio-rs` becomes
  public, config, key, database, descriptor, and Skill writes must use handle-relative
  operations that reject reparse-point swaps; this foundation slice is not a production
  security claim.

## Completion rule

The migration is complete only when the public native binary passes every compatibility
gate, updates safely from an existing public installation, runs without Node.js, and the
TypeScript production runtime has been removed. Rust code existing beside Node code is not
completion.
