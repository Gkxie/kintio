# Architecture

## Goals and boundaries

Kintio connects supported public messaging adapters to an agent runtime. It receives messages, isolates provider identities, persists state, schedules the agent, and safely executes outbound actions in the originating conversation.

The current agent runtime is Codex CLI. The code exposes a replaceable agent interface but deliberately avoids additional abstraction until a second implementation exists. The currently supported messaging adapters are WeChat KF API and iLink Bot.

A Kintio deployment shares one Codex login. Each provider identity has an independent Codex thread. Kintio does not implement a multi-tenant model with separate agent credentials or working directories for individual messaging users.

## Installation and runtime boundary

Program files belong to the installed package; mutable state belongs to
`~/.kintio`. WeCom configuration and its managed Agent workspace live in
`~/.kintio/wecom/`. iLink retains its existing home and account data. Both
channels use `~/.kintio/data/kintio.sqlite`, one global Agent scheduler, and
one set of runtime locks and logs. `--home` selects the Kintio home, not a
second WeCom instance. There is one WeCom listener, not a WeCom account registry.

[cli.ts](../cli.ts) and [src/cli.ts](../src/cli.ts) implement the public commands.
The native daemon provides bounded crash recovery and log rotation for one
[worker.ts](../worker.ts). The worker composes the shared business services in
[src/runtime.ts](../src/runtime.ts); Hono is an optional listener inside it,
not the process entry point.

```text
kintio wecom start/stop ──┐
                        ├── private local operator IPC ── shared business worker
kintio ilink commands ───┘                                 ├── WeCom singleton (optional Hono)
                                                          ├── enabled iLink account listeners
                                                          ├── SQLite + one Agent scheduler
                                                          └── Agent CLI + stdio MCP children
```

The first background start launches the daemon and worker. Starting another
channel attaches to that worker instead of creating another database owner.
iLink login can still run temporarily without any background worker or WeCom
configuration. Operator tools are available only over private local IPC;
conversation Agents receive scoped delivery tools, never lifecycle controls.
The shared CLI operator client is in
[src/runtime/operator-client.ts](../src/runtime/operator-client.ts); QR rendering
and temporary standalone login remain in `src/ilink/cli-login.ts`. Neither
channel owns the other channel's control transport.

WeCom start loads its own configuration, installs its Skill, and binds its HTTP
listener. iLink alone does not load that configuration or bind a TCP port.
Repeated WeCom start is idempotent. Stopping or restarting a listener does not
restart the shared worker or another channel's listeners. When the last channel
is stopped, the worker drains and asks its daemon to exit.

SQLite retains the WeCom enabled flag and each iLink account's enabled flag.
A whole-worker restart restores only those choices. Startup recovery closes
or repairs interrupted work once per worker, never when adding a second
channel. Downtime work remains low-priority under the same global scheduler.

Shared resources do not share trust: conversation keys include channel,
account, and participant. WeCom authorization, iLink enrollment, thread history,
Agent workspace, and MCP delivery capabilities remain scoped. Host-level
access granted by local iLink login does not authorize a WeCom identity.

A whole-worker failure affects both channels; the daemon restarts that one
worker with bounded backoff. This is a deliberate trade-off for avoiding two
sets of supervision, persistence, recovery, and scheduling. A callback bind
failure is reported without closing an already-running iLink listener.

## Message flow

```text
WeChat KF HTTPS callback ─┐
                          ├→ NormalizedMessage → SQLite Inbox → scheduler → Agent Adapter
iLink Bot long polling ───┘                                            ├── Kintio Prompt
                                                                      ├── session-selected Skill
                                                                      └── stdio MCP registration
                                                                                  ↓
Messaging user ← provider API ← local MCP tool ← scoped capability ← host Agent CLI
```

SQLite is the source of truth for both inbound and outbound processing:

1. A messaging adapter converts a provider message into the common inbound structure and writes it to the Inbox.
2. The scheduler claims messages, prioritizing live traffic and processing downtime backfill only when capacity is idle.
3. The agent adapter starts, resumes, or steers the current Codex thread.
4. Each turn receives a short-lived MCP session scoped to the current identity and message direction.
5. The agent calls an action tool; MCP resolves the actual recipient and records the result.
6. The inbound message completes only when the SQLite send record agrees with the agent result.

## Four core boundaries

### 1. Messaging adapters

Messaging adapters handle provider protocols. They do not decide what the agent should say.

Hono is the public HTTP adapter for callbacks, not the Kintio process entry or
lifecycle owner. The local MCP IPC host, long polling, and future WebSocket
adapters have independent lifecycles under the Runtime.

