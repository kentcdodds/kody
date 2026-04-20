# Repo-backed editing sessions

Repo-backed saved skills, jobs, and apps keep their durable source in artifact
repos. After an artifact exists, that repo-backed source is the source of truth
for later edits and publishes.

Use the repo capabilities when you want to inspect or modify that saved source
directly.

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

## Opening by user-facing identity

`repo_open_session` and `repo_edit_flow` open repo-backed entities by their
user-facing identity instead of requiring the internal `source_id`.

Examples:

```json
{ "target": { "kind": "skill", "name": "triage-github-pr" } }
```

```json
{ "target": { "kind": "job", "job_id": "job-123" } }
```

```json
{ "target": { "kind": "job", "name": "Nightly inbox sweep" } }
```

```json
{ "target": { "kind": "app", "app_id": "app-123" } }
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
- run checks separately from publish
- inspect status with `repo_get_check_status`
- repair drift with `repo_rebase_session`

## Example

```ts
await codemode.repo_edit_flow({
	target: { kind: 'skill', name: 'triage-github-pr' },
	instructions: [
		{
			kind: 'replace',
			path: 'src/skill.ts',
			search: 'return { status: "todo" }',
			replacement: 'return { status: "done" }',
		},
	],
})
```

This returns the session metadata, applied edits, check outcome, and publish
result in one structured response.
