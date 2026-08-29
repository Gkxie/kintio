# Roadmap

## Long-term goal

Kintio lets people continue conversations with Agents they are authorized to
use through messaging channels. Channel adapters handle provider identity and
message transport; Kintio provides adapter boundaries, conversation
isolation, Agent orchestration, and durable delivery.

The current release provides WeChat Customer Service API and Weixin iLink Bot
adapters. One deployment currently shares one Codex login while each channel
identity receives an independent Thread. Kintio does not yet let each person
bind independent Agent credentials and a dedicated working directory. That is
part of the goal and must not be implied by documentation before it exists.

## The 0.x phase

Work proceeds in this priority order:

1. **Deployability:** startup, upgrades, health checks, logs, and failure
   recovery have explicit outcomes.
2. **Extensible channels:** a new messaging adapter does not duplicate Agent
   orchestration or the reliability state machine.
3. **Replaceable Agents:** Codex CLI is the first Runtime, while the interface
   allows later Agent implementations.
4. **Per-user Agent binding:** define how a channel identity maps to an Agent
   instance, credentials, working directory, and quota boundary.
5. **Stable external contracts:** version MCP, environment variables, database
   migrations, and HTTP endpoints in preparation for `1.0.0`.

This file does not duplicate individual work items. Work entering implementation
must have a GitHub issue, observable acceptance conditions, and a target
Milestone. After merge, mark it `status: pending release`; close it with the
GitHub Release that delivers it.

## Non-goals

- Do not merge identities or history across channels based on inference.
- Do not add framework layers, package splits, or a monorepo for implementations
  that do not yet exist.
- Do not use fixed prose to imply that an Agent completed an external action.
- Do not make Discord servers, group chats, or other unsearchable conversations
  the project's only source of knowledge.

## How proposals enter the roadmap

1. Use [GitHub Discussions](https://github.com/Gkxie/kintio/discussions/categories/ideas)
   for a direction whose goal or boundary is still unclear.
2. Once behavior and scope are clear, create a Feature issue. A maintainer marks
   it `status: accepted` and assigns a Milestone.
3. Use `Refs #Issue` in the PR and prove the behavior with tests. Close the issue
   only after the corresponding release.

See [docs/architecture.md](docs/architecture.md) for architecture boundaries,
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidance, and
[MAINTAINING.md](MAINTAINING.md) for maintenance and release policy.
