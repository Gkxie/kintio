# Security Policy

## Report vulnerabilities privately

Credential exposure, authentication bypass, cross-conversation data access,
message forgery, SSRF, path traversal, and arbitrary tool execution must not be
reported in a public issue.

Use **Security → Advisories → Report a vulnerability** in this repository to
submit a redacted reproduction through GitHub Private Vulnerability Reporting.
If that entry is unavailable, do not disclose vulnerability details publicly.
Email [gkxie@qq.com](mailto:gkxie@qq.com), or open an issue containing no
reproduction, logs, or identity data to request a private contact channel.

Harassment, spam, and impersonation without a technical exploit follow the
private reporting path in [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md#enforcement).
Repository compromise, malicious payloads, and exploitable security defects use
Private Vulnerability Reporting.

Never include real instances of the following in a report:

- CorpID, WeChat Customer Service Secret, callback Token, or EncodingAESKey;
- conversation capability, OpenAI API key, or Codex login information;
- channel user ID, Bot Token, reply context token, or QR-code token; or
- conversation transcript, media file, SQLite database, or local path.

Describe the affected version, observable impact, minimum redacted
reproduction, and any temporary mitigation you have already applied. Do not
disclose the vulnerability publicly before a maintainer confirms it.

Kintio is currently maintained by one person in their spare time and does
not promise a fixed response time. The maintainer will acknowledge a report when
they see it, then coordinate impact, remediation, and disclosure privately. A
reporter will not be asked to repeat vulnerability details in a public issue
before disclosure.

## Supported versions

| Version | Security fixes |
| --- | --- |
| Latest `0.6.x` Patch | Supported |
| `master` | In development; security fixes accepted |
| `0.5.x` | Unsupported |
| `0.4.x` | Unsupported |
| `< 0.4.0` | Unsupported |

Operators should upgrade to the latest Patch in a supported release line. When
a new Minor release is published, this table will state explicitly whether the
previous line remains supported. Kintio does not implicitly promise to
maintain every `0.x` line at the same time.

## Operator responsibilities

- Rotate immediately any credential that appears in an issue, log, recording,
  or chat.
- Never commit `.env`, `data/`, the Codex login state, or reverse-proxy private
  keys.
- Keep the Kintio instance and config below directories that untrusted local
  users cannot replace or modify. Custom Windows paths need an owner-only DACL;
  custom POSIX paths need trusted parents or sticky shared parents.
- Keep the Runtime-owned MCP descriptor and IPC endpoint private. MCP uses stdio
  plus a Unix-domain socket or Windows named pipe, not a publishable TCP listener;
  public Hono `/mcp*` paths intentionally return 404, and conversation capabilities
  must never be logged or copied between sessions.
- Bind archived memory through the current short-lived session; never let the
  model select an arbitrary Thread ID.
- Prefer a dedicated operating-system user in production. WeChat authorization
  supports only explicit IDs or the configured passphrase flow; wildcard
  authorization is rejected for every runtime user.
- An `accepted` provider response means only that the platform accepted the
  request; it does not prove that a client displayed or received the message.

Kintio applies capability and prompt boundaries to Codex, but it does not
provide operating-system-level filesystem or network isolation. Operators must
decide whether the Agent's actual capabilities require a container, dedicated
user, or additional network isolation.
