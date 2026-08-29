# Changelog

This file records important user-visible changes after the first public release.

## Unreleased

- Removed the unused `/healthz` endpoint; process state and the Hono startup log
  remain the supported local liveness signals.

## 0.4.0 - 2026-08-29

- Authorized channel users can assign work to a Codex Agent and receive results
  in the originating conversation.
- Added WeChat Customer Service API and independent Weixin iLink Bot
  conversations.
- Added text and image input, with text, image, link, mini-program, and location
  delivery according to each adapter's capabilities.
- New user instructions steer the active Agent turn instead of receiving stale
  answers in sequence.
- SQLite recovery resumes missed and unfinished messages after restart while
  prioritizing live inbound traffic.
- Channel identities, Threads, media, and reply windows are isolated, and
  provider secrets are not exposed to the Agent.
- Adopted the channel-neutral Kintio identity, English canonical documentation,
  and one concise Simplified Chinese entry page.
- Added Hono lifecycle management, PM2 deployment guidance, SQLite durability,
  and compatibility paths for existing deployments.
- Added deterministic unit, integration, recovery, and security tests with
  coverage, TypeScript, dependency, secret, and CodeQL checks.
- Added repository-native CLA enforcement, contributor accountability,
  release provenance checks, and an abuse-response runbook.
