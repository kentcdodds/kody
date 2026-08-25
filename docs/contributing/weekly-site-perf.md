# Weekly site performance

Production landing performance is measured every Monday (UTC) against
https://kody.codes/. The collector only answers one question: did something
cross a budget or fail a landing signal?

| Verdict     | What happens                                                                                                                                                                                               |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ok`        | Budgets hold. Existing "Weekly site perf" issues close. No package invoke.                                                                                                                                 |
| `needs-fix` | A tracking issue stays open and the workflow invokes Kent's `weekly-site-perf` Kody package. That package launches a Cursor cloud agent. The agent decides whether to implement a fix or stop for a human. |

The GitHub Action never edits the site and never classifies "human vs
implementable." It measures, upserts the issue, and (when a fix is needed) calls
Kody.

## Measure

```bash
npm run site-perf -- --url https://kody.codes/ --json
```

[`tools/site-perf/collect.ts`](../../tools/site-perf/collect.ts) fetches the
homepage, records HTML weight, `Cache-Control`, the largest same-origin JS
payload, the preloaded LCP image, TTFB, and `Server-Timing` phases (`session`,
`ssr`, plus loader phases such as `code-runs`). When the primary URL is `/`, it
also probes `/onboarding` and `/guides/how-kody-works` for the same timing
snapshot. Those extra pages are observational and do not change the verdict. A
failed extra probe is omitted so homepage classify still runs. Homepage HTML
that lacks an app `ssr` phase is a finding. The collector then classifies
against [`tools/site-perf/budget.json`](../../tools/site-perf/budget.json).

[`.github/workflows/weekly-site-perf.yml`](../../.github/workflows/weekly-site-perf.yml)
runs that collector on Mondays at 14:17 UTC and on `workflow_dispatch`.
`needs-fix` upserts `Weekly site perf: needs a fix`. A later `ok` run closes
that issue (and the older `actionable` / `human review` titles).

## Kody package invoke

When the verdict is `needs-fix` and `KODY_PACKAGE_INVOCATION_TOKEN` is set, the
same job `POST`s
`https://kody.codes/@kentcdodds/api/package-invocations/weekly-site-perf/__root__`
with the report. See [package invocation API](./package-invocation-api.md).

The `weekly-site-perf` package owns the agent prompt and calls `createAgent`
from `@kentcdodds/cursor`. The Cursor API key stays a Kody secret on that Cursor
package. The agent implements an obvious local fix when it can, follows
[`.agents/skills/ship-pr/SKILL.md`](../../.agents/skills/ship-pr/SKILL.md), or
leaves the tracking issue open when a human should decide.

Create a scoped invocation token on the `weekly-site-perf` package details page
(`exportNames=.`) at
`https://kody.codes/account/packages/<weekly-site-perf-package-id>?newToken=1&name=Weekly%20site%20perf&exportNames=.`
and store the raw value as the repository (or org) secret
`KODY_PACKAGE_INVOCATION_TOKEN`. Do not put the raw token in the URL. See
[setup manifest](./setup-manifest.md).

If the secret is unset, the workflow still measures and upserts the issue. It
skips the invoke so the weekly job stays green.

Retries of the same GitHub run reuse
`idempotencyKey: weekly-site-perf:<GITHUB_RUN_ID>`. A successful invoke that
returns an agent URL comments it on the open needs-fix issue.

## What the homepage already does

Anonymous `/`, `/pricing`, `/blog`, `/community`, `/onboarding`, `/guides`, and
`/guides/:slug` HTML is `public, max-age=60, stale-while-revalidate=300` with
`Vary: Cookie`. Anonymous `/onboarding.json` uses the same cache with
`Vary: Cookie`. Guide JSON (`/guides/:slug.json`) is shared publicly without a
cookie vary because the body is the same for every visitor. Any `kody_session`
cookie, a resolved session, or a `Set-Cookie` response stays `no-store` on HTML.
Auth, OAuth, and account pages never use the short CDN cache.

Landing layout CSS lives in `packages/worker/public/styles.css` (`.landing-*`)
so SSR does not emit a Remix style tag per marketing node. Hero and below-fold
art ship `srcset` variants. The homepage waitlist loads Turnstile only when the
form is near the viewport. Login, signup, and verify still load the widget
immediately.

## Budget

Edit [`tools/site-perf/budget.json`](../../tools/site-perf/budget.json) when the
live site has a new honest baseline. Bump a threshold only after the change is
on production and the collector agrees.

`htmlBytes` counts the full anonymous document, including the intentionally
inlined `styles.css` `<style>` block (see
[`inline-stylesheet.ts`](../../packages/worker/src/app/inline-stylesheet.ts)).
That trade removes a render-blocking stylesheet round trip; do not "fix" an
`html-over-budget` finding by switching back to a `<link rel="stylesheet">`
without a product call. When landing CSS grows for real product work, raise
`htmlBytes` to the new honest production size instead.
