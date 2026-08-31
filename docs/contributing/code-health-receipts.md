# Code health receipts

Kody is a source-available codebase written almost entirely by AI agents.
Instead of asking readers to take code quality on faith, this page records the
measured numbers and the enforcement that keeps them from regressing. All
figures below were measured directly against the repository (2026-08-30).

## Measured baseline

| Signal                                                   | Value |
| -------------------------------------------------------- | ----- |
| `as any` casts in `packages/`                            | 1     |
| `TODO` comments in `packages/`                           | 0     |
| `@ts-expect-error` suppressions in `packages/`           | 1     |
| Duplicated lines (jscpd, min 70 tokens, non-test source) | 1.96% |
| Runtime dependencies of the main worker package          | 28    |
| Decision records in `docs/contributing/decisions/`       | 45    |
| Checks in the `npm run validate` gate                    | 23    |

## Enforcement, not promises

- `npm run validate` is the single authoritative gate: format, lint, typecheck,
  node/workers/e2e/mcp test suites, build checks for every worker, migrations,
  deploy guardrails, temporal-docs and decision-record checks, the file-size
  ratchet, and knip dead-code analysis.
- `tools/file-size-ratchet.json` enforces budgets of 800 lines for client routes
  and 2,000 lines for node test files. Files may only shrink out of the
  grandfathered list; new oversized files fail CI.
- `knip` fails the gate on unused exports, files, and dependencies.
- `tools/check-decorative-banners.ts` rejects decorative comment banners.

## Oversized-file cleanup receipts

Every grandfathered file over budget was split along behavior boundaries with no
runtime or assertion changes, and its ratchet exception removed in the same PR,
so the budget is now enforced for it.

### Client routes (budget: 800 lines)

| Route                                  | Before | After | PR                                                    |
| -------------------------------------- | ------ | ----- | ----------------------------------------------------- |
| connect-oauth.tsx                      | 2,192  | 795   | [#1852](https://github.com/kentcdodds/kody/pull/1852) |
| account-integrations.tsx               | 2,167  | 581   | [#1851](https://github.com/kentcdodds/kody/pull/1851) |
| onboarding.tsx                         | 1,628  | 713   | [#1853](https://github.com/kentcdodds/kody/pull/1853) |
| account-secrets.tsx                    | 1,610  | 777   | [#1854](https://github.com/kentcdodds/kody/pull/1854) |
| community-detail.tsx                   | 1,490  | 800   | [#1865](https://github.com/kentcdodds/kody/pull/1865) |
| onboarding-mcp-client-tabs.tsx         | 1,477  | 556   | [#1869](https://github.com/kentcdodds/kody/pull/1869) |
| account.tsx                            | 1,440  | 791   | [#1855](https://github.com/kentcdodds/kody/pull/1855) |
| admin-users.tsx                        | 1,435  | 784   | [#1866](https://github.com/kentcdodds/kody/pull/1866) |
| login.tsx                              | 1,335  | 773   | [#1870](https://github.com/kentcdodds/kody/pull/1870) |
| admin-insights.tsx                     | 1,289  | 134   | [#1871](https://github.com/kentcdodds/kody/pull/1871) |
| account-mcp-servers.tsx                | 1,251  | 598   | [#1858](https://github.com/kentcdodds/kody/pull/1858) |
| account-jobs.tsx                       | 1,146  | 554   | [#1872](https://github.com/kentcdodds/kody/pull/1872) |
| admin-codemods.tsx                     | 1,100  | 789   | [#1875](https://github.com/kentcdodds/kody/pull/1875) |
| admin-platform-integrations.tsx        | 1,098  | 565   | [#1877](https://github.com/kentcdodds/kody/pull/1877) |
| account-activity.tsx                   | 954    | 516   | [#1878](https://github.com/kentcdodds/kody/pull/1878) |
| account-email.tsx                      | 891    | 487   | [#1861](https://github.com/kentcdodds/kody/pull/1861) |
| record-table.tsx (shared table module) | 837    | 586   | [#1863](https://github.com/kentcdodds/kody/pull/1863) |
| home.tsx                               | 808    | 562   | [#1857](https://github.com/kentcdodds/kody/pull/1857) |

Extraction pattern: routes keep loader consumption, mutations, and lifecycle
orchestration; extracted modules are render-only sections/forms/detail panels
plus shared URL/filter helpers.

### Node test suites (budget: 2,000 lines)

| Suite                                          | Before | After (entrypoints)               | PR                                                    |
| ---------------------------------------------- | ------ | --------------------------------- | ----------------------------------------------------- |
| jobs/service.node.test.ts                      | 5,596  | 5 workflow suites, 723–1,286 each | [#1864](https://github.com/kentcdodds/kody/pull/1864) |
| package-runtime/module-graph.node.test.ts      | 3,093  | 990 + 1,161 + 892                 | [#1879](https://github.com/kentcdodds/kody/pull/1879) |
| mcp/run-kody-registry.node.test.ts             | 2,889  | 1,039 + 1,305                     | [#1880](https://github.com/kentcdodds/kody/pull/1880) |
| package-invocations/service.node.test.ts       | 2,857  | 1,212 + 820                       | [#1881](https://github.com/kentcdodds/kody/pull/1881) |
| repo/repo-session-do.node.test.ts              | 2,764  | 1,288 + 1,193                     | [#1882](https://github.com/kentcdodds/kody/pull/1882) |
| package-runtime/package-workflows.node.test.ts | 2,534  | 999 + 1,239                       | [#1883](https://github.com/kentcdodds/kody/pull/1883) |
| app/account-deletion.node.test.ts              | 2,234  | 1,110 + 615                       | [#1884](https://github.com/kentcdodds/kody/pull/1884) |
| account/export.node.test.ts                    | 2,147  | 771 + 1,234                       | [#1885](https://github.com/kentcdodds/kody/pull/1885) |

Every split preserved every test and assertion (verified by matching test counts
before and after), moved reusable fixtures to
`packages/worker/src/test-support/`, and kept `vi.mock` wiring file-local
because Vitest hoists mocks per test file. No production code changed.

## What was intentionally not done

- No Durable Object rewrites: large DOs are frozen by the ratchet and shrink
  opportunistically.
- No test behavior changes: splits reorganize, never weaken, coverage.
- No suppression sweeps: the near-zero `as any`/`TODO` counts are the actual
  state of the tree, not a lint-ignore artifact.
