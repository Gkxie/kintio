# Contributing to Kintio

You are welcome to deploy Kintio, report problems, improve tests, or contribute
code. You do not need to understand the entire project first. Start with the
observable problem, then decide whether it requires a code change.

Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in discussions and reviews.

## Choose a workflow

Choose the workflow that preserves the reason for the change with the least
ceremony:

- **Issue-driven workflow:** open or claim an issue when the direction needs
  discussion, the work needs coordination, or the result spans more than one
  pull request. An external contributor claiming an existing issue must wait
  for a maintainer to confirm the proposed scope. Work on a `help wanted` or
  `good first issue` also requires confirmation; a public label is not approval
  to start.
- **Direct pull request workflow:** start with a pull request when the problem,
  boundary, and solution are already clear enough to review as one change. The
  PR itself must preserve the motivation, observable result, verification, and
  compatibility impact. Do not create a retrospective issue only to satisfy a
  form field.

These workflows apply equally to maintainers, contributors with write access,
local Agent-assisted work, and external contributors. A maintainer may redirect
a direct PR to an issue or Discussion when consensus or scope discovery is
still required. Work explicitly requested in an existing review may link that
review instead.
External contributors may keep at most one pull request open, including drafts,
unless a maintainer grants an exception.

## Human accountability

AI-assisted contributions are welcome when a human actively directs and reviews
the work. Disclose any material use of generative AI or an automated agent,
naming each tool and what it produced or substantially changed. The contributor
must review the complete diff, understand and be able to explain the design, run
the reported verification, and remain responsible for review responses and
reasonable follow-up.

Kintio does not accept unattended or undisclosed agent submissions, or
bulk-generated submissions: repeated or automated pull requests made without
separate, repository-specific human review. Approved repository bots are exempt
from this section. Routine autocomplete, formatters, linters, and deterministic
code generators do not require disclosure.

## Sign the CLA

Every contributor identified by the `CLA` check must sign the current
[Contributor License Agreement](CLA.md). To sign, post this exact comment on
the pull request:

```text
I have read the Kintio CLA v1.1 and I hereby sign it
```

CLA Assistant authenticates the comment with GitHub and retains the public
record in the protected `cla-signatures` branch. A material agreement change
uses a new versioned document and signature path, so later contributions
require a new signature. Dependabot and Renovate are exempt. Pull requests with
more than 100 commits or `Co-authored-by` trailers are rejected because the
frozen CLA Action cannot inspect those contributors completely; split that
work into separately authored pull requests instead. Sign before the pull
request reaches 30 comments because the frozen Action reads only the first
comment page. The pull request opener must also be a primary commit author so
their GitHub identity participates in the CLA check.

## Open an issue

- Use the Bug form for a problem that can be reproduced consistently.
- Use the Feature form when the behavior and scope are already clear. Take goals
  or boundaries that are still being explored to
  [Ideas](https://github.com/Gkxie/kintio/discussions/categories/ideas) first.
- Put deployment questions, configuration help, usage experience, and uncertain
  problems in [GitHub Discussions](https://github.com/Gkxie/kintio/discussions/categories/q-a).

Use fake IDs, synthetic messages, and redacted logs in every issue. Never upload
an `.env` file, SQLite database, real conversation, user ID, media file, or
credential. Report security problems privately through [SECURITY.md](SECURITY.md).

## Develop locally

During the native-runtime migration you need Node.js 24 or newer, the pnpm
version pinned in `package.json`, and the Rust toolchain pinned in
`rust-toolchain.toml`. Install Rust through
[rustup](https://www.rust-lang.org/tools/install); Cargo selects the pinned
toolchain automatically.

```bash
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm test
```

`pnpm test` runs both the existing Vitest specifications and the Rust tests.
The default suite uses temporary SQLite databases and fake external
boundaries. It does not require an `.env` file, a Codex login, or live channel
credentials, and it does not send real messages.

## Find the right starting point

- For channel protocols and inbound handling, start in `src/domain/`,
  `src/services/wecom-sync.ts`, or `src/ilink/`.
- For Agent context or steering behavior, start in
  `src/services/codex-agent.ts` or `src/services/conversation-processor.ts`.
- For delivery, persistence, or recovery, start in `src/mcp/`, `src/state/`,
  or `test/recovery/`.

See [Where to make changes](docs/architecture.md#where-to-make-changes) for the
complete source-to-test map.

## Adding a channel or Agent runtime

For a channel adapter, define and test:

- the stable conversation identity and authorization boundary;
- inbound normalization for text, images, and unsupported-message summaries;
- outbound capabilities, reply windows, quotas, and delivery receipts;
- session-scoped MCP actions that cannot select another recipient;
- restart recovery, idempotency, and live-versus-backfill priority.

For an Agent runtime, define and test:

- initial submission, steering, restoration, and shutdown behavior;
- conversation-to-Agent session binding, including missing, archived, or
  deleted sessions;
- redacted, channel-neutral input and scoped tool results;
- resource cleanup, interruption, timeout, and crash recovery.

## Change principles

- Begin with observable behavior. Do not introduce abstractions for reuse that
  does not yet exist.
- Keep channel protocols, Agent orchestration, and MCP delivery tools separate.
  Provider-specific error codes must not leak into the generic Agent interface.
- New behavior requires a test that would fail without the change. Prefer real
  boundaries and state transitions over implementation details or fixed prose.
- Add the relevant integration, recovery, or security coverage when a change
  affects concurrency, crash recovery, quotas, or identity isolation.
- Document platform constraints. Put precise behavior in clear
  `describe`/`it`/`test` names and assertions.
- Do not add production branches that exist only for tests, and do not put live
  external calls in the default test suite.

Documentation should first tell readers what they can accomplish, then explain
the implementation. Remove duplicated conclusions, template-like summaries,
and unsupported claims such as “comprehensive,” “powerful,” “elegant,” or
“robust.” Maintain each fact in one place, and run every documented command.
Use technical terminology only when it helps readers operate the service or
locate the relevant code.

## Submit a pull request

Keep one pull request focused on one clear problem. Explain:

1. what users observed before the change;
2. what they will observe after it;
3. how the result was verified; and
4. whether it changes configuration, MCP interfaces, the database, or external
   behavior.

PR titles use `type(optional-scope): description`. Allowed types are `feat`,
`fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`, and `revert`.
For example:

```text
feat(ilink): support a new inbound message type
fix(recovery): prevent duplicate delivery after restart
docs: document reverse proxy configuration
```

Before submitting, run:

```bash
pnpm test
```

CI checks TypeScript, Rust formatting and Clippy, unused code, both builds,
dependencies, security scanning, and the complete deterministic test suite.
Live Codex or channel-adapter tests
run only when a maintainer supplies a dedicated target and an explicit
allowlist. Delete every test Thread after such a run.

If the work follows the issue-driven workflow, link the issue and its scope
confirmation. A direct PR may write `None` for the related issue only when its
`Why` section contains the complete problem and decision context.

Contributors with repository write access must also follow
[MAINTAINING.md](MAINTAINING.md).
