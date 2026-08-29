# Maintaining Kintio

This document connects issues, pull requests, releases, and security response
for people with repository write access. Other contributors can start with
[CONTRIBUTING.md](CONTRIBUTING.md).

## Roles

- **Contributor:** submits issues, discussions, documentation, tests, or code.
- **Reviewer:** contributes consistently and understands an area well enough to
  review its pull requests, but has no release permission.
- **Maintainer:** is responsible for merges, releases, security response, and
  repository settings.

The current maintainer is `@Gkxie`, who is also the default CODEOWNER. An
existing maintainer may invite a contributor to become a Reviewer or Maintainer
after that person has made reliable contributions in an area, participated in
reviews, and agreed to accept ongoing responsibility. Split CODEOWNERS by real
responsibility when more maintainers join; do not repeat the same name merely
to make the file look distributed.

Kintio currently lives in a personal repository, where adding a collaborator
also grants broad code and release authority. Keep Reviewers outside the
collaborator list. Before adding a second Maintainer, prefer moving the project
to an organization with separate triage, maintain, and write roles; then require
one independent approval for protected changes. Restrict `cla-signatures`
updates to the CLA GitHub App or workflow before granting anyone else write
access; its current tamper-evident model trusts every write collaborator. Also
restrict creation of `v*` tags to a Release Maintainer role or dedicated App;
the current tag rules prevent mutation and deletion but not creation by a write
collaborator.

Protect the owner account with a passkey and two-factor authentication. CLI and
automation credentials should be short-lived, fine-grained, restricted to this
repository, and granted only the permissions required for the current task.
Never store a broad GitHub owner token on the production Kintio host. Prefer the
per-run `GITHUB_TOKEN` inside Actions, and audit active sessions and tokens after
any suspected account compromise.

Architecture, protocol, and incompatible changes must first reach a verifiable
proposal in a public issue or discussion. Prefer evidence and tests when
building consensus. If consensus is not possible, the responsible Maintainer
documents the trade-off and decides. Security incidents remain private until a
fix is ready.

## Issue triage

Check three things when a new issue arrives:

1. Does it contain credentials, real user IDs, conversations, or media? If so,
   hide the content immediately and ask the reporter to rotate the credentials.
2. Can it be reproduced on the current `master` with synthetic data?
3. Is it a Bug, Feature, or Discussion, and does an existing report already
   cover it?

If a plausible bug lacks enough evidence to reproduce, replace
`status: needs triage` with `status: needs reproduction`, state exactly what is
missing, and keep the report open. Once a synthetic reproduction, failing test,
or sufficient redacted diagnostics are available, replace it with
`status: needs triage`, or with `status: accepted` when the evidence already
makes the direction clear. Do not use the label as an automatic inactivity
timer.

When closing an issue as `duplicate`, `invalid`, or `wontfix`, explain why and
state the next useful step. Use `good first issue` only for real work with a
clear boundary and a verifiable acceptance condition. Do not manufacture tasks
to make the project look active. Security reports always follow the
[private reporting process](SECURITY.md).

Bugs and Features start with `status: needs triage`. Once the direction is
accepted, remove it and add `status: accepted`. When code is merged but has not
reached a user release, use `status: pending release`. Add the released version
and close the issue only after that release is available. Features entering
implementation must align with [ROADMAP.md](ROADMAP.md) and have a real
Milestone.

## Merging pull requests

- Keep fork workflow approval set to **all external contributors**, including
  contributors whose earlier work was merged. Inspect the diff before approving
  any workflow run. Verify the issue-confirmation link and the completed
  disclosure and accountability fields first.
- Keep the concurrent open pull request cap at one non-draft PR for users
  without write access, and manually close excess draft PRs from the same user.
  The cap is queue hygiene, not a security boundary. Add only known,
  accountable contributors to the bypass list.
- External feature, behavior, protocol, data, and architecture changes require
  an issue claim and explicit maintainer scope confirmation before
  implementation. `help wanted` and `good first issue` work also requires
  confirmation. Maintainer-authored work, small obvious documentation or test
  fixes, and work explicitly requested in an existing review are exempt.
