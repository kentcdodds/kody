# Repo-backed editing sessions

Saved packages keep their durable source in artifact repos. Once a package
exists, that repo-backed source is the source of truth for later edits and
publishes.

Use the repo capabilities when you want to inspect or modify package source
directly.

## `edits` payload

`repo_edit_flow` returns `edits.dry_run` and `edits.total_changed` by default.

The full `edits.edits` array is opt-in through `include_edits: true`.

That keeps the default response small for agent workflows that only need
session, checks, publish status, or a count of changed files, while allowing
callers to request the concrete changed content and diff when they need audit or
explanation detail.

## Preferred workflow

For common edits, prefer **`repo_edit_flow`**.

It combines the usual sequence into one capability:

1. open or reuse a repo session
2. apply structured edits
3. run Worker-native checks
4. optionally publish

That keeps normal edit workflows to one capability call instead of separate
`repo_open_session` + `repo_apply_patch` + `repo_run_checks` +
`repo_publish_session` calls.

## Opening by package identity

`repo_open_session` and `repo_edit_flow` can open repo-backed packages by
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

- **`blocked_by_checks`** when checks fail inside `repo_edit_flow`
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
- apply multiple edit batches over time
- inspect file contents or diffs only when you decide to read them
- run checks separately from publish
- inspect status with `repo_get_check_status`
- repair drift with `repo_rebase_session`

## Example

```ts
await codemode.repo_edit_flow({
	target: { kind: 'package', kody_id: 'triage-github-pr' },
	include_edits: true,
	instructions: [
		{
			kind: 'replace',
			path: 'src/index.ts',
			search: 'return { status: "todo" }',
			replacement: 'return { status: "done" }',
		},
	],
})
```

This returns the session metadata, edit summary, check outcome, and publish
result in one structured response. Set `include_edits: true` when you also want
the full applied edit list with file content and diffs.
