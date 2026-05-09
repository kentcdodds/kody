# RFC: Reconcile `npm run validate` with CI `validate.yml`

Status: Draft — discussion only. No source changes yet.

## Problem

`package.json` advertises `npm run validate` as the "full validation" command,
and `.cursor/CLOUD.md` repeats that framing for cloud agents. The script is
intended to mirror what CI runs on every PR. It does not.

The local script and the CI workflow have drifted in three independently
problematic ways:

1. `validate` runs `lint:fix` (which mutates files), but CI runs `lint` (read
   only). A contributor who runs `npm run validate` to "mirror CI" silently gets
   unstaged auto-fixes applied to their working tree.
2. `validate` skips the unit `test` job entirely, while CI requires it. A clean
   `npm run validate` does not prove that `nx run worker:test` passes.
3. `validate` runs jobs that CI does not (`format:check`, `build`) and CI runs
   jobs in a different order than `validate` lists them.

The Husky `pre-push` hook (`npm run test:push`) runs yet another subset (unit +
Playwright E2E, no MCP E2E, no lint, no typecheck, no build, no format check),
which means we have _three_ slightly different "this is the bar" gates and none
of them agrees with the others.

## Side-by-side: what each gate actually runs

Source of truth for the table below:

- `package.json` `validate`, `test:push`, `test`, `lint`, `lint:fix`,
  `format:check`, `build`, `typecheck`, `test:e2e:run`, `test:mcp`.
- `.github/workflows/validate.yml` jobs `lint`, `typecheck`, `test`, `e2e`,
  `mcp-e2e`.
- `.husky/pre-commit` and `.husky/pre-push`.

Legend: ✅ = runs that step, ❌ = does not run it, ✏️ = runs a _mutating_
variant, 📁 = scoped to staged files only.

| Step                    | `npm run validate`                                   | CI `validate.yml`                                                       | `npm run test:push` | `.husky/pre-commit`            | `.husky/pre-push`    |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- | ------------------- | ------------------------------ | -------------------- |
| `oxfmt --check` (repo)  | ✅ `format:check`                                    | ❌                                                                      | ❌                  | ❌                             | ❌                   |
| `oxfmt` write (staged)  | ❌                                                   | ❌                                                                      | ❌                  | ✏️ via `lint-staged` (📁)      | ❌                   |
| `oxlint` (read-only)    | ❌                                                   | ✅ job `lint` → `npm run lint`                                          | ❌                  | ❌                             | ❌                   |
| `oxlint --fix` (repo)   | ✏️ `lint:fix`                                        | ❌                                                                      | ❌                  | ❌                             | ❌                   |
| `oxlint --fix` (staged) | ❌                                                   | ❌                                                                      | ❌                  | ✏️ via `lint-staged` (📁)      | ❌                   |
| `npm run typecheck`     | ✅                                                   | ✅ job `typecheck`                                                      | ❌                  | ✅                             | ❌                   |
| `npm run build`         | ✅                                                   | ❌                                                                      | ❌                  | ❌                             | ❌                   |
| `npm run test` (unit)   | ❌                                                   | ✅ job `test`                                                           | ✅                  | ❌                             | ✅ (via `test:push`) |
| `npm run test:e2e:run`  | ✅                                                   | ✅ job `e2e` (+ Playwright install, `cp .env.example`, `migrate:local`) | ✅                  | ❌                             | ✅ (via `test:push`) |
| `npm run test:mcp`      | ✅                                                   | ✅ job `mcp-e2e` (+ `cp .env.example`, `migrate:local`)                 | ❌                  | ❌                             | ❌                   |
| Concurrent vs serial    | concurrent (`concurrently --kill-others-on-fail`)    | parallel jobs, separate runners                                         | serial (`&&`)       | serial                         | serial               |
| Mutates working tree?   | yes — `lint:fix` rewrites `.ts/.tsx` files repo-wide | no                                                                      | no                  | yes — but only on staged files | no                   |

### Observed drift

