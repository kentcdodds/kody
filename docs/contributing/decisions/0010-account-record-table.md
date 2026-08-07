# 0010: One RecordTable for account and admin list/detail screens

- **Status:** accepted
- **Date:** 2026-08-07

## Context

Thirteen account and admin screens compose `AccountManagementLayout`: a card
list in a `minmax(18rem, 22rem)` sidebar beside a card detail pane. Inside
`AccountManagementShell` the 200px nav rail, the gutters and the `72rem`
(`layoutMaxWidths.extended`) cap leave an 810px content column, and that column
is then split 352 + 24 + 434. The detail pane therefore gets 434px on any
monitor, because widening the browser past 1152px only adds margin.

At 434px a card detail pane is 376px inside its padding, and
`<MetadataGrid columns={3}>` divides that into 115px columns. A 36-character
UUID reaching such a column with `overflow-wrap: anywhere` wraps into five lines
of broken hex. There are 17 `MetadataGrid` call sites, nine of them at
`columns={3}`. Four screens hand-roll a table through
`accountManagementTableCss`.

Measurements and the rejected alternatives are in
[the supporting material](./0010-account-record-table/index.md).

## Decision

Keep `AccountManagementShell` exactly as it is — rail, cap, gutters and both
breakpoints — and stop splitting the content column. A single `RecordTable`
component owns the inside of these screens, with a `mode` prop selecting where
the record renders:

- `expand` — the record unfolds inside the table beneath its own row, for
  read-only records (packages, activity, email, admin users, admin platform
  feedback)
- `pane` — the record renders in a pane below the table, for records with an
  editor (secrets, values, memories, MCP servers, integrations, connectors,
  package invocation tokens, jobs)
- `none` — table only, replacing the four hand-rolled
  `accountManagementTableCss` screens

Rows stay real anchors built from `createListDetailRoute`, so the selected
record remains in the URL and the scroll-preserving list navigation from #1270
keeps working. `MetadataGrid` drops its `columns` prop for
`repeat(auto-fit, minmax(min(14rem, 100%), 1fr))`, and identifiers render
through an `IdValue` primitive as single-line copy targets rather than wrapped
prose.

Community listings and `/account/stars` stay card grids. They are content
(title, description, star count) rather than uniform records, and
`/account/stars` never adopted `AccountManagementLayout` in the first place.
Both still benefit from the `MetadataGrid` change.

## Consequences

The record gets the full 810px content column instead of 434px, metadata columns
size themselves from available space at every viewport, and the same markup
collapses to labeled cards below 620px — which is the part that helps phones,
where no amount of page width would have. `mode` being a prop rather than two
components keeps one toolbar, one table, one metadata band.

Each screen pays for column choices: which fields become columns, and a
`drop: 1 | 2 | 3` priority per column so narrow containers shed the least useful
ones instead of squeezing all of them. `expand` must not cap the list's height,
because the record renders inside that scroller and a capped list traps it in a
nested scroll; `pane` and `none` keep the cap.

Revisit if a screen needs simultaneous list and record visibility badly enough
to justify a fourth mode, or if a record grows past what one column can hold —
at which point a dedicated record route, deliberately not built here, becomes
the answer.
