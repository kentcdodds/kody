# Repo-backed editing sessions

Saved packages keep their durable source in artifact repos. Once a package
exists, that repo-backed source is the source of truth for later edits and
publishes.

Use the repo capabilities when you want to inspect or modify package source
directly.

## Why `repo_edit_flow` returns `edits`

`repo_edit_flow` returns the applied `edits` array by default.

That response shape favors one-shot agent workflows:

- the caller can inspect exactly what changed without issuing extra read calls
- checks and publish results can be paired with the concrete file diffs that
  produced them
- retries and repair logic can reason over one structured result instead of
  reconstructing state from a session after the fact

This is especially useful for auditability and for agents that need to explain
their work immediately after an edit flow finishes.

The tradeoff is response size. Large edit batches can produce a large `edits`
payload, which may be wasteful for callers that only need session, checks, or
publish status. When response size matters more than a self-contained result,
use the lower-level repo capabilities instead of `repo_edit_flow` so you can
choose when to read file contents or diffs.

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

You can still pass `source_id` when you already have it, but most callers should
prefer `target`.

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
- avoid returning the full `edits` payload from one convenience workflow
- run checks separately from publish
- inspect status with `repo_get_check_status`
- repair drift with `repo_rebase_session`

## Example

```ts
await codemode.repo_edit_flow({
	target: { kind: 'package', kody_id: 'triage-github-pr' },
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

This returns the session metadata, applied edits, check outcome, and publish
result in one structured response. The response is intentionally self-contained,
which is why the `edits` array is included by default.
