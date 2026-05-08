# Repo-backed editing sessions

Saved packages keep their durable source in artifact repos. Once a package
exists, that repo-backed source is the source of truth for later edits and
publishes.

Use the repo capabilities when you want to inspect or modify package source
directly.

## When to use repo sessions vs. a local git remote

There are two supported ways to edit repo-backed source:

- **Repo sessions** (`repo_open_session`, `repo_run_commands`, and the
  lower-level `repo_*` capabilities). Use these when you are a tool-only agent
  without a real filesystem, or when you only need to apply small parsed git
  workflows. Repo sessions also work for repo-backed scheduled jobs (open by
  `source_id`), not just saved packages.
- **A short-lived authenticated git remote** via `package_get_git_remote` plus
  `package_publish_external_push`. Use this when you have local filesystem and
  git access and want to clone the repo into a temp directory, edit normally,
  and push the resulting HEAD back. This path is **saved-package-only**; there
  is no equivalent helper for non-package repo-backed job source.

For one-file edits to a non-package repo-backed scheduled job, the simplest path
is usually neither of these: pass a replacement `code` string to
**`job_update`**, which republishes the job module on its repo-backed source
without opening a session.

## Preferred workflow for repo sessions

For package edits via repo sessions, use **`repo_run_commands`**.

It combines the usual sequence into one capability:

1. open or reuse a repo session
2. parse and run constrained git commands
3. run Worker-native checks when requested
4. publish when requested and checks pass

Commands are parsed, not shell-executed. Unsupported syntax returns a
line-specific parse error with examples so agents can correct the command
string.

Only git commands are accepted. Non-git commands and shell syntax such as pipes,
command substitution, `&&`, or tools like `npm`, `cat`, and `sed` are not
supported.

Supported commands:

- `git status [--short]`
- `git diff`
- `git apply <<'PATCH' ... PATCH`
- `git add <path>`
- `git rm <path>`
- `git commit -m "message"`
- `git log [--depth N]`
- `git branch [name]` / `git branch -d <name>`
- `git checkout <ref>` / `git checkout -b <branch> [--force]`
- `git fetch [remote] [ref]`
- `git pull [remote] [ref]`
- `git push [remote] [ref] [--force]`
- `git remote`, `git remote -v`, `git remote add <name> <url>`,
  `git remote remove <name>`

`git clone` is intentionally unsupported because repo sessions are opened and
cloned by Kody.

### `git apply` patch format

`git apply` only accepts heredoc form, and the heredoc body must be a standard
unified diff. Each file patch must include:

- a `--- a/<path>` line and a `+++ b/<path>` line (use `/dev/null` on either
  side to create or delete a file)
- one or more `@@ -<old>,<n> +<new>,<n> @@` hunk markers
- normal context (` `), removal (`-`), and addition (`+`) lines inside each hunk

Multiple file patches can be stacked back-to-back inside a single heredoc; do
not separate them with `diff --git` lines or per-file `git apply` invocations.
Patches are applied with the standard `diff` library, so the heredoc must match
exactly what an upstream `git diff` would produce. If you have the full new file
body and only need to overwrite a file (rather than apply a true patch with
context lines), prefer `repo_write_file` (see below) — it sidesteps unified-diff
context drift entirely.

## Opening by package identity

`repo_open_session` and `repo_run_commands` can open repo-backed packages by
user-facing identity instead of requiring the internal `source_id`.

Examples:

```json
{ "target": { "kind": "package", "kody_id": "triage-github-pr" } }
```

```json
{ "target": { "kind": "package", "package_id": "pkg-123" } }
```

Pass `source_id` when you already have it, but most callers should prefer
`target`.

## Structured repair detail

Publish-oriented repo flows return structured detail for important failure
states:

- **`blocked_by_checks`** when checks fail inside `repo_run_commands`
- **`checks_outdated`** when a session changed after the last successful check
- **`base_moved`** with `repair_hint: "repo_rebase_session"` plus both the
  session base commit and current published commit

That makes it easier for agents to resume or repair a workflow without string
parsing.

## When to use low-level repo capabilities

Use the lower-level repo capabilities when you need more control over the
session:

- browse files with `repo_tree` and `repo_read_file`
- search the workspace with `repo_search`
- overwrite or create files with `repo_write_file` (preferred over `git apply`
  for whole-file replacements such as single-file job sources or generated
  package modules)
- inspect file contents or diffs only when you decide to read them
- run checks separately from publish
- inspect status with `repo_get_check_status`
- repair drift with `repo_rebase_session`

### `repo_write_file` vs `git apply`

`repo_run_commands` accepts `git apply <<'PATCH' ... PATCH` heredocs for true
unified diffs (see [`git apply` patch format](#git-apply-patch-format)). That
form is fragile when you do not have the exact surrounding context lines — a
common situation for AI-authored single-file job sources or freshly generated
files.

`repo_write_file` overwrites one or more files with full new content and returns
a per-file diff plus a `changed` flag. Reach for it when:

- replacing the entire body of a job, app server, or skill module
- writing a freshly generated package file that does not yet exist
- patching a one-line config when you do not want to hand-craft a diff hunk

It only mutates the live session overlay. Pair it with `repo_run_commands` for
`git add`/`git commit` and `repo_publish_session` (or `repo_run_commands` with
`publish: true`) when you are ready to publish.

For non-package repo-backed scheduled job source you can also short-circuit
sessions entirely by passing a replacement `code` string to `job_update`, which
republishes the job module without opening a session.

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
await codemode.repo_run_commands({
	target: { kind: 'package', kody_id: 'triage-github-pr' },
	commands: `git apply <<'PATCH'
--- a/src/index.ts
+++ b/src/index.ts
@@ -1 +1 @@
-return { status: "todo" }
+return { status: "done" }
PATCH
git add .
git commit -m "Mark triage complete"`,
	run_checks: true,
	publish: true,
})
```

This returns the session metadata, per-command results, check outcome, and
publish result in one structured response.
