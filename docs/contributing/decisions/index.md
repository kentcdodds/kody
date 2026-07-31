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
