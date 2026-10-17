# Repo health

Budgets for this repository are enforced in CI and in-repo checkers. Agents run
`npm run validate` (and ship-pr for review-bot sort). There is no separate
package gate.

| Budget                    | Where it fails                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `AGENTS.md` line cap | File-size ratchet (`agents-md` group, 20 lines after oxfmt, not grandfatherable) via `npm run file-size-ratchet:check` / Validate 🧹 Static. Do not add another AGENTS.md check.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Unit test time            | Validate `🧪 Node` fails **itself** when that job's wall-clock exceeds ≤720s (`tools/ci/enforce-unit-job-budget.ts`). `☁️ Workers` soft-caps each suite **attempt** at ≤720s and retries once on timeout exit 124, or kill-after 137 only after that soft deadline, so a mid-suite cancel does not fail ✅ Validate (#3763); early SIGKILL and real assertion failures never retry. On retry the post-suite check measures the successful attempt only, so overall Workers wall can exceed 720s (job `timeout-minutes: 30` is the hard cap). Cache hit or miss does not change the attempt cap. No separate workflow or follow-up reporter. |
| Review-bot comment sort   | [ship-pr](../../.agents/skills/ship-pr/SKILL.md) via `@kentcdodds/ship-pr` (Bugbot / Devin / Seer). Invalid findings get a short kody-bot reply; valid and unsure stay blockers unless a human or kody-bot reply cites the fixing commit or a wontfix, or a 7-day decision states why; unsure is never auto-dismissed from wording alone. Not a CI job.                                                                                                                                                                                                                                                                                     |

Do not delete or skip tests to stay under the unit-time budget. Any overrun of
the cold-run caps fails the job.

## Agent entry (review-bot sort)

The sort lives in the `@kentcdodds/ship-pr` Kody package (`./tick` embeds it):

```bash
npx @kodycodes/cli execute --local \
  --code 'import run from "kody:@kentcdodds/ship-pr/review-sort"; export default (p) => run(p)' \
  --params '{"prUrl":"https://github.com/kody-hq/kody/pull/123"}'
```

Classification only by default; pass `applyInvalidReplies: true` to post the
invalid replies. Gate Bugbot / Devin / Seer via `mustAddress`; CodeRabbit and
other reviewers are listed under `otherThreads`, unclassified.
