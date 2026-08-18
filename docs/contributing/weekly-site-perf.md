# Weekly site performance

Production landing performance is measured every Monday (UTC) against
https://kody.codes/. The loop has three outputs:

| Verdict      | What happens                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `ok`         | Budgets hold. Existing "Weekly site perf" issues close. No cloud agent.                                          |
| `actionable` | A tracking issue stays open and the workflow launches a Cursor cloud agent to implement the budget-backed fixes. |
| `human`      | A tracking issue stays open. No cloud agent — a person decides.                                                  |

The GitHub Action never edits the site. It measures, upserts the issue, and
(when the verdict is `actionable`) starts a cloud agent.

## Measure

```bash
npm run site-perf -- --url https://kody.codes/ --json
```

[`tools/site-perf/collect.ts`](../../tools/site-perf/collect.ts) fetches the
homepage, records HTML weight, `Cache-Control`, the largest same-origin JS
payload, and the preloaded LCP image, then classifies against
[`tools/site-perf/budget.json`](../../tools/site-perf/budget.json).

[`.github/workflows/weekly-site-perf.yml`](../../.github/workflows/weekly-site-perf.yml)
runs that collector on Mondays at 14:17 UTC and on `workflow_dispatch`. A
verdict other than `ok` upserts a tracking issue (`Weekly site perf: actionable`
or `Weekly site perf: human review`). A later `ok` run closes those issues.

## Cloud agent

When the verdict is `actionable` and `CURSOR_API_KEY` is set, the same job
`POST`s
[https://api.cursor.com/v1/agents](https://cursor.com/docs/cloud-agent/api/endpoints)
with the report embedded in the prompt. The agent starts from `main`, opens a
PR, and follows
[`.agents/skills/ship-pr/SKILL.md`](../../.agents/skills/ship-pr/SKILL.md)
(green CI, AI reviewers on medium risk, squash-merge when policy allows).

Create a Cursor API key at
[https://cursor.com/dashboard/api](https://cursor.com/dashboard/api) and store
it as the repository (or org) secret `CURSOR_API_KEY`. The key's Cursor account
must have GitHub access to this repository. See
[setup manifest](./setup-manifest.md).

If the secret is unset, the workflow still measures and upserts the issue. It
skips the launch so the weekly job stays green.

The launch is idempotent per GitHub run: `agentId` is derived from
`GITHUB_RUN_ID`. A retry of the same workflow run gets HTTP 409
`agent_id_conflict` and is treated as already launched. A successful launch
comments the agent URL on the open actionable issue.

The generated prompt is the contract. The agent implements only the report's
`actionable` findings (not `human`), verifies with the smallest related tests,
and does not convert `kody-mark.png` to SVG, invent Lighthouse numbers this
collector does not measure, or change Worker env, Turnstile, auth, or sessions
to "fix" cache.

## What the homepage already does

Anonymous `/`, `/pricing`, `/blog`, and `/community` HTML is
`public, max-age=60, stale-while-revalidate=300` with `Vary: Cookie`. Any
`kody_session` cookie, a resolved session, or a `Set-Cookie` response stays
`no-store`. Auth, OAuth, and account pages never use the short CDN cache.

Landing layout CSS lives in `packages/worker/public/styles.css` (`.landing-*`)
so SSR does not emit a Remix style tag per marketing node. Hero and below-fold
art ship `srcset` variants. The homepage waitlist loads Turnstile only when the
form is near the viewport. Login, signup, and verify still load the widget
immediately.

## Budget

Edit [`tools/site-perf/budget.json`](../../tools/site-perf/budget.json) when the
live site has a new honest baseline. Bump a threshold only after the change is
on production and the collector agrees.
