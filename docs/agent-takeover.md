# Agent takeover and handoff guide

This guide lets a new coding agent continue public project work without access
to private conversation history. The root [agent contract](../AGENTS.md) remains
normative; this document supplies a practical intake and handoff procedure.

## 1. Intake: establish authority before action

Write down the requested outcome in observable terms, then establish:

- what the user authorized you to inspect, change, verify, and externally affect;
- repository root, branch, exact revision, remotes when relevant, and working-tree status;
- pre-existing modified or untracked paths and their owner;
- applicable repository contracts, package instructions, security constraints,
  and generated-file owners;
- in-scope and no-touch paths, completion checks, stop conditions, and recovery;
- whether a commit, push, release, deployment, upload, issue, or other external
  effect is separately authorized.

Product and publication decisions remain user-owned. Within an authorized and
recoverable boundary, an agent may choose technical implementation details and
run applicable local verification without asking for every routine step.

## 2. Reconstruct evidence, not a story

Use this priority order:

1. current user instructions and public repository contracts;
2. current source, schemas, generated contracts, and focused tests;
3. version-control history and reviewable public records;
4. a runtime-provided current-Session rules directory or explicit handoff;
5. clearly labelled hypotheses.

Observe facts before interpretation. For each important causal claim, record:

- **Hypothesis** — what is believed and why it matters;
- **Evidence** — source locations, commands, outputs, or reproduction;
- **Falsifier** — the observation that would make the hypothesis wrong;
- **Response** — recover, narrow, or redesign if falsified.

Do not treat a model summary, stale plan, title, filename, or passing unrelated
test as proof. If private history is missing, do not guess it or block by
default. Reconstruct the current contract from public artifacts, identify what
remains unknown, and ask the user only when a user-owned decision or authority
is truly required.

## 3. Use current-Session continuity safely

Some runtimes provide a preferred rules directory for the root Session and its
descendants. When its exact location is injected into the current context:

1. use that exact location; never derive one from a guessed Session ID;
2. read the smallest Goal-specific plan, architecture note, decision, or handoff;
3. check it against current source and Git state;
4. keep live status and sensitive evidence Session-scoped rather than committing
   them by default.

The directory is only a location hint. It is not necessarily created, read,
validated, synchronized, or durable. If it is unavailable, continue from public
evidence. For historical Session transfer or optional local-history analysis,
see [Session history and recovery](session-history.md).

## 4. Plan a bounded dependency graph

For work with more than one dependent concern, make a small DAG rather than a
flat task list. Each node should state:

- one outcome and its prerequisites;
- owned paths or contract boundary;
- inputs and expected outputs;
- verification that can falsify completion;
- recovery and handoff target.

Run nodes concurrently only when their writable paths and product decisions do
not overlap. One path has one writer at a time. Shared contracts are read-only
until their owner integrates the result. Keep integration, publication, and
remote effects as explicit nodes with explicit authority; editing does not
authorize them.

Example:

```text
A: establish contract and baseline
├─ B: implement owner change (writes owner paths)
├─ C: update stable documentation (writes documentation paths)
└─ D: focused verification (starts after B/C candidate exists)
   └─ E: integrate and publish (user-authorized owner only)
```

## 5. Execute in attributable cycles

Each cycle must answer: what changed, why, and how will we know whether it
worked? Preserve unknown user changes and avoid unrelated cleanup. Search for
the canonical owner before creating a duplicate contract or workaround.

Use package-local commands. This repository intentionally rejects root
`bun test`; change to the owning package directory and use its documented,
focused checks. Report the working directory as part of the evidence.

### Stop and re-frame when

- the baseline or allowed-path boundary drifts;
- two writers need the same path or contract decision;
- a required owner or schema is contradictory or unknown;
- progress would copy credentials, live Session/provider data, private paths,
  endpoints, configuration, snapshots, or operational records;
- a destructive or external action lacks explicit authority;
- recovery or applicable verification is unavailable;
- evidence falsifies the plan.

If the same bounded candidate and causal hypothesis fail twice, stop that cycle.
Record both failures, restore or stabilize only its owned paths, narrow the
boundary, revise the hypothesis, and begin a newly framed cycle. Renaming the
same attempt does not reset the count.

## 6. Verify and recover

Select the smallest checks whose failure would disprove the intended result:

- focused tests, type checks, lint, parsers, schema checks, or deterministic
  scripts from the owning package;
- exact diff and changed-path inventory;
- documentation links, commands, examples, terminology, and privacy scans;
- public-contract and fork/upstream attribution review.

A result record includes command, working directory, exit status, significant
output, skips, and the claim it covers. A scoped pass proves only that scope.
Never describe “not run” as “passed.”

Prefer reversible edits and synthetic fixtures. Recovery may be a reverse diff,
restoring only owned files, deleting an isolated disposable workspace, or a
normal revert after an authorized non-sensitive publication. Sensitive public
disclosure requires containment and platform-specific remediation, not merely a
revert.

## 7. Completion and publication state

Call work complete only when every fixed completion condition has corresponding
evidence. Distinguish these states explicitly:

- edited locally;
- verified locally;
- reviewed;
- committed;
- pushed or proposed for review;
- released or deployed;
- accepted by the user.

None implies the next. If an authorized outcome stops before the original goal,
name every unmet condition. Do not publish, commit, push, merge, release, deploy,
upload, or alter remote state unless that exact effect is authorized.

## Handoff template

```markdown
# Handoff: <Goal>

## Outcome
- Requested outcome:
- Current state: local edit | verified | reviewed | committed | published
- Completion criteria: <criterion -> met/unmet + evidence>

## Baseline and authority
- Repository/workspace:
- Starting branch and revision:
- Final branch and revision:
- Authorized mutations:
- Authorized external effects:
- Pre-existing changes preserved:

## Ownership and decisions
- Public/source contracts consulted:
- Fork-owned vs upstream-adapted classification:
- Key decisions and evidence:
- Falsified hypotheses or missing history:

## Change inventory
- Changed paths:
- Intentionally untouched paths:
- Runtime or durable-data effects: none | <exact effect>

## Verification evidence
- `<command>`
  - cwd:
  - exit status:
  - result and covered claim:
- Not run / not verified:

## Recovery
- How to reverse only this work:
- Stop conditions encountered:

## Remaining integration
- Blockers or residual risks:
- Required owner/decision:
- Publication state and next authorized integration seam:
```
