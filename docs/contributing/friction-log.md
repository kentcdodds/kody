# Friction log

Contributor and agent papercuts while working in this repository live as GitHub
issues labeled `friction`. They are not files in the tree.

This is not [platform friction](../../guides/platform-friction.md). That guide
is for user-facing Kody product feedback. This page is for developing the
`kentcdodds/kody` repo: confusing docs, a test that only fails locally, a
command that needs a secret handshake, a type that lies.

The policy lives here. Agents load
[`.agents/skills/friction-log/SKILL.md`](../../.agents/skills/friction-log/SKILL.md)
when they hit friction or when they are the daily investigator.

## File an entry

Search open `friction` issues first. Comment on a match instead of opening a
duplicate.

Title: `Friction: <what hurt>`.

Label: `friction`.

Use the [Friction issue form](../../.github/ISSUE_TEMPLATE/friction.yml) or:

```bash
gh issue create --repo kentcdodds/kody --title "Friction: …" --label friction --body-file -
```

Write one issue per papercut. Include what you were doing, the unexpected cost,
the workaround, and enough reproduction to investigate without the original
session. Omit secrets, tokens, and unrelated private content.

Do not commit a `.agents/friction-log/` directory. GitHub is the log.

## Daily investigation

Kent's `@kentcdodds/friction-log` package runs a daily job at 05:00
America/Denver. It lists open `friction` issues and, when any are eligible,
spawns one Cursor Cloud Agent on `kentcdodds/kody` `main`.

The investigator chooses one outcome per issue:

| Outcome       | What happens                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Already fixed | Closes the issue with the evidence.                                                                                                              |
| Invalid       | Closes the issue (not repo friction, duplicate, or not actionable).                                                                              |
| Skip          | Comments a recommended fix and marks the issue skipped until @kentcdodds replies.                                                                |
| Fix           | Opens a PR and follows [ship-pr](../../.agents/skills/ship-pr/SKILL.md). Low and medium risk may squash-merge. High risk stays ready-for-review. |

A skip comment includes `<!-- friction-log:skipped -->`. Later daily runs ignore
that issue until @kentcdodds comments (approve the recommendation, close it, or
give a different approach).

## Operator controls

| Export                                 | Purpose                                        |
| -------------------------------------- | ---------------------------------------------- |
| `kody:@kentcdodds/friction-log/scan`   | Read-only eligibility scan. No agent.          |
| `kody:@kentcdodds/friction-log/sweep`  | Scan and optionally spawn (`dryRun`, `force`). |
| `kody:@kentcdodds/friction-log/pause`  | Kill switch: stop spawning.                    |
| `kody:@kentcdodds/friction-log/resume` | Re-enable spawning.                            |
| `kody:@kentcdodds/friction-log/status` | Kill switch, today's sweep, recent outcomes.   |

The 05:00 job calls `./daily`, the no-arg wrapper around `sweep`.
