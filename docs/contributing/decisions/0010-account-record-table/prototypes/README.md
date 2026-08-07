# Prototypes

Four self-contained pages behind
[decision 0010](../../0010-account-record-table.md). Open any of them directly
in a browser — no build step, no server.

Each one rebuilds `AccountManagementShell`, the 200px rail, the gutters, the
`72rem` cap and the 860/1100px breakpoints from
`packages/worker/client/routes/account-management-components.tsx`, using the
tokens in `packages/worker/public/styles.css` and the repo's own two typefaces
(loaded by relative path from `packages/worker/public/fonts/`, so they render
correctly from this directory).

The app's media queries are **container** queries in these pages, at the same
thresholds, so a frame can be resized with the slider without resizing the
browser. Every pixel figure and row count on the pages is measured from the live
DOM rather than written in.

Read them in order; each one answers the question the previous one raised.

| File                                                                 | Question it answers                                                |
| -------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [01-width-diagnosis.html](./01-width-diagnosis.html)                 | Where does the width go, and can it be patched without a redesign? |
| [02-rejected-shell-rewrites.html](./02-rejected-shell-rewrites.html) | What if the shell itself changed? (**rejected** — see 0010)        |
| [03-content-column-options.html](./03-content-column-options.html)   | Keeping the shell, how should the content column spend its 810px?  |
| [04-record-table-proof.html](./04-record-table-proof.html)           | Does one component really cover four very different screens?       |

`04` is the one that settled the API. It renders `account/packages`,
`admin/users`, `account/secrets` and `account/usage` through a single render
function and prints each screen's config underneath it — the configs being small
and declarative is the actual result.

## Caveats

- Records are rendered from **plausible** rows, not live data, except the real
  `@vojta/cloudflare` package used throughout. Two real packages cannot show
  density in a table, which is the thing under test.
- These are HTML and CSS, not Remix 3 components. They prove layout, density and
  responsive behavior. They do not prove component structure, and the
  `RecordTable` API in 0010 is a description of what the prototype does, not
  extracted code.
- Interaction is deliberately shallow: rows select, ids copy, disclosures open.
  Search, filters and sort are inert.
