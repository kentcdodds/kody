---
id: flake_hunter
title: Flake Hunter
summary:
  Homepage cron example: a package-owned daily job that scans CI for flaky
  end-to-end runs, stays quiet on a clean day, and only acts when a flake
  signal is present. Load this when someone asks how Flake Hunter works or how
  to hang a schedule on a package they own.
category: platform
---

# Flake Hunter

The homepage **Trigger it** card labeled Cron is this example. A schedule is
optional, not the product. The product is a package you own that can run while
your laptop is closed, with no model in the loop and no tokens spent.

Live public package:
[`@kentcdodds/e2e-flake-hunter`](https://kody.codes/@kentcdodds/e2e-flake-hunter).
Fork that listing when you want the same hunt on your repo. The primitive is
documented in [Jobs, workflows, and webhooks](./triggers.md).

## The job

Every day at 4am America/Denver, the published package scans the last 24 hours
of GitHub Actions jobs on `kentcdodds/kody`. If any job indicates e2e flakiness,
it starts **one** investigation. A clean day is silent.

That is the factory loop from [How Kody works](./how-kody-works.md) aimed at CI
noise: ask once, save the scan, trigger it on a cron.

Kent's copy also spawns one Cursor Cloud Agent when a flake signal is present.
Obvious fixes ship through the repo's ship-pr path. A non-obvious flake becomes
a written recommendation emailed to Kent with a link to the investigating agent.
Your fork can stop at "scan and notify" if you do not want an agent spawned.

## Package shape

Declare the schedule in `package.json#kody.jobs` so it travels with the code it
runs:

```json
{
	"kody": {
		"jobs": {
			"daily": {
				"entry": "./src/daily.ts",
				"schedule": { "type": "cron", "expression": "0 4 * * *" },
				"timezone": "America/Denver",
				"enabled": false
			}
		}
	}
}
```

Publish with `"enabled": false`. The entry is a no-argument wrapper. The usual
shape is a thin module that calls a callable export and notifies only when there
is news:

```ts
import sweep from './sweep.ts'

export default async function daily() {
	return await sweep()
}
```

Keep the scan itself callable from `execute` so you can prove it before the
clock does:

```ts
import scan from 'kody:@you/e2e-flake-hunter/scan'

export default async function main() {
	return await scan()
}
```

- Shared implementation accepts an optional cursor (`since` / last seen run id)
  and returns `{ flakes, message }`.
- A read-only `./scan` export never spawns work and never sends mail. Use it
  from chat and from the scheduled wrapper's dry path.
- A `./sweep` export runs the scan, records the newest run id in
  `packageStorage()`, and only then starts one investigation or `emailSend`.
- `emailSend` only mails the account's own verified address. Skip it when
  `flakes.length === 0`. An empty digest every morning trains people to ignore
  the real one.
- Each job run gets a job-scoped scratch bucket. The cursor belongs in
  `packageStorage()`, not in the scratch bucket.

`jobRunNow` fires one run for debugging. `jobUpdate` flips `enabled` after that
run looks right. Name and source stay in the repo.

## Example prompts

Paste one of these into an agent already connected to your Kody account.

**Build one**

> Search Kody for flake hunter and official job guides. I want a daily cron that
> scans the last 24 hours of GitHub Actions jobs on this repo for e2e flakes.
> Stay quiet when the day is clean. If a flake signal is present, record it and
> mail me once. Publish with the job disabled, invoke the wrapper from execute,
> then enable it only after that run looks right.

**Fork the public one**

> Open https://kody.codes/@kentcdodds/e2e-flake-hunter, fork it into my account,
> and adapt it to my repo. Keep the daily job disabled until we have invoked
> `./daily` once. Prefer `./scan` for the first check. Do not disable a live job
> on Kent's package.

**Operate an existing copy**

> Import `kody:@me/e2e-flake-hunter/status` and tell me whether today's sweep
> ran, whether the kill switch is on, and what the last outcome was. If I want
> it quiet for a bit, use `./pause` rather than disabling the job.

## What you see

| Surface             | What it is for                                                              |
| ------------------- | --------------------------------------------------------------------------- |
| Chat (`execute`)    | Invoke `./scan`, `./sweep`, or `./daily` and read a structured result       |
| `/account/jobs`     | The `daily` row, enable/disable, timezone, and "run now"                    |
| `/account/activity` | Failures and recent runs for that job                                       |
| Your inbox          | Mail only when the sweep found something worth saying                       |
| Package listing     | Public page at `/@username/e2e-flake-hunter` after you publish a named copy |

The homepage card is a tile with the kicker **Cron** and the title **Flake
Hunter**. It links here so the marketing example and the docs stay the same
story.

## Where to go next

- [Jobs, workflows, and webhooks](./triggers.md) — when to pick a job versus a
  webhook, a subscription, or the inbox.
- [Package lifecycle](./package-lifecycle.md) — test a scheduled wrapper before
  enabling it.
- [How Kody works](./how-kody-works.md) — the quieter daily-email loop this
  example is built on.
- [Sentry Issues](./sentry-issues.md) — the webhook sibling on the same homepage
  row.
