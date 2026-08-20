# 0028: List/detail records expand inside the table

- **Status:** accepted
- **Date:** 2026-08-20
- **Supersedes:** [0010](./0010-account-record-table.md) mode assignment
  (`expand` for read-only records, `pane` for editors)

## Context

[0010](./0010-account-record-table.md) put editors in a pane below `RecordTable`
so a long form would not push the list apart. In use, that made secrets,
integrations, MCP servers, memories, jobs, and the other list/detail screens
feel unlike packages: the record lived outside the row that selected it. Create
flows (`/new`) also had no row to attach to — `selectedId` is `null` — so a
naive `mode="expand"` hid the editor.

Admin platform integrations already kept its form in the expanded row. That is
the shape readers expect for every list/detail screen.

## Decision

List/detail screens use `RecordTable` `mode="expand"`, including editors. `pane`
stays only as the off-window fallback: a loaded record whose row is not in the
current list (deep link, filter, or paging) still renders below the table. A
not-found state also renders below the table, even when no row is selected.

Create flows share one `createRow` prop. It prepends a selected placeholder row
and unfolds the editor under it, including when the collection is empty so the
table is not replaced by the empty-state copy.

## Consequences

The list is not height-capped while a record is expanded (already required by
0010). A large editor still grows the table; that is the accepted trade. Screens
no longer assemble a one-off `__new__` row and selected id.

Revisit if a record outgrows one column badly enough to need a dedicated route —
the option 0010 left open — rather than adding a fourth table mode.
