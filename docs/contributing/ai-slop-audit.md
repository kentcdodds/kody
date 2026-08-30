# AI-generated code quality audit

Snapshot dated 2026-08-30. Counts come from the tree at that date (`packages/` +
`tools/`, excluding generated `worker-configuration.d.ts`). Garden or delete the
snapshot numbers after the remediations land; keep the quality bar and the "do
not rewrite" section.

This page answers two launch questions:

1. How AI-sloppy is this source-available, almost-entirely-agent-authored tree?
2. What work actually reduces a critic's ability to call it slop without hurting
   reliability or the agent harness?

It is not a security, performance, or architecture review.

## Verdict

**Not bad.** A good-faith reader who opens MCP capabilities, auth gates, or
isolation comments will not conclude this is nonsense. A critic who wants a
screenshot thread can still write one from about five files.

On a 0–10 slop scale (0 = tightly hand-edited systems code, 10 = an unreviewed
vibe-coded dump):

| Dimension                       | Score | Why                                                                                                                 |
| ------------------------------- | ----: | ------------------------------------------------------------------------------------------------------------------- |
| Comment / JSDoc / "AI voice"    |     1 | Almost no narrating comments, zero `// TODO`, zero commented-out blocks, zero "comprehensive/robust/seamless" prose |
| Type escapes                    |     2 | Zero `as any`, two justified `@ts-expect-error`, four real `: any` sites                                            |
| Docs / agent harness            |     1 | Checkers over should-lists, import boundaries, temporal-language check, short `AGENTS.md`                           |
| Leftovers / shims               |     4 | Documented drains (values, legacy hosts) remain in the tree                                                         |
| Tests                           |     5 | High coverage volume; several multi-thousand-line suites with hoisted mock walls                                    |
| Structure (god files / UI)      |     6 | Backend is governed; Remix routes are not                                                                           |
| **Overall (critic ammunition)** | **3** | The embarrassing files are real and clustered, not systemic                                                         |

The interesting thesis of this repo is the harness, not hidden authorship.
Critics who assume "100% AI-generated" means "no invariants, no types, no
cleanup" lose that argument on contact. Critics who open `connect-oauth.tsx` or
`jobs/service.node.test.ts` still have a fair point.

## What a critic screenshots

These are the highest-signal, lowest-context exhibits. Fix these first if the
goal is to take the easy article away.

### 1. Two-thousand-line Remix route functions

Eighteen client routes are 800+ lines. The worst:

| Lines | File                                                     | Why it photographs well                                      |
| ----: | -------------------------------------------------------- | ------------------------------------------------------------ |
|  2192 | `packages/worker/client/routes/connect-oauth.tsx`        | `ConnectOauthRoute` is ~1,911 lines in one function          |
|  2168 | `packages/worker/client/routes/account-integrations.tsx` | Route plus ~25 inlined helpers                               |
|  1630 | `packages/worker/client/routes/onboarding.tsx`           | Split awkwardly from `onboarding-mcp-client-tabs.tsx` (1408) |
|  1610 | `packages/worker/client/routes/account-secrets.tsx`      | Pair with a 1450-line server handler                         |
|  1492 | `packages/worker/client/routes/community-detail.tsx`     | Includes a leftover "prototype" style banner                 |
|  1440 | `packages/worker/client/routes/account.tsx`              | Same mega-function pattern                                   |
|  1435 | `packages/worker/client/routes/admin-users.tsx`          | `AdminUsersRoute` ~1,265 lines                               |

`packages/worker/client/routes/` is a flat directory of 82 `.tsx` files. The
backend is nested by domain; the UI is not. That asymmetry is the strongest
"ungoverned / vibe-coded" narrative available without misrepresenting the MCP
layer.

This is also the change that helps agents: a 1,900-line route is a context tax
and a regression magnet.

### 2. Multi-thousand-line test files

`packages/worker/src/jobs/service.node.test.ts` is **5,596 lines and 23 tests**
(~243 lines/test) with a large hoisted `vi.mock` wall. Other 2k+ suites:
`module-graph.node.test.ts` (3093), `run-kody-registry.node.test.ts` (2889),
`package-invocations/service.node.test.ts` (2857).

