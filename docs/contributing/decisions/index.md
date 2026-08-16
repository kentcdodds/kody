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
- [0006 — No repo/package CI primitive for now](./0006-no-repo-ci-primitive.md)
- [0007 — Keep in-house feature flags; revisit Flagship at GA](./0007-keep-in-house-feature-flags.md)
- [0008 — Declined ADLC primitives (traces, previews, browser runs, session mining)](./0008-declined-adlc-primitives.md)
- [0009 — Shiki for in-app syntax highlighting](./0009-shiki-syntax-highlighting.md)
- [0010 — One RecordTable for account and admin list/detail screens](./0010-account-record-table.md)
  ([supporting material](./0010-account-record-table/index.md))
- [0011 — Workers-unit keeps per-file isolation; budget cold DO load in timeouts](./0011-workers-unit-pool-harness.md)
- [0012 — Client-safe shared code lives in `#universal/*`](./0012-universal-layer.md)
- [0013 — Synthetic package requests for post-publish verification](./0013-synthetic-package-requests.md)
- [0014 — Platform scopes resolve live in package imports](./0014-platform-live-packages.md)
- [0015 — Wait on Skills over MCP (SEP-2640); serve skill content via packages](./0015-skills-over-mcp-wait.md)
- [0016 — Extract the package runtime and jobs lanes into separate workers](./0016-mono-worker-extraction.md)
- [0017 — Per-user subdomains for hosted package apps](./0017-per-user-package-app-subdomains.md)
- [0018 — Inbound CLA for external contributions to this repository](./0018-inbound-cla.md)
