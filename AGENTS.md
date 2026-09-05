# Repository contract for coding agents

This file is a public, bounded operating contract for agents working in this
repository. It does not replace the user's instructions or the product and
security contracts linked below.

## Sources of truth

1. Follow the user's current goal and mutation authority.
2. Read the nearest applicable `AGENTS.md`, then the repository documents that
   own the surface being changed. Start with [README.md](README.md),
   [CUSTOMIZATIONS.md](CUSTOMIZATIONS.md), [CONTRIBUTING.md](CONTRIBUTING.md),
   and [SECURITY.md](SECURITY.md) when relevant.
3. Use implementation, focused tests, schemas, and generated contracts as
   evidence for current technical behavior. Do not make private notes or an old
   handoff override the current public source.
4. If the runtime injects a current root-Session rules directory, read only the
   smallest Goal-specific plan, decision, or handoff needed there. The location
   is runtime-provided and shared with descendants; do not guess a path or
   hardcode a Session ID. Its absence is not a blocker: reconstruct from public
   artifacts and record uncertainty.

## Authority and state

- The user owns product choices and authorization for publication and other
  external effects. Agents may make bounded technical decisions needed to
  implement an authorized goal.
- Edit or test authority never implies authority to commit, push, open or merge
  a pull request, publish a release, deploy, upload, or change a remote service.
- Before editing, identify the repository root, current branch and revision,
  working-tree status, pre-existing changes, allowed paths, and recovery path.
  Treat unknown changes as user work; do not reset, overwrite, or reformat them.
- Keep credentials, private endpoints, live configuration, local identities and
  machine paths, Session content, provider state, and generated snapshots out of
  source, logs, examples, issues, and handoffs. Use synthetic data and
  environment-variable placeholders.

## Bounded work and verification

- Define an observable outcome, no-touch boundary, applicable checks, and stop
  conditions before changing files. Split independent goals so each change is
  attributable and recoverable.
- Search for the owning contract and existing implementation before adding a
  second rule, type, adapter, configuration key, or documentation owner.
- Run commands from the owning package directory and report that directory.
  Root `bun test` intentionally fails as a guard; it is not the project test
  entry point and must not be bypassed or reported as a product failure.
- Use the smallest applicable checks that can falsify the changed behavior.
  Record the exact command, exit status, important output, skips, and anything
  not verified. Never weaken a test or silently fall back merely to obtain a
  pass.
- Stop when authority or ownership is unclear, private material would need to be
  copied, user work cannot be preserved, recovery is unknown, or evidence
  contradicts the active plan. After the same bounded approach fails twice,
  stop that approach, preserve evidence, narrow the scope, and re-frame.

## Fork ownership and documentation

- Distinguish fork-developed behavior, fork reliability/adaptation work,
  selected and adapted upstream work, optional fork plugins, and internal
  mechanisms. Presence in this repository does not prove fork authorship.
- Do not imply endorsement by OpenAI, anomalyco, upstream OpenCode, or a
  third-party dependency. Model identity is not correctness evidence.
- Update the public document that owns a changed stable behavior, configuration,
  default, operational requirement, or user-visible boundary. Keep examples
  copyable and public-safe; do not publish internal governance or incident data.

## Handoff and external effects

Hand back: the goal and outcome, exact changed paths, preserved pre-existing
changes, decisions and ownership classifications, verification commands and
results, unresolved risks or blockers, recovery instructions, and the current
commit/publication state. Say explicitly whether nothing was committed or
published. See [the takeover guide](docs/agent-takeover.md) and the optional
[workflow template](docs/workflow-template.md).
