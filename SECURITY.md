# Security Policy

## Independent Fork

OpenCode2 zh-CN is an independent community fork. Fork-specific security
reports are handled separately from the upstream OpenCode project. Reporting
to this fork does not automatically notify upstream maintainers.

## Reporting a Vulnerability

For a vulnerability introduced by or specific to this fork, use a private
[GitHub Security Advisory](https://github.com/521ox/opencode2-zh-CN/security/advisories/new).

Do not disclose an unpatched vulnerability in a public issue, pull request,
discussion, log excerpt, snapshot, or chat transcript. Do not include API keys,
cookies, authorization headers, private prompts, customer data, session
databases, generated memory snapshots, or unredacted local paths in a report.
Replace sensitive values with minimal synthetic examples.

If the vulnerability also affects upstream OpenCode, report it privately using
the upstream [SECURITY.md](https://github.com/anomalyco/opencode/blob/v2/SECURITY.md).
For non-security fork defects, use the public
[issue tracker](https://github.com/521ox/opencode2-zh-CN/issues).

## Security Model

OpenCode2 is a local development agent, not a security sandbox. Depending on
configuration and approvals, it may:

- read and modify files available to the current operating-system user;
- execute local processes and shell commands;
- connect to model providers, gateways, MCP servers, and network services;
- load JavaScript packages, provider adapters, plugins, and native components;
- persist prompts, tool results, provider checkpoints, and session metadata.

Run it with the least operating-system privilege required. Review provider,
gateway, MCP, plugin, and tool permissions before use. Keep credentials outside
the repository, restrict access to configuration and database files, and back
up important work before enabling write-capable tools.

Third-party gateways are separate trust boundaries. They may log content,
ignore protocol fields, or return non-conforming events. Native OpenAI remote
compaction is available only on its native package owner; official xAI compact
is available only on the xAI Responses owner. Display names and base URLs do
not grant either capability. Remote checkpoints and encrypted provider content
must remain opaque and must not be decoded, logged, or exposed by clients.

The `session-memory-v2` plugin may generate redacted snapshots that still
contain sensitive context. Store them locally with restrictive permissions,
review them before sharing, and never commit generated snapshots.

## Supported Code

Security fixes target the current public `main` branch. Public updates are
source-only sanitized snapshots; there is no GitHub Release or supported
prebuilt binary from this repository. For a locally compiled or redistributed
binary, reporters should identify the corresponding public source revision and
reproduction steps without attaching credentials, local configuration, or
machine-specific build evidence.
