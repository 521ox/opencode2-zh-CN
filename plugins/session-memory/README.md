# Session Memory for OpenCode V2

`session-memory-v2` is a user-owned fork plugin for OpenCode V2. It is published
with this repository under the repository's MIT license. It is not presented as
an upstream OpenCode component or as work authored or maintained by the upstream
OpenCode project.

The plugin registers two tools:

- `session_catalog` lists redacted titles and IDs for historical root sessions
  using bounded, keyset-paginated results. It does not return transcripts.
- `session_snapshot` creates or removes a privacy-gated temporary snapshot for
  one exact session. The snapshot includes navigation metadata for bounded
  review of retained conversation history.

## Requirements

- OpenCode V2 with directory-plugin support.
- Bun, including `bun:sqlite` and `bun:test` for the included tests.

No dependencies need to be installed inside this plugin directory.

## Installation

Copy this repository directory to the OpenCode directory-plugin location. For
example, using an XDG-style user configuration layout:

```text
plugins/session-memory/  ->  ~/.config/opencode/plugins/session_memory/
```

The installed entry point should therefore be:

```text
~/.config/opencode/plugins/session_memory/index.ts
```

Keep the repository copy as the reviewable source and copy only this plugin
tree. Do not copy a live OpenCode configuration, database, generated snapshot,
or dependency directory into a public repository.

To disable the plugin, stop OpenCode and remove or rename only the installed
`session_memory` plugin directory.

## Database access

The plugin is intentionally read-only at the SQLite boundary. It opens the
OpenCode V2 database with Bun SQLite using all of the following controls:

```text
readonly: true
create: false
PRAGMA query_only = ON
```

It queries the V2 session tables needed for catalog and snapshot projection. It
does not create a missing database and does not write to an existing database.

`OPENCODE_DB` is an optional override. An absolute value is used directly; a
relative value is resolved beneath the OpenCode data root. Without the override,
the database filename follows the active OpenCode channel convention.

## Snapshot lifecycle and privacy

`session_snapshot` writes temporary bundles below the operating system's
temporary directory. A bundle contains `snapshot.json` and `navigation.json`.
Call the tool again with `cleanup=true` after the bounded analysis is complete.
The implementation uses owned-directory checks, per-session locking, protected
temporary files, validation, and atomic publication.

On Windows, snapshot directories and files are protected and verified with
ACLs limited to the current user and the operating-system service identity. On
POSIX systems, directories use mode `0700` and files use mode `0600`.

Redaction and validation reduce accidental disclosure; they do not make a
snapshot safe to publish. **Sanitized snapshots may still contain sensitive
conversation content. Never commit, upload, or share a generated snapshot
without an independent content review.** Clean up snapshots promptly.

Recognized NUL bytes or dense unsupported control content in non-identity text
is omitted locally instead of rejecting the entire Session. Structured values
are inspected for unsupported or credential-like keys before they are
serialized or reduced to a bounded preview, so truncation cannot discard the
key context before sanitization. The original unsafe key and its value are not
retained.

Identity fields remain fail-closed because replacing them would corrupt
navigation, correlation, or ownership. This includes Session, message, part,
tool-call, project, workspace, parent, and child-Session identities. Truly
unsupported structures, malformed source JSON, unsafe paths or permissions, and
unstable database reads can still make snapshot creation fail visibly. The
final secret and unsupported-content validators remain enabled.

V2 `session_message.seq` is the conversation-order authority. Message
timestamps are metadata and may be non-monotonic after import, recovery, or
concurrent events. Snapshot lines and first/last message IDs follow `seq`, while
navigation time spans and contiguous UTC-hour divisions use the minimum and
maximum timestamps observed in their respective ranges.

## Development and tests

Use synthetic fixtures only. Never point tests at a live OpenCode database or a
copy containing real sessions, account data, project data, or customer data.

The included tests use synthetic values and temporary SQLite databases. Run
them from this plugin directory:

```sh
bun test
```

If `OPENCODE_DB` is set in the surrounding environment, override it with a path
to a synthetic or nonexistent database in an approved temporary directory when
running any additional local checks.

## Provenance and license

This repository snapshot contains a user-owned fork plugin and associated tests.
Its inclusion does not imply upstream OpenCode authorship, endorsement, or
maintenance. The plugin is distributed under the repository's MIT license; see
the repository-level license and notices for the governing terms and
attribution.
