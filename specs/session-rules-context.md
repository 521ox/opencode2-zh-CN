# Session Rules Location Context

Status: **Accepted**
Scope: V2 Session persistence and normal Agent model requests

## Purpose

Every normal Agent request receives one protected system context naming the preferred Session-scoped directory for rules, plans, architecture notes, and working documents. This feature identifies a location only. It does not discover, create, read, load, validate, or synchronize rule documents.

The directory is:

```text
<root-session-start-directory>/.opencode/rules/<root-session-id>
```

The final directory name is the readable root Session ID itself. It is not encoded, hashed, case-folded, or replaced by an opaque storage key.

## Root Ownership

The root Session uses its own ID. Every direct or nested descendant, including subagent Sessions, resolves the same root ID and rules directory through the durable `parent_id` lineage.

The root start directory is the absolute working directory recorded when the root Session was created. Core stores it as the nullable, immutable `session_v2.start_directory` fact. Session movement, worktree ownership resolution, project changes, and a descendant's current Location never rewrite that value.

Persisted Windows drive or UNC paths and POSIX absolute paths remain valid independent of the host performing an import or migration. Path validation and rules-directory derivation use the syntax of the persisted path itself rather than `process.platform`.

Core must not reconstruct the start directory from the current process directory, the current Session directory, a project or worktree root, a drive root, or a subpath traversal.

## Model-Visible Contract

The protected context contains:

- `current_session_id`
- `root_session_id`
- `rules_directory`
- `status`
- `reason` when unavailable

The `session.context` plugin hook may transform or remove ordinary system parts. Core appends the Session rules context after that hook, so a plugin cannot delete or replace it.

Only normal Agent Step requests receive this context. Title generation, local compaction summaries, provider-native compaction, Session generation helpers, and other auxiliary model requests do not receive it.

## Failure Semantics

Resolution fails closed with `status: "unavailable"` when:

- the current Session is missing or does not match the requested ID;
- a parent Session is missing;
- the parent chain contains a cycle;
- a current, parent, or root Session ID is unsafe;
- the root start directory is missing, relative, a filesystem root, an incomplete UNC location, or otherwise invalid.

Unavailable context never substitutes the child ID as the root, guesses another location, or searches sibling Session directories. Unsafe current IDs are not echoed into privileged context.

A fork is a new root Session rather than a `parent_id` descendant. The current fork event does not carry an authoritative creation Location, so its `start_directory` is `NULL` and its rules context is unavailable. Core must not copy the source Session's historical start directory into the fork. A future event contract may make fork creation Location explicit.

## Filesystem Boundary

Resolution and rendering perform zero filesystem operations. They do not create the directory, check whether it exists, enumerate siblings, read documents, inspect metadata, or write manifests. The model is instructed to create the directory lazily only when a task needs Session-scoped persistence.

Explicit user instructions and authoritative project artifacts naming another document location take precedence over this preferred location.

## Historical Data

New Session projections write `start_directory` from the durable `session.created.1` Location. Historical databases may backfill only from exact persisted creation facts:

1. A valid legacy `session.start_directory` direct fact, when that column exists.
2. One and only one `session.created.1` event at aggregate sequence zero whose Session ID matches the row and whose creation directory is valid.

Malformed, duplicate, late, mismatched, or relative facts remain `NULL`. Migration and V1 import never use the mutable Session `directory` as a fallback.

## Non-Goals

This contract does not define a rule document schema, automatic discovery, automatic loading, a document editor, a desktop UI, permission rules, or migration of historical `v1-<hex-session-id>` directories.