1. **`lint:fix` vs `lint`.** `validate` rewrites files; CI does not. A green
   `validate` run after which `git status` is dirty does **not** prove the tree
   is CI-clean; the only thing it proves is the _fixed_ tree would be CI-clean.
   The repo-wide `oxlint --fix` is also broader than the staged `oxlint --fix`
   that `lint-staged` runs in `pre-commit`.
2. **Missing unit tests.** `validate` runs E2E and MCP E2E but _not_
   `npm run test` (unit). CI requires unit tests; pre-push requires unit tests.
   Only `validate` skips them.
3. **Extra `build` step.** `validate` runs `npm run build`. CI does not run a
   standalone `build` job; the build is implicit in `e2e` / `mcp-e2e` targets
   via Nx dependencies and in the `deploy` workflow. So `validate` is stricter
   than CI here, but contributors are not told that.
4. **Extra `format:check`.** `validate` runs `oxfmt --check` repo-wide; CI does
   not. Formatting is enforced only at commit time via `lint-staged`.
5. **No env / migration prep.** CI's `e2e` and `mcp-e2e` jobs explicitly
   `cp packages/worker/.env.example packages/worker/.env`, install Playwright
   with `--with-deps`, and `npm run migrate:local`. Locally, `validate` relies
   on the cached Nx `worker:prepare-e2e-env` and `worker:prepare-playwright`
   targets to do the same work, which makes the two flows behave subtly
   differently on a clean machine.
6. **`pre-push` is a third opinion.** `test:push` runs unit + E2E but not MCP
   E2E, lint, typecheck, build, or format check. So `git push` does not
   reproduce CI either, and it disagrees with `validate` in both directions.
7. **Concurrency semantics.** `validate` uses
   `concurrently --kill-others-on-fail`, so if `lint:fix` finishes first and
   mutates files, downstream `build` / `typecheck` / `test:e2e:run` may already
   be reading the _unfixed_ tree. The result depends on scheduling. CI
   parallelism is safe because each job runs on its own checkout.

## Options

### Option A — Fix `validate` to mirror CI

Replace `lint:fix` with `lint`, add unit tests, drop the steps CI does not run,
and align ordering with CI.

Concretely the script would change from:

```jsonc
"validate": "concurrently --kill-others-on-fail -n format,lint,build,typecheck,test,test:mcp -c green,yellow,blue,magenta,cyan,red \"npm run format:check\" \"npm run lint:fix\" \"npm run build\" \"npm run typecheck\" \"npm run test:e2e:run\" \"npm run test:mcp\""
```

to (illustrative; not committed in this PR):

```jsonc
"validate": "concurrently --kill-others-on-fail -n lint,typecheck,test,e2e,mcp -c yellow,magenta,blue,cyan,red \"npm run lint\" \"npm run typecheck\" \"npm run test\" \"npm run test:e2e:run\" \"npm run test:mcp\""
```

Pros:

- One name, one meaning. "Local `validate` should pass iff CI passes" becomes a
  true statement again.
- Eliminates the silent-mutation footgun (`lint:fix` repo-wide).
- Adds unit-test coverage to the local gate, which is the cheapest of the five
  jobs.
- AGENTS.md / `.cursor/CLOUD.md` / `setup.md` / `harness-engineering.md` keep
  pointing at `npm run validate` and the message stays correct.

Cons:

- Drops the repo-wide `format:check` from the local gate. Format is currently
  only enforced on staged files by `lint-staged`; if a non-staged file becomes
  mis-formatted (e.g. via tooling), `validate` will no longer catch it. This is
  acceptable because **CI also does not catch it** — the goal of `validate` is
  parity, not super-set coverage. If we still want a format gate, that is a
  separate decision and should be added to _CI_ as well, not just to the local
  script.
- Drops the standalone `build` from the local gate. The `e2e` / `mcp-e2e` Nx
  targets already exercise the build through their dependency graph, and the
  deploy pipeline guards production builds. Adding it back is cheap if we miss
  it.
- Some contributors rely on `validate` autofixing their lint errors. They would
  need to call `npm run lint:fix` explicitly.

