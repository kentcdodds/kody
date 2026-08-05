# Decision records

Short architecture decision records (ADRs) for choices that shape the platform,
including decisions **not** to build something. Check here before proposing a
change that may already have been decided.

Decision records are point-in-time documents, so they are exempt from
`npm run docs:check-temporal`; everything else in `docs/` describes current
behavior (see [documentation principles](../documentation.md)).

## Adding a record

1. Copy [`0000-template.md`](./0000-template.md) to the next number with a short
   kebab-case slug (for example `0002-some-decision.md`).
2. Keep it to roughly half a page: context, decision, consequences.
3. When a later record changes a decision, mark the old one `superseded by NNNN`
   rather than editing or deleting it.
4. Add the record to the list below.

## Records

- [0001 — No user-facing package versioning or import pins](./0001-no-package-versioning.md)
- [0002 — Data placement: D1, per-user Durable Objects, Analytics Engine](./0002-data-placement.md)
- [0003 — Repos are the base primitive; packages are an explicit extension](./0003-repos-as-base-primitive.md)
- [0004 — Status page as a separate worker with its own storage](./0004-status-page-separate-worker.md)
- [0005 — MCP dual-lane serving with metrics-driven legacy retirement](./0005-mcp-dual-lane-stateless-migration.md)
