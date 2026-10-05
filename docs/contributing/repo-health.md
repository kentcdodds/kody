# Repo health

Budgets for this repository are enforced in CI and in-repo checkers. Agents run
`npm run validate` (and ship-pr for review-bot sort). There is no separate
package gate.

| Budget                    | Where it fails                                                                                                                                                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `AGENTS.md` line cap | File-size ratchet (`agents-md` group, 20 lines after oxfmt, not grandfatherable) via `npm run file-size-ratchet:check` / Validate 🧹 Static. Do not add another AGENTS.md check.                                                                                                                                                                        |
| Unit test time            | Validate `🧪 Node` (≤360s) and `☁️ Workers` (≤480s) fail **themselves** when that job's wall-clock exceeds the cold-run baseline (`tools/ci/enforce-unit-job-budget.ts`). Cache hit or miss does not change the cap. No separate workflow or follow-up reporter.                                                                                        |
| Review-bot comment sort   | [ship-pr](../../.agents/skills/ship-pr/SKILL.md) via `@kentcdodds/ship-pr` (Bugbot / Devin / Seer). Invalid findings get a short kody-bot reply; valid and unsure stay blockers unless a human or kody-bot reply cites the fixing commit or a wontfix, or a 7-day decision states why; unsure is never auto-dismissed from wording alone. Not a CI job. |

Do not delete or skip tests to stay under the unit-time budget. Any overrun of
the cold-run caps fails the job.

## Agent entry (review-bot sort)

The sort lives in the `@kentcdodds/ship-pr` Kody package (`./tick` embeds it):

```bash
npx @kodycodes/cli execute --local \
  --code 'import run from "kody:@kentcdodds/ship-pr/review-sort"; export default (p) => run(p)' \
  --params '{"prUrl":"https://github.com/kentcdodds/kody/pull/123"}'
```

Classification only by default; pass `applyInvalidReplies: true` to post the
invalid replies. Gate Bugbot / Devin / Seer via `mustAddress`; CodeRabbit and
other reviewers are listed under `otherThreads`, unclassified.
