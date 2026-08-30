# Deployment Guide

This guide takes a Kintio deployment from a clean machine to the first agent reply through a supported messaging adapter. For code structure and extension points, see [Architecture](architecture.md).

## 1. Prepare the runtime

Requirements:

- Linux;
- Node.js 24 or later;
- pnpm 10;
- [Codex CLI](https://developers.openai.com/codex/cli), with the same operating-system user that starts Kintio already signed in;
- an HTTPS domain reverse-proxied to `127.0.0.1:8888` when using the WeChat KF callback adapter.

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
cp .env.example .env
codex login status
```

Kintio uses the local Codex CLI session directly. It does not copy API keys or modify user-level Codex configuration.

## 2. Configure shared settings

Generate an MCP bearer token:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Write the generated value to `.env`:

```dotenv
PORT=8888
KINTIO_MCP_URL=http://127.0.0.1:8888/mcp
KINTIO_MCP_BEARER_TOKEN=paste_the_generated_value_here
CODEX_ENABLED=true
CODEX_WEB_SEARCH_MODE=live
```

When the agent and Kintio run on the same machine, keep `KINTIO_MCP_URL` on the loopback interface. Use a public HTTPS URL only when MCP is deployed on another machine.

Existing deployments may keep `TALKFERRY_MCP_URL`,
`TALKFERRY_MCP_BEARER_TOKEN`, and `TALKFERRY_DB_FILE` during a staged upgrade.
New configuration should use the `KINTIO_*` names.

The model and reasoning effort inherit the local Codex configuration by default. Set service-specific values only when needed:

```dotenv
# CODEX_MODEL=gpt-5.6-luna
# CODEX_REASONING_EFFORT=none
```

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
pnpm start
```

`pnpm start` builds the TypeScript project before starting `dist/index.js`. For development, use:

```bash
pnpm run dev
```

Successful startup prints `Hono server is listening on port 8888`. Also confirm
that the logs contain no later `runtime startup failed` entry.

For a WeChat KF deployment, save the callback configuration and complete the authorization flow in section 3.2. For an iLink deployment, send a normal message from the bound account and confirm that the agent replies. If it does not, check for `[ilink-listener] poll cycle failed` in the logs.

Run the test suite:

```bash
pnpm test
```

The default tests do not contact live messaging providers or a live Codex session.

## 6. Keep the service running with PM2

PM2 is an optional deployment tool, not a project dependency:

```bash
pnpm run build
pm2 start ecosystem.config.cjs
pm2 save
```

When upgrading from a TalkFerry release, replace the old PM2 process instead of
running both names concurrently:

```bash
pm2 stop talkferry
pm2 start ecosystem.config.cjs
pm2 status kintio
pm2 logs kintio --lines 50 --nostream
```

Deployments older than `0.2.0` used the still older process name `wechat-bot`;
use that name in both the stop and delete commands when upgrading directly.
Keep the stopped old PM2 entry until `kintio` remains online and its logs show
the Hono listener and startup catch-up without a later `runtime startup failed`.
After that verification, finalize the migration:

```bash
pm2 delete talkferry
pm2 save
```

Common commands:

```bash
pm2 status
pm2 logs kintio
pm2 restart kintio
```

PM2 must run as the same operating-system user that can successfully execute `codex login status`. If you use nvm, reinstall PM2 and update its startup configuration after switching or removing a Node.js version.

## 7. Provider constraints

These constraints come from the messaging providers and cannot be bypassed locally by Kintio:

- WeChat KF API access and human-agent handling are mutually exclusive. After switching to human handling, Kintio receives no further callbacks until API access is restored in the provider console.
- An iLink Bot can reply only within 24 hours of the user's latest message and can send at most 10 messages in that window. A new user message opens a new reply window.
- A successful provider API response means the request was accepted, not that the client displayed it. When a process interruption leaves the result uncertain, Kintio does not resend automatically because doing so could duplicate a message.
- Identities from different adapters remain distinct even when they belong to the same person in the real world.

## 8. Data and backups

New installations store runtime state in `data/kintio.sqlite`. Upgraded
deployments continue to use an existing `data/talkferry.sqlite` or
`data/wecom.sqlite` unless `KINTIO_DB_FILE` is set explicitly. If more than one
default state database exists, Kintio refuses to guess which one is
authoritative; inspect them and set `KINTIO_DB_FILE` explicitly before
starting. SQLite files, WAL files, `.env`, temporary media, and iLink storage
keys are excluded from Git.

For a deployment migration, stop the currently active process and back up these
items together:

- `.env`;
- the active SQLite file (`data/kintio.sqlite`, `data/talkferry.sqlite`, or
  `data/wecom.sqlite`);
- `data/ilink-storage.key`, when using the file-based key;
- the Codex login state and thread history for the operating-system user. Codex CLI manages these separately; they are not included in the SQLite backup.

When troubleshooting, check the process state, service logs, the relevant
provider console, and `codex login status` for the operating-system user that
starts Kintio.
