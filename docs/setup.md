# Deployment Guide

This guide takes a Kintio deployment from a clean machine to the first agent reply through a supported messaging adapter. For code structure and extension points, see [Architecture](architecture.md).

## 1. Prepare the runtime

Requirements:

- macOS, Linux, or Windows;
- Node.js 24 or later;
- pnpm 10;
- [Codex CLI](https://developers.openai.com/codex/cli), with the same operating-system user that starts Kintio already signed in;
- an HTTPS domain reverse-proxied to `127.0.0.1:8888` when using the WeChat KF callback adapter.

```bash
git clone https://github.com/Gkxie/kintio.git
cd kintio
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run build
npm install --global .
kintio setup
codex login status
```

Kintio uses the local Codex CLI session directly. It does not copy API keys or modify user-level Codex configuration.

The global command is installed from the checked-out source during the `0.x`
phase. Like Codex's user-level [`CODEX_HOME`](https://learn.chatgpt.com/docs/config-file/environment-variables),
which defaults to `~/.codex`, Kintio keeps mutable user state outside its
installation. `kintio setup` creates
the default instance at `~/.kintio`, installs the bundled Agent skill in the
effective `CODEX_WORKING_DIRECTORY`, and writes `~/.kintio/.env`. On macOS and
Linux the file is created with mode `0600`. On Windows, the CLI requires the
instance and config to stay inside the current user's profile and trusts that
profile's ACL boundary; it does not claim to audit arbitrary Windows DACLs.
Kintio refuses to overwrite an existing config. Use `--home` or `--config` for
an explicit instance location. Windows keeps Kintio-owned database, lock, iLink
key file, and image staging paths inside that instance. Runtime state never
defaults to the global package directory.
The installed `wechat-kf-reply-sop` file is a Kintio-managed asset and is
atomically refreshed by `setup` and again before every process launch. Changing
`CODEX_WORKING_DIRECTORY` therefore moves the active managed Skill boundary to
that workspace instead of leaving a dangling prompt reference. Keep local Agent
customizations outside the managed Skill path.

The instance path is a security boundary. For custom locations, every mutable
parent must be trusted: use owner-controlled directories (or a sticky shared
directory such as `/tmp`) on POSIX. On Windows, keep the instance and config
inside the current user profile without granting untrusted accounts write
access; paths outside the profile are rejected by the CLI. The default
`~/.kintio` directory is the recommended choice.

## 2. Configure shared settings

Configure the shared settings in `~/.kintio/.env`:

```dotenv
PORT=8888
CODEX_ENABLED=true
# CODEX_WORKING_DIRECTORY=./codex-workspace
```

Kintio registers MCP with Codex as local stdio processes. Behind stdio it uses a
private Unix-domain socket or Windows named pipe, never a TCP port or public Hono
route, and requires no configured URL or Bearer Token. Remove obsolete
`KINTIO_MCP_URL`, `KINTIO_MCP_BEARER_TOKEN`, and
the equivalent `TALKFERRY_`, `HARNESS_`, or `WECOM_` URL/Bearer aliases from
upgraded deployments.

Model, provider, reasoning effort, public search, login, and global Codex
settings come entirely from the host Codex CLI. Configure them through the
[official Codex configuration](https://developers.openai.com/codex/config-reference);
Kintio does not mirror them in `.env` or modify `$CODEX_HOME/config.toml`.
Existing deployments may keep `TALKFERRY_DB_FILE` during a staged database-name
migration; new configuration should use `KINTIO_DB_FILE`.

## 3. Configure the WeChat KF adapter

Skip this section if you only need to restore an existing iLink Bot. In that case, confirm that all four `WECOM_*` values below are empty in `.env`.

### 3.1 Obtain credentials

Follow the [WeChat KF API documentation](https://kf.weixin.qq.com/api/doc/path/93304). In the WeCom administration console, prepare these values from the WeChat KF internal API configuration:

- callback token;
- EncodingAESKey;
- enterprise CorpID;
- WeChat KF secret.

These are four distinct values. Add them to `.env`:

```dotenv
WECOM_CALLBACK_TOKEN=...
WECOM_ENCODING_AES_KEY=...
WECOM_CORP_ID=...
WECOM_KF_SECRET=...
```

### 3.2 Configure initial authorization

On a first deployment, you usually do not yet know your `external_userid`. The recommended bootstrap method is a temporary passphrase known only to the intended user:

```dotenv
WECOM_AUTH_TRIGGER=choose_a_private_passphrase
WECOM_AUTH_TRIGGER_COUNT=3
WECOM_AUTH_CONFIRMATION=Code accepted. You can continue the conversation.
```

After the service is running and callback verification succeeds, have the intended user send the exact passphrase three consecutive times. The third message receives the configured confirmation immediately. Send a normal message next and confirm that the agent replies. Authorization is persisted in SQLite, so you can clear `WECOM_AUTH_TRIGGER` and restart Kintio after bootstrap.

If you already know the `external_userid` values through the WeCom API, configure a static allowlist instead:

```dotenv
WECOM_ALLOWED_USER_IDS=wm_user_a,wm_user_b
```

Unauthorized users receive no reply, do not wake Codex, and cannot trigger
image downloads. Wildcards are unsupported: `WECOM_ALLOWED_USER_IDS` accepts
only explicit `external_userid` values.

### 3.3 Configure the callback

Reverse-proxy a public HTTPS domain to `127.0.0.1:8888`. Set the WeChat KF callback URL to the service root, for example:

```text
https://kintio.example.com/
```

The root route handles both GET verification and POST message events. The reverse proxy should terminate TLS and forward requests without rewriting query parameters or request bodies.

Prepare the URL first, then save the callback configuration in the provider console after Kintio starts. The log entry `callback URL verification succeeded` confirms successful verification.

## 4. Configure the iLink adapter

Follow Tencent's [iLink upstream instructions](https://github.com/Tencent/openclaw-weixin/blob/main/README.zh_CN.md). To restore existing bindings, enable iLink in `.env`:

```dotenv
ILINK_ENABLED=true
```

iLink bot tokens and reply credentials are stored encrypted. In production, you can provide an explicit 32-byte base64url key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```dotenv
ILINK_STORAGE_KEY=paste_the_generated_value_here
```

Without an explicit key, Kintio creates `ilink-storage.key` next to the SQLite database with `0600` permissions. Back up this key with the database; otherwise, restored iLink accounts cannot be decrypted.

Existing accounts resume long polling at startup. The current enrollment flow for a new account begins in an authorized WeChat KF conversation: after the user explicitly asks for a separate bot channel, the agent calls `offer_weixin_bot_channel` to send a login QR code. The user who scans it becomes the only allowed user identity for that bot.

WeChat KF and iLink identities remain separate. Scanning the QR code does not copy authorization, Codex threads, or conversation history from the originating adapter.

## 5. Start and verify

```bash
kintio start
kintio status
kintio logs --lines 100
```

`kintio start` validates the instance config and launches Kintio's portable
background daemon. Repeating it while that instance is online reports the
existing PID instead of creating another consumer. The installed command starts
prebuilt JavaScript and never compiles TypeScript at runtime. It returns success
only after the worker completes runtime initialization. A crashed worker is
restarted with bounded backoff; a port conflict or repeated initialization
failure returns nonzero. Inspect `kintio logs --no-follow` for the retained log.
Readiness does not wait for downtime backlog to finish; recoverable messages
continue at low priority after the live listeners can safely accept work.

For a foreground process under a container or another service manager, use:

```bash
kintio run
```

For development inside the source checkout, use:

```bash
pnpm run dev
```

Confirm that `kintio logs` contains `Hono server is listening on port 8888` and
no later `[supervisor] process failed` entry.

For a WeChat KF deployment, save the callback configuration and complete the authorization flow in section 3.2. For an iLink deployment, send a normal message from the bound account and confirm that the agent replies. If it does not, check for `[ilink-listener] poll cycle failed` in the logs.

Run the test suite:

```bash
pnpm test
```

The default tests do not contact live messaging providers or a live Codex session.

## 6. Process lifecycle

Kintio includes a small cross-platform background daemon. Users operate it
through the Kintio command surface:

```bash
kintio start
kintio status
kintio logs --lines 100
kintio restart
kintio stop
```

`stop` uses an authenticated local Unix socket or Windows named pipe and waits
for the worker's graceful shutdown path.
`restart` reloads the current installed code and instance config. The CLI does
not modify Nginx, provider consoles, shell profiles, or operating-system boot
configuration. Configure launchd, systemd, Task Scheduler, a container runtime,
or another boot mechanism separately with `kintio run` if the machine must start
Kintio automatically after reboot.

Each instance keeps its daemon identity, private control capability, and rotated
logs under `<home>/data`; its random Unix socket or Windows named pipe exists
only while the daemon is running. Every lifecycle command for a custom instance
must carry the same selector, or `KINTIO_CONFIG_FILE` can be exported once for
that shell:

```bash
export KINTIO_CONFIG_FILE=/absolute/path/to/existing/.env
kintio start
kintio status
kintio logs --lines 100
kintio restart
kintio stop
```

With no explicit `--home`, the config directory becomes the instance root, so
relative database and workspace paths retain their existing meaning.

Existing source deployments may still use a traditional PM2 entry. Before the
first native-daemon start, use the old
PM2 command once to stop and delete its `kintio`, `talkferry`, or `wechat-bot`
entry, then verify the old process and port are gone. Only then run the command
group above. This is a one-time ownership transfer; starting both managers would
create competing consumers and is intentionally not automated.

```bash
# Choose the name shown by the old `pm2 status` output.
legacy_name=kintio
pm2 stop "$legacy_name"
pm2 delete "$legacy_name"
pm2 status
```

The global command and its native daemon must run as the same operating-system user
that can successfully execute `codex login status`. Reinstall the global Kintio
command after switching or removing the Node.js version that owns it.

## 7. Provider constraints

These constraints come from the messaging providers and cannot be bypassed locally by Kintio:

- The provider's API access state and provider-side takeover state are mutually exclusive. After provider-side takeover, Kintio receives no further callbacks until API access is restored in the provider console.
- An iLink Bot can reply only within 24 hours of the user's latest message and can send at most 10 messages in that window. A new user message opens a new reply window.
- A successful provider API response means the request was accepted, not that the client displayed it. When a process interruption leaves the result uncertain, Kintio does not resend automatically because doing so could duplicate a message.
- Identities from different adapters remain distinct even when they belong to the same person in the real world.

## 8. Data and backups

CLI installations store runtime state in `~/.kintio/data/kintio.sqlite` by
default. `--home` or `KINTIO_HOME` moves the whole instance; `--config` or
`KINTIO_CONFIG_FILE` selects an existing environment file. Relative paths in
that configuration resolve from the instance root, not the package manager's
global installation directory or the caller's current directory.

Upgraded deployments continue to use an existing `data/talkferry.sqlite` or
`data/wecom.sqlite` unless `KINTIO_DB_FILE` is set explicitly. If more than one
default state database exists, Kintio refuses to guess which one is
authoritative. SQLite files, WAL files, environment files, temporary media, and
iLink storage keys are excluded from Git.
`data/daemon.json`, the ephemeral local control endpoint, and `data/logs` are
process metadata and logs, not application data; do not restore them with
SQLite on another machine.

For a deployment migration, stop the currently active process and back up these
items together:

- the active instance environment file (normally `~/.kintio/.env`);
- the active SQLite file (`data/kintio.sqlite`, `data/talkferry.sqlite`, or
  `data/wecom.sqlite`);
- `data/ilink-storage.key`, when using the file-based key;
- the Codex login state and thread history for the operating-system user. Codex CLI manages these separately; they are not included in the SQLite backup.

When troubleshooting, check the process state, service logs, the relevant
provider console, and `codex login status` for the operating-system user that
starts Kintio.
