# Project simplification and reliability

Status: implementation started. Updated: 2026-09-06.
Tracking issue: [#102](https://github.com/Gkxie/kintio/issues/102).
Baseline: `master` after #99 (`fb0fc6c`). #101 was subsequently reviewed,
passed all required checks, and merged as `39c77d7`; it remains a separate
runtime-boundary change, not the container for this entire plan.

## Outcome

Make each operation have one owner and one readable execution path. Remove
competing recovery rules and historical forwarding layers, not essential
identity, transaction, delivery, or process guarantees. The maintainer accepted
the whole-project review and this staged remediation scope on 2026-09-06.

This is an execution ledger, not a replacement architecture manual. Tests become
the executable specifications; this file retains scope, order, decisions, and
links to the evidence so work can resume without repeating the review.

## Keep these boundaries

- One shared worker, SQLite database, and ten-conversation scheduler. WeCom is
  a singleton listener; iLink accounts have independently controlled listeners.
- Identity and capabilities stay bound to channel, account, and participant.
  Local iLink enrollment never upgrades a WeCom identity.
- Only allowlisted/passphrase-authorized WeCom users and enrolled iLink users
  can reach an Agent. Keep atomic reply windows, quotas, and delivery receipts.
- Use the installed host Agent and its model/provider configuration. Kintio
  supplies instructions and scoped stdio MCP; it does not become a model host.
- Archived/deleted threads are not resumed or unarchived. Existing bounded,
  read-only archived-memory access remains unchanged by this plan.
- Keep the existing supervisor and SQLite JS interfaces. No second database,
  general event bus, DI container, channel superclass, or replacement supervisor.
- No destructive data reset, credential changes, live messaging, paid model
  runs, or publication are included in this cleanup. The maintainer delegated
  scoped remediation PR review/merge on 2026-09-06; merge only after reviewing
  the final diff and passing required checks, never by bypassing protections.

## Work packages and acceptance

| ID | Priority | Change and owner | Acceptance |
| --- | --- | --- | --- |
| A1 | P1 | Agent adapter reports fatal transport/process failures; the worker exits unsuccessfully and its existing supervisor owns recovery. | Unexpected spawn errors, process exit, or invalid protocol output cause one fatal signal. The worker stops ingress and releases resources; it does not keep retrying a permanently closed adapter. The next supervised worker can consume persisted work. Intentional close/abort never requests a restart. Preserve bounded supervisor backoff. |
| A2 | P1 | Conversation processor uses one admission/scheduling path for live input and recovery. | A live follow-up to an active recovered turn steers that turn instead of waiting for a second start. A waiting recovered conversation is promoted on live input. Respect capacity, global-idle backlog admission, queue notices, authorization, window validity, and no duplicate accepted/uncertain delivery. |
| A3 | P2 | Agent adapter removes keyword-based image intent and forced image-generation retries. | Negated instructions such as “do not edit this photo” cannot cause a host-injected generation instruction. Keep valid artifact staging/delivery, bounded generic delivery-contract correction, and receipt-based no-action decisions. Remove old brand markers with the obsolete intent branches. |
| A4 | P2 | Agent protocol handles approval requests through the originating trusted conversation. | Preserve host approval policy. Support explicit command/file approval decisions, bind replies to the live request and participant, reject cross-conversation/stale/replayed decisions, and clear requests on timeout, interruption, disconnect, or stop. No implicit permission grants; unsupported request types fail explicitly. Restricted conversations cannot gain host access. |
| C1 | P2 | CLI holds lifecycle locks only during ownership/state transitions, not human QR waiting. | Two TTYs can obtain separate QRs without rejecting the second at the global lock. Different scanning users enroll independently; repeated enrollment of one owner follows the existing account/generation rules. One writer owns state, QR expiry stays five minutes, cancellation cleans only its own offer, and another channel can start/stop while a scan is pending. |
| R1 | P2 | Release Codex validation follows the same immutable candidate and metadata lifecycle as Release plan. | Simulate branch synchronization with an old title, followed by title correction for the same SHA. Validation becomes eligible again without another commit. Draft, fork, wrong author/branch, and stale candidates remain ineligible; paid execution still needs explicit Environment approval. |
| R2 | P2 | Existing release scripts own reusable version/Changelog/file-scope rules. | Preparation, PR checks, and publication agree on valid/invalid candidates. Test policy with executable fixtures, including event order and tampering, not just source-string matches. Keep independent permission and provenance checks at each privileged boundary. |
| C2 | P3 | CLI keeps parsing, prompts, and dispatch; existing runtime/update modules own lifecycle coordination. | Public help and commands retain behavior. Remove single-value `DaemonMode` plumbing and identity wrappers, preserving actual instance identity, update locks, rollback, and cross-platform process checks. No file split justified only by line count. |
| D1 | P3 | Maintenance documentation describes the workflows actually present. | Remove the retired ordinary-PR Real Codex workflow instructions and obsolete command/marker references. Keep one source for each operational fact; do not replicate test cases into multiple documents. |

## Implementation order

1. **Agent failure lifecycle (A1):** first independent PR from current `master`,
   including this plan. Add a fatal-completion boundary, propagate it to the
   worker, and exercise normal versus failed shutdown with fake child processes.
2. **Conversation scheduling (A2):** build on the now-merged #101. Integrate its
   admission checks rather than maintaining
   competing versions. No additional scheduler outside the processor.
3. **Agent intent and approvals (A3, A4):** remove image-intent guesses in a small
   PR; keep approval interaction as a separately reviewable change because it
   introduces a user-visible control exchange. Use explicit request correlation,
   not conversational keyword guessing. Verify supported requests against the
   official Codex App Server protocol before implementation.
   The first approval bridge supports explicit, one-use command/file decisions
   in trusted iLink conversations. Other approval/elicitation methods remain
   explicitly unsupported. Protocol fixtures use schemas generated offline from
   Codex CLI 0.153.4; synthetic App Server tests verify correlation, cancellation,
   and the refresh-then-steer-ACK ordering. This does **not** establish that a
   real installed Codex can steer while waiting for approval: that upstream
   interoperability still needs a separately authorized real-model run. No live
   model or channel-provider test is included in the synthetic evidence.
4. **CLI ownership and simplification (C1, C2):** reuse the shared local operator
   owner for concurrent logins. First fix the ownership/lock lifetime; then move
   cohesive update/lifecycle code out of command parsing and delete dead modes.
5. **Release and documentation (R1, R2, D1):** R1 can ship independently of runtime
   work. Consolidate business rules without collapsing separate trust domains.
   Update stale documentation alongside the corresponding workflow changes.

Each PR remains focused. Independent batches need not wait for unrelated
changes; dependency-sensitive batches must not overwrite #101. Reference #102
from intermediate PRs; close it only when all acceptance rows are complete.

## Verification

For each acceptance row:

1. Add a focused synthetic regression and observe its failure before the fix.
2. Implement the smallest production change that satisfies the behavior.
3. Run focused tests while iterating, then `pnpm test` on an unchanged snapshot.
4. Run TypeScript checking, unused-code analysis, and the package build for each
   code PR. Hosted Linux/macOS/Windows CI is the cross-platform gate; never use
   the maintainer machine as a public PR runner.
5. Review resource ownership, cancellation, identity scope, and failure paths in
   the final diff. Inspect hosted check results before reporting a batch ready.

Default tests use temporary data, fake providers, and fake Agent processes.
They do not modify the active service or its data. Real Codex/channel runs need
separate approval; delete test threads when such a run is authorized.

## Progress ledger

| Work | State | Evidence / next action |
| --- | --- | --- |
| Plan and scope | Recorded | Tracking issue #102; this document. |
| A1 | PR checks | [#105](https://github.com/Gkxie/kintio/pull/105); fatal transport, early notifications, startup/running failure, normal shutdown tested. Full suite: 674 tests / 92 files passed; independent review completed. |
| A2 | In progress | #101 merged; active and waiting recovery promotion tests in an isolated branch. |
| A3 | Merged | [#103](https://github.com/Gkxie/kintio/pull/103); 667 tests passed locally; independent review and all hosted checks passed. |
| A4 | In review | One-use command/file approval bridge implemented; scoped protocol, SQLite, iLink quota, and runtime-stop regressions. Real pending-approval/steering interoperability remains unverified; see the boundary above. |
| C1 | In progress | Shared operator ownership and per-connection terminal offers; foreground and cancellation regressions. |
| C2 | Pending | Remove dead modes and relocate cohesive update/lifecycle logic after C1. |
| R1 / D1 | Merged | [#104](https://github.com/Gkxie/kintio/pull/104); 672 tests passed locally; independent authorization review and all hosted checks passed. |
| R2 | In progress | Pure manifest, file-scope, and Changelog rules; privileged boundary checks remain separate. |

When a batch finishes, update its state and link its PR/tests here. A green test
suite or merged unrelated PR must not mark unfinished acceptance rows complete.
