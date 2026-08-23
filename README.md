# WeChat Customer Service to Codex

Hono service that receives encrypted WeChat Customer Service callbacks, pulls
messages with `kf/sync_msg`, sends each allowlisted customer to an isolated
Codex thread, and replies with `kf/send_msg`.

## Runtime flow

1. Verify and decrypt the callback, then immediately return `success`.
2. Pull messages asynchronously with the callback token and persisted cursor.
3. Process delivery/session events and ignore customers outside
   the static or persisted authorization list.
4. Resume or create one Codex thread per `open_kfid` and `external_userid`.
5. Start one active Codex turn, or inject a rapid follow-up into that turn with
   the Codex app-server `turn/steer` protocol instead of queueing another turn.
6. Load the WeChat reply SOP Skill and expose only the current conversation's
   bound send tools through a local STDIO MCP server.
7. Codex chooses and calls native send tools; persist tool arguments, WeChat
   message receipts, and progress before advancing the cursor.

The message-sync queue waits only until `turn/start` or `turn/steer` has been
accepted. A steered follow-up is persisted as part of the primary inbound
message and does not produce a second independent reply. When the active turn
finishes, all injected messages are marked absorbed and the customer receives
one final tool-delivered response. Different customer conversations remain
isolated and may run concurrently.

MCP send calls are validated and staged while a turn is active. The app-server
event sequence records the latest steering boundary; tool calls that began
before that boundary are superseded, while every call after it remains in the
final delivery batch. Only after `turn/completed` does the trusted processor
commit that batch to WeChat. This preserves intentional multi-card replies but
prevents a pre-steering draft and its replacement from both reaching a customer.

Primary and steered inbound messages are stored before the sync cursor advances.
After a process restart, unfinished groups are replayed as one start plus the
same ordered steering inputs. Stable send IDs and the SQLite tool journal prevent
an already accepted WeChat send from being emitted twice during recovery.

State is written atomically to `data/wecom-state.json` with mode `0600`.

## Message domain

Raw WeChat payloads are safely classified before processing. Customer text and
images are native Codex inputs. Known non-native formats are converted to
explicit context summaries: voice, video, file, location, link, business card,
mini program, Channels product/order/content, merged chat history, menu, and
note. Unknown formats are ignored; system events remain active for session state
and delivery receipts.

Customer images are downloaded into memory, staged only in `/dev/shm`, attached
to the Codex turn, and removed in a `finally` block. Voice/video/file contents
are not downloaded or interpreted. Structured API fields are preserved as text.
`merged_msg.item.msg_content` JSON is recursively summarized using the same
message-type rules, including explicit unresolved-media markers.

Codex can freely choose these native WeChat Customer Service send tools:

- text, with WeChat-safe UTF-8 chunking;
- image resend from a verified customer-owned `media:N` reference;
- generated or edited images returned by Codex's built-in image-generation
  capability;
- geographic locations with validated coordinates;
- native link cards with an uploaded thumbnail;
- native mini-program cards when an exact `appid` and `pagepath` can be
  verified from a trustworthy public source;

The SOP is maintained as
`codex-workspace/.agents/skills/wechat-kf-reply-sop/SKILL.md` so it is discovered
from the Codex CLI app-server's isolated working directory. It guides format selection and
fallbacks. The MCP server owns side effects and exposes `send_text`,
`send_image`, `send_link`, `send_miniprogram`, and `send_location`. Tool
parameters never contain
`external_userid` or `open_kfid`;
those values are bound by the application for one customer turn. Each tool
process enforces the official five-message limit.

For location intent, the native preference order is `location`, mini program,
link, then text. A mini program is treated as a structured WeChat-internal deep
link, never inferred from a brand name or ordinary URL. Native send failures
fall back to one safe text message.

Location replies also have a deterministic map resolver. Coordinates embedded
in trusted map links are promoted to native `location` replies. For exact Apple
Maps place pages, only the public `place:location:*` metadata is fetched, with a
strict host allowlist, timeout, no redirects, and a one-MiB response cap. Generic
search links are never treated as coordinates.