- WeChat KF callback and signature verification: [src/routes/wecom.ts](../src/routes/wecom.ts)
- WeChat KF message synchronization: [src/services/wecom-sync.ts](../src/services/wecom-sync.ts)
- WeChat KF message domain: [src/domain/wecom-message.ts](../src/domain/wecom-message.ts)
- Channel-neutral message admission: [src/domain/message.ts](../src/domain/message.ts)
- iLink long polling: [src/ilink/listener.ts](../src/ilink/listener.ts)
- iLink protocol client: [src/ilink/protocol/client.ts](../src/ilink/protocol/client.ts)
- iLink message conversion: [src/ilink/message.ts](../src/ilink/message.ts)

Each adapter has distinct identity keys, authorization rules, and reply windows. Identities must not be merged based on an assumption that they represent the same person in the real world.

### 2. Conversation scheduling and state

[src/services/conversation-processor.ts](../src/services/conversation-processor.ts) manages concurrency windows, live-versus-backfill priority, and steering within a conversation. [src/state/persistence.ts](../src/state/persistence.ts) owns the single SQLite connection and creates the core, iLink, and enrollment state facades. [src/state/sqlite-store.ts](../src/state/sqlite-store.ts) implements the shared Inbox, authorization, short-lived capabilities, thread bindings, and send records.

Runtime, messaging adapters, MCP, and Agent code receive only JS/TS state
methods; the raw database handle stays inside the persistence implementation.
In-process queues only drive work forward; SQLite owns recoverable state.
Database transactions are never held open during network requests.

### 3. Agent adapter

[src/agent/runtime.ts](../src/agent/runtime.ts) defines the minimal agent lifecycle Kintio needs: start, steer, resume, and stop. [src/services/codex-agent.ts](../src/services/codex-agent.ts) is the current Codex CLI implementation, while [src/services/codex-app-server.ts](../src/services/codex-app-server.ts) implements the app-server protocol.

Each adapter produces the same `NormalizedMessage`; the shared processor then
builds channel-neutral `AgentInput`. A managed Skill lives in the private Kintio
instance workspace and is selected by the trusted per-session channel prompt.
It is not installed into the host user's global Agent configuration.

The Agent process inherits the environment supplied to Kintio by its host.
Kintio parses its instance `.env` without copying those values into
`process.env`; adapter credentials therefore remain application configuration
unless the operator explicitly exports them in the host environment. Kintio
does not select a model, provider, reasoning effort, or public-search mode. The
Codex adapter adds only the session prompt, selected managed Skill, local MCP tools, and
the safety restrictions required for untrusted chat input.

The structured Agent input contains channel-neutral text, images, and summaries.
Kintio does not place messaging-provider secrets, real user IDs, raw `media_id`
values, or database paths in that input. Provider payloads, error codes, and delivery
policies cannot enter channel-neutral adapter input. MCP tools may return
sanitized execution facts to the Agent.

### 4. MCP action tools

MCP is the agent's only path for actions against messaging providers:

- WeChat KF: [src/mcp/wechat-kf-server.ts](../src/mcp/wechat-kf-server.ts)
- iLink: [src/mcp/ilink-server.ts](../src/mcp/ilink-server.ts)
- read-only memory for archived threads: [src/mcp/conversation-memory-server.ts](../src/mcp/conversation-memory-server.ts)
- local iLink enrollment for the CLI: [src/mcp/ilink-login-server.ts](../src/mcp/ilink-login-server.ts)
- Worker-owned IPC lifecycle: [src/mcp/ipc-host.ts](../src/mcp/ipc-host.ts)
- stdio relay: [src/mcp/stdio-relay.ts](../src/mcp/stdio-relay.ts)
- bounded descriptor and handshake protocol: [src/mcp/ipc-protocol.ts](../src/mcp/ipc-protocol.ts)

Codex starts one local stdio relay for each enabled MCP server. The relays connect
to one Worker-owned Unix-domain socket on POSIX or named pipe on Windows; no MCP
TCP listener exists. A per-Worker descriptor contains a rotated transport token
in the private instance directory. Codex receives only the relay command,
descriptor path, and fixed route—never the token through arguments or environment
variables. Public Hono routes never expose MCP. Every action still requires the
short-lived session capability embedded in the current trusted Agent input. Each
tool revalidates the adapter, recipient, message direction, media ownership,
expiration, and quota. The model cannot select a recipient through tool arguments.

The local operator route is not registered with Codex. When an instance is running,
`kintio ilink login`, `list`, `start`, `stop`, and `delete` reach it through a separate
private descriptor, random token, IPC address, and stdio relay; the running process remains
the only SQLite writer. Without a running owner, the CLI acquires the same instance lock.
Login lazily composes the shared Enrollment Service; account lifecycle commands operate on
the account store directly. A held lock with unavailable IPC fails closed. No Agent process
receives the operator descriptor path or credential.

