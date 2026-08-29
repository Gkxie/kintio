## Why

Describe the original user problem. Use fake IDs and synthetic messages.

## Related issue

For feature, behavior, protocol, data, architecture, `help wanted`, or `good first issue` work, external contributors must link the issue and the maintainer comment confirming the scope before work began. Maintainer-authored work and small, obvious documentation or test fixes may write `None`; work explicitly requested in an existing review may link that review. Use `Refs #123` in most cases so maintainers can close the issue after a release. Use `Fixes #123` only for repository workflow or documentation changes that take effect when merged.

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