- Enforce the policy through observable accountability, not AI detection: a
  complete disclosure, a repository-specific technical explanation, and
  substantive review responses. If accountability is unclear, ask one concrete
  technical question. Writing style, turnaround time, or high-volume account
  activity are not proof by themselves. Close confirmed unattended, materially
  undisclosed, or bulk-generated submissions; block an account only for repeated
  or clearly abusive behavior.
- The pull request opener and every GitHub-linked commit author must have a
  successful `CLA` status for the current agreement hash. Unlinked authors fail
  closed. Never bypass that status or edit the signature ledger by hand.
- Every PR must explain the problem, observable result, verification, and
  compatibility impact. Use `Refs` for issues that remain open until release.
- `Quality`, `Unit, integration, recovery, security`, and `gitleaks` must pass.
- A CODEOWNER reviews external contributions. A sole maintainer cannot approve
  their own PR, but their changes must still pass the same automated checks.
- Use squash merge and delete the source branch after merging. The PR title must
  stand on its own as the final commit message.
- Do not auto-merge dependency updates. Review runtime versions, type packages,
  and platform constraints together.

The public `master` branch rejects direct pushes, force pushes, and deletion.
Emergency security fixes should also use a PR. If a platform outage forces a
maintainer to bypass the rule, record both the incident and the direct commit
immediately. Restore missing regression tests, documentation, or cleanup in a
follow-up PR; when appropriate, revert first and resubmit through the normal
process.

After a second active maintainer joins, require at least one approval so that a
maintainer's PR is reviewed by another maintainer. Require Code Owner approval
only after path ownership is stable.

## Abuse response

Judge observable behavior and impact, not writing style, speed, or tool choice.
Contain harm before investigating: do not approve a suspicious fork workflow;
minimize ordinary spam; and close or lock destructive discussions. For exposed
credentials or private data, revoke or rotate first, then delete the public
content and ask GitHub Support to address retained edit history or caches when
needed. Keep only the minimum evidence needed for review in a private,
access-limited record: account, URLs, timestamps, a redacted summary or
screenshot, a content hash when useful, and the moderation actions. Never retain
live credentials or executable payloads, and do not copy unsafe content into
another public thread.

For a low-impact first incident, state the boundary once when practical.
Repeated disruption, control evasion, impersonation, phishing, malicious
payloads, credible threats, or doxxing may be blocked and reported immediately.
Do not debate an attacker in public. Restore content or access after a clear
mistake; once a second Maintainer exists, an uninvolved Maintainer reviews an
appeal.

Keep temporary interaction limits off during normal operation. During a
coordinated attack, start with `contributors_only` for 24 hours, escalate to
`collaborators_only` for 24 hours only when necessary, and let the limit expire
or remove it as soon as the attack stops. Keep the one-open-PR cap and external
workflow approval enabled throughout.

After suspected repository or maintainer-account compromise, revoke suspicious
sessions and tokens, rotate credentials, stop releases, and audit collaborators,
webhooks, deploy keys, Actions secrets, rulesets, tags, releases, and workflow
history. Resume releases only after the known-good state is verified.

## CLA changes

`CLA.md` names XIE YU as the Project Owner. The repository-native workflow
stores public signature records on the tamper-evident `cla-signatures` branch
after authenticating the GitHub signing event. Any byte-level change to
`CLA.md` changes its SHA-256 hash and requires a new signature for future
contributions. Protect the ledger from deletion and non-fast-forward writes.
Manual ledger edits are forbidden. Never rewrite or delete historical ledger
commits. Review legal changes separately from implementation changes.

Correct an inaccurate current record only by asking the contributor to post a
new commit-and-hash-bound signature comment. The workflow may then append a
correcting ledger commit; a maintainer must never edit the JSON by hand.

To activate CLA enforcement without locking out every pull request:

1. Merge the CLA document, workflow, script, and tests before requiring its
   status.
2. Create `cla-signatures` from an empty root commit.
3. Protect that branch from deletion and non-fast-forward writes.
4. Open a temporary pull request, confirm that the manual commit status context
   is exactly `CLA`, sign the generated commit-and-hash-bound comment, and verify
   the status changes from pending to success.
