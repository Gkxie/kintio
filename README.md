<div align="center">

# Kintio

**Connect chat channels to an Agent you control.**

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/Gkxie/kintio/actions/workflows/ci.yml/badge.svg)](https://github.com/Gkxie/kintio/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Gkxie/kintio/actions/workflows/codeql.yml/badge.svg)](https://github.com/Gkxie/kintio/actions/workflows/codeql.yml)
[![Latest release](https://img.shields.io/github/v/release/Gkxie/kintio?display_name=tag)](https://github.com/Gkxie/kintio/releases/latest)
[![License](https://img.shields.io/github/license/Gkxie/kintio)](LICENSE)

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
- pnpm 10 (pinned in `package.json`);
- an installed and authenticated Codex CLI;
- credentials for at least one supported adapter.

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
cp .env.example .env
codex login status
```

No adapter is enabled by default. Follow the [setup guide](docs/setup.md) to generate a
strong MCP token and configure one adapter:

- For WeChat KF API, set its callback token, EncodingAESKey, CorpID, and secret. A temporary
  `WECOM_AUTH_TRIGGER` can authorize the first user without knowing their
  `external_userid` in advance.
- For an existing Weixin iLink binding, set `ILINK_ENABLED=true`. Creating a new binding
  currently starts from an authorized WeChat KF conversation.

Start Kintio:

```bash
pnpm start
```

Check that the HTTP listener is alive from another terminal:

```bash
curl http://127.0.0.1:8888/healthz
```

An `ok` response confirms process liveness, not adapter readiness. Complete the callback
or binding checks described in the setup guide before sending production traffic.

## Security boundaries

- `.env`, SQLite databases, downloaded media, and local key files are ignored by Git and
  must never be force-added.
- The Agent does not receive provider secrets, stable user identifiers, raw media IDs, or
  database paths.
- MCP endpoints require strong bearer tokens; non-loopback access must use HTTPS.
- Project-level Agent capability restrictions are not an operating-system sandbox. Use a
  dedicated system account and additional isolation appropriate to the Agent's real powers.
- A provider accepting an outbound request does not prove that a client displayed it;
  uncertain outcomes remain explicit to avoid duplicate delivery.

See the [security policy](SECURITY.md) for the complete trust boundary and private
vulnerability-reporting process.

## Documentation and contributing

- [Setup guide](docs/setup.md) — configuration through the first Agent reply.
- [Architecture](docs/architecture.md) — message flow, module boundaries, identity
  isolation, and source entry points.
- [Roadmap](ROADMAP.md) — long-term direction and `0.x` priorities.
- [Contributing guide](CONTRIBUTING.md) — where to start and how to validate changes.
- [Maintainer guide](MAINTAINING.md) — issue, pull request, and release operations.
- [Code of Conduct](CODE_OF_CONDUCT.md), [Changelog](CHANGELOG.md), and
  [Apache License 2.0](LICENSE).

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
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

Kintio is an independent open-source project. It is not affiliated with, authorized by,
endorsed by, or an official product of Tencent, WeChat, Weixin, or any other channel
provider.
