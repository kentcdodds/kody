# 0020: Repo sessions spill Workspace objects to R2; do not adopt `@cloudflare/computer`

- **Status:** accepted
- **Date:** 2026-08-16

## Context

Interactive repo sessions (`repo_open_session` and the file-level `repo_*` API)
are a full Artifacts clone inside the RepoSession Durable Object
`@cloudflare/shell` Workspace, not a pointer. isomorphic-git writes the incoming
packfile as one blob. Without an R2 bucket, Workspace stores that inline and
hits Cloudflare DO SQLite's 2 MiB row limit (`SQLITE_TOOBIG`). Artifacts can
already hold those objects (packs up to ~32 MiB; Kody's per-file policy is 10
MiB). The git-remote lane does not need this working copy.

[0003](./0003-repos-as-base-primitive.md) said to revisit a
checkout-plus-execution runtime such as `@cloudflare/computer`. Computer is the
same class of Durable Object SQLite VFS plus isomorphic-git, with optional
isolate/container exec. It is an early preview (unstable, not production), still
SQLite-backed (same row limit unless it also spills), and its Artifacts/R2 mount
interface is not implemented. [0006](./0006-no-repo-ci-primitive.md) declined a
CI/exec primitive; 0003 already replaced `repo_run_commands` with a file-level
API.

## Decision

Keep the session lane on `@cloudflare/shell` Workspace. Bind
`REPO_SESSION_BLOBS` so objects above the inline threshold spill to R2,
prefix-purge that scratch with the session, count those bytes in
`estimatedBytes`, and omit the bucket from DR canonical exports. Do not adopt
`@cloudflare/computer` for this lane.

This is not a 0003 user-file rewrite. Spill is platform-internal Workspace
packing; the 10 MiB gate and Artifacts as the durable home stay.

## Consequences

- Sessions can materialize repos that Artifacts already accepted.
- Shared-bucket isolation is `repo-session:{durableObjectId}/`. Discard marks
  the catalog row discarded, then prefix-purges. Expired-session cleanup
  prefix-purges before dropping the row so a failed R2 delete can retry. A
  missing catalog row is not ownership proof, so discard and cleanup do not
  wipe. `purgeSession` (account deletion) still prefix-purges after `deleteAll`.
- Isolated check/rebuild DOs share the class and must not write this workspace.
- Revisit Computer when its API is production-stable, Artifacts can mount
  without cloning a pack into SQLite, and there is a real need for
  checkout-plus-execution (the 0003/0006 reopen).
