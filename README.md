<div align="center">

<h1>
  <img src="https://raw.githubusercontent.com/Gkxie/kintio/master/assets/logo.svg" alt="Kintio" width="320" />
</h1>

**Connect chat channels to an Agent you control.**

English | [简体中文](https://github.com/Gkxie/kintio/blob/master/README.zh-CN.md)

[![CI](https://github.com/Gkxie/kintio/actions/workflows/ci.yml/badge.svg)](https://github.com/Gkxie/kintio/actions/workflows/ci.yml)
[![CodeQL](https://github.com/Gkxie/kintio/actions/workflows/codeql.yml/badge.svg)](https://github.com/Gkxie/kintio/actions/workflows/codeql.yml)
[![Latest release](https://img.shields.io/github/v/release/Gkxie/kintio?display_name=tag)](https://github.com/Gkxie/kintio/releases/latest)
[![License](https://img.shields.io/github/license/Gkxie/kintio)](LICENSE)

</div>

Kintio connects chat channels to the Agent running on your computer. Send tasks and
follow-ups from chat, then receive the Agent's results in the same conversation. The current
release uses the authenticated Codex CLI and configuration already available on the host.

## Quick start

You need Node.js 24+ and a Codex CLI authenticated by the same operating-system user that
runs Kintio.

```bash
npm install --global @kin-tio/cli
codex login status
```

### Weixin iLink

iLink is the shortest path to a working conversation. It uses QR enrollment and long
polling, so it needs no public URL, callback server, setup file, or `.env` file.

```bash
kintio ilink start
```

On the first interactive run, `ilink start` prints a QR code. Scan it within five minutes;
Kintio encrypts the enrolled account under `~/.kintio`, continues startup, and leaves iLink
polling in the background. You can then send a message to the new bot in WeChat. Later
`ilink start` calls reuse the saved account and do not require another scan.

> A locally enrolled iLink account inherits the capabilities allowed by the host Agent
> configuration. Only an authorized operator should scan the QR code.

Check the runtime or follow its output:

```bash
kintio status
kintio logs --lines 100
```

### Manage iLink accounts

| Goal | Command |
| --- | --- |
| Enroll an account without starting it | `kintio ilink login` |
| List enrolled accounts | `kintio ilink list` |
| Start an account | `kintio ilink start` |
| Stop an account | `kintio ilink stop` |
| Permanently delete an account and its Kintio data | `kintio ilink delete` |
| Keep the Runtime attached to a service manager | `kintio ilink start --foreground` |

With one account, lifecycle commands select it automatically. With multiple accounts, an
interactive terminal opens a searchable picker. Scripts should use
`--account <provider-id-or-account-key>` for start and stop. Non-interactive deletion always
requires both `--account` and `--yes`. Deletion removes Kintio's local state; it does not
delete the provider-side bot or guarantee server-side token revocation.

`kintio ilink login` performs enrollment and exits without starting a listener or Agent
turn. A graphical or non-terminal caller can request a temporary raw PNG instead of terminal
blocks:

```bash
kintio ilink login --qr-output ~/.kintio/ilink-login.png
```

The PNG is temporary and the QR expires after five minutes. See the
[setup guide](docs/setup.md) for the complete QR, multi-account, and non-interactive
contracts.

### Callback-based channels

Channels that receive public HTTPS callbacks require a deployment configuration:

```bash
kintio setup
kintio start
kintio status
kintio logs --lines 100
```

`kintio setup` creates a private instance under `~/.kintio`, installs the managed Agent
skill, and writes the channel configuration template. Continue with the
[setup guide](docs/setup.md) for callback credentials, authorization, and the first reply.
WeChat KF deployments can also enable iLink in the same service Runtime.

## What it provides

- A separate Agent thread for every channel identity.
- Follow-ups that steer active work instead of waiting behind stale instructions.
- A durable SQLite inbox with restart recovery and live-message priority.
- Session-scoped MCP actions and explicit accepted, failed, or uncertain delivery outcomes.

See the [architecture guide](docs/architecture.md) for message flow, identity boundaries,
recovery, and source entry points.

## Current adapters

| Adapter | Receive | Send | Transport |
| --- | --- | --- | --- |
| Weixin iLink | Text and images; explicit summaries for other types | Text and images | QR enrollment and long polling |
| WeChat KF API | Text and images; explicit summaries for other types | Text, images, links, Mini Programs, and locations | Public HTTPS callback |

Capabilities stay scoped to the originating conversation; users, media references, and
Agent threads are never implicitly merged across channels.

## Operations and updates

```bash
kintio status
kintio logs
kintio restart
kintio update
```

`kintio upgrade` is an exact alias for `update`. A recognized global npm or pnpm installation
can update itself without changing Agent or channel configuration. Kintio refuses unknown
installation layouts and active Agent work; an idle background instance is restored in its
existing service or iLink mode.

## Security boundaries

- `.env`, SQLite databases, downloaded media, and local key files are ignored by Git and
  must never be force-added.
- Kintio does not inject channel secrets, stable user identifiers, raw media IDs, or database
  paths into the Agent; host Agent credentials remain host-managed.
- Codex starts MCP over stdio. Kintio uses only a private Unix-domain socket or Windows named
  pipe behind that process boundary, never a public MCP TCP port or Hono route.
- Project-level Agent capability restrictions are not an operating-system sandbox. Use a
  dedicated system account and isolation appropriate to the Agent's real powers.
- Accounts enrolled locally through iLink are explicitly host-authorized. Accounts enrolled
  from a remote adapter remain restricted, and chat input cannot change that trust level.
- Provider acceptance does not prove that a client displayed a message. Uncertain outcomes
  stay explicit to prevent duplicate delivery.

Read the [security policy](SECURITY.md) for the
complete trust boundary and private vulnerability-reporting process.

## Project status and documentation

Kintio is in the `0.x` stage while its channel, identity, recovery, and Agent-runtime
contracts are stabilized for additional adapters.

- [Setup guide](docs/setup.md) — deployment through the first Agent reply.
- [Architecture](docs/architecture.md) — message flow, boundaries, and source entry points.
- [Roadmap](ROADMAP.md) — long-term direction and `0.x` priorities.
- [Changelog](CHANGELOG.md) — user-visible changes by release.

The Weixin iLink implementation incorporates work described in
[THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES). Kintio is an independent open-source project; it
is not affiliated with, authorized by, endorsed by, or an official product of Tencent,
WeChat, Weixin, or any other channel provider.

## Contributing

Contributions are welcome. Start with the
[contributing guide](CONTRIBUTING.md), then run the
same default verification entry point used by the repository:

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm test
```

Tests use temporary SQLite databases and simulated channel and Agent boundaries by default.
They contact real services only when explicit live-test flags, targets, and allowlists are
supplied. Contributors should also read the
[Code of Conduct](CODE_OF_CONDUCT.md); release and
repository operations are documented in the
[maintainer guide](MAINTAINING.md). Kintio is
available under the [Apache License 2.0](LICENSE).