Risk: low. This is the smallest change that makes the advertised contract true.

### Option B — Delete `validate` and document running individual scripts

Remove the `validate` script. Update `.cursor/CLOUD.md` and any other onboarding
docs to list the individual commands that CI runs: `npm run lint`,
`npm run typecheck`, `npm run test`, `npm run test:e2e:run`, `npm run test:mcp`.

Pros:

- Forces contributors and agents to be explicit about which gate they ran; no
  false sense of parity.
- Removes the temptation to keep `validate` "almost like CI but with extras".
- Encourages running the cheapest gates first (`lint`, `typecheck`) before the
  slow ones (`test:e2e:run`, `test:mcp`).

Cons:

- `.cursor/CLOUD.md`, `docs/contributing/setup.md`,
  `docs/contributing/end-to-end-testing.md`, and
  `docs/contributing/harness-engineering.md` all need rewording.
- Loses the parallel-by-default convenience that `concurrently` gives the local
  script. A documented "run these five in parallel with `concurrently`" recipe
  in setup.md would partly compensate.
- Removes a single grep target (`npm run validate`) that humans and agents use
  to recognize "the full local gate".

Risk: low-medium. Mostly a docs migration.

### Option C — Have CI invoke `npm run validate`

Replace the five CI jobs (`lint`, `typecheck`, `test`, `e2e`, `mcp-e2e`) with a
single job that runs `npm ci` and then `npm run validate` (after fixing
`validate` itself to use `lint` instead of `lint:fix`). Single source of truth.

Pros:

- One literal command, one definition of "validated".
- Cannot drift again: changing the local script changes CI.
- Easy for new contributors: "what does CI run?" → "exactly what you just ran
  locally."

Cons:

- Slower wall-clock CI feedback. Today the five jobs run on five runners in
  parallel; the slow ones (`e2e` 12 min, `mcp-e2e` 4 min) run while the fast
  ones (`lint` 4 min, `typecheck` 4 min, `test` 4 min) finish quickly and
  surface failures early. A merged single job is bounded by the slowest step
  (E2E), so a typo caught by `lint` now waits ~12 min instead of ~1 min.
- Lose per-job status checks in the GitHub UI (one ✅/❌ instead of five). Less
  informative when debugging which gate failed.
- We would need to set up Playwright caching, browser install, env-file copy,
  and `migrate:local` for the merged job — i.e. the union of what the current
  `e2e` and `mcp-e2e` jobs do. That is doable but pushes more setup complexity
  into the local script.
- `concurrently --kill-others-on-fail` aborts other branches as soon as one
  fails, which means a CI re-run after a flaky E2E might not actually re-run
  typecheck or lint. We would need to drop `--kill-others-on-fail` in the CI
  codepath to keep useful logs from every branch.

Risk: medium. Touches CI ergonomics that maintainers actively rely on.

## Recommendation

**Option A.** It is the smallest reversible change that makes the documented
contract — "`npm run validate` is the full validation command and mirrors CI" —
actually true, while preserving the per-job parallelism in CI and the human
ergonomics of the local script. The trade-off it accepts (dropping
`format:check` and `build` from the local gate) is the right one because CI also
does not run them; adding them back as _extras_ is what created the drift in the
first place. Option C remains attractive long-term once we have a stronger
answer for parallelism (e.g. an Nx affected pipeline or a CI matrix that calls
the same script with a `--target` filter), and this RFC is not closing the door
on that, just unblocking the immediate parity bug.

### Concrete diff that would land if Option A is approved

`package.json` — replace the existing `validate` script with the version below.
**Not part of this PR.**

```diff
-    "validate": "concurrently --kill-others-on-fail -n format,lint,build,typecheck,test,test:mcp -c green,yellow,blue,magenta,cyan,red \"npm run format:check\" \"npm run lint:fix\" \"npm run build\" \"npm run typecheck\" \"npm run test:e2e:run\" \"npm run test:mcp\"",
+    "validate": "concurrently --kill-others-on-fail -n lint,typecheck,test,e2e,mcp -c yellow,magenta,blue,cyan,red \"npm run lint\" \"npm run typecheck\" \"npm run test\" \"npm run test:e2e:run\" \"npm run test:mcp\"",
```

