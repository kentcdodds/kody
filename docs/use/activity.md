# Activity

When a job fails, a package app crashes, a webhook delivery rejects, or a
service wake errors, Kody keeps a short execution history so you (and your
agent) can see what happened.

## Where to look

Open **`/account/activity`** while signed in. The page defaults to **failures
first**, with:

- a short summary of recent totals and errors
- filters by status and runtime surface (jobs, webhooks, package apps, services,
  workflows, and others)
- a detail view with captured log lines
- cursor pagination for older pages

From **`/account/jobs`**, each job’s recent runs link into the same Activity
detail view.

## Ask your agent

The MCP **`runs`** domain reads the same data:

- **`run_summary`** — “is anything broken?” totals and per-surface breakdown
- **`run_list`** — filtered history (by surface, status, job, package, time)
- **`run_get`** — one run plus its log lines

Search for “runs”, “failures”, or “why did my job stop working” if your host
does not surface those names yet.

## What is retained

Records are kept about **30 days**, capped per account, and pruned so failures
tend to outlive successes. Payload bodies for inbound webhooks are never stored
— only delivery metadata and logs.

## Successful `execute` calls are not listed

Ad-hoc MCP **`execute`** calls that succeed are **not** written to Activity. You
already get the result and logs in the tool response, and success volume is
tracked separately for usage. **Failed** `execute` calls do appear. Every other
surface (jobs, webhooks, package apps, services, workflows, exports, and so on)
records both success and error.

If a successful one-off `execute` is missing from Activity, that is expected —
check the original tool result instead.

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
