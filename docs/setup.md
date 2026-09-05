# Deployment Guide

This guide takes a Kintio deployment from a clean machine to the first agent reply through a supported messaging adapter. For code structure and extension points, see [Architecture](architecture.md).

## iLink-only path

An iLink-only instance needs no setup file, public domain, reverse proxy, Hono listener, or
callback credential:

```bash
npm install --global @kin-tio/cli
codex login status
kintio ilink login
kintio ilink start
```

`ilink login` owns the canonical instance lock only while it enrolls and persists an
account. If the same instance is already running, it delegates to that process through the
private operator IPC instead of opening a second SQLite writer. `ilink start` launches the
iLink-only Runtime through Kintio's background daemon without starting Hono.

Continue with the sections below only for a configured callback deployment or optional
overrides.

## 1. Prepare the runtime

Requirements:

- macOS, Linux, or Windows;
- Node.js 24 or later;
- [Codex CLI](https://developers.openai.com/codex/cli), with the same operating-system user that starts Kintio already signed in;
- an HTTPS domain reverse-proxied to `127.0.0.1:8888` when using the WeChat KF callback adapter.

```bash
npm install --global @kin-tio/cli
kintio wecom setup
codex login status
```

Kintio uses the local Codex CLI session directly. It does not copy API keys or modify user-level Codex configuration.

The global command is installed from the public npm Registry. Like Codex's
user-level [`CODEX_HOME`](https://learn.chatgpt.com/docs/config-file/environment-variables),
which defaults to `~/.codex`, Kintio keeps mutable user state outside its
installation. `kintio wecom setup` creates
the WeCom instance at `~/.kintio/wecom`, installs its bundled Agent skill in the
effective `CODEX_WORKING_DIRECTORY`, and writes `~/.kintio/wecom/.env`. On macOS and
Linux the file is created with mode `0600`. On Windows, the CLI requires the
instance and config to stay inside the current user's profile and trusts that
profile's ACL boundary; it does not claim to audit arbitrary Windows DACLs.
Kintio preserves an existing config. Use `--home` or `--config` for
an explicit instance location. Windows keeps Kintio-owned database, lock, iLink
key file, and image staging paths inside that instance. Runtime state never
defaults to the global package directory.
The installed `wechat-kf-reply-sop` file is a Kintio-managed asset and is
atomically refreshed by `wecom setup` and before WeCom process launches only. Changing
`CODEX_WORKING_DIRECTORY` therefore moves the active managed Skill boundary to
that workspace instead of leaving a dangling prompt reference. Keep local Agent
customizations outside the managed Skill path.

The instance path is a security boundary. For custom locations, every mutable
parent must be trusted: use owner-controlled directories (or a sticky shared
directory such as `/tmp`) on POSIX. On Windows, keep the instance and config
inside the current user profile without granting untrusted accounts write
access; paths outside the profile are rejected by the CLI. The default
channel directory (`~/.kintio/wecom` for WeCom, `~/.kintio` for iLink) is the
recommended choice.

## 2. Configure WeCom settings

Configure the WeCom settings in `~/.kintio/wecom/.env`:

```dotenv
PORT=8888
CODEX_ENABLED=true
# CODEX_WORKING_DIRECTORY=./codex-workspace
```

Kintio registers MCP with Codex as local stdio processes. Behind stdio it uses a
private Unix-domain socket or Windows named pipe, never a TCP port or public Hono
route, and requires no configured URL or Bearer Token.

Model, provider, reasoning effort, public search, login, and global Codex
settings come entirely from the host Codex CLI. Configure them through the
[official Codex configuration](https://developers.openai.com/codex/config-reference);
Kintio does not mirror them in `.env` or modify `$CODEX_HOME/config.toml`.
`KINTIO_DB_FILE` is the only setting for selecting the SQLite file.

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

## 4. Run iLink independently

The iLink channel uses its own process, database, workspace, and logs. It does
not read WeCom credentials or start Hono. Its existing `~/.kintio` data stays in
place; WeCom uses `~/.kintio/wecom`. There is no `ILINK_ENABLED` switch.

iLink bot tokens and reply credentials are stored encrypted. In production, you can provide an explicit 32-byte base64url key:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

```dotenv
ILINK_STORAGE_KEY=paste_the_generated_value_here
```

Without an explicit key, Kintio creates `ilink-storage.key` next to the SQLite database with `0600` permissions. Back up this key with the database; otherwise, restored iLink accounts cannot be decrypted.

Optional iLink settings belong in `~/.kintio/.env`, not the WeCom configuration.
The standalone CLI does not require this file. An operator can connect a new account
whether or not another Kintio process is running:

```bash
kintio ilink login
```

The default command prints the QR code itself. A graphical or non-terminal caller can
explicitly select a temporary raw PNG instead:

```bash
kintio ilink login --qr-output ~/.kintio/ilink-login.png
```

The target must be directly inside the selected Kintio instance directory and must not
exist. Kintio creates it exclusively and removes it on normal completion, cancellation,
or error without printing the QR payload. Both forms wait
for at most five minutes and do not start an Agent turn. A locally enrolled account is
marked as host-authorized: its owner receives
the capabilities exposed by the host Agent configuration, including any local, network,
tool, approval, or multi-agent powers enabled there. Only show the terminal QR code to a
person authorized to control that host Agent.

The login command exits after persisting credentials and starts no listener. Run
`kintio ilink start` to process iLink messages in the background without Hono, or use
`kintio ilink start --foreground` under an external service manager. Start the callback channel separately with `kintio wecom start` when needed.

Account lifecycle is explicit:

```bash
kintio ilink list
kintio ilink start [--account <provider-id-or-account-key>] [--foreground]
kintio ilink stop [--account <provider-id-or-account-key>]
kintio ilink delete [--account <provider-id-or-account-key>] [--yes]
```

One enrolled account is selected automatically. With no account, interactive `start`
opens the five-minute login flow and continues after enrollment. Multiple accounts open
a searchable picker; non-interactive callers use `--account` with a provider ID from
`list`. The first standalone `start` launches one managed daemon. Further `start` and
`stop` commands reach that owner over private operator IPC,
so one process owns SQLite while independently reconciling account listeners. Stopping
the last running account stops the iLink-only daemon. `kintio ilink status` and `kintio ilink logs`
expose its state and output.

`kintio ilink list` prints one provider account ID per line. Pass that exact value to
`--account`; Kintio's internal hashed account key is not needed for normal operation.

`delete` is intentionally stronger than logout. Interactive use selects an account and
asks for confirmation with a default of No; scripts require `--account` and `--yes`.
It atomically removes the selected
account, credentials, conversations, messages, media, send records, reply windows, and
enrollment audit rows from Kintio. It cannot be undone.

An uncatchable termination such as `SIGKILL` or power loss can leave the temporary PNG
behind. Its provider-side QR still expires after five minutes; remove the stale file
manually before reusing the same path.

Enrollment is available through `kintio ilink login` or the first interactive
`kintio ilink start`. The WeCom runtime has no iLink enrollment or account
management tools. Channel authorization, threads, and history remain separate.

## 5. Start and verify

```bash
kintio wecom start
kintio wecom status
kintio wecom logs --lines 100
```

`kintio wecom start` validates the instance config and launches Kintio's portable
background daemon. Repeating it while that instance is online reports the
existing PID instead of creating another consumer. The installed command starts
prebuilt JavaScript and never compiles TypeScript at runtime. It returns success
only after the worker completes runtime initialization. A crashed worker is
restarted with bounded backoff; a port conflict or repeated initialization
failure returns nonzero. Inspect `kintio wecom logs --no-follow` for the retained log.
Readiness does not wait for downtime backlog to finish; recoverable messages
continue at low priority after the live listeners can safely accept work.

For a foreground process under a container or another service manager, use:

```bash
kintio wecom run
```

For development inside the source checkout, use:

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm run dev
```

Confirm that `kintio wecom logs` contains `Hono server is listening on port 8888` and
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
kintio wecom start
kintio wecom status
kintio wecom logs --lines 100
kintio wecom restart
kintio update
kintio wecom stop
```

`stop` uses an authenticated local Unix socket or Windows named pipe and waits
for the worker's graceful shutdown path.
`wecom restart` and `ilink restart` reload only their respective channel with its
instance configuration. The CLI does
not modify Nginx, provider consoles, shell profiles, or operating-system boot
configuration. Configure launchd, systemd, Task Scheduler, a container runtime,
or another boot mechanism separately with `kintio wecom run` if the machine must start
Kintio automatically after reboot.

`update` (or its exact alias `upgrade`) recognizes the npm or pnpm global
installation that owns the current CLI, resolves the Registry `latest` tag to
one exact version, and restores an idle background instance after verification:

```bash
kintio update
```

Active Agent work, a foreground Runtime, an active standalone login, an unknown
installation layout, or an ambiguous package-manager root fails before the
package is changed. The updater checks both default channel directories and
the selected `--home`. If both channels are running, stop the other channel
first; at most one idle channel is restored automatically. Stop any other custom
instance homes using the same global installation before updating.
Kintio also verifies the running Runtime's effective configuration before
stopping it. If the Runtime was started with shell-only overrides, run the
update with the same environment or persist those values in the instance
configuration first.

To remove the command, stop WeCom with `kintio wecom stop` and each active iLink
account with `kintio ilink stop`, then run `npm uninstall --global
@kin-tio/cli`. The instance under `~/.kintio` is retained by default so uninstalling
the package does not silently delete configuration, conversations, or media.

Each instance keeps its daemon identity, private control capability, and rotated
logs under `<home>/data`; its random Unix socket or Windows named pipe exists
only while the daemon is running. Every lifecycle command for a custom instance
must carry the same selector, or `KINTIO_CONFIG_FILE` can be exported once for
that shell:

```bash
export KINTIO_CONFIG_FILE=/absolute/path/to/existing/.env
kintio wecom start
kintio wecom status
kintio wecom logs --lines 100
kintio wecom restart
kintio wecom stop
```

With no explicit `--home`, the config directory becomes the instance root, so
relative database and workspace paths retain their existing meaning.

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

iLink stores state in `~/.kintio/data/kintio.sqlite`; WeCom stores its own state
in `~/.kintio/wecom/data/kintio.sqlite`. Configuration, account data, and
Agent workspaces are not deleted by setup, stop, restart, or package removal. `--home` or `KINTIO_HOME` moves the whole instance; `--config` or
`KINTIO_CONFIG_FILE` selects an existing environment file. Relative paths in
that configuration resolve from the instance root, not the package manager's
global installation directory or the caller's current directory.

Only the current SQLite schema (v24) and daemon metadata (v2) are supported.
Other database versions are rejected without migration or data deletion. Use a
fresh instance directory when starting from an incompatible version. Retired
database names and configuration aliases are not discovered automatically.
SQLite files, WAL files, environment files, temporary media, and iLink storage
keys are excluded from Git.
`data/daemon.json`, the ephemeral local control endpoint, and `data/logs` are
process metadata and logs, not application data; do not restore them with
SQLite on another machine.

For a deployment migration, stop the currently active process and back up these
items together:

- the active instance environment file (normally `~/.kintio/wecom/.env`);
- the active SQLite file (normally `data/kintio.sqlite`);
- `data/ilink-storage.key`, when using the file-based key;
- the Codex login state and thread history for the operating-system user. Codex CLI manages these separately; they are not included in the SQLite backup.

When troubleshooting, check the process state, service logs, the relevant
provider console, and `codex login status` for the operating-system user that
starts Kintio.
