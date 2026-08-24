# 0037 — No author-facing `packages.invoke`

- **Status:** accepted
- **Date:** 2026-08-24

## Context

`packages.invoke` was a third composition primitive next to static `kody:@`
imports and workflows. Among user-owned modules (including forks), isolate
entry is not a trust boundary: an agent can publish another self-authored
package. The useful jobs invoke covered are already other primitives: a
known name is a static import; a name that is data is `import(specifier)`;
exactly-once is a workflow. HTTP invocation tokens are ingress, not author
composition — they run a named export and do not use the `kody:runtime`
helper.

## Decision

Authors do not get `packages.invoke`.

- Name known at write time → static `import` from `kody:@scope/package/export`.
- Name is data → `import(specifier)` (caller-owned / forks). Computed
  specifiers load through a runtime helper that still uses the quarantined
  invoke path until that helper is deleted
  ([#1750](https://github.com/kentcdodds/kody/issues/1750)).
- Exactly-once → workflows. Do not keep a keyed invoke beside them.
- External callers → HTTP invocation tokens (`POST /@:user/api/package-invocations/…`).
  That path stays. It is not `packages.invoke`.

The `kody:runtime` helper stays quarantined for a soak so already-published
packages do not break, then the folder is deleted.

## Consequences

Composition is import plus workflows. Agents stop seeing invoke in usage
docs, guides, and MCP copy. Fleet source migrates with package codemod
`0008-packages-invoke-to-static-import` (literal specifiers → static
import, including Markdown examples; computed specifiers →
`import(specifier)`; keyed invokes stay `needsManual` for workflows).

Revisit only if the computed `import(specifier)` facade cannot stand in
for caller-owned name-as-data loads after the quarantined helper is
deleted.
