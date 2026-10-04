# Repo health

Autonomous **repo-health budgets** for this repository live in one Kody package
— [`@kentcdodds/repo-health`](https://kody.codes/@kentcdodds/repo-health) — not
as separate bots or automations per concern. Checks are data in that package. A
schedule and a pull-request webhook share the same runner.

When an **enforced** budget moves the wrong way, the package files a GitHub
friction issue via `kody:@kentcdodds/friction-log/create` on `kentcdodds/kody`
and **stops**. It does not open a fix PR. The [friction log](./friction-log.md)
project ships two-way fixes.

## Enforced now

| Check                     | What fails                                                                                                                                   |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents-md-line-cap`      | Root `AGENTS.md` grows past the package budget (keep aligned with the in-repo `agents-md` line budget in `npm run file-size-ratchet:check`). |
| `test-time-budget`        | Validate `🧪 Node` or `☁️ Workers` exceeds the CI-measured budget + headroom.                                                                |
| `review-bot-comment-sort` | Surfaces Bugbot / Devin / Seer findings for ship-pr; invalid ones get a short kody-bot reply and are not blockers. Unsure stays valid.       |

## Stubbed (same package, not enforced)

`docs-link-rot`, `homepage-perf-bytes`, `accessibility-new-violations` — named
budgets with stub runners until a later PR.

## Agent entry points

```ts
import scan from 'kody:@kentcdodds/repo-health/scan'
import sortReviewBotComments from 'kody:@kentcdodds/repo-health/sort-review-bot-comments'

export default async function main() {
	return {
		scan: await scan({ dryRun: true }),
		sort: await sortReviewBotComments({ prUrl, dryRun: true }),
	}
}
```

ship-pr uses `./sort-review-bot-comments` so only **valid** (and unsure) Bugbot
/ Devin / Seer findings from that export are blockers for those bots. CodeRabbit
and other reviewers stay outside this sort — address their valid feedback
separately. Prefer local CLI execute
([prefer-local-cli-execute](../../.agents/skills/prefer-local-cli-execute/SKILL.md)).
