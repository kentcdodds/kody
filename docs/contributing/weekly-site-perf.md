# Weekly site performance

Production landing performance is measured every week against
https://kody.codes/. The loop has three outputs:

- **Things look good** — budgets hold; no code change.
- **Significant changes needed** — a human reviews. The measure job opens or
  updates a GitHub issue and the weekly agent stops.
- **Obvious improvements implemented and verified** — the weekly agent (or a
  human following the same skill) lands a focused PR, waits for AI review and
  CI, and squash-merges when the change is low or medium risk.

## Measure

```bash
npm run site-perf -- --url https://kody.codes/ --json
```

[`tools/site-perf/collect.ts`](../../tools/site-perf/collect.ts) fetches the
homepage, records HTML weight, `Cache-Control`, the largest same-origin JS
payload, and the preloaded LCP image, then classifies against
[`tools/site-perf/budget.json`](../../tools/site-perf/budget.json).

[`.github/workflows/weekly-site-perf.yml`](../../.github/workflows/weekly-site-perf.yml)
runs that collector on Mondays and on `workflow_dispatch`. A verdict other than
`ok` upserts a tracking issue (`Weekly site perf: actionable` or
`Weekly site perf: human review`). A later `ok` run closes those issues.

## Agent loop

The durable procedure is
[`.agents/skills/weekly-site-perf/SKILL.md`](../../.agents/skills/weekly-site-perf/SKILL.md).
Create a Cursor Cloud Automation that runs weekly and prompts the agent to
follow that skill. The GitHub workflow does not spawn the agent; it is the
always-on measurement and the human page.

Shipping an `actionable` fix follows
[`.agents/skills/ship-pr/SKILL.md`](../../.agents/skills/ship-pr/SKILL.md):
green CI, AI reviewers on medium risk, then squash-merge as Kody.

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