Testing principles in this repo prefer fewer, longer workflow tests. That rule
is about **case** shape, not **file** size. A 5.6k-line file with 23 cases is
still a critic exhibit, and it is hard for an agent to edit safely.

Positive signals in the same area: **zero** `toMatchSnapshot` /
`toMatchInlineSnapshot` calls, and the node vs workers vs MCP-e2e flavor matrix
is real.

### 3. Marketing-route section banners

```tsx
{
	/* ============ hero ============ */
}
```

Ten of those live in `home.tsx`. `login.tsx` has two. CSS-in-JS
`/* ---------- styles ---------- */` banners repeat in `timeline.tsx`,
`pricing.tsx`, `community-detail.tsx`, and a few explorers. Cosmetic, but they
are the classic "AI laid out a page" tell.

### 4. A handful of narrating comments

Almost none exist. The ones that do are screenshot-ready:

- `packages/worker/src/utils.ts` — `// Handle CORS preflight requests`,
  `// Call the original handler`, `// Add CORS headers to ALL responses…`
- `packages/worker/universal/styles/tokens.ts` —
  `// Helper to create media query string`

The `mergeHeaders` JSDoc next to those CORS comments is the contrast: it
explains why `Set-Cookie` is appended instead of set.

### 5. Retired-but-still-shipped surfaces

