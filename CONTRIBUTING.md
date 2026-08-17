# Contributing to OpenCode2 zh-CN

Thank you for contributing to this independent OpenCode V2 fork.

## Choose the Correct Project

Use this repository for behavior introduced by this fork, including its
Simplified Chinese TUI, native Responses path, compaction safeguards, durable
session execution, migration tooling, and custom Windows build process.

If a defect reproduces on the current upstream V2 branch without this fork's
changes, report it to [anomalyco/opencode](https://github.com/anomalyco/opencode).
When practical, link the upstream report from the fork issue so the relationship
is visible.

Security vulnerabilities must follow [SECURITY.md](SECURITY.md) and must not be
opened as public issues.

## Before Opening an Issue

1. Search existing issues and confirm the behavior still occurs on the current
   public `main` branch.
2. State the operating system, terminal, exact source commit, provider route,
   model identifier, and whether a third-party gateway is involved.
3. Provide the smallest reproducible sequence and the expected and observed
   behavior.
4. Redact credentials, prompts, customer data, cookies, authorization headers,
   session databases, logs, and identifying local paths.
5. For lifecycle or concurrency defects, include process IDs and timestamps only
   after confirming they do not expose private data.

## Development Setup

The repository pins Bun through the root `packageManager` field.

```bash
git clone https://github.com/521ox/opencode2-zh-CN.git
cd opencode2-zh-CN
bun install
bun dev
```

The root `bun test` command intentionally fails. Run type checking and tests for
the affected package instead:

```bash
bun run typecheck
bun test packages/core/test/<relevant-test>.test.ts
```

Windows release candidates must be built with
`script/build-custom-windows.ps1`; do not replace or overwrite a running binary.

## Change Requirements

Keep each change bounded to one product outcome. A pull request should include:

- the user-visible behavior or defect being addressed;
- the affected ownership boundary and public contract, if any;
- focused tests that can fail on the previous behavior;
- the commands and exit results used for verification;
- migration, recovery, and compatibility notes when persistent state changes;
- an upstream-sync impact note when a protected customization is touched.

Preserve the contracts documented in
[`specs/v2/upstream-sync-preservation.md`](specs/v2/upstream-sync-preservation.md).
Do not silently replace native Responses behavior with an AI SDK compatibility
path, bypass session ownership fencing, weaken migration preflight, or publish
an unverified compile runtime.

Generated clients, schemas, and migrations must be regenerated with the
repository's existing scripts. Do not hand-edit generated output unless the
owning generator explicitly requires it.

## Style and Scope

- Follow the surrounding TypeScript and Effect patterns.
- Prefer existing services and schemas over parallel abstractions.
- Keep unrelated formatting and refactors out of behavioral fixes.
- Add comments only where the invariant is not evident from the code.
- Use clear English for persistent engineering documentation. Preserve Chinese
  localization text where it is part of the product experience.

Large features or public contract changes should start with an issue describing
the behavior, non-goals, compatibility constraints, and acceptance criteria.

## Pull Requests

Open pull requests against `main`. Use a concise conventional title such as
`fix(core): fence session terminal publication`. Draft pull requests are
welcome when the unresolved behavior or verification gap is clearly listed.

A contribution may be declined when it cannot be reconciled with the protected
fork contracts, lacks a reproducible verification path, contains private data,
or expands the product scope without an agreed contract.

By contributing, you agree that your contribution is provided under the
repository's [MIT License](LICENSE).
