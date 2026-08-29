# Architecture

## Goals and boundaries

Kintio connects supported public messaging adapters to an agent runtime. It receives messages, isolates provider identities, persists state, schedules the agent, and safely executes outbound actions in the originating conversation.

The current agent runtime is Codex CLI. The code exposes a replaceable agent interface but deliberately avoids additional abstraction until a second implementation exists. The currently supported messaging adapters are WeChat KF API and iLink Bot.

A Kintio deployment shares one Codex login. Each provider identity has an independent Codex thread. Kintio does not implement a multi-tenant model with separate agent credentials or working directories for individual messaging users.

## Message flow

```text
WeChat KF HTTPS callback ─→ normalize inbound message ─┐
                                                      ├→ SQLite Inbox → conversation scheduler → Agent
iLink Bot long polling ───────────────────────────────┘                                      │
                                                                                             ↓
Messaging user ←──────── provider API ← MCP action tool ← scoped conversation capability
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

- WeChat KF callback and signature verification: [src/routes/wecom.ts](../src/routes/wecom.ts)
- WeChat KF message synchronization: [src/services/wecom-sync.ts](../src/services/wecom-sync.ts)
- WeChat KF message domain: [src/domain/wecom-message.ts](../src/domain/wecom-message.ts)
- iLink long polling: [src/ilink/listener.ts](../src/ilink/listener.ts)
- iLink protocol client: [src/ilink/protocol/client.ts](../src/ilink/protocol/client.ts)
- iLink message conversion: [src/ilink/message.ts](../src/ilink/message.ts)

Each adapter has distinct identity keys, authorization rules, and reply windows. Identities must not be merged based on an assumption that they represent the same person in the real world.

### 2. Conversation scheduling and state

[src/services/conversation-processor.ts](../src/services/conversation-processor.ts) manages concurrency windows, live-versus-backfill priority, and steering within a conversation. [src/state/sqlite-store.ts](../src/state/sqlite-store.ts) owns the Inbox, authorization, short-lived capabilities, thread bindings, and send records.

In-process queues only drive work forward; SQLite owns recoverable state. Database transactions are never held open during network requests.

### 3. Agent adapter

[src/agent/runtime.ts](../src/agent/runtime.ts) defines the minimal agent lifecycle Kintio needs: start, steer, resume, and stop. [src/services/codex-agent.ts](../src/services/codex-agent.ts) is the current Codex CLI implementation, while [src/services/codex-app-server.ts](../src/services/codex-app-server.ts) implements the app-server protocol.

The agent adapter receives channel-neutral text, images, and summaries. It never receives provider secrets, real user IDs, raw `media_id` values, or database paths. Provider payloads, error codes, and delivery policies cannot enter channel-neutral adapter input. MCP tools may return sanitized execution facts to the agent.

### 4. MCP action tools

MCP is the agent's only path for actions against messaging providers:

- WeChat KF: [src/mcp/wechat-kf-server.ts](../src/mcp/wechat-kf-server.ts)
- iLink: [src/mcp/ilink-server.ts](../src/mcp/ilink-server.ts)
- read-only memory for archived threads: [src/mcp/conversation-memory-server.ts](../src/mcp/conversation-memory-server.ts)
- Streamable HTTP transport: [src/mcp/http.ts](../src/mcp/http.ts)

The Hono process hosts these MCP servers. Codex receives only the MCP URL, bearer token, and current conversation session. Each tool revalidates the adapter, recipient, message direction, media ownership, expiration, and quota. The model cannot select a recipient through tool arguments.

Tools return execution facts only: accepted, failed, or uncertain. Provider-specific errors are explained by tool results when they occur. They do not belong in the global prompt, and retry decisions are not hard-coded into channel-neutral agent behavior.

## Identity, context, and media

- A WeChat KF conversation key is `open_kfid + external_userid`.
- An iLink conversation key is `bot_id + user_id`.
- Later messages within the same adapter can steer the running agent turn; different adapters never share a Codex thread.
- WeChat KF authorization applies to an `external_userid` within an enterprise, while thread isolation still uses the account-and-user pair.
- Only text and images become native model input. Other message types retain important provider fields and become explicit summaries.
- User images are available only through `media:N` references in the current session; generated images use short-lived `artifact:N` references.
- Kintio does not download or transcribe audio, video, or files merely to claim support for them.

## Crash recovery

Every send is persisted before invoking the provider API. If the process exits after a send begins but before its result is known, the record becomes `uncertain` and is not retried automatically.

At startup, the WeChat KF adapter backfills messages from its saved cursor, while iLink resumes long polling for every bound bot. Live traffic receives agent concurrency first; backfill begins only when no active conversation is waiting. An archived Codex thread starts a new thread and exposes a read-only memory tool bound only to the archived thread ID. A deleted thread simply starts over.

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
| Change HTTP callbacks or lifecycle | `src/app.ts`, `src/runtime.ts` | `test/integration/callback.test.ts`, `runtime-*` |

To add a messaging adapter, first implement its listener, identity model, and provider reply window. Then reuse the common Inbox, agent runtime, and MCP receipt contract. Do not leak its payloads or error codes into another adapter, and do not build a generalized framework for hypothetical integrations.

There is one default verification command:

```bash
pnpm test
```

Test names describe behavior; code and assertions are the precise specification. This document covers only the system boundaries and provider facts needed before reading the code.
