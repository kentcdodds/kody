# Repo-backed package workbenches

Saved packages keep their durable source in artifact repos. Once a package
exists, that repo-backed source is the source of truth for later edits and
publishes.

Use **`package_shell_open`** and **`package_shell_exec`** when you want to edit
package source. The shell workbench is the package authoring primitive: agents
can run normal git, npm, formatter, generator, and test commands against the
package repo.

Kody still owns the platform gates:

1. edit with `package_shell_exec`
2. commit and push from the shell workbench
3. validate with `package_check`
4. publish with `package_publish`

## Opening by package identity

`package_shell_open` can open repo-backed packages by user-facing identity
instead of requiring the internal `source_id`.

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

- **`checks_outdated`** when a session changed after the last successful check
- **`base_moved`** with `repair_hint: "repo_rebase_session"` plus both the
  session base commit and current published commit

That makes it easier for agents to resume or repair a workflow without string
parsing.

## When to use repo inspection capabilities

Use repo capabilities when you need to inspect, search, check, publish, or
repair a session:

- browse files with `repo_tree` and `repo_read_file`
- search the workspace with `repo_search`
- run checks separately from publish
- inspect status with `repo_get_check_status`
- repair drift with `repo_rebase_session`

## Example

```ts
const opened = await codemode.package_shell_open({
	target: { kind: 'package', kody_id: 'triage-github-pr' },
})

await codemode.package_shell_exec({
	session_id: opened.session_id,
	command:
		'if [ ! -d "$KODY_PACKAGE_DIR/.git" ]; then git clone "$KODY_PACKAGE_REMOTE" "$KODY_PACKAGE_DIR"; fi && cd "$KODY_PACKAGE_DIR" && npm test && git status',
})
```
