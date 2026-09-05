# Contributing to OpenCode2 zh-CN

Thank you for contributing to this independent OpenCode V2 fork.

## Choose the Correct Project

Use this repository for behavior introduced or intentionally preserved by this
fork, including the Simplified Chinese TUI, native Responses ownership,
compaction safeguards, session/subagent behavior, fork-owned tools, plugin
management, and source-build workflow.

If a defect reproduces on the current upstream V2 branch without fork changes,
report it to [anomalyco/opencode](https://github.com/anomalyco/opencode). When
practical, link the upstream report from the fork issue. Security
vulnerabilities must follow [SECURITY.md](SECURITY.md), not a public issue.

## Before Opening an Issue

1. Search existing issues and reproduce on the current public `main` branch.
2. State the operating system, terminal, public source revision, configured
   provider package/protocol, model identifier, and whether a gateway is used.
3. Provide the smallest reproducible sequence and expected/observed behavior.
4. Redact credentials, prompts, customer data, cookies, authorization headers,
   session databases, memory snapshots, logs, and identifying local paths.
5. Use synthetic data. Do not attach machine-local configuration or audit data.

## Development Setup

The root `packageManager` field is authoritative; the current source requires
Bun 1.3.14.

```bash
git clone https://github.com/521ox/opencode2-zh-CN.git
cd opencode2-zh-CN
bun install
bun dev
```

The root aggregate test entry intentionally fails. Use Bun's global `--cwd`
option to run type checks and tests from the affected package cwd:

```bash
bun --cwd packages/core run typecheck
bun --cwd packages/core test test/<relevant-test>.test.ts
bun --cwd packages/ai run typecheck
bun --cwd packages/ai test test/<relevant-test>.test.ts
```

Do not add a second runtime or canary lane to documentation or automation
without an accepted product change. This source snapshot does not publish
prebuilt binaries.

## Change Requirements

Keep each change bounded to one product outcome. A pull request should include:

- the user-visible behavior or defect;
- the affected owner and public contract;
- focused tests that fail on the previous behavior where applicable;
- exact verification commands and exit results;
- recovery and compatibility notes when persistent state changes;
- an upstream-sync impact note when a protected customization is touched.

Preserve [CUSTOMIZATIONS.md](CUSTOMIZATIONS.md). In particular:

- do not infer capabilities from provider display names or base URLs;
- do not replace native Responses behavior with a compatibility route;
- do not route native OpenAI compaction to `/responses/compact`;
- do not add local fallback to failed xAI remote compaction;
- do not bypass Session ownership, direct-child, or permission boundaries;
- do not restore retired fork-specific V1 migration tooling.

Generated clients and schemas must be regenerated through their existing owner
workflow. Do not hand-edit generated output unless that workflow explicitly
requires it.

## Style, Privacy, and Scope

- Follow surrounding TypeScript and Effect patterns.
- Prefer existing services, schemas, and route owners over parallel abstractions.
- Keep unrelated formatting and refactors out of behavioral changes.
- Use clear English for persistent engineering documentation; Chinese-primary
  product copy such as the README and localization resources is appropriate.
- Never commit credentials, private endpoints, local configuration, generated
  session-memory snapshots, local paths, private session data, or build/audit
  sidecars.

Large features and public-contract changes should begin with an issue describing
the behavior, non-goals, compatibility constraints, and acceptance criteria.

## Pull Requests

Open pull requests against `main`. Use a concise conventional title such as
`fix(core): preserve route ownership`. Draft pull requests are welcome when the
remaining behavior or verification gap is explicit.

A contribution may be declined when it conflicts with protected fork
contracts, lacks a reproducible verification path, contains private data, or
expands product scope without an agreed contract.

By contributing, you agree that your contribution is provided under the
repository's [MIT License](LICENSE).