No changes are required in `.github/workflows/validate.yml`. The five jobs
already match the five sub-commands above one-for-one.

### Optional follow-ups (not blockers for the diff above)

- Add a sentence to `docs/contributing/setup.md` clarifying that
  `npm run validate` is read-only and that contributors should run
  `npm run lint:fix` and `npm run format` separately when they want auto-fixes.
- Update `docs/contributing/end-to-end-testing.md` to remove the line describing
  the `validate` gate as running `lint:fix` (currently true, would be stale
  after the diff).
- Reconsider whether `pre-push` should also run `test:mcp`, or whether
  `test:push` should drop the redundancy with the new `validate` and simply
  alias to it. Out of scope for this RFC.

## Downstream files that mention `npm run validate`

These are the files that would need wording or content updates depending on
which option is chosen. (For Option A, only `end-to-end-testing.md` is strictly
out-of-date; the others stay correct because they reference the script by name
without claiming what it runs internally.)

| File                                            | What it says today                                                                                                          | Needs update under Option A                            | Needs update under Option B       | Needs update under Option C |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | --------------------------------- | --------------------------- |
| `.cursor/CLOUD.md`                              | "Full validation \| `npm run validate`" in the quick-reference table.                                                       | no                                                     | yes (replace command)             | no                          |
| `docs/contributing/setup.md`                    | Says `validate` runs "format check, lint fix, build, typecheck, Playwright tests, MCP E2E".                                 | yes (remove "lint fix / build", add "unit tests")      | yes (remove the bullet)           | yes (mention CI runs same)  |
| `docs/contributing/setup.md` (push-hook bullet) | Says push hooks "stop short of `npm run validate`; MCP E2E, build validation, and repo-wide format checks remain explicit". | yes (drop "build validation, repo-wide format checks") | yes (rephrase without `validate`) | yes                         |
| `docs/contributing/setup.md` (self-heal bullet) | Says `validate` and `test:push` self-heal Playwright install on a fresh machine.                                            | no                                                     | yes (drop `validate`)             | no                          |
| `docs/contributing/end-to-end-testing.md`       | Says E2E tests are executed by the `validate` gate "which also runs `lint:fix` and the MCP E2E suite".                      | yes (drop `lint:fix`)                                  | yes (rephrase without `validate`) | no                          |
| `docs/contributing/harness-engineering.md`      | Lists `npm run validate` as the default evaluation step and references "deterministic scripts (`validate`...)".             | no                                                     | yes (replace with concrete list)  | no                          |
| `AGENTS.md` (top-level)                         | Does not mention `validate` directly today, but the cloud-specific section in `.cursor/CLOUD.md` does.                      | no                                                     | yes via `.cursor/CLOUD.md`        | no                          |

The greps used to build this list:

```sh
rg -n "npm run validate|`validate`" --glob '!docs/contributing/cleanup-rfcs/**'
rg -n "validate" --glob '*.md'
```

`packages-and-manifests.md`, `mcp-server-patterns.md`, `secret-rotation.md`,
`testing-principles.md`, `mock-api-servers.md`, `architecture/**`,
`generated-ui-oauth.md`, `execute.md`, and the Remix skill files mention the
word "validate" only in unrelated contexts (zod validation, request validation,
table-level `validate` hooks, etc.) and do not reference the npm script.

## Open questions for reviewers

1. Do we want a repo-wide `format:check` gate at all? If yes, it should live in
   CI, not only in the local script. Option A leaves this for a separate
   discussion.
2. Is the `build` step worth keeping locally as a smoke test even though CI does
   not run it standalone? The Nx `e2e` target builds transitively, so the answer
   is probably no.
3. Should `pre-push` reuse the new `validate` or stay as the cheaper
   `test:push`? If we make `validate` read-only and reasonably fast, `pre-push`
   could shell out to it. Out of scope here.
