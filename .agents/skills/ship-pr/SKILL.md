---
name: ship-pr
description: >
  Ship a pull request end-to-end: mark ready for review, loop on CI failures and
  AI reviewer bot feedback until green, optionally merge and verify production
  deploy with manual smoke testing, then notify Kent on Discord via Kody. Use
  when asked to ship a PR, mark ready for review, loop on CI, merge and verify,
  or send a Discord notification about a PR.
metadata:
  discord-channel-id: ''
  production-url: 'https://heykody.dev'
---

# Ship PR

Orchestrate PR shipping from draft → green CI → (optional) merge → Discord
notification. Compose the existing CI and review skills instead of redefining
their steps.

## Inputs

Resolve at the start of every run:

| Input                  | Default                       | Notes                                                    |
| ---------------------- | ----------------------------- | -------------------------------------------------------- |
| **mode**               | `ready-for-review`            | `merge-and-verify` adds merge, deploy watch, manual test |
| **discord-channel-id** | `metadata.discord-channel-id` | Required before sending Discord; ask if empty            |
| **production-url**     | `metadata.production-url`     | Health check target for merge mode                       |

If the user says "merge it", "ship to prod", or "verify deploy", use
`merge-and-verify`. Otherwise default to `ready-for-review`.

## Prerequisites

Before starting, confirm:

1. **Active PR** for the current branch (`gh pr view`).
2. **`gh` authenticated** with permission to push, mark ready, and (merge mode)
   merge.
3. **Kody MCP connected** with:
   - Saved package `@kentcdodds/discord-gateway` (kody id `discord-gateway`)
   - Secret `discordBotToken`
   - Package invocation token for `./post-message`

If Discord setup is missing, stop before the notification step and link the user
to Kody secret/token setup — never ask for tokens in chat.

## Related skills (read when activated)

| Step                                | Skill             |
| ----------------------------------- | ----------------- |
| CI watch loop                       | `loop-on-ci`      |
| Fix failing checks                  | `fix-ci`          |
| Summarize review feedback           | `get-pr-comments` |
| PR description recap (kody repo)    | `visual-recap`    |
| Manual browser testing (merge mode) | `control-ui`      |

## Workflow

### A. Prepare

```bash
gh pr view --json number,url,title,isDraft,headRefName,baseRefName,reviewDecision
gh pr ready
```

Marking ready matters in this repo: **Validate** and **Preview** workflows skip
draft PRs. CI will not run until the PR is ready for review.

If the repo has `.agents/skills/visual-recap/SKILL.md`, upsert the system recap
block before entering the loop (recap mode).

### B. Loop until exit

Repeat until **all required checks pass** and **no unaddressed valid bot
feedback** remains.

#### 1. CI status

Follow **loop-on-ci**. Use `gh pr checks` as the source of truth (not
`gh run list` alone):

```bash
gh pr checks --json name,bucket,state,workflow,link
gh pr checks --watch --fail-fast   # when checks are pending
```

If any check is in `FAIL`/`CANCEL`/`SKIPPED` when it should have run, follow
**fix-ci** before continuing.

#### 2. Fix failures

Follow **fix-ci**:

- One root cause per commit when possible.
- Never bypass hooks (`--no-verify`).
- After each push, re-run `gh pr checks --json name,bucket,state,workflow,link`.

#### 3. AI reviewer bot feedback

Follow **get-pr-comments**, then fetch raw comments when needed:

```bash
gh pr view --comments
gh api repos/{owner}/{repo}/pulls/{number}/comments
gh api repos/{owner}/{repo}/pulls/{number}/reviews
```

**Valid feedback** (must fix or explicitly rebut in a PR comment):

- Correctness, security, or regression issues backed by the diff.
- CI-related suggestions that match an actual failure.
- Repeated bot themes (same comment class twice → treat as valid).

**Ignore** (do not loop on):

- Style-only nits already covered by lint/format.
- Issues already fixed in the latest commit (verify against diff).
- Hallucinated file/line references or suggestions contradicted by the code.
- Subjective preferences with no project rule backing them.

Optionally launch the **Bugbot** subagent for a deeper pass on large or risky
diffs. Bot output still goes through the validity filter above.

#### 4. Exit condition

Break the loop when:

- Every attached check is `PASS` or legitimately `SKIPPING`, and
- No valid unaddressed bot feedback remains.

If you fixed anything in steps 2–3, commit, push, and **go back to step 1**.

### C. Mode branch

#### Mode: `ready-for-review`

Send Discord via Kody (see **Discord notification** below):

- PR title and URL
- One line: CI green, bot feedback addressed, ready for human review

#### Mode: `merge-and-verify`

Only when the user explicitly wants merge + deploy verification.

1. **Pre-merge gate** — re-check:

   ```bash
   gh pr checks --json name,bucket,state,workflow,link
   gh pr view --json mergeable,mergeStateStatus,reviewDecision
   ```

   Do not merge with failing required checks or unresolved merge conflicts.

2. **Merge** (adjust flags if the user specifies otherwise):

   ```bash
   gh pr merge --squash --delete-branch
   ```

3. **Watch production deploy** — kody deploys after Validate succeeds on `main`:

   ```bash
   gh run list --workflow="🚀 Deploy (production)" --branch main --limit 1 \
     --json databaseId,status,conclusion,url
   gh run watch <run-id> --exit-status
   ```

4. **Manual smoke test** — follow **control-ui** (or equivalent):
   - `curl -sf "${production-url}/health"` → `{"ok":true,...}`
   - One critical user flow relevant to the PR (sign-in, changed route, MCP
     health, etc.)
   - Record what was tested and the outcome.

5. **Discord summary** — what merged, deploy run URL/status, smoke test notes,
   and link to the (now merged) PR.

## Discord notification (Kody)

1. Discover the package API (first run or when unsure):
   ```
   search({ entity: "discord-gateway:package" })
   ```
2. Send via `execute`:

```javascript
import { packages } from 'kody:runtime'

export default async function main({ channelId, content }) {
	return packages.invokeChecked({
		kodyId: 'discord-gateway',
		exportName: './post-message',
		params: { channelId, content },
	})
}
```

Pass `channelId` from skill metadata or user input. Keep messages short; use
markdown links for PR and deploy URLs.

## Guardrails

- Do not merge unless **mode** is `merge-and-verify` and intent is explicit.
- Do not merge with failing required checks.
- Do not bypass git hooks or force-push to main.
- Do not send Discord until the success criteria for the chosen mode are met.
- If CI failures are clearly unrelated and fixed on `main`, merge latest main
  instead of unrelated fixes in the PR.
- If checks are flaky, retry once and note flake evidence before looping again.

## Output

Report back with:

- PR URL and final CI status
- Fixes applied during the loop (if any)
- Bot feedback addressed vs dismissed (brief)
- Discord delivery confirmation
- **Merge mode only:** merge SHA, deploy run URL, smoke test notes
