# Changelog

This file records important user-visible changes after the first public release.

## Unreleased

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
