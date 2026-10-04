# Repo health

Budgets for this repository are enforced in CI and in-repo checkers. Agents run
`npm run validate` (and ship-pr for review-bot sort). There is no separate
package gate.

| Budget                    | Where it fails                                                                                                                                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Root `AGENTS.md` line cap | File-size ratchet (`agents-md` group, 20 lines after oxfmt, not grandfatherable) via `npm run file-size-ratchet:check` / Validate 🧹 Static. Do not add another AGENTS.md check.                                                                                 |
| Unit test time            | Validate `🧪 Node` (≤360s) and `☁️ Workers` (≤480s) fail **themselves** when that job's wall-clock exceeds the cold-run baseline (`tools/ci/enforce-unit-job-budget.ts`). Cache hit or miss does not change the cap. No separate workflow or follow-up reporter. |
| Review-bot comment sort   | [ship-pr](../../.agents/skills/ship-pr/SKILL.md) step only (Bugbot / Devin / Seer). Invalid findings get a short kody-bot reply and drop off the blocker list; valid and unsure stay blockers; unsure is never auto-dismissed. Not a CI job.                     |

Do not delete or skip tests to stay under the unit-time budget. Any overrun of
the cold-run caps fails the job.

## Agent entry (review-bot sort)

```bash
node .agents/skills/ship-pr/scripts/sort-review-bot-comments.mjs --pr-url "$PR_URL"
```

Use `--dry-run` to classify without posting invalid replies. Gate Bugbot / Devin
/ Seer via `mustAddress`; CodeRabbit and other reviewers stay outside this sort.
