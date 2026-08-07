# 0010 supporting material — account RecordTable

Working material behind [decision 0010](../0010-account-record-table.md): the
measurements that forced it, the alternatives that were rejected, the settled
component API, and the screen-by-screen inventory. Point-in-time by design, like
the record it supports.

- [Screen inventory](./page-inventory.md) — every affected screen, its mode, and
  its `MetadataGrid` call site
- [Prototypes](./prototypes/) — four self-contained pages, openable directly in
  a browser

## The measurement that reframed it

`AccountManagementShell` caps at `72rem`. Inside it the rail and gutters leave
an 810px content column, and `AccountManagementLayout` splits that column:

|               | list  | gap  | record    |
| ------------- | ----- | ---- | --------- |
| Split (today) | 352px | 24px | **434px** |
| Unsplit       | —     | —    | **810px** |

434px is what the browser reports at 1244px wide, and also at 2560px: past
1152px every extra pixel becomes margin. Unsplitting the column is worth +87% to
the record and touches nothing outside `AccountManagementLayout` — more than
raising the cap to `96rem` would have given (525px at the same viewport), for a
far smaller blast radius.

At 434px the pane is 376px inside its padding, so `columns={3}` yields 115px
columns. A UUID is 36 characters. That is the whole story of the wrapped ids.

## Rejected alternatives

**Raise the cap to `layoutMaxWidths.wide`.** Two tokens, and it does help. But
the header and footer keep their own `72rem` measure, so the console outgrows
the brand above it unless all three move together, and it does nothing for
phones. Kept as a possible follow-up, not a prerequisite.

**Replace the shell: rail into a horizontal section bar, uncapped width,
mail-client split.** Prototyped in
[02-rejected-shell-rewrites.html](./prototypes/02-rejected-shell-rewrites.html).
It buys the most room, but the rail is not what starves the record — the split
is — and a 15-item horizontal section bar scrolls sideways on a laptop, which
trades one problem for another. Rejected in favour of leaving the shell alone.

**A dedicated record route per screen.** Best density available, and the right
answer for a record deep-linked from outside the account area. It discards the
scroll-preserving list navigation from #1270 and turns comparing two records
into two navigations. Deliberately not built; named in 0010 as the escape hatch
if a record outgrows one column.

**Keep side-by-side with a slimmer list.** A 216px name-and-date rail gives the
record 578px. Better than today, worse than stacking, and it forces the filters
into a popover that then needs designing. Rejected.

## The component API

Settled by building it against four screens rather than by design:

```ts
RecordTable({
  mode: 'expand' | 'pane' | 'none',
  columns: [{ key, label, align?, drop?, render? }],
  rows,
  selectedId,
  buildHref, // rows stay real links
  toolbar: [ /* controls */ ],
  renderRecord, // omitted for mode: 'none'
  countLabel,
})
```

Four screens needed 13–15 lines of config each and no per-page CSS. Three things
that only surfaced from building it:

1. **`mode` is a prop, not two components.** The plan was `RecordTable` plus a
   separate list-over-detail layout. Secrets proves they are one component:
   identical toolbar, table, columns and metadata band, differing only in where
   the record renders.
2. **Column dropping is per-column priority, not one breakpoint.** Usage has
   five columns that all matter; packages has two that do not. Hence
   `drop: 1 | 2 | 3` on the column, with the card fallback at 620px catching
   whatever is left.
3. **`expand` must not cap the list height.** The record renders inside the
   list's scroller, so a `max-height` traps it in a nested scroll. Visible the
   moment admin users unfolded eight fields and a role cluster. `pane` and
   `none` keep the cap, because there it is what keeps the record below
   reachable.

A control _cluster_ fits an expanded row (admin users carries a role select, an
add button and two destructive actions). A _form_ does not — that is what `pane`
exists for.

## Implementation order

Two independent steps. The first stands alone and is the only one that helps
phones.

**1. Content layer.** No layout change, so it can land and be judged by itself.

- `MetadataGrid`: drop the `columns` prop for
  `repeat(auto-fit, minmax(14rem, 1fr))`; update all 17 call sites
- Add an `IdValue` primitive: single line, `text-overflow: ellipsis`, full value
  in `title`, copy button. Replaces `<code overflowWrap: anywhere>` for every id
- Timestamps get `white-space: nowrap` and `font-variant-numeric: tabular-nums`
- `/account/packages` `searchText` moves behind a disclosure with a scroll box
  rather than setting the page's height

**2. `RecordTable`, with `/account/packages` as its first consumer.** Live with
one screen before migrating the rest. `AccountManagementLayout` stays until the
last consumer moves off it.

Both steps keep `createListDetailRoute`, the loader payloads, and the `selected`
query parameter untouched — this is a rendering change, not a data or routing
one.

## Open questions

- **Sort affordance.** The prototype's toolbar keeps the existing `sort` select.
  Clickable column headers would be more natural in a table but need to stay
  URL-backed to match how `q`, `app` and `sort` already work.
- **Expanded-row semantics.** The prototype uses a `colspan` row after the
  selected row. The name cell's link wants `aria-expanded` and `aria-controls`
  pointing at that row; worth checking against a screen reader, since the axe
  suite will not catch an awkward-but-valid table.
- **`admin/users` role cluster.** It reads fine in an expanded row, but it is
  the only `expand` screen with live controls. If it feels wrong in use, it
  moves to `pane` — a one-word change.
- **Whether to also raise the cap** afterwards, moving header and footer in
  step. Independent of everything above.
