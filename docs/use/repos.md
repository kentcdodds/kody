# Plain repos

Plain repos are Kody's base Artifacts-backed storage primitive. Every plain repo
maps to a Cloudflare Artifacts git repository via `entity_sources` with
`entity_kind = 'repo'`. They are **live-at-HEAD**: pushes and session publishes
materialize directly on the default branch with no `published_commit` publish
step and no external-push reconcile lane.

Saved packages are an **explicit extension**: a package is a repo whose
`entity_sources` row has `entity_kind = 'package'` and a matching
`saved_packages` projection. Activation is never inferred from contents—a root
`package.json` alone does not make a package. Use `repo_promote_to_package` when
you want runtime surfaces (exports, apps, services, jobs, webhooks).

## Capabilities

| Capability                         | Purpose                                                                                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo_create`                      | Create a `user_repos` row and backing Artifacts repo (enforces `repos` entitlement).                                                                                                                                   |
| `repo_list`                        | List plain repos from D1 (`user_repos`); no live Artifacts reads.                                                                                                                                                      |
| `repo_get`                         | One repo by id or name, live default-branch HEAD, `package_shaped` hint.                                                                                                                                               |
| `repo_delete`                      | Delete `user_repos`, `entity_sources`, and Artifacts repo (best-effort).                                                                                                                                               |
| `repo_get_git_remote`              | Short-lived git remote; write pushes are live at HEAD (no publish reconcile).                                                                                                                                          |
| `repo_promote_to_package`          | Full publish checks + saved-package projection when root `package.json` exists at HEAD.                                                                                                                                |
| `repo_open_session` + session lane | File-level editing (`repo_edit_files`, `repo_apply_patch`, `repo_commit`, `repo_status`, `repo_diff`, `repo_log`, `repo_restore`, `repo_run_checks`, `repo_publish_session`, …) with `target: { kind: "repo", name }`. |

Vectorize/search integration for plain repos is not in v1—use `repo_list` for
discovery.

## Git lane

`repo_get_git_remote` mints a short-lived Artifacts remote (read or write). The
result includes `git_author` (signed-in Kody account email and display name) and
setup commands that set local `user.email` / `user.name` to that identity. Use
those values for commits; do not invent a git email. Kody's **10 MiB** per-file
gate (10,485,760 stored bytes) binds on session and file-level writes and again
at `repo_promote_to_package`; a direct `git push` to the minted remote has no
Kody gate, so the only ceiling on that lane is Artifacts itself, which rejects
pushes above ~32 MiB of decompressed pack content with a raw HTTP 413. Plain
repos do not run the package publish reconcile cron after push—HEAD is live.

## Sessions

Open with `repo_open_session` using `target: { kind: "repo", name: "<name>" }`
or `source_id`. Session base is the current default-branch HEAD (not a publish
pointer). `repo_publish_session` on a plain repo runs only the source size walk
(manifest, bundle, typecheck, and lint checks are skipped). When the published
tree contains root `package.json`, the result includes `package_shaped: true`
and a promote notice.

## Promote flow

When a plain repo has `package.json` at HEAD, `repo_get` and publish surfaces
surface progressive disclosure (`package_shaped`, `activated: false`, promote
notice). `repo_promote_to_package` enforces the `saved_packages` entitlement,
runs full publish checks, creates the `saved_packages` row, flips
`entity_sources` to `package`, and deletes the `user_repos` row.

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

Declare handlers under `package.json#kody.subscriptions`. Delivery is same-user
only: packages saved by the entity owner that declare the topic receive the
event. Session fork Artifacts repos never fan out.

`repo.pushed` is the primary automation hook (for example resyncing a projection
after a git-lane push to a plain repo). For packages and jobs, a push updates
HEAD but does **not** by itself advance `published_commit` — publish /
`package_publish_external_push` / reconcile still own activation.

Payload shapes and idempotency details live in the
[package subscriptions guide](../guides/package-subscriptions.md).
