# Repo-backed editing sessions

Saved packages keep their durable source in artifact repos. Once a package
exists, that repo-backed source is the source of truth for later edits and
publishes.

Use the repo capabilities when you want to inspect or modify package source
directly.

## When to use repo sessions vs. a local git remote

There are two supported ways to edit repo-backed source:

- **Repo sessions** (`repo_open_session` and the file-level `repo_*` session
  capabilities). Use these when you are a tool-only agent without a real
  filesystem, or when you only need structured file edits inside an isolated
  workspace. Repo sessions also work for repo-backed scheduled jobs (open by
  `source_id`), not just saved packages.
- **A short-lived authenticated git remote** via `package_get_git_remote` plus
  `package_publish_external_push`. Use this when you have local filesystem and
  git access and want to clone the repo into a temp directory, edit normally,
  and push the resulting HEAD back. Commits use `git_author` from the remote
  result (the signed-in Kody account); do not invent a git email. This path is
  **saved-package-only**; there is no equivalent helper for non-package
  repo-backed job source.

For one-file edits to a non-package repo-backed scheduled job, the simplest path
is usually neither of these: pass a replacement `code` string to
**`job_update`**, which republishes the job module on its repo-backed source
without opening a session.

When you only need to inspect the current scheduled job source, call
**`job_get`** with `includeCode: true`. The response includes the published
manifest-declared entrypoint path and source code, so you do not need to open a
repo session just to read the job module.

## File-level session API

Repo sessions expose a **file-level API**. There is no git-command channel:
branch, checkout, fetch, pull, push, and remote operations are not available
inside sessions. For saved packages, use `package_get_git_remote` when you need
full git; non-package job sources have no git-remote lane, so the file-level
session API is their only edit surface.

Merge drift from the published default branch is handled separately by
**`repo_rebase_session`**.

### Core edit and git-inspection capabilities

| Capability             | Purpose                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `repo_edit_files`      | Batch write, replace, writeJson, delete, or move edits (10 MiB per-file limit on content-changing results) |
| `repo_apply_patch`     | Apply a unified-diff patch (all-or-nothing)                                                                |
| `repo_write_file`      | Convenience wrapper for whole-file overwrites                                                              |
| `repo_status`          | Git status for the session workspace                                                                       |
| `repo_diff`            | Git diff for uncommitted changes                                                                           |
| `repo_log`             | Commit history (`depth` optional)                                                                          |
| `repo_commit`          | Stage all changes and commit with a message                                                                |
| `repo_restore`         | Restore paths to content at a commit (default: session base)                                               |
| `repo_run_checks`      | Run Worker-native validation                                                                               |
| `repo_publish_session` | Publish after checks pass                                                                                  |

### Unified-diff patch format

`repo_apply_patch` accepts a standard unified diff. Each file patch must
include:

- a `--- a/<path>` line and a `+++ b/<path>` line (use `/dev/null` on either
  side to create or delete a file)
- one or more `@@ -<old>,<n> +<new>,<n> @@` hunk markers
- normal context (` `), removal (`-`), and addition (`+`) lines inside each hunk

Multiple file patches can be stacked back-to-back in one patch string. If you
have the full new file body, prefer `repo_write_file` or a `write` edit in
`repo_edit_files` instead of hand-crafting hunks.

## Opening by package identity

`repo_open_session` can open repo-backed packages by user-facing identity
instead of requiring the internal `source_id`.

Examples:

```json
{ "target": { "kind": "package", "kody_id": "my-package" } }
```

```json
{ "target": { "kind": "package", "package_id": "pkg-123" } }
```

Pass `source_id` when you already have it, but most callers should prefer
`target`.

## Structured repair detail

Publish-oriented repo flows return structured detail for important failure
states:

- **`checks_outdated`** when a session changed after the last successful check
- **`base_moved`** with `repair_hint: "repo_rebase_session"` plus both the
  session base commit and current published commit

That makes it easier for agents to resume or repair a workflow without string
parsing.

## When to use other repo capabilities

Use the other repo capabilities when you need more control over the session:

- discover current sessions with `repo_list_sessions` before you know a
  `session_id`; it defaults to active sessions and can be filtered by `status`
  or `source_id`
- browse files with `repo_tree` and `repo_read_file`
- search the workspace with `repo_search`
- inspect status with `repo_get_check_status`
- repair drift with `repo_rebase_session`

If you find an active session you no longer need, pass its `id` as `session_id`
to `repo_discard_session` to close it. One-shot package helpers that open a
session to read or write should discard in a `finally` so leftovers do not
accumulate against the `repo_sessions` entitlement. Unused (never-edited)
sessions are swept after 30 minutes idle; sessions with unpublished edits are
swept after 7 days idle.

### `repo_write_file` vs patches

`repo_write_file` overwrites one or more files with full new content and returns
a per-file diff plus a `changed` flag. Reach for it when:

- replacing the entire body of a package export module, job module, or app
  server
- writing a freshly generated package file that does not yet exist
- patching a one-line config when you do not want to hand-craft a diff hunk

It only mutates the live session overlay. Pair it with `repo_commit`,
`repo_run_checks`, and `repo_publish_session` when you are ready to publish.

```json
{
	"session_id": "session-1",
	"files": [
		{
			"path": "src/index.ts",
			"content": "export default async function main() { return { ok: true } }\n"
		}
	]
}
```

## Example

```ts
const session = await kody.repo_open_session({
	target: { kind: 'package', kody_id: 'my-package' },
})

await kody.repo_edit_files({
	session_id: session.id,
	edits: [
		{
			kind: 'replace',
			path: 'src/index.ts',
			search: 'return { status: "todo" }',
			replacement: 'return { status: "done" }',
		},
	],
})

await kody.repo_diff({ session_id: session.id })

await kody.repo_commit({
	session_id: session.id,
	message: 'Mark triage complete',
})

await kody.repo_run_checks({ session_id: session.id })

await kody.repo_publish_session({ session_id: session.id })
```

Each step returns structured JSON so agents can inspect diffs, check outcomes,
and publish results without shell parsing.
