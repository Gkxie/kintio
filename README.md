<div align="center">

<h1>
  <img src="assets/logo.svg" alt="Kintio" width="320" />
</h1>

**Connect chat channels to an Agent you control.**

English | [简体中文](https://github.com/Gkxie/kintio/blob/master/README.zh-CN.md)

[![CI](https://github.com/Gkxie/kintio/actions/workflows/ci.yml/badge.svg)](https://github.com/Gkxie/kintio/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Gkxie/kintio/actions/workflows/codeql.yml/badge.svg)](https://github.com/Gkxie/kintio/actions/workflows/codeql.yml)
[![Latest release](https://img.shields.io/github/v/release/Gkxie/kintio?display_name=tag)](https://github.com/Gkxie/kintio/releases/latest)
[![License](https://img.shields.io/github/license/Gkxie/kintio)](https://github.com/Gkxie/kintio/blob/master/LICENSE)

</div>

Deploy Kintio next to an Agent runtime and authorized people can assign work,
steer an active task, and receive results without leaving their chat app. Kintio
connects each
conversation to the Agent while keeping identities, state, and reply capabilities scoped to
the originating channel. The current runtime uses the Codex CLI session on the deployment
host.

```text
Chat: "Investigate this"  -> Kintio starts a task in the Agent on your machine
Chat: "Focus on the logs" -> Kintio steers that running task
Agent result              -> Kintio delivers it back to the same chat
```

## What it provides

- A separate Agent thread for every adapter identity, with no implicit identity or history
  merging across channels.
- Steering for active work: a user's follow-up can redirect the current Agent turn instead
  of waiting behind stale instructions.
- A durable SQLite inbox, restart recovery, and live-message priority over backlog recovery.
- One application Supervisor for HTTP callbacks, polling listeners, and future long-lived
  channel transports; Hono is an adapter rather than the process lifecycle owner.
- Session-scoped MCP actions that cannot choose another recipient or expose provider
  credentials, raw user identifiers, or database paths to the Agent.
- Explicit delivery outcomes: accepted, failed, or uncertain. Uncertain sends are not
  blindly retried.

One deployment currently shares one Agent runtime login. Conversation state is isolated,
but Kintio is not yet a multi-tenant platform where each chat user supplies independent
Agent credentials, quotas, or working directories.

## Current adapters

| Adapter | Inbound | Outbound | Transport | Conversation identity |
| --- | --- | --- | --- | --- |
| WeChat KF API | Text and images; other message types become explicit summaries | Text, images, links, Mini Programs, and locations | Public HTTPS callback | `open_kfid + external_userid` |
| Weixin iLink | Text and images; other message types become explicit summaries | Text and images | Long polling after QR-code binding | `bot_id + user_id` |

Adapter capabilities are enforced per conversation. For example, an image received in one
conversation can only be referenced by the short-lived MCP session bound to that same
conversation.

## Quick start

Prerequisites:

- Node.js 24 or later;
- an installed and authenticated Codex CLI;
- credentials for at least one supported adapter.

```bash
npm install --global @kin-tio/cli
codex login status
```

An installed npm or pnpm copy can update itself without changing Agent or
channel configuration:

```bash
kintio update
```

`kintio upgrade` is an exact alias. Kintio refuses unknown installation layouts
and active Agent work; an idle background instance is restored in its existing
service or iLink mode.

For an iLink-only instance, no setup file or public HTTP listener is required:

```bash
kintio ilink login
kintio ilink start
```

`ilink login` performs one encrypted enrollment, starts no listener, and exits. In an
interactive terminal, `ilink start` opens the same login flow automatically when needed,
then runs provider polling and the host Agent through the background daemon without Hono or a TCP listener.
Use `--foreground` only when a service manager needs to own the process. Both commands
use `~/.kintio` by default and accept `--home`. Multiple accounts open a searchable
terminal picker. Scripts and non-interactive callers use the provider ID from `ilink list`
through `--account`. Repeated `start` commands add accounts to the live runtime; `stop` removes one.

For a callback-based adapter, create and edit the deployment configuration instead:

```bash
kintio setup
kintio start
kintio status
kintio logs --lines 100
```

`kintio setup` creates a private instance under `~/.kintio`, installs the managed Agent
skill, and writes the channel configuration template. Follow the
[setup guide](https://github.com/Gkxie/kintio/blob/master/docs/setup.md):

- For WeChat KF API, set its callback token, EncodingAESKey, CorpID, and secret. A temporary
  `WECOM_AUTH_TRIGGER` can authorize the first user without knowing their
  `external_userid` in advance.
- A combined callback + iLink deployment may additionally set `ILINK_ENABLED=true`.

For a graphical or non-terminal caller, select a temporary raw PNG instead of ANSI blocks:

```bash
kintio ilink login --qr-output ~/.kintio/ilink-login.png
```

The target must be directly inside the selected Kintio instance directory and must not
already exist. Kintio removes the PNG when login succeeds, expires, is cancelled, or fails;
the QR payload is never printed. Without `--qr-output`, the command
requires an interactive terminal. Both forms stop waiting after five minutes and never
start an Agent turn. The resulting iLink identity represents
the local operator and inherits the host Agent configuration without Kintio's untrusted-
channel capability restrictions. Show this QR code only to someone authorized to control
the host Agent. Run `kintio ilink start` after enrollment to process messages without Hono.

To permanently remove an account and every Kintio record scoped to it, run:

```bash
kintio ilink delete
```

Interactive use selects the account and asks for confirmation with a default of No.
Scripts retain `--account <provider-id-or-account-key> --yes`. Credentials,
conversations, messages, media, delivery records, and enrollment audit rows for that
account are deleted atomically.

For callback deployments, confirm that `kintio logs` contains
`Hono server is listening on port 8888`. Use `kintio run` when a foreground process is
preferable to the native daemon.
Existing source-based deployments can keep their current state after the one-time
process-manager migration described in the setup guide.

Source builds and contributor setup are documented in
[CONTRIBUTING.md](https://github.com/Gkxie/kintio/blob/master/CONTRIBUTING.md).

## Security boundaries

- `.env`, SQLite databases, downloaded media, and local key files are ignored by Git and
  must never be force-added.
- Kintio does not inject messaging-adapter secrets, stable user identifiers, raw media IDs,
  or database paths into the Agent; host Agent credentials remain host-managed.
- Codex starts MCP over stdio. Kintio uses only a private Unix-domain socket or
  Windows named pipe behind that process boundary, never an MCP TCP port or public
  Hono route; every action still requires a short-lived conversation capability.
- Project-level Agent capability restrictions are not an operating-system sandbox. Use a
  dedicated system account and additional isolation appropriate to the Agent's real powers.
- An iLink account enrolled by `kintio ilink login` is explicitly host-authorized; its owner
  receives the capabilities allowed by the host Agent configuration. Accounts enrolled from
  a remote adapter remain restricted, and chat input cannot change this persisted trust level.
- A provider accepting an outbound request does not prove that a client displayed it;
  uncertain outcomes remain explicit to avoid duplicate delivery.

See the [security policy](https://github.com/Gkxie/kintio/blob/master/SECURITY.md) for the complete trust boundary and private
vulnerability-reporting process.

## Documentation and contributing

- [Setup guide](https://github.com/Gkxie/kintio/blob/master/docs/setup.md) — configuration through the first Agent reply.
- [Architecture](https://github.com/Gkxie/kintio/blob/master/docs/architecture.md) — message flow, module boundaries, identity
  isolation, and source entry points.
- [Roadmap](https://github.com/Gkxie/kintio/blob/master/ROADMAP.md) — long-term direction and `0.x` priorities.
- [Contributing guide](https://github.com/Gkxie/kintio/blob/master/CONTRIBUTING.md) — where to start and how to validate changes.
- [Maintainer guide](https://github.com/Gkxie/kintio/blob/master/MAINTAINING.md) — issue, pull request, and release operations.
- [Code of Conduct](https://github.com/Gkxie/kintio/blob/master/CODE_OF_CONDUCT.md), [Changelog](CHANGELOG.md), and
  [Apache License 2.0](https://github.com/Gkxie/kintio/blob/master/LICENSE).

The default verification entry point is:

```bash
pnpm test
```

Tests use temporary SQLite databases and simulated provider and Agent boundaries by
default. They contact real services only when explicit live-test flags, targets, and
allowlists are supplied.

## Project status

Kintio is in the `0.x` stage. It currently ships the two adapters listed above while the
channel, identity, recovery, and Agent-runtime contracts are stabilized for future
adapters.

The Weixin iLink protocol implementation incorporates work described in
[THIRD_PARTY_NOTICES](https://github.com/Gkxie/kintio/blob/master/THIRD_PARTY_NOTICES).

Kintio is an independent open-source project. It is not affiliated with, authorized by,
endorsed by, or an official product of Tencent, WeChat, Weixin, or any other channel
provider.
