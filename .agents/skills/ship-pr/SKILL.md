---
name: ship-pr
description: >
  Ship a pull request end-to-end: mark ready for review via Kody, loop on CI
  failures and AI reviewer bot feedback until green, optionally merge and verify
  production deploy with manual smoke testing, then notify Kent on Discord via
  Kody. Resolves Discord destination and deploy URLs from Kody values and repo
  metadata — no hardcoded channel or production URL. Use when asked to ship a
  PR, mark ready for review, loop on CI, merge and verify, or send a Discord
  notification about a PR.
---

# Ship PR

Orchestrate PR shipping from draft → green CI → (optional) merge → Discord
notification. Compose the existing CI and review skills instead of redefining
their steps.

**Do not hardcode Discord channel ids or production URLs.** Resolve them at
runtime from Kody and the repo (see **Resolve context** below). You already have
what you need when Kody MCP is connected.

## Inputs

| Input    | Default            | Notes                                                    |
| -------- | ------------------ | -------------------------------------------------------- |
| **mode** | `ready-for-review` | `merge-and-verify` adds merge, deploy watch, manual test |

If the user says "merge it", "ship to prod", or "verify deploy", use
`merge-and-verify`. Otherwise default to `ready-for-review`.

## Resolve context (always do this first)

Run these lookups once at the start. Cache the results for the rest of the run.

### Kody packages (via `search`)

| Need                               | Kody entity               | Export to use                               |
| ---------------------------------- | ------------------------- | ------------------------------------------- |
| Mark PR ready for review           | `github-pr-tools:package` | `./set-pr-review-status` with `ready: true` |
| PR details                         | `github-pr-tools:package` | `./get-pr-info`                             |
| Notify Kent on Discord (default)   | `discord-gateway:package` | `./send-me-a-message`                       |
| Notify a specific workflow channel | `discord-gateway:package` | `./post-message` + resolved channel value   |

**Default Discord path:** `./send-me-a-message` posts to Kent's configured
general channel. It reads `kodyDiscordGeneralChannelId` internally — you do
**not** need a channel id for the usual "message me on Discord" case.

**Workflow-specific channel:** when the user names a workflow (e.g. "GitHub
summary channel"), search Kody values:

```
search({ query: "discord channel <workflow>" })
```

Prefer values whose names end in `DiscordChannelId` (e.g.
`dailyGithubSummaryDiscordChannelId`). Load with
`search({ entity: "user:<name>:value" })` or `codemode.value_get`.

### Deploy / health-check URL (from repo metadata)

Resolve in this order; stop at the first hit:

1. **Production (merge-and-verify mode):**

   ```bash
   gh variable get APP_BASE_URL --repo "$(gh repo view --json nameWithOwner -q .nameWithOwner)"
   ```

   GitHub Actions production deploy uses this variable (see
   `.github/workflows/deploy.yml`).

2. **Preview (optional pre-merge smoke test on kody PRs):** parse the PR body
   for the preview marker:

   ```bash
   gh pr view --json body -q .body | rg -o 'https://[^ )]+' | head -1
   # or look for the line after <!-- kody-preview-url -->
   ```

   Preview deploy comments are posted by `.github/workflows/preview.yml`.

3. **Kody-hosted hint:** saved package invocation URLs (e.g. from
   `search({ entity: "discord-gateway:package" })`) expose the canonical Kody
   host (`https://heykody.dev`). Use only when the repo has no `APP_BASE_URL`
   variable and you need a production fallback for the kody repo itself.

4. **Deploy run output:** after watching `🚀 Deploy (production)`, read the
   deploy job log or environment URL if steps 1–3 did not yield a URL.

Health check: `curl -sf "${deployUrl}/health"` → `{"ok":true,...}`.

## Prerequisites

Before starting, confirm:

1. **Active PR** for the current branch (`gh pr view`).
2. **`gh` authenticated** with permission to push and (merge mode) merge.
3. **Kody MCP connected** with saved packages `github-pr-tools` and
   `discord-gateway` (plus invocation tokens for the exports you call).

If Kody setup is missing, stop and link setup pages — never ask for tokens in
chat.

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
```

Mark ready via **Kody** (preferred over raw `gh pr ready`):

```javascript
import { packages } from 'kody:runtime'

export default async function main({ owner, repo, number }) {
	return packages.invokeChecked({
		kodyId: 'github-pr-tools',
		exportName: './set-pr-review-status',
		params: { owner, repo, number, ready: true },
	})
}
```

Pass `owner`, `repo`, and `number` from `gh pr view` / git remote. Fall back to
`gh pr ready` only if Kody is unavailable.

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

4. **Manual smoke test** — follow **control-ui** (or equivalent), using the
   **deploy URL resolved above**:
   - `curl -sf "${deployUrl}/health"` → `{"ok":true,...}`
   - One critical user flow relevant to the PR (sign-in, changed route, MCP
     health, etc.)
   - Record what was tested and the outcome.

5. **Discord summary** — what merged, deploy run URL/status, smoke test notes,
   and link to the (now merged) PR.

## Discord notification (Kody)

### Default: message Kent

Use `./send-me-a-message` — no channel id required:

```javascript
import { packages } from 'kody:runtime'

export default async function main({ content }) {
	return packages.invokeChecked({
		kodyId: 'discord-gateway',
		exportName: './send-me-a-message',
		params: { content },
	})
}
```

Discover the export contract when unsure:
`search({ entity: "discord-gateway:package" })`.

### Override: specific channel

Only when the user names a workflow channel or `search` surfaces a better
`*DiscordChannelId` value for this notification type:

```javascript
import { packages, codemode } from 'kody:runtime'

export default async function main({ valueName, content }) {
	const channelId = await codemode.value_get({
		name: valueName,
		scope: 'user',
	})
	return packages.invokeChecked({
		kodyId: 'discord-gateway',
		exportName: './post-message',
		params: { channelId, content },
	})
}
```

Keep messages short; use markdown links for PR and deploy URLs.

## Guardrails

- Do not merge unless **mode** is `merge-and-verify` and intent is explicit.
- Do not merge with failing required checks.
- Do not bypass git hooks or force-push to main.
- Do not send Discord until the success criteria for the chosen mode are met.
- Do not ask the user for a Discord channel id when `./send-me-a-message` or
  Kody value search can resolve it.
- If CI failures are clearly unrelated and fixed on `main`, merge latest main
  instead of unrelated fixes in the PR.
- If checks are flaky, retry once and note flake evidence before looping again.

## Output

Report back with:

- PR URL and final CI status
- Resolved deploy URL and Discord path used
- Fixes applied during the loop (if any)
- Bot feedback addressed vs dismissed (brief)
- Discord delivery confirmation
- **Merge mode only:** merge SHA, deploy run URL, smoke test notes
