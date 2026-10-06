---
name: visual-recap
description:
  Generate and maintain the system recap block in a PR description - a
  GitHub-rendered visual summary of which system primitives a change touches,
  how risky it is, and what changed. Prefer mermaid sequence diagrams for the
  change; pick another graph type when it explains the diff better. Use when
  planning a non-trivial change (plan mode), when creating or updating a pull
  request (recap mode), or when the user asks for a visual recap, visual plan,
  system review, or PR recap.
---

# System recap (visual plan / visual recap)

Produce a high-altitude, visual review aid in the PR description. GitHub renders
the block (including mermaid), and the PR is the storage. The marker-delimited
block is machine-readable, so follow the format exactly.

The recap is informational and non-blocking. It supplements the PR description
and normal code review. It never replaces reading the diff.

Read this core, classify the rollup, then open **one** risk reference. Open the
block format once when you write the block. Leave the other risk files unread.

## Modes

- **Plan mode** (before or while implementing): describe the intended change
  against the current system. If no PR exists yet, put the block in the plan
  document or message. Move it into the PR description once the PR exists.
- **Recap mode** (PR creation and every meaningful update): describe what the
  diff actually does. Replaces a plan-mode block if one exists.

## Source of truth

1. **Recap mode reads the diff, not memory.** Generate the recap from
   `git diff <base>...HEAD` (plus `git diff --stat`) against the PR base branch.
   Session context may explain intent, but every claim about what changed must
   be checkable against the diff.
2. **Classification uses the primitives taxonomy.** Read
   [`docs/contributing/architecture/primitives.yaml`](../../../docs/contributing/architecture/primitives.yaml)
   for stable `id` / `name` / `group` values. Prefer the classifier script over
   hand-matching paths:

   ```bash
   node .agents/skills/visual-recap/scripts/classify-primitives.mjs --base <base> --head HEAD
   # or: git diff --name-only <base>...HEAD | node .agents/skills/visual-recap/scripts/classify-primitives.mjs --stdin --json
   ```

3. **The taxonomy is not a feature changelog.** Update `primitives.yaml` only
   when this PR adds, removes, or materially reshapes a primitive (new `id`,
   renamed meaning, or ownership roots that must change). Do not edit `summary`
   for ordinary feature work. Put behavioral detail in the linked architecture
   docs under `docs:`. Run `npm run primitives:check` after map edits.

## Risk

Classify each touched primitive, then roll up to the highest severity (`adds` >
`extends` > `composes`):

| Classification | Meaning                                                    | Risk   | Read                                           |
| -------------- | ---------------------------------------------------------- | ------ | ---------------------------------------------- |
| `composes`     | Uses existing primitives as-is; wiring and call sites only | Low    | [references/low.md](./references/low.md)       |
| `extends`      | Changes a primitive's behavior, shape, or contract         | Medium | [references/medium.md](./references/medium.md) |
| `adds`         | Introduces a new primitive (must update primitives.yaml)   | High   | [references/high.md](./references/high.md)     |

A change touching invariants from `primitives.yaml` (for example per-user
isolation) is called out explicitly regardless of classification.

The classifier reports which primitives' `code` roots the diff touches. You
still decide `composes` vs `extends` from the diff (and `adds` when you create a
new map entry). Follow that one risk reference. Medium and high include the
preview pass. Low does not.

## Write the block

Template, diagram rules, plan-mode fields, and examples (read once):
[references/block-format.md](./references/block-format.md).

1. Resolve base/head (`gh pr view <n> --json baseRefName,headRefName`). Plan
   mode does not require Base/Head commits.
2. Classify paths (command above; add `--json` for structured output).
3. Read the full diff for anything you did not author this session. Decide
   composes/extends/adds per matched primitive, and note important unmatched
   paths if they introduce a new surface.
4. Author the block from the format reference and the one risk reference. Use
   map `name` for participant and node labels. Pull behavioral detail from
   architecture docs and the diff, not by rewriting map summaries.
5. Upsert it into the PR description.

   ```bash
   node .agents/skills/visual-recap/scripts/upsert-recap-block.mjs <pr-number> <block-file>
   ```

   The script rejects mermaid GitHub cannot parse, then replaces the content
   between the markers, or appends the block to the end of the description on
   first run. It never touches text outside the markers.

   **Cloud Agents:** `gh pr edit` fails with
   `Resource not accessible by integration (updatePullRequest)`. Do not treat
   that as a reason to skip the recap. Run the script anyway so mermaid is
   checked. When it prints the merged PR body, apply that body with Cursor
   **ManagePullRequest**. Do not have Kody, a Kody workflow, or Kody's GitHub
   integration edit the PR.

6. Re-run steps 2-5 after pushing significant new commits to the PR.