One Runtime owns every selected iLink listener. Starting another account reconciles it into
that process rather than creating another SQLite owner; stopping or deleting one account
reconciles only that listener. Stopping or deleting the last running account from a
standalone iLink runtime also closes that runtime. Complete deletion is account-scoped and transactional: Kintio
removes its credentials, Inbox history, conversations, media, reply windows, delivery
records, and enrollment audit while preserving unrelated accounts and channels.

### Agent access provenance

iLink accounts persist an Agent access level derived only from their enrollment source.
CLI enrollment grants `host` access. Previously restricted accounts keep their
stored access level until explicitly enrolled by the local operator. WeCom no
longer offers iLink enrollment tools.
Provider messages, Agent prompts, MCP arguments, and participant IDs cannot select or
upgrade this field. Existing host access survives remote credential rotation and can only
originate from the local operator path.

Restricted conversations use Kintio's capability fence and channel Developer Instructions.
Host-authorized conversations run in a separate lazy Agent boundary: Kintio adds only its
iLink delivery and memory MCP servers, omits forced sandbox/approval/feature overrides, and
inherits the host model, provider, tools, network, shell, MCP, and other Agent settings. The
access contract is Agent-runtime-neutral even though the current implementation uses Codex.

Tools return execution facts only: accepted, failed, or uncertain. Provider-specific errors are explained by tool results when they occur. They do not belong in the global prompt, and retry decisions are not hard-coded into channel-neutral agent behavior.

## Identity, context, and media

- Every conversation identity is `channel + accountKey + peerId`. Provider adapters translate their native account and participant IDs at the normalization boundary.
- Identical `accountKey`, `peerId`, or provider message IDs in different channels remain independent; adapters do not need coordinated ID namespaces.
- Later messages within the same adapter can steer the running agent turn; different adapters never share a Codex thread.
- WeChat KF authorization applies to an `external_userid` within an enterprise, while thread isolation still uses the account-and-user pair.
- Only text and images become native model input. Other message types retain important provider fields and become explicit summaries.
- User images are available only through `media:N` references in the current session; generated images use short-lived `artifact:N` references.
- Kintio does not download or transcribe audio, video, or files merely to claim support for them.

## Crash recovery

Every send is persisted before invoking the provider API. If the process exits after a send begins but before its result is known, the record becomes `uncertain` and is not retried automatically.

At startup, the WeChat KF adapter backfills messages from its saved cursor, while iLink resumes long polling for every runtime-selected bot. Live traffic receives agent concurrency first; backfill begins only when no active conversation is waiting. An archived Codex thread starts a new thread and exposes a read-only memory tool bound only to the archived thread ID. A deleted thread simply starts over.

The exact recovery, race, and idempotency transitions are specified by these tests:

- [test/recovery](../test/recovery)
- [test/integration/sqlite-invariants.test.ts](../test/integration/sqlite-invariants.test.ts)
- [test/integration/ilink-channel-invariants.test.ts](../test/integration/ilink-channel-invariants.test.ts)

## Where to make changes

| Goal | Start here | Primary tests |
| --- | --- | --- |
| Change WeChat KF inbound parsing | `src/domain/wecom-message.ts`, `src/services/wecom-sync.ts` | `test/unit/wecom-message*`, `test/integration/wecom-sync.test.ts` |
| Change iLink protocol or media handling | `src/ilink/` | `test/unit/ilink-*`, `test/integration/ilink-*` |
| Change agent context or steering | `src/services/codex-agent.ts`, `conversation-processor.ts` | `test/integration/codex-*`, `conversation-*` |
| Change provider send capabilities | `src/mcp/`, `src/domain/send-contract.ts` | `test/integration/*-mcp.test.ts` |
| Change authorization, queues, or recovery | `src/state/sqlite-store.ts`, `conversation-processor.ts` | `test/recovery/`, `sqlite-*` |
| Change installation or process lifecycle | `cli.ts`, `daemon.ts`, `src/cli.ts`, `src/runtime/native-daemon.ts`, `worker.ts` | `test/unit/cli.test.ts`, `test/unit/daemon-protocol.test.ts`, `test/recovery/cli-daemon.test.ts` |
| Change HTTP callbacks or runtime shutdown | `src/app.ts`, `src/runtime.ts`, `worker.ts` | `test/integration/callback.test.ts`, `runtime-*` |

To add a messaging adapter, first implement its listener, identity model, and provider reply window. Then reuse the common Inbox, agent runtime, and MCP receipt contract. Do not leak its payloads or error codes into another adapter, and do not build a generalized framework for hypothetical integrations.

There is one default verification command:

```bash
pnpm test
```

Test names describe behavior; code and assertions are the precise specification. This document covers only the system boundaries and provider facts needed before reading the code.
