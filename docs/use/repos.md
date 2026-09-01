# Plain repos

Plain repos are Kody's base Artifacts-backed storage primitive. Every plain repo
maps to a Cloudflare Artifacts git repository via `entity_sources` with
`entity_kind = 'repo'`. They are **live-at-HEAD**: pushes and session publishes
materialize directly on the default branch with no `published_commit` publish
step and no external-push reconcile lane.

Saved packages are an **explicit extension**: a package is a repo whose
`entity_sources` row has `entity_kind = 'package'` and a matching
`saved_packages` projection. Activation is never inferred from contents—a root
`package.json` alone does not make a package. Use `repoPromoteToPackage` when
you want runtime surfaces (exports, apps, jobs, webhooks).

## Capabilities

| Capability                       | Purpose                                                                                                                                                                                                   |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repoCreate`                     | Create a `user_repos` row and backing Artifacts repo (enforces `repos` entitlement).                                                                                                                      |
| `repoList`                       | List plain repos from D1 (`user_repos`); no live Artifacts reads.                                                                                                                                         |
| `repoGet`                        | One repo by id or name, live default-branch HEAD, `package_shaped` hint.                                                                                                                                  |
| `repoDelete`                     | Delete `user_repos`, `entity_sources`, and Artifacts repo (best-effort).                                                                                                                                  |
| `repoGetGitRemote`               | Short-lived git remote; write pushes are live at HEAD (no publish reconcile).                                                                                                                             |
| `repoPromoteToPackage`           | Full publish checks + saved-package projection when root `package.json` exists at HEAD.                                                                                                                   |
| `repoOpenSession` + session lane | File-level editing (`repoEditFiles`, `repoApplyPatch`, `repoCommit`, `repoStatus`, `repoDiff`, `repoLog`, `repoRestore`, `repoRunChecks`, `repoPublishSession`, …) with `target: { kind: "repo", name }`. |

Plain repos do not have Vectorize/search integration—use `repoList` for
discovery.

## Git lane

`repoGetGitRemote` mints a short-lived Artifacts remote (read or write). The
result includes `git_author` (signed-in Kody account email and display name) and
setup commands that set local `user.email` / `user.name` to that identity. Use
those values for commits; do not invent a git email. Kody's **10 MiB** per-file
gate (10,485,760 stored bytes) binds on session and file-level writes and again
at `repoPromoteToPackage`; a direct `git push` to the minted remote has no Kody
gate, so the only ceiling on that lane is Artifacts itself, which rejects pushes
above ~32 MiB of decompressed pack content with a raw HTTP 413. Plain repos do
not run the package publish reconcile cron after push—HEAD is live.

## Sessions

Open with `repoOpenSession` using `target: { kind: "repo", name: "<name>" }` or
`source_id`. Session base is the current default-branch HEAD (not a publish
pointer). Pass `conversation_id` to resume that conversation's active session.
Omitting `conversation_id` always mints a new session: never-checkpointed is not
the same as abandoned, and two callers of the same source must not share a
workspace that has not checkpointed yet. `repoPublishSession` on a plain repo
runs only the source size walk (manifest, bundle, typecheck, and lint checks are
skipped). When the published tree contains root `package.json`, the result
includes `package_shaped: true` and a promote notice.

## Promote flow

When a plain repo has `package.json` at HEAD, `repoGet` and publish surfaces
surface progressive disclosure (`package_shaped`, `activated: false`, promote
notice). `repoPromoteToPackage` enforces the `saved_packages` entitlement, runs
full publish checks, creates the `saved_packages` row, flips `entity_sources` to
`package` while seeding `published_commit` from the session's HEAD (plain repos
have no publish pointer, and a null pointer after the flip looks like a stale
session), and deletes the `user_repos` row.

## Mental model

Repos are the durable home for versioned source; packages add runtime surfaces
on top of an explicitly activated extension.

## Package subscriptions for repo lifecycle

Kody relays Cloudflare Artifacts repository lifecycle events into package
subscriptions for the owning user:

| Topic          | Cloudflare event            | When it fires                            |
| -------------- | --------------------------- | ---------------------------------------- |
| `repo.pushed`  | `cf.artifacts.repo.pushed`  | Commits land on a managed Artifacts repo |
| `repo.created` | `cf.artifacts.repo.created` | A managed Artifacts repo is created      |
| `repo.deleted` | `cf.artifacts.repo.deleted` | A managed Artifacts repo is deleted      |

Account-level Artifacts subscriptions deliver `repo.pushed` as
`cf.artifacts.repo.pushed` with `source.type === "artifacts"`. Repo-scoped
wrappers use the same event type with `source.type === "artifacts.repo"`.

Declare handlers under `package.json#kody.subscriptions`. Delivery is same-user
only: packages saved by the entity owner that declare the topic receive the
event. Session fork Artifacts repos and session workspace branch pushes
(`sessions/<id>`) never fan out.

`repo.pushed` is the primary automation hook (for example resyncing a projection
after a git-lane push to a plain repo). For packages and jobs, a push updates
HEAD but does **not** by itself advance `published_commit` — publish /
`packagePublishExternalPush` / reconcile still own activation.

Payload shapes and idempotency details live in the
[package subscriptions guide](../guides/package-subscriptions.md).
