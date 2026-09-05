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
- Bun, including `bun:sqlite` and `bun:test` for the included catalog test.

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

## Development and tests

Use synthetic fixtures only. Never point tests at a live OpenCode database or a
copy containing real sessions, account data, project data, or customer data.

The included catalog test creates its own temporary SQLite database and removes
it after each test:

```sh
bun test session_catalog/catalog.test.ts
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
