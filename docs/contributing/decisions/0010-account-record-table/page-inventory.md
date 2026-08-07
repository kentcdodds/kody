# Screen inventory

Supporting material for [decision 0010](../0010-account-record-table.md). Counts
taken on `main` at `9a4f3fcc`; line numbers drift, the shapes do not.

Two independent axes: which screens compose `AccountManagementLayout` (so they
get a `RecordTable` mode), and which render a `MetadataGrid` (so they get the
content-layer change whether or not their layout moves).

## `mode: 'expand'` — read-only record

The record unfolds inside the table under its own row. Buttons and short control
clusters are fine here; forms are not.

| Screen                    | Record content                                             |
| ------------------------- | ---------------------------------------------------------- |
| `account/packages`        | 6 metadata fields, tags, search index                      |
| `account/activity`        | metadata only                                              |
| `account/email`           | metadata plus action buttons                               |
| `admin/users`             | 9 metadata fields, a role cluster, two destructive actions |
| `admin/platform-feedback` | metadata only                                              |

`admin/users` is the boundary case: the only one here with live controls, and it
also hand-rolls a table today, so it is a replacement rather than an addition.
If the role cluster feels wrong in use it moves to `pane`.

## `mode: 'pane'` — record has an editor

The record renders in a pane below the table. Unfolded inside a row these push
the table apart by a screen or more.

| Screen                              | Why                                                  |
| ----------------------------------- | ---------------------------------------------------- |
| `account/secrets`                   | 8 editable fields, masked value, destructive actions |
| `account/values`                    | name, description, value textarea                    |
| `account/jobs`                      | `editState` form (name, timezone, schedule)          |
| `account/package-invocation-tokens` | two forms, eight textareas                           |
| `account/mcp-servers`               | connection form                                      |
| `account/integrations`              | provider config form                                 |
| `account/remote-connectors`         | connector form, five inputs                          |
| `account/memories`                  | edit field                                           |

## `mode: 'none'` — table only, no selection

These already hand-roll a table through `accountManagementTableCss`. Adopting
`RecordTable` removes that primitive rather than adding beside it.

| Screen               | Notes                                                  |
| -------------------- | ------------------------------------------------------ |
| `account/usage`      | numeric columns; wants `align: 'end'` and a meter cell |
| `admin/codemods`     | three tables in one screen                             |
| `admin/system-email` | one table                                              |
| `admin/users`        | listed above; its table becomes the `expand` one       |

`admin/invites`, `admin/community-reports` and `admin/roles` are flat lists with
no table today. They would read better tabulated, but none of them is why this
work exists — leave them until the primitive has settled.

## Out of scope

`account/stars` and the community listings stay card grids. They render content
— a title, a description, a star count — not uniform records, and
`account/stars` never adopted `AccountManagementLayout`. Both still pick up the
`MetadataGrid` change.

## `MetadataGrid` call sites

All 17 lose their `columns` prop. Nine currently pass `columns={3}`, which is
the configuration that produces the 115px column; the rest default to 2. The
definition itself lives at `account-management-components.tsx:808`.

| File                                    | Line | Today         |
| --------------------------------------- | ---- | ------------- |
| `account-email.tsx`                     | 734  | `columns={3}` |
| `account-packages.tsx`                  | 588  | `columns={3}` |
| `account-secrets.tsx`                   | 1670 | `columns={3}` |
| `admin-feature-flags.tsx`               | 408  | `columns={3}` |
| `admin-feature-flags.tsx`               | 561  | `columns={3}` |
| `admin-invites.tsx`                     | 505  | `columns={3}` |
| `admin-platform-feedback.tsx`           | 506  | `columns={3}` |
| `admin-system-email.tsx`                | 276  | `columns={3}` |
| `admin-users.tsx`                       | 868  | `columns={3}` |
| `account-activity.tsx`                  | 793  | default (2)   |
| `account-billing.tsx`                   | 455  | default (2)   |
| `account-jobs.tsx`                      | 839  | default (2)   |
| `account-mcp-servers.tsx`               | 583  | default (2)   |
| `account-memories.tsx`                  | 468  | default (2)   |
| `account-package-invocation-tokens.tsx` | 1715 | default (2)   |
| `account-usage.tsx`                     | 276  | default (2)   |
| `account-values.tsx`                    | 691  | default (2)   |

`account-billing.tsx` and `account-usage.tsx` render a `MetadataGrid` without
composing `AccountManagementLayout` at all, which is why the content-layer step
is worth landing on its own.

## Reproducing these counts

```sh
cd packages/worker/client/routes

# screens composing the list/detail layout
grep -l AccountManagementLayout *.tsx | grep -v account-management-components

# every MetadataGrid call site with its columns value
for f in *.tsx; do
  grep -n '<MetadataGrid' "$f" | while IFS=: read -r ln _; do
    cols=$(sed -n "${ln},$((ln + 2))p" "$f" | grep -oE 'columns=\{[0-9]\}' | head -1)
    printf '%s:%s %s\n' "$f" "$ln" "${cols:-default}"
  done
done

# screens hand-rolling a table
grep -rl accountManagementTableCss . | grep -v account-management-components
```
