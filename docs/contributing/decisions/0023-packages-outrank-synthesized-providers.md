# 0023: Packages outrank synthesized providers

- **Status:** accepted
- **Date:** 2026-08-19

## Context

OpenAPI bindings and connected MCP servers can synthesize dozens of operations
for one provider. A provider-name query therefore favored repetitive raw
operations even when the user had saved a package that wrapped the provider with
safer workflows, storage, jobs, or an app.

## Decision

When a saved package's Kody id, package name, tags, or README identity matches
an OpenAPI or MCP provider, ranked discovery places the package and a compact
provider card above raw operations. The provider card reports the operation
count, runtime call pattern, and matching wrapping package. General
provider-name search does not expand dozens of operations; exact tool or
operation names and `search({ domain })` continue to resolve operations.

## Consequences

Users discover maintained, higher-level behavior before low-level bindings while
retaining direct access to every generated operation. Provider/package matching
remains explainable identity matching and may need additional aliases as naming
conventions evolve. We reject automatically deleting provider bindings and a
per-user ranking toggle because both would make capability availability or
discovery semantics inconsistent.
