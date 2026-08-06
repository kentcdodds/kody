# Activity

When a job fails, a package app crashes, a webhook delivery rejects, or a
service wake errors, Kody keeps a short execution history so you (and your
agent) can see what happened.

## Where to look

Open **`/account/activity`** while signed in. The page defaults to **open
failures first**, with:

- a short summary of recent totals, open errors, and ignored/resolved counts
- filters by status, triage (open / ignored / resolved / all), and runtime
  surface (jobs, webhooks, package apps, services, workflows, and others)
- a detail view with captured log lines and any triage note
- cursor pagination for older pages

Ignored and resolved error runs stay in history but are hidden from the default
view so soft-failures and already-fixed noise do not clutter Activity.

From **`/account/jobs`**, each job’s recent runs link into the same Activity
detail view.

## Ask your agent

`/account/activity` includes a short copyable prompt that tells your agent to
review open errors and recommend whether to ignore, resolve, or fix them.

The MCP **`runs`** domain reads and triages the same data:

- **`run_summary`** — “is anything broken?” open-error totals (plus ignored /
  resolved counts) and per-surface breakdown
- **`run_list`** — filtered history (by surface, status, job, package, time, and
  `error_triage`; defaults to **open**, hiding ignored/resolved)
- **`run_get`** — one run plus its log lines and triage fields
- **`run_update`** — mark a retained **error** run as `ignored` or `resolved`
  (or `open` to clear triage), with an optional note — non-destructive soft
  triage; error details stay intact

Search for “runs”, “failures”, “ignore this error”, or “why did my job stop
working” if your host does not surface those names yet.

## What is retained

Records are kept about **30 days**, capped per account, and pruned so failures
tend to outlive successes. Payload bodies for inbound webhooks are never stored
— only delivery metadata, a bounded handler-result snapshot when available, and
logs. Package exports and keyed execute runs similarly retain a small
`metadata.result` snapshot (truncated when large).

## Successful key-less `execute` calls are not listed

Ad-hoc MCP **`execute`** calls that succeed **without** an `idempotencyKey` are
**not** written to Activity. You already get the result and logs in the tool
response, and success volume is tracked separately for usage. **Failed**
`execute` calls do appear, and execute calls that pass an `idempotencyKey` are
recorded eagerly (including successes) so a client-side timeout can recover via
`run_get` or a keyed retry. Every other surface (jobs, webhooks, package apps,
services, workflows, exports, and so on) records both success and error.

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
