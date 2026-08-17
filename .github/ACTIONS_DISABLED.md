# GitHub Actions Status

GitHub Actions are intentionally disabled at the repository level for the
initial public source publication.

The workflow files are inherited from upstream and include release, deployment,
triage, publication, scheduled, and secret-dependent jobs. They are retained as
source history but are not approved for execution in this fork.

Before enabling Actions, each workflow must be reviewed for fork ownership,
permissions, secrets, environments, external actions, publication targets, and
irreversible side effects. Enabling a harmless-looking test workflow must not
implicitly enable the remaining upstream workflows.
