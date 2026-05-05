# Repo-backed editing sessions

Saved packages keep their durable source in artifact repos. Once a package
exists, that repo-backed source is the source of truth for later edits and
publishes.

Use the repo capabilities when you want to inspect or modify package source
directly.

## Preferred workflow

For package edits, use **`repo_run_commands`**.

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
- inspect file contents or diffs only when you decide to read them
- run checks separately from publish
- inspect status with `repo_get_check_status`
- repair drift with `repo_rebase_session`

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