The media gateway downloads a referenced customer image into memory,
re-uploads it as official temporary media, and then sends the new `media_id`.
References expire after three days and are isolated by conversation. Codex
never sees raw `media_id` values or local paths. Public URL fields from link
messages may be included in their context summary.

During an active steered turn, the bound MCP server reloads its media catalog
from a mode-`0600` temporary file. A newly arrived customer image therefore
replaces the visible `media:N` mapping before any resend tool call; the temporary
catalog is deleted when the turn completes.

Successful app-server `imageGeneration` items take precedence over any later
text fallback that incorrectly claims no image was returned. The host selects
the last valid post-steering result, decodes it in memory, enforces WeChat's
two-MiB image limit, uploads it as temporary media, and sends it with the same
stable-ID/SQLite idempotency guarantees as other replies. Codex-generated image
files are removed after their in-memory result is captured. `send_image`
remains restricted to unchanged customer-owned `media:N` references.

The state store also exposes the latest successfully delivered generated image
as channel context for the next Codex turn. Iterative edits are treated as
deltas against that latest result: only explicitly requested attributes should
change, while unspecified visual properties remain stable. Customer quality
feedback cannot be converted into a false delivery or generation failure; the
host rejects such a tool dispatch and requests a corrected response.

Images are understood because they are passed directly as native Codex image
inputs. All other summarized formats are context only; the SOP prohibits claims
that hidden media or unavailable note bodies were understood.

An API success is stored as `accepted`, not `delivered`. Later
`msg_send_fail` events are matched to the WeChat `msgid` and update the delivery
record.

MCP sends are crash-safe against duplicate delivery. Each inbound customer
`msgid` and send index reserves a row in `data/wecom-tool-journal.sqlite` before
the external API call and uses a stable client `msgid`. A restarted process
returns the existing `accepted` receipt, or `uncertain` for an interrupted call,
without sending again.

## Configuration

Copy the documented variables from `.env.example` into `.env`. The existing
callback Token and EncodingAESKey are not the same as `WECOM_KF_SECRET`.

Leave `WECOM_ALLOWED_USER_IDS` empty for discovery mode. Incoming customer IDs
remain silent and cannot invoke Codex. Add only trusted IDs and restart the
service. `*` is intentionally rejected when the service runs as root.

Optional self-authorization is enabled only when `WECOM_AUTH_TRIGGER` is set.
An unauthorized customer must send that exact text for
`WECOM_AUTH_TRIGGER_COUNT` consecutive customer messages. Any other customer
message resets the count. Attempts are persisted by inbound `msgid`, so webhook
retries cannot advance the count. On the final match, the application stores the
authorization and directly sends `WECOM_AUTH_CONFIRMATION` without starting or
resuming Codex. Earlier attempts and all other unauthorized messages receive no
reply. The next customer message enters the customer's normal Codex thread.

The default Codex controls are:

- read-only sandbox;
- no local shell or local-image tools;
- no command network access;
- live hosted web search can remain enabled independently;
- no interactive approvals;
- a dedicated `codex-workspace` working directory.

## Verify and run

```bash
npm test
node index.js
```

The opt-in integration test uses the real Codex CLI app-server and STDIO MCP server but a
mock `sync_msg` customer and mock WeChat send endpoint:

```bash
RUN_CODEX_MCP_INTEGRATION=1 node --test test/codex-mcp-integration.test.js
```

The opt-in live delivery test mocks only the upstream `sync_msg` customer
payload. It uses the latest two recent customer images, then performs real
WeChat media downloads, real Codex steering/image generation, real WeChat media
upload, and real `kf/send_msg` delivery to that authorized conversation. It
normally consumes one WeChat send from the five-message turn budget:

```bash
RUN_LIVE_WECOM_IMAGE_INTEGRATION=1 \
  node --test test/live-wecom-generated-image.test.js
```

Never enable this flag in routine CI because it performs a real external send.

The HTTP service listens on port `8888` unless `PORT` is set.
