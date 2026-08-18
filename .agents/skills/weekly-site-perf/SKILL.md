---
name: weekly-site-perf
description: >
  Measure production landing-page performance, classify the result, and either
  stop, loop in a human, or implement obvious verified fixes and ship them. Use
  for the weekly site-perf automation, after a Pagespeed/Lighthouse regression,
  or when asked to clean up marketing performance.
---

# Weekly site performance

Autonomous cleanup for https://kody.codes/. Measure first. Classify. Act only
inside the verdict. Do not invent a redesign.

## Measure

```bash
npm run site-perf -- --url https://kody.codes/ --json
```

Budgets live in
[`tools/site-perf/budget.json`](../../../tools/site-perf/budget.json). The
collector is
[`tools/site-perf/collect.ts`](../../../tools/site-perf/collect.ts). GitHub
Actions also runs this weekly
([`.github/workflows/weekly-site-perf.yml`](../../../.github/workflows/weekly-site-perf.yml))
and upserts an issue when the verdict is not `ok`.

Optional: confirm with
[PageSpeed Insights](https://pagespeed.web.dev/analysis?url=https://kody.codes/)
(mobile). PSI quota failures are not a verdict; the collector is.

## Classify

Read `verdict` and `findings`. Do not upgrade `ok` because a score “feels” low.
Do not downgrade `human` because a fix looks fun.

| Verdict      | Meaning                                                 | Action                                            |
| ------------ | ------------------------------------------------------- | ------------------------------------------------- |
| `ok`         | Budgets and landing signals hold                        | No code. Optional Discord note. Stop.             |
| `actionable` | Known, local, verifiable fix                            | Implement only the listed findings. Verify. Ship. |
| `human`      | Architectural, third-party, or over the human threshold | Open/update the tracking issue. Discord. Stop.    |

`actionable` examples the collector already names: missing LCP preload, LCP
preload not using the 640w hero, anonymous `/` still `no-store`, Turnstile in
the first HTML, HTML/JS/LCP just over the soft budget.

`human` examples: Shiki back on `/`, JS or HTML past the human threshold, a new
third-party on first paint, or an `actionable` pass that failed verify.

## `ok`

Stop. If this run was scheduled, a one-line Discord summary is enough
(`kody:@kentcdodds/discord/post-message`, channel `1491568683737157683`): things
look good, no action needed, link the report artifact or command output.

## `human`

1. Open or update the GitHub issue titled `Weekly site perf: human review` with
   the JSON report and what you refused to guess at.
2. Discord the same, @ the human owner, include the issue link.
3. Do **not** open a speculative PR.

## `actionable`

Implement the findings only. Typical owners:

- LCP / `srcset` / mark bytes → `packages/worker/universal/landing-images.ts`,
  `packages/worker/public/images/`, `ssr-document.tsx`
- Anonymous HTML cache → `packages/worker/src/app/anonymous-html-cache.ts`
- First-paint third parties → `deferred-turnstile.ts`, homepage waitlist
- Landing CSS / HTML weight → `packages/worker/public/styles.css`,
  `packages/worker/client/routes/home.tsx`
- Entry JS / Shiki leak → `lazy-route.tsx`, `tools/build-client-manifest.ts`

Verify:

```bash
npm run site-perf -- --url https://kody.codes/ --json
# and, for a local change:
npx vitest run --project node-unit tools/site-perf/collect.node.test.ts packages/worker/src/app/anonymous-html-cache.node.test.ts packages/worker/src/app/ssr-render.node.test.ts packages/worker/client/lazy-route.node.test.ts
```

A local `site-perf` against production will not see an unmerged fix. After the
PR deploys, re-run against production before calling the finding closed.

If verify fails or the fix is no longer local, reclassify as `human`.

## Ship obvious, verified fixes

Follow [ship-pr](../ship-pr/SKILL.md):

- Self-assess risk. Marketing HTML/CSS/image/cache work is usually **medium**.
- Mark the PR ready. Wait for CI.
- Medium: wait for AI reviewer(s), address **valid** feedback, run
  `npm run preview:manual-test` with data this change actually needs (often none
  for anonymous `/`; still hit `/` and `/login`).
- When green and reviewers are clear: squash-merge via
  `kody:@kentcdodds/github/pr/merge` `{ prUrl, mergeMethod: 'squash' }`.
- Discord the outcome (merged or not) with agent / PR / CI / deploy links.

Do not auto-merge **high** risk or a `human` verdict.

## Cursor Cloud Automation

This skill is the weekly agent prompt. Create a Cloud Automation that:

1. Runs weekly (Monday is enough; the GitHub workflow already measures).
2. Prompts: “Follow `.agents/skills/weekly-site-perf/SKILL.md` against
   https://kody.codes/.”
3. May implement and merge only on `actionable` + verified + ship-pr policy.

The GitHub workflow does not spawn this agent. It pages humans on `human` and
leaves an issue on `actionable` so a missed Automation still has a paper trail.
