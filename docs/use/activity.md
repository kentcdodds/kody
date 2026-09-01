# Activity

When a job fails, a package app crashes, or a webhook delivery rejects, Kody
keeps a short execution history so you (and your agent) can see what happened.

[Waiting](./waiting.md) is the current-state queue of gates only you can clear.
Activity is history; it does not replace Waiting.

## Where to look

Open **`/account/activity`** while signed in. The page defaults to **open
failures first**, and a **Recent runs** view lists the last 7 days of history
(successes, running work, and errors) from the same records:

- a short summary of recent totals, open errors, and ignored/resolved counts
- a view toggle between **Open errors** and **Recent runs**
- filters by status (including success), triage (open / ignored / resolved /
  all), and runtime surface (jobs, webhooks, package apps, workflows, and
  others)
- a detail view with captured log lines and any triage note
- cursor pagination for older pages

Ignored and resolved error runs stay in history but are hidden from Open errors
so soft-failures and already-fixed noise do not clutter triage. Recent runs
shows them unless you change the triage filter.

From **`/account/jobs`**, each job’s recent runs link into the same Activity
detail view.

## Ask your agent

`/account/activity` includes a short copyable prompt that tells your agent to
review open errors and recommend whether to ignore, resolve, or fix them.

The MCP **`runs`** domain reads and triages the same data:

- **`runSummary`** — “is anything broken?” open-error totals (plus ignored /
  resolved counts) and per-surface breakdown
- **`runList`** — filtered history (by surface, status, job, package, time, and
  `error_triage`; defaults to **open**, hiding ignored/resolved). Pass `status`
  `success` (or omit `status` with `error_triage` `all`) to inspect what ran.
- **`runGet`** — one run plus its log lines and triage fields
- **`runUpdate`** — mark a retained **error** run as `ignored` or `resolved` (or
  `open` to clear triage), with an optional note — non-destructive soft triage;
  error details stay intact
- **`runUpdateBulk`** — preview (`dry_run`) and soft-triage up to 100 errors at
  a time by explicit run ids or exact job/package/surface/name/error filters;
  repeat while `has_more` is true

When a scheduled job later succeeds, Kody automatically marks earlier **open**
errors for that same `job_id` resolved. Their execution status remains `error`,
their error details and logs remain inspectable, and errors you explicitly
ignored are not overwritten.

Search for “runs”, “failures”, “ignore this error”, or “why did my job stop
working” if your host does not surface those names yet.

## What is retained

Records are kept about **30 days** and capped per account. At the count cap,
handled errors are pruned first, then successes, while open errors are retained
last. Soft triage never deletes immediately: every row remains inspectable until
normal retention prunes it. Payload bodies for inbound webhooks are never stored
— only delivery metadata, a bounded handler-result snapshot when available, and
logs. Package exports and keyed execute runs similarly retain a small
`metadata.result` snapshot (truncated when large).

## Successful key-less `execute` calls are not listed

Ad-hoc MCP **`execute`** calls that succeed **without** an `idempotencyKey` are
**not** written to Activity. You already get the result and logs in the tool
response, and success volume is tracked separately for usage. **Failed**
`execute` calls do appear, and execute calls that pass an `idempotencyKey` are
recorded eagerly (including successes) so a client-side timeout can recover via
`runGet` or a keyed retry. Every other surface (jobs, webhooks, package apps,
workflows, exports, and so on) records both success and error.

If a successful one-off `execute` without a key is missing from Activity, that
is expected — check the original tool result instead. See
[Execute and workflows](./execute.md) for keyed recovery.

## React to failures from a package

Packages can subscribe to the `run.error.recorded` topic in
`package.json#kody.subscriptions`. When one of your runs finishes with an error,
Kody dispatches a metadata-first event (run identifiers, truncated error fields,
and an `activity_url` link to this page) to matching handlers in your account.
Use that to email yourself, write to a sheet, spawn an agent, or otherwise
follow up. See [Packages](./packages.md) and the
[package subscriptions guide](../guides/package-subscriptions.md).

## Related

- [Execute and workflows](./execute.md)
- [Workflows](./workflows.md)
- [Inbound webhooks](./webhooks.md)
- [Packages](./packages.md)
- [Troubleshooting](./troubleshooting.md)
