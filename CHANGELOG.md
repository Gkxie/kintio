# Changelog

This file records important user-visible changes after the first public release.

## Unreleased

## 0.8.0

- Removed the redundant Owner PR/manual hosted Codex workflow so the protected,
  deterministic Release Bot check is the only hosted real-Codex validation path
  ([#80](https://github.com/Gkxie/kintio/issues/80)).

- Allowed deterministic Release Bot pull requests to expose the optional,
  maintainer-approved real Codex smoke test only after a secret-free validation
  of the exact three-file release plan ([#78](https://github.com/Gkxie/kintio/issues/78)).

- Added equivalent `kintio update` and `kintio upgrade` commands that update an
  identified global npm or pnpm installation to one exact published version,
  refuse active Agent work, and restore an idle background instance in its
  original service or iLink mode ([#74](https://github.com/Gkxie/kintio/issues/74)).
- Made `kintio ilink start` open login automatically when no account exists and
  added searchable account selection plus default-No deletion confirmation;
  explicit `--account` and `--yes` remain available for automation
  ([#74](https://github.com/Gkxie/kintio/issues/74)).

## 0.7.2

- Prevented the background Agent process on Windows from opening a persistent
  empty `cmd.exe` window while preserving its stdio transport and lifecycle
  ownership ([#70](https://github.com/Gkxie/kintio/issues/70)).

## 0.7.1

- Made `kintio ilink start` use the managed background daemon by default while
  retaining `--foreground` for external service managers, simplified
  `kintio ilink list` to reusable provider account IDs, rejected Node.js below
  24 before application startup, and added sanitized Codex request diagnostics
  ([#65](https://github.com/Gkxie/kintio/issues/65)).

## 0.7.0

- Added `kintio ilink login`, which reuses the iLink enrollment state machine
  while rendering its five-minute QR code directly in an interactive terminal;
  no WeChat KF conversation or Agent turn is required. Accounts
  enrolled locally receive host-level Agent access and inherit the host runtime
  configuration, while remotely offered iLink accounts remain restricted
  ([#54](https://github.com/Gkxie/kintio/issues/54)).
- Added an explicit `--qr-output <file>` view for `kintio ilink login`, allowing
  graphical and non-terminal callers to consume a temporary raw PNG directly
  from the QR payload without parsing ANSI terminal output. The file is created
  exclusively and removed when the login attempt ends
  ([#57](https://github.com/Gkxie/kintio/issues/57)).
- Made iLink a standalone lifecycle: `kintio ilink login` now initializes and
  persists an account without setup, an environment file, Hono, or a running
  Worker, while safely delegating to a running instance when present;
  `kintio ilink start` starts polling and the host Agent in the foreground without
  a public HTTP listener. The iLink Runtime configuration no longer contains a
  synthetic WeChat KF adapter
  ([#59](https://github.com/Gkxie/kintio/issues/59)).
- Added per-account `kintio ilink list`, `start`, `stop`, and confirmed `delete`
  lifecycle commands. One Runtime can reconcile multiple selected listeners;
  complete deletion atomically purges the selected account and all Kintio data
  scoped to it while preserving unrelated accounts and channels
  ([#60](https://github.com/Gkxie/kintio/issues/60)).

## 0.6.2

- Added a custom Kintio wordmark and its circular-safe TIO avatar to the English
  and Simplified Chinese entry pages and public package.
- Added a repository-scoped Release App that deterministically maintains one
  fully checked Release PR from the reviewed Unreleased notes; maintainers now
  authorize a release by reviewing and merging that PR only
  ([#48](https://github.com/Gkxie/kintio/issues/48)).
- Made a merged, owner-authored Release PR the sole human release authorization;
  Kintio now creates the annotated tag and dispatches its verified OIDC release
  automatically
  ([#45](https://github.com/Gkxie/kintio/issues/45)).

## 0.6.1 - 2026-08-31

- Added approval-gated npm Trusted Publishing with an exact artifact integrity
  boundary, publish-time scan awareness, and public Registry installation before
  each GitHub Release
  ([#42](https://github.com/Gkxie/kintio/issues/42)).

## 0.6.0 - 2026-08-31

- Published the global `kintio` command as `@kin-tio/cli` through the public
  npm Registry and added exact tarball and clean Registry-install verification
  ([#37](https://github.com/Gkxie/kintio/issues/37)).
- Disabled persisted Codex Goals and multi-agent tools inside untrusted channel
  sessions so conversation work cannot outlive its bounded turn or expand into
  background Agent execution
  ([#38](https://github.com/Gkxie/kintio/issues/38)).
- Made `~/.kintio` the single default mutable instance root for global and
  direct Worker entry points, hardened foreground and daemon-first crash cleanup,
  and constrained Windows-owned state to the selected Profile instance without
  restricting the Agent project directory
  ([#32](https://github.com/Gkxie/kintio/issues/32)).
- Made one Worker-owned persistence root the only production owner of the raw
  SQLite connection; Runtime, channels, MCP, and Agent code now consume JS/TS
  state facades instead of a public database handle
  ([#29](https://github.com/Gkxie/kintio/issues/29)).
- Installed and refreshed the managed conversation Skill in the effective
  configured Agent workspace, so a custom `CODEX_WORKING_DIRECTORY` cannot
  leave a dangling session-level Skill reference
  ([#30](https://github.com/Gkxie/kintio/issues/30)).
- Moved MCP actions off HTTP entirely: Codex now starts true stdio relays backed
  by a private Unix-domain socket or Windows named pipe, with no MCP TCP port or
  static URL/Bearer configuration. The Codex adapter continues to inherit host
  model, provider, reasoning, and search settings
  ([#21](https://github.com/Gkxie/kintio/issues/21),
  [#27](https://github.com/Gkxie/kintio/issues/27)).
- Added macOS, Linux, and Windows lifecycle support with an authenticated native
  daemon, bounded worker restarts, rotated logs, portable path and temporary-file
  handling, and a three-system CI matrix
  ([#19](https://github.com/Gkxie/kintio/issues/19)).
- Removed duplicate post-merge CI, coverage artifact round trips, redundant
  registry audits, and brittle repository-policy snapshots; retained the
  executable security boundaries and made Agent subprocesses inherit the host
  environment without copying Kintio configuration-file values into it
  ([#16](https://github.com/Gkxie/kintio/issues/16)).
- Made iLink activation explicit with `ILINK_ENABLED=true`, fixed an
  authorization race that could defer an already-authorized message until
  restart, and stopped opt-in tests and low-level Codex processes from
  inheriting unrelated deployment credentials
  ([#14](https://github.com/Gkxie/kintio/issues/14)).
- Replaced the custom CLA parser and ledger writer with the immutable,
  SHA-pinned CLA Assistant Lite workflow used by OpenAI Codex, while retaining
  public signature records in the protected `cla-signatures` branch
  ([#11](https://github.com/Gkxie/kintio/issues/11)).

## 0.5.0 - 2026-08-30

- Added a global `kintio` command with secure setup, foreground execution, and
  PM2-backed start, stop, restart, status, and log operations
  ([#5](https://github.com/Gkxie/kintio/pull/5)).
- Separated installed program files from instance configuration, SQLite state,
  temporary media, and the Agent workspace under `~/.kintio` by default.
- Made an application Supervisor the process composition root; Hono now remains
  an HTTP callback and MCP channel beside polling and future WebSocket inputs.
- Rendered optional iLink login invitations as branded QR cards with an explicit
  five-minute validity notice
  ([#6](https://github.com/Gkxie/kintio/pull/6)).

## 0.4.1 - 2026-08-30

- Removed wildcard WeChat authorization; `WECOM_ALLOWED_USER_IDS` now accepts
  explicit `external_userid` values only.
- Removed the unused `/healthz` endpoint; process state and the Hono startup log
  remain the supported local liveness signals.

## 0.4.0 - 2026-08-29

- Authorized channel users can assign work to a Codex Agent and receive results
  in the originating conversation.
- Added WeChat Customer Service API and independent Weixin iLink Bot
  conversations.
- Added text and image input, with text, image, link, mini-program, and location
  delivery according to each adapter's capabilities.
- New user instructions steer the active Agent turn instead of receiving stale
  answers in sequence.
- SQLite recovery resumes missed and unfinished messages after restart while
  prioritizing live inbound traffic.
- Channel identities, Threads, media, and reply windows are isolated, and
  provider secrets are not exposed to the Agent.
- Adopted the channel-neutral Kintio identity, English canonical documentation,
  and one concise Simplified Chinese entry page.
- Added Hono lifecycle management, PM2 deployment guidance, SQLite durability,
  and compatibility paths for existing deployments.
- Added deterministic unit, integration, recovery, and security tests with
  coverage, TypeScript, dependency, secret, and CodeQL checks.
- Added repository-native CLA enforcement, contributor accountability,
  release provenance checks, and an abuse-response runbook.
