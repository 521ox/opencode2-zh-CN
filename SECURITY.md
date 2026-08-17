# Security Policy

## Independent Fork

OpenCode2 zh-CN is an independent community fork. Fork-specific security
reports are handled separately from the upstream OpenCode project.

## Reporting a Vulnerability

For a vulnerability introduced by or specific to this fork, use a private
[GitHub Security Advisory](https://github.com/521ox/opencode2-zh-CN/security/advisories/new).

Do not disclose an unpatched vulnerability in a public issue, pull request,
discussion, log excerpt, or chat transcript. Do not include API keys, cookies,
authorization headers, private prompts, customer data, session databases, or
unredacted local paths in a report.

If the vulnerability also affects upstream OpenCode, report it privately using
the process in the upstream
[SECURITY.md](https://github.com/anomalyco/opencode/blob/v2/SECURITY.md). Reporting
to this fork does not automatically notify the upstream maintainers.

For non-security defects, use the fork's
[issue tracker](https://github.com/521ox/opencode2-zh-CN/issues).

## Security Model

OpenCode2 is a local development agent, not a security sandbox. Depending on
your configuration and approvals, it may:

- read and modify files available to the current operating-system user;
- execute local processes and shell commands;
- connect to model providers, gateways, MCP servers, and other network services;
- load JavaScript packages, provider adapters, plugins, and native components;
- persist prompts, tool results, provider checkpoints, and session metadata.

Run the program with the least operating-system privilege required for the
task. Review provider and MCP endpoints before use. Keep credentials outside
the repository, restrict the permissions of configuration and database files,
and back up important work before allowing write-capable tools.

Third-party OpenAI-compatible gateways are separate trust boundaries. A
gateway may log content, ignore protocol fields, or return events that differ
from the official provider. Remote compaction checkpoints and encrypted
provider content should remain opaque; clients must not infer or expose their
internal plaintext.

## Supported Code

Security fixes are made against the current public `main` branch. The initial
publication does not distribute a supported binary release. Locally compiled
or redistributed binaries must be tied to an exact source commit and verified
build metadata before a report can be reproduced.
