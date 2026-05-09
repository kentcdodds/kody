# RFC: rethink the example oxlint plugin rule

Status: draft, request for comment. No source changes proposed in this PR.

## Background

Three files in this repo exist solely to demonstrate how to author a custom
[oxlint](https://oxc.rs/docs/guide/usage/linter/js-plugins.html) JS plugin:

- [`tools/oxlint/local-plugin.js`](../../../tools/oxlint/local-plugin.js)
  defines a plugin `kody-custom` exposing one rule, `no-example-identifier`,
  which flags any identifier literally named `__oxlint_plugin_example__`.
- [`tools/oxlint/oxlint-rules.json`](../../../tools/oxlint/oxlint-rules.json)
  registers the plugin and turns the rule on at `error` severity.
- [`docs/contributing/oxlint-js-plugins.md`](../oxlint-js-plugins.md) is the
  tutorial that points contributors at the example.
- [`.oxlintrc.json`](../../../.oxlintrc.json) extends
  `./tools/oxlint/oxlint-rules.json`, so the rule runs on every
  `npm run lint` invocation, including production CI.

The sentinel identifier `__oxlint_plugin_example__` is not used anywhere in
the repo and never will be. The rule's only job is to keep the contributor
documentation grounded in a real, working plugin wired into the live config.

This RFC weighs three paths and recommends one.

## Option A: keep as-is, add a clarifying banner

Leave the plugin, config, and `.oxlintrc.json` extends entry exactly as they
are today and tighten the tutorial copy so future readers do not mistake the
rule for something with production teeth.

### Cost analysis

The runtime cost is negligible. The rule is a single `Identifier` visitor that
short-circuits on a name comparison, dispatched per file by oxlint's batched JS
plugin runner. On a repo of this size (low thousands of files lint-checked
per `npm run lint`), the additional time per lint run is dominated by JS
plugin dispatch overhead and is well under a millisecond per file in practice;
total wall-time impact is below the noise floor of a normal lint run. The
plugin file itself is ~30 lines and is parsed once per lint invocation.

The honest cost is conceptual rather than runtime: a rule that can never fire
in production code is a small but permanent piece of cruft in the lint config,
and new contributors have to read the plugin and the tutorial to understand
why it exists.

### Proposed clarifying edits

In [`docs/contributing/oxlint-js-plugins.md`](../oxlint-js-plugins.md):

- Add a short banner under the page title, for example:
  > Note: the `kody-custom/no-example-identifier` rule is intentionally a
  > no-op in production. It exists only to keep this tutorial wired into the
  > live oxlint config so the example cannot drift. See
  > [`docs/contributing/cleanup-rfcs/oxlint-plugin-example.md`](./cleanup-rfcs/oxlint-plugin-example.md)
  > for the rationale.
- In the "Example in this repo" section, replace the current sentence
  ("This keeps the demo deterministic and avoids accidentally linting normal
  production code.") with text that explicitly calls out the rule as a
  no-op-in-production tutorial fixture.
- Add a one-liner near "Verify manually" reminding readers that the rule's
  presence in CI is a deliberate design choice, not an oversight.

In [`tools/oxlint/local-plugin.js`](../../../tools/oxlint/local-plugin.js),
optionally extend the `description` string in `meta.docs` to read something
like "Tutorial-only no-op rule; see docs/contributing/oxlint-js-plugins.md."

### Pros

- Zero behavior change. The doc continues to point at a real, plugged-in rule
  that contributors can run against a scratch file end-to-end.
- The "executable docs" property is preserved: if the plugin loader, JS
  plugin protocol, or `createOnce` shape ever regresses, `npm run lint` will
  surface the failure immediately rather than after the next contributor
  tries to author a custom rule.

### Cons

- The rule still ships in production CI with no production purpose.
- A rule that lints for an identifier no human will ever write is a magnet
  for "what is this?" questions and PR review noise.

## Option B: keep the docs, delete the live rule

Move the example plugin source into a fenced code block inside
[`docs/contributing/oxlint-js-plugins.md`](../oxlint-js-plugins.md), then:

- Delete [`tools/oxlint/local-plugin.js`](../../../tools/oxlint/local-plugin.js).
- Delete [`tools/oxlint/oxlint-rules.json`](../../../tools/oxlint/oxlint-rules.json),
  or empty it out if other future local rules might land there.
- Remove the `./tools/oxlint/oxlint-rules.json` entry from the `extends`
  array in [`.oxlintrc.json`](../../../.oxlintrc.json).

The tutorial would then be a self-contained code listing labeled "save this
as `tools/oxlint/local-plugin.js` and register it in
`tools/oxlint/oxlint-rules.json` to enable" rather than a tour of files
already in the repo.

### Pros

- Lint config becomes honest about what is enforced. Every entry in the
  config corresponds to a rule that can actually fire on this repo's code.
- Removes a small piece of permanent cruft from production CI.
- Eliminates the "what is `__oxlint_plugin_example__`?" question entirely.

### Cons

- The doc no longer demonstrates a working integration. It demonstrates code
  that *could* work, which is qualitatively weaker.
- Doc rot risk goes up. If the JS plugin loading API or `createOnce`
  signature changes upstream, nothing in this repo will surface the break.
  Contributors learn the regression by trying the snippet and discovering
  it no longer compiles, rather than by `npm run lint` failing.
- This contradicts the spirit of
  [`docs/contributing/setup.md`](../setup.md)'s guidance: "When failures
  repeat, promote lessons from docs into tests, lint rules, or scripts."
  Option B does the inverse for this particular doc.

## Option C: replace with a real rule

Keep the integration plugged into CI, but make the example rule earn its
keep by enforcing something the team actually cares about. The tutorial then
points at a rule that is both a working integration *and* a real lint check,
which is strictly better than either A or B.

### Candidate rules sourced from existing guidance

The following candidates come from
[`docs/contributing/code-style.md`](../code-style.md), the user rule "Keep
imports at top of file and avoid inline imports", recurring nits visible in
recent PRs, and the cloud-agent guidance in `AGENTS.md`. For each, the
checked criterion is: is it (a) clearly stated in our own guidance, (b) not
already enforced by the `@epic-web/config` baseline or by an oxlint builtin
we already ship, and (c) cheap to implement as a single AST visitor.

#### C1. `no-inline-dynamic-import` — ban `await import(...)` outside module scope

What it does: flags `ImportExpression` nodes (i.e., `import(...)` calls)
that appear inside function bodies, methods, or arrow expressions. Module
top-level dynamic imports remain allowed for legitimate code-splitting cases.

Why it matters: the agent-side user rule `no-inline-imports` says
"Keep imports at top of file and avoid inline imports." Ad-hoc
`await import('...')` inside handler bodies is one of the most common
recurring review nits — it hides dependencies, defeats static analysis, and
produces inconsistent module graphs across hot paths. A cluster of test
files in `packages/worker/src/` already uses this pattern (mostly to break
import cycles in test setup); a lint rule with a tightly scoped
`overrides` block for `**/*.test.ts` plus a single `eslint-disable-next-line`
escape hatch would document the exception explicitly rather than implicitly.

Implementation sketch (one visitor):

```js
ImportExpression(node) {
  // Walk up the scope chain; if any ancestor is a function/method, report.
}
```

`createOnce` makes this trivial to wire up because the scope lookup happens
once per node visit, not once per file.

Risk: a few legitimate lazy-load sites (deferred Cloudflare/Wrangler
imports, large optional dependencies) would need disable comments. The
allowlist surface is small and stable.

#### C2. `prefer-array-generic` — ban `T[]` in favor of `Array<T>` / `ReadonlyArray<T>`

What it does: flags `TSArrayType` AST nodes and recommends rewriting them
as `Array<T>`.

Why it matters:
[`docs/contributing/code-style.md`](../code-style.md) explicitly states
"Prefer `Array<T>` and `ReadonlyArray<T>` over `T[]`. This avoids precedence
pitfalls in union types and keeps type reads clearer." The repo already
adheres to this in hand-written source (a quick grep finds only a handful of
hits in non-generated files), so the rule mostly serves as a guard rail
against drift, especially for new contributors and AI-generated diffs.

Caveat: the upstream `@typescript-eslint/array-type` rule covers this
behavior. Before authoring a custom version we should confirm whether
oxlint already ships a builtin equivalent. If it does, this candidate
collapses into "just enable the builtin" and is no longer a fit for the
*custom plugin* example slot. If it does not, a thin custom rule is the
shortest path and doubles as a teaching example.

Implementation sketch:

```js
TSArrayType(node) {
  context.report({ node, messageId: 'preferArrayGeneric' })
}
```

Risk: noisy on first introduction; would need either a one-shot codemod or
a phased `warn` -> `error` rollout.

#### C3. `no-relative-parent-imports` — ban `../../` import specifiers

What it does: flags `ImportDeclaration` and `ExportAllDeclaration` source
strings that begin with `../../` (or `..` followed by `../`). Same-folder
`./...` imports remain allowed, as do generated files via an `ignorePatterns`
or `overrides` block matching `worker-configuration.d.ts`.

Why it matters:
[`docs/contributing/code-style.md`](../code-style.md) says "Prefer repo-root
`#...` imports (configured via `package.json` `imports`) over parent-relative
`../...` paths." The repo is essentially clean already (one current
violation in `packages/worker/src/mcp/resources/generated-ui-app-resource.ts`,
which a follow-up can fix), so this is again a guard-rail rule that prevents
new drift more than it cleans up old code.

Caveat: same as C2 — if `eslint-plugin-import`'s
`no-relative-parent-imports` is already available through oxlint's
`import/...` namespace and we just have not opted in, adopting the builtin
is the right move and this candidate stops being a custom-plugin example.

Implementation sketch:

```js
ImportDeclaration(node) {
  if (node.source.value.startsWith('../../')) {
    context.report({ node: node.source, messageId: 'preferRootImport' })
  }
}
```

Risk: low. The fix is mechanical and the rule has well-defined edges.

### Which one earns the slot

C1 (`no-inline-dynamic-import`) is the strongest candidate because:

- It maps directly to a user rule that already exists and is repeatedly
  cited in review.
- It is unlikely to be covered cleanly by an existing builtin (most
  upstream rules in this space target `require()`, not `await import()`,
  and few of them gate on enclosing scope rather than file location).
- The implementation requires a small amount of scope analysis, which makes
  it a *better* tutorial example than the current single-line identifier
  comparison: it shows readers something they could not trivially do with a
  text grep, and exercises the `createOnce` API meaningfully.

C2 and C3 are still worth picking up separately, but they should be added
as builtin-or-thin-shim rules in
[`tools/oxlint/oxlint-rules.json`](../../../tools/oxlint/oxlint-rules.json),
not as the showcase plugin example.

## Recommended path

**Option C, with C1 (`no-inline-dynamic-import`) replacing the current
example rule.** This preserves the "executable docs" property of Option A —
the tutorial keeps pointing at a real plugin loaded by the real lint config,
so any regression in oxlint's JS plugin protocol surfaces on the next
`npm run lint` — while removing the cruft objection that motivates Option B.
The replacement rule pulls its weight on real code, exercises a slightly
richer slice of the `createOnce` API than the current sentinel-identifier
check, and codifies an existing user rule that contributors and review
agents already invoke informally. Pursuing C2 and C3 alongside (preferably
via oxlint builtins where available) would land most of the recurring
code-style-doc nits in CI without bloating the custom plugin surface.

If C1 turns out to be impractical for any reason — for example, if the
exception list balloons or if scope analysis through `createOnce` proves
fragile against the repo's mix of `.ts`/`.tsx`/`.js` source — fall back to
**Option A with the clarifying banner**, not Option B. Keeping the docs
attached to a live, loaded plugin is the more important property; the
identity of the rule itself is secondary.