5. Add that `CLA` status—not the `CLA evaluation` workflow job—to the strict
   required checks on `master`, and bind its expected source to GitHub Actions
   rather than trusting another integration that publishes the same context.
6. Repeat the unsigned/signed smoke test from a fork, then close the temporary
   pull request and retain its public signature evidence.

After a repository rename or transfer, update the repository identity in the
CLA, workflow, script validation, ledger ruleset, and smoke test before
accepting more contributions.

## Version policy

Kintio uses SemVer and `vX.Y.Z` Git tags. During `0.x`:

- **Patch:** compatible fixes and documentation updates.
- **Minor:** new capabilities. If a public MCP interface, environment variable,
  or data format must change, do so only in a Minor release and provide a
  migration path.
- **`1.0.0`:** reserved for stable public interfaces and an established upgrade
  policy.

Kintio is a self-hosted application. `private: true` prevents accidental npm
publication; the release artifacts are a GitHub Release and its corresponding
source, not an npm package. Source-only releases carry no uploaded assets. The
release workflow refuses any pre-existing Release for the tag instead of
publishing or trusting content that it did not create.

## Publish a release

1. Create a PR from the latest `master`.
2. Update the version in `package.json`; `src/version.ts` must match it.
3. Move the relevant entries under `## Unreleased` in `CHANGELOG.md` into
   `## X.Y.Z - YYYY-MM-DD`. Include only user-observable changes, and reference
   public issues or PRs where useful.
4. Run `pnpm test`. After merging, wait for CI and Gitleaks to pass on the release
   commit.
5. Create and push an annotated tag from the latest `master`:

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

   Once pushed, a release tag must never be deleted, moved, or reused, even if
   the release workflow fails.

6. The release workflow's read-only job rechecks version monotonicity, the
   Changelog, source commit, tests, build, and dependencies. A separate job with
   minimal write permission then publishes the GitHub Release. Pushing the tag
   is the final release action, so Release Notes must already have been reviewed
   in the version PR.
7. Confirm that [SECURITY.md](SECURITY.md) lists the supported release line.
   Close linked issues only after the release is downloadable.

Rerun the original workflow after a transient infrastructure failure only when
no GitHub Release was created. A pre-existing Release always fails closed; if a
Release exists, verify it instead of rerunning the workflow. If code must change,
keep the failed tag, increment to a new Patch version, and carry forward every
Changelog entry that has never been published. Never rewrite a public Release;
publish a new Patch release instead.

## Public repository checks

After any visibility change, and before accepting external contributions,
verify that:

- `master` can be changed only through pull requests and cannot be force-pushed
  or deleted;
- required checks are `PR title`, `Quality`,
  `Unit, integration, recovery, security`, `gitleaks`, `CLA`,
  `JavaScript and TypeScript` (CodeQL), and `review` (Dependency Review);
- required checks use strict branch freshness so a CLA change forces open pull
  requests to synchronize and re-evaluate the current agreement hash;
- fork workflows require approval for all external contributors, and users
  without write access can have at most one open non-draft PR;
- the Actions allowlist permits only GitHub-owned actions and
  `pnpm/action-setup`; actions use full commit SHAs, the Gitleaks container uses
  an OCI digest, default tokens are read-only, and Actions cannot approve pull
  requests;
- `master` rejects deletion and non-fast-forward updates, and `v*` tags reject
  updates and deletion;
- `cla-signatures` rejects deletion and non-fast-forward writes, and records
  preserve the authenticated signing event and immutable CLA hash;
- Private Vulnerability Reporting, CodeQL, Secret Scanning, and Push Protection
  are enabled; enable validity checks and non-provider patterns when the account
  plan supports them, with digest-pinned Gitleaks covering the current gap;
- Dependency Review has been exercised by a real PR; and
- squash merge is the only merge strategy and merged branches are deleted
  automatically.

GitHub Free cannot continuously enforce every one of these rules on a private
repository. A check that passed before a visibility change is not evidence that
the rule remains active afterward; verify the settings again each time.
