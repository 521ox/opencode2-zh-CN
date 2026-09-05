# Portable Goal workflow template

This optional template coordinates one bounded Goal. It does not define product
behavior and does not require a particular model, orchestrator, agent count,
concurrency level, reviewer budget, branch strategy, or private Session naming
convention.

Copy this file and fill in a Goal-specific instance. If the runtime provides an
exact rules directory for the current root Session, that directory is the
preferred place for the live instance shared with descendants. Do not invent
the directory, hardcode a Session ID, or commit live status by default. If no
directory is provided, keep the instance in another user-approved workspace or
use it directly in the Session.

Use **Lite** only for one clear, low-risk, reversible outcome with a simple
check. Use **Full** when work is materially ambiguous, irreversible, crosses an
ownership/public-contract boundary, or contains independent concerns requiring
separate attribution.

---

# Goal: `<desired user outcome>`

## Authority and baseline

- **User-owned outcome:**
- **Authorized inspection:**
- **Authorized mutation:**
- **Authorized external effects:** none unless listed
- **Repository/workspace root:**
- **Starting branch/revision:**
- **Initial status and pre-existing work:**
- **Contracts/instructions loaded:**
- **Privacy boundary:**

## Fixed completion contract

- **Completion criteria:**
  1.
  2.
  3.
- **Material failure(s), or none:**
- **Must not touch/assume/conclude:**
- **Recovery path:**
- **Verification methods:**

## Active evidence

- **Observed facts:**
- **Hypothesis (when causal/contestable):**
- **Falsifier:**
- **Action if falsified:**
- **Unknowns:**

## Choose a workflow

### Lite workflow

Use for a single attributable cycle:

```text
Baseline -> bounded change -> applicable check -> handoff
```

- **Owned paths/boundary:**
- **Expected change:**
- **Check and working directory:**
- **Result:**
- **Recovery:**

If scope, risk, or uncertainty grows, stop and convert this instance to Full.

### Full workflow

Define dependencies and ownership before execution. Add, remove, or serialize
nodes according to the Goal; the sample labels are not a required agent layout.

| Node | Outcome | Prerequisites | Path/contract owner | Writes | Verification | Recovery | State |
|---|---|---|---|---|---|---|---|
| A | Establish baseline and owner | none | coordinator | none | state evidence | re-frame | pending |
| B | Implement bounded owner change | A | assigned owner | explicit paths | focused check | reverse owned diff | pending |
| C | Integrate and verify Goal | B and any other prerequisites | integration owner | explicit paths | completion matrix | restore candidate | pending |

Concurrency is allowed only for independent nodes with disjoint writable paths
and no unresolved shared decision. Keep one writer per path. A node hands back
evidence; it does not silently broaden its assignment or publish the result.

## Cycle log

Record decisions and evidence, not a full transcript.

```text
Cycle:
Node / owner:
What changed and why:
Observed evidence:
Verification command + cwd + exit status:
Hypothesis result:
Recovery state:
Next dependency:
```

### Stop rules

Stop the affected cycle when authority, boundary, ownership, privacy, recovery,
or verification is unclear; when baseline drift risks another person's work; or
when evidence contradicts the plan. After the same candidate and hypothesis
fail twice, preserve evidence and re-frame with a narrower or materially
different approach. Ask the user only for a decision or authority the agent
cannot own.

## Completion matrix

| Criterion | Evidence | Status |
|---|---|---|
| 1 |  | met / unmet |
| 2 |  | met / unmet |
| 3 |  | met / unmet |

## Final handoff

- **Outcome and exact changed paths:**
- **Starting/final revision and status:**
- **Pre-existing work preserved:**
- **Commands, cwd, exit status, and key results:**
- **Unverified or unresolved items:**
- **Recovery instructions:**
- **Commit/push/review/release/deploy state:**
- **Next authorized integration seam, or none:**

For the project-specific intake and a fuller handoff record, see
[Agent takeover and handoff](agent-takeover.md).