`value_get` / `value_list` / `value_delete` and `/account/values` remain as an
unadvertised drain
([values retirement runbook](./architecture/values-retirement-runbook.md)).
Legacy host dual-serve is still wired (`APP_LEGACY_HOSTS` /
`PACKAGE_APP_LEGACY_*` in 16 files) and tracked as issues
[#1300](https://github.com/kentcdodds/kody/issues/1300) and
[#1428](https://github.com/kentcdodds/kody/issues/1428). Secrets still have a
dual-read re-encrypt path.

These are documented leftovers, not forgotten TODOs. A critic can still title a
section "retired primitive still in the tree."

## What a critic does not find

This is the part that surprises people who have only seen ungoverned
AI-generated apps.

| Pattern critics expect                                           | Count in this tree                                                      |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `as any`                                                         | **0**                                                                   |
| `@ts-ignore`                                                     | **0**                                                                   |
| `@ts-expect-error`                                               | **2**, both justified (OAuth provider issue #71; untyped oxlint plugin) |
| `// TODO` / `// FIXME` / `// HACK`                               | **0**                                                                   |
| Multi-line commented-out code                                    | **0**                                                                   |
| `catch {}`                                                       | **0**                                                                   |
| `\|\| []` / `\|\| {}` (falsy defaults)                           | **0** (the repo uses `??`)                                              |
| "comprehensive / robust / seamless / leverage / utilize / delve" | **0** in `.ts`/`.tsx`/`.md`                                             |
| Snapshot walls                                                   | **0**                                                                   |
| Feature-flag forest                                              | Registry has one flag (`demo-indicator`)                                |
| `Record<string, any>` in hand-written code                       | **0**                                                                   |
| Emoji decoration in comments                                     | **0** (one test mentions `🐨` as the subject under test)                |

Scale of the tree those zeros sit in: **2,378** TypeScript files, **~556k**
lines (`packages/` + `tools/`). `packages/worker` is ~296k production lines and
~203k test lines (test/prod ratio **0.68**).

Comments that remain tend to be load-bearing: fail-closed email-verification and
suspension gates in `mcp-auth.ts`, the PKCE `allowPlainPKCE` note in
`origin-handler.ts`, CAS / idempotency notes on Durable Objects. Those are the
opposite of slop. Do not strip them in a cleanup pass.

The MCP layer is boring on purpose. A typical capability (`webhook-enable.ts`)
is a `defineDomainCapability` call: name, Zod schema, `requireMcpUser`, one
service function. There are ~200 of these, ~200 lines each. That is a primitive,
not copy-paste chaos. Do not flatten it.

Custom oxlint already encodes local law (`enforce-import-boundaries`,
`prefer-loader-data-types`, `no-literal-frame-src`). Docs policy is "prefer a
checker over a should-list." That is why the comment/type hygiene stayed clean
while the UI file-size hygiene did not: **nothing rejects a 2,000-line route.**

## Scorecard detail

### Comments and docs — clean

~2,400 production `.ts`/`.tsx` files. Strict narrating-comment patterns
(`Helper to`, `Note that`, `Let's`, `We need to`) hit about **11** times in
**8** files. JSDoc `@param` restaters are essentially unused. Durable docs pass
`npm run docs:check-temporal`. Agent-steering strings live on the MCP product
surface (`z.describe`, memory-verify warnings), which is the product, not a
comment smell.

### Types — clean with four stains

Production `as unknown as`: **~44–55**, mostly Cloudflare Durable Object RPC
stubs and a repeated AST-parser cast in package codemods. Tests carry the rest
(~650), almost all `as unknown as R2Bucket` / `typeof fetch` doubles.

Real production `: any`:

- `packages/worker/client/routes/admin-insights.tsx` — `ChartCard`
  `legend?: any; children: any`
- `packages/worker/src/d1-data-table-adapter.ts` —
  `compileComparisonValue(predicate: any, …)`
- `packages/worker/client/event-mixin.ts` — `event: any` on the mixin descriptor

Production non-null assertions: **~43**. The habitual ones are `input.userId!`
in `search-loaders.ts` / `fetch-gateway.ts` and redundant `payload.app!` in
`account-integrations.tsx` after a throw that already narrows.

`.catch(() => {})`: **~31** production sites. Several are documented
(ViewTransition, cancel unread bodies). A few hub/admin removals swallow
failures and deserve a second look, not a blanket purge.

`?? []` is common (**~483** production). D1's `results` field is optional in the
typings, so most of these are idiomatic, not bug-hiding.

### Structure — the real debt

**48** production files are 1,000+ lines; **18** are 1,500+.

Intentional concentration (weak critic argument if you know the constraint):

- Durable Objects: `run-log-do.ts` (3547), `repo-session-do.ts` (3060),
  `user-meter-do.ts` (1615)
- MCP execute orchestration: `executor.ts` (1738)
- Shared Remix loader contracts: `loader-data.ts` (1805)
- Package validation: `repo/checks.ts` (1600)

Accidental concentration (strong critic argument):

- The Remix routes listed above
- `community/service.ts` (1968), `account/export.ts` (2061), `jobs/service.ts`
  (1803) — service god-files without a DO excuse
- `tools/ci/resource-utils.ts` (1887) — CI grab-bag

There is no `knip` / `ts-prune` unused-export gate. No evidence of a dead export
swamp; there is also no mechanical proof there isn't one.

### Leftovers — tracked, still citeable

The [cleanup-after-migrations](./cleanup-after-migrations.md) policy is clear.
Feature flags and `retiringPrimitiveNotices` are already empty. Values and
legacy hosts still occupy the tree because a soak or DNS cutover is unfinished.
Open `Cleanup:`-prefixed issues are sparse even though #1300 and #1428 exist
under other titles.

## What to do (active remediations)

Ordered by critic-screenshot value and how much they help agents make reliable
changes. Do not start a whole-repo rewrite.

### Track A — Optics sweep (one small PR)

Behavior-preserving. Kills the cheap screenshots.

1. Delete `{/* ============ … ============ */}` banners in `home.tsx` and
   `login.tsx`.
2. Delete `/* ---------- … ---------- */` style-section banners in client routes
   and `style-primitives.ts`. Keep comments that explain a non-obvious layout
   invariant (the community-detail shirt-pattern note stays; the "prototype"
   label goes).
3. Delete the three narrating comments in `utils.ts` and the `Helper to` line in
   `tokens.ts`.
4. Replace the four `: any` sites with real types.
5. Drop redundant `!` after guards (`payload.app!` in
   `account-integrations.tsx`; tighten `userId` at the MCP boundary instead of
   asserting it five times).

### Track B — Lock the clean parts (one PR, checkers)

This repo stays clean where a checker exists. Encode the zeros so the next agent
cannot regress them.

1. Oxlint (or a tiny `tools/` check) that rejects `as any` and `// TODO` /
   `// FIXME` / `// HACK` in non-generated TS.
2. Oxlint that rejects `========` / decorative `----------` section banners in
   `packages/worker/client/**`.
3. A **ratchet**, not a sudden error on every large file: fail CI if the count
   of `client/routes/*.tsx` files over 800 lines increases, or if a new route is
   added above that budget. Same idea for `*.node.test.ts` files over 2,000
   lines.
4. Optional later: `knip` on a narrow allowlist once the first unused-export
   report is triaged.

Do not add a should-list to `AGENTS.md`. Point the contributing index at the
checker.

### Track C — Split the screenshot routes (several PRs)

Highest-value maintainability work. Follow the Remix skill and
[style primitives](./code-style.md); do not invent a third UI pattern.

Suggested order:

1. `connect-oauth.tsx` — extract chooser, callback, host-approval, and
   scope-disclosure into modules that already have seeds
   (`connect-oauth-chooser-list.ts`, `account-approval-shared.ts`).
2. `account-integrations.tsx`
3. `onboarding.tsx` / `onboarding-mcp-client-tabs.tsx`
4. `account-secrets.tsx`, `account.tsx`, `admin-users.tsx`

Done means: no single route component over ~400 lines, styles in named objects
or shared primitives, loader types still imported from
`#universal/loader-data.ts`. Each PR is one route family. Browser-verify the
flow; these pages are medium-risk logged-in surfaces.

### Track D — Split the mega tests (several PRs)

Keep long workflow tests. Move the hoisted mock modules into
`packages/worker/src/test-support/` and split `jobs/service.node.test.ts` (then
the next 2k+ files) by scenario. The ratchet in Track B stops the next agent
from concatenating them again.

While splitting, drop tautological `toHaveBeenCalled` assertions that only prove
a mock was wired. [Testing principles](./testing-principles.md) already forbid
that class of test.

### Track E — Finish documented leftovers (not a slop rewrite)

Do not drop these in a cosmetics PR.

1. Values drain: follow the runbook; drop capabilities and D1 tables when
   leftover rows hit zero.
2. Legacy hosts: drive #1300 and #1428 to deletion of the dual-serve vars and
   the 16 call sites.
3. Secrets dual-read / owned-secret-names soak: file or update a `Cleanup:`
   issue if one is missing, then remove the dual path when the soak criterion is
   met.

### Track F — Optional service splits (lower critic value)

`community/service.ts`, `account/export.ts`, and `jobs/service.ts` are large but
domain-shaped. Split them only when an agent is already in the file for behavior
work. Do not schedule a "make services pretty" program ahead of Tracks A–D.

## What not to do

- Do not rewrite Durable Objects into many small classes to chase a line count.
  The 3k-line DO is a concentration of RPC surface, not leftover narration.
- Do not merge the ~200 MCP capability files into a few barrels. One capability
  per file is the primitive that keeps agents from editing the wrong handler.
- Do not strip security, isolation, CAS, or protocol comments.
- Do not "deslop" `loader-data.ts` into per-route type files that then drift
  from `prefer-loader-data-types`.
- Do not add snapshot tests as a shortcut while splitting UI.
- Do not expand `AGENTS.md`. A new checker plus a one-line link is the harness
  move.

## How this stays true after launch

The failure mode is not "an agent writes a narrating comment." The failure mode
is "an agent appends 400 lines to `connect-oauth.tsx` because nothing stops it."

Tracks B and C are the launch-readiness pair: remove the current exhibits, then
make the exhibits expensive to recreate. That is the same loop
[harness engineering](./harness-engineering.md) already describes.

After Track A–C land, replace the snapshot tables on this page with a pointer at
the ratchet output, or delete this page and keep only the quality bar in
[code style](./code-style.md) and the checkers.
