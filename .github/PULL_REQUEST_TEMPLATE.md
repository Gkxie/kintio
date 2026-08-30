## Why

Describe the original user problem. Use fake IDs and synthetic messages.

## Related issue

Link the issue when this work was discussed, claimed, coordinated, or tracked there. Use `Refs #123` when the issue remains open until release, and `Fixes #123` only when the change takes effect at merge. Work explicitly requested in an existing review may link that review. A self-contained direct PR may write `None`, but its `Why` section must then preserve the complete problem and decision context. Do not create an issue only to satisfy this field. Work claimed from `help wanted` or `good first issue` still requires the maintainer scope confirmation recorded on that issue.

## Human accountability

Material generative AI or agent use (required; write `None`, or name each tool and what it produced or substantially changed):

- [ ] I disclosed material AI or agent use, reviewed the complete diff, can explain and revise it, ran the reported verification, accept responsibility for follow-up, and confirm this is not an unattended or bulk-generated submission.

## What changed

Describe the smallest meaningful change and the result users can now observe.

## Verification

- [ ] `pnpm test` passes.
- [ ] New behavior has corresponding tests, or the reason tests are unnecessary is explained below.

List manual verification steps or targeted test commands:

## Changelog impact

Choose one:

- [ ] Added or updated the user-visible entry under `CHANGELOG.md` → `Unreleased`.
- [ ] No user-visible change. Explain why:

## Impact

Describe compatibility and risk when the change affects configuration, MCP interfaces, database migrations, concurrency, recovery, quotas, or security boundaries. Otherwise, write `None`.

## Privacy

- [ ] This PR contains no real credentials, user IDs, conversations, media, SQLite data, local filesystem paths, or Codex test threads.
