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

- Introduce version directories plus a stable launcher so Windows can update a running EXE.
- Keep transition-only `bin/kintio.js` and `dist/daemon.js` shims in the first native npm
  package because every existing updater hard-codes those paths and installs with scripts
  disabled. The shims contain no business logic and only hand control to the native binary.
- Test direct npm and pnpm upgrades from every public version that contains the legacy
  updater, including skipped intermediate releases and both service/iLink restoration modes.
- Build signed/checksummed native assets for supported OS/CPU targets.
- Add a standalone installer and optional npm platform packages.

Exit gate: every supported historical updater reaches the native binary safely, and native
self-update works with running-file constraints on Windows.

### 8. Cutover and removal

- Switch the public `kintio` entry only after every previous gate passes.
- Delete all maintained `*.ts`, `tsconfig`, TypeScript, Vitest, Knip, Node production
  dependencies, and JavaScript business/runtime entry files in the same cutover series.
- A minimal npm compatibility or installation shim may remain only while historical direct
  upgrade support requires it; it must contain no Kintio behavior.

Exit gate: the installed production command runs with Node absent from `PATH`, and no
legacy business implementation or duplicate behavior test remains to maintain. The release
candidate must also record successful real Codex start/steer/resume/MCP, real WeChat
callback/send, real iLink login/poll/send/media, and native lifecycle/update on Linux,
macOS, and Windows.

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
