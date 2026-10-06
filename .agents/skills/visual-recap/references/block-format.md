# Recap block format

Read this once while authoring the block. Risk-specific summary wording, map
edits, and preview live in [low.md](./low.md), [medium.md](./medium.md), or
[high.md](./high.md). The workflow and upsert command live in
[SKILL.md](../SKILL.md).

## Choosing a diagram

Pick the mermaid graph that best explains **this PR's** change. Do not default
to a topology flowchart.

- **Sequence diagram (preferred):** request or job timing, who calls whom, and
  what this PR adds or changes on each hop. This is the usual choice.
- **Flowchart / system map:** many-to-many wiring, fan-out, or a crossing that
  is awkward as a single timed path. Useful **in addition** to a sequence
  diagram when topology is the story.
- **Other mermaid types** when they fit better: `erDiagram` for schema,
  `stateDiagram-v2` for lifecycle, `flowchart TB` for a decision tree. Use them
  instead of (or alongside) a sequence diagram. Do not force a sequence diagram
  that hides the real change.

Every diagram is PR-scoped: only the path this diff changes, not the full
architecture. Open with one sentence naming what the graph shows. **Label every
arrow or message** with what this PR does across that boundary (route, handler,
table/column, guard, capability, env var). Unlabeled arrows are forbidden.

Include at least one diagram. Add a second only when it shows something the
first cannot (for example a sequence for timing plus a small ER snippet for a
new table). Do not restate the same path in two graphs.

## Block format

The block lives in the PR description between HTML comment markers, wrapped in
`<details>`. Fixed section order. Keep the structure stable so the
marker-delimited block stays machine-readable. Omit optional sections rather
than leaving them empty.

````markdown
<!-- system-recap:start -->

<details>
<summary>System recap — <b>composes existing primitives</b> (low risk)</summary>

**Mode:** recap · **Base:** `main` @ `abc1234` · **Head:** `def5678`

**Classification:** composes — no primitives added or changed; this PR wires
existing primitives together.

### Primitives touched

| Primitive    | Group    | Impact                                  |
| ------------ | -------- | --------------------------------------- |
| `mcp-server` | surfaces | composes                                |
| `d1-app-db`  | storage  | extends — new `jobs.retry_count` column |

### Change flow

Search/execute records a retry count on the job row.

```mermaid
sequenceDiagram
	participant mcpServer as mcp-server
	participant registry as capability-registry
	participant d1AppDb as d1-app-db
	mcpServer->>registry: search/execute
	registry->>d1AppDb: write jobs.retry_count
```

### System map

_Optional: a topology flowchart when a sequence diagram is not enough, or when a
second view of crossings helps._

### Before / after

_Optional: schema, API shape, or route changes as compact before/after fenced
blocks or tables._

### Invariants

_Optional: only when the change touches an invariant from primitives.yaml._

### Plan vs actual

_Recap mode only, when a plan-mode block existed: what shipped as planned and
what drifted, in a short list._

</details>

<!-- system-recap:end -->
````

The fenced example above is the low-risk shape. Keep the same section order for
every risk. Put the rollup classification and risk in the `<summary>` (bold) and
in the **Classification** line. Medium says `extends` and medium risk. High says
`adds` and high risk. Wording for those rollups is in the matching risk
reference.

## Format rules

- The `<summary>` line always carries the overall classification and risk in
  bold so reviewers see it without expanding.
- Blank line after `<summary>` and around every fenced block, or GitHub will not
  render the markdown/mermaid inside `<details>`.
- **Change flow** (preferred visual): usually a mermaid **sequence diagram** of
  the changed path. Rules:
  - Open with one sentence naming the main flow (e.g. "Social login flows from
    the login UI through session auth into D1.").
  - Participants are primitives: use the `id` as the alias (e.g.
    `participant appSessions as app-sessions`). Add an `actor` only when a human
    or external caller is part of the change.
  - **Label every message** with what this PR does on that hop. Unlabeled
    messages are the sequence-diagram form of unlabeled flowchart arrows.
  - Include only participants on the changed path, not all ~25 primitives. Add a
    neighbor only when this PR actually calls through them.
  - Use `Note over` / `Note right of` for new or changed data, guards, or
    status. Notes do not substitute for a labeled message.
  - Do not put `;` in sequence notes or messages: mermaid ends the statement
    there, and GitHub then fails on leftover tokens (often `+`). Rephrase
    (`and`, a comma) instead of quoting. `npm run mermaid:check` and
    `upsert-recap-block.mjs` parse every fenced mermaid block the way GitHub
    does.
  - Keep the happy path first. Use `alt` / `opt` only for a branch this PR
    introduces or changes.
- **System map** (optional): a PR-scoped **topology** view of how touched
  primitives connect because of this diff. Use when a sequence diagram cannot
  show fan-out, ownership, or several crossings at once. Rules when you include
  one:
  - Include the **legend** line directly above the flowchart, using this fixed
    wording: green = composes (wiring only) · amber = extended by this PR · red
    = new primitive · gray = context (unchanged, included only when an edge
    crosses it).
  - Node labels: primitive `id` plus the `name` from `primitives.yaml` on a
    second line via `<br/>` (e.g.
    `appSessions["app-sessions<br/>Browser sessions"]`).
  - Color nodes with the four `classDef` styles (`touched` = composes,
    `extended`, `added`, `untouched` for context-only nodes).
  - **Label every edge.** Prefer fewer, labeled edges over chaining unlabeled
    `A --> B --> C` hops.
  - Quote node labels containing spaces or special characters.
  - Skip this section when the sequence diagram already covers the path,
    including storage or cross-cutting hops (DB, RBAC, export).
- Other mermaid types follow the same labeling and PR-scope rules. Put an
  `erDiagram` or `stateDiagram-v2` in **Change flow** (or **Before / after** for
  a compact schema snippet) when that graph is the clearest.
- Keep the whole block scannable: prefer tables and diagrams over prose, and
  keep it well under ~120 lines.

## Plan mode

Same sections, with these differences: `**Mode:** plan`, no Base/Head commits
required, and "Primitives touched" describes intended impact. When
implementation later diverges from the plan, the recap's "Plan vs actual"
section records the drift.

## Diagram examples (weak vs strong)

The diagram must explain **this PR's** crossings, not restate static
architecture. A sequence diagram is the usual strong choice.

**Weak** (unlabeled hops; reviewers cannot tell what changed):

```mermaid
sequenceDiagram
	participant appUi as app-ui
	participant appSessions as app-sessions
	participant d1AppDb as d1-app-db
	appUi->>appSessions: request
	appSessions->>d1AppDb: write
```

**Strong** (intro sentence, primitive participants, messages from the diff):

Social login flows from the login UI through session auth into D1; the new
`oauth_connections` row is what account export later reads.

```mermaid
sequenceDiagram
	actor User
	participant appUi as app-ui
	participant appSessions as app-sessions
	participant rbac as rbac
	participant d1AppDb as d1-app-db
	User->>appUi: click provider button
	appUi->>appSessions: POST /auth/:provider
	appSessions->>rbac: 2FA gate on sign-in
	appSessions->>d1AppDb: insert oauth_connections
	Note over d1AppDb: new table is an export + deletion target
```

A topology flowchart is still useful when the change is structural rather than a
single timed path (several owners, fan-out, or crossings a sequence would
flatten). Same labeling bar: every edge names what this PR does.

**Weak** (unlabeled topology):

```mermaid
flowchart LR
	appUi["app-ui"]:::touched
	appSessions["app-sessions"]:::extended
	d1AppDb["d1-app-db"]:::extended
	appUi --> appSessions --> d1AppDb
```

**Strong** (intro, legend, human names, labeled edges):

Account export and session auth both gain the new `oauth_connections` table.

**Legend:** green = composes · amber = extended by this PR · red = new primitive
· gray = context.

```mermaid
flowchart LR
	appUi["app-ui<br/>Browser app"]:::touched
	appSessions["app-sessions<br/>Browser sessions"]:::extended
	d1AppDb["d1-app-db<br/>D1 app database"]:::extended
	accountExport["account-export<br/>Account data export"]:::extended
	rbac["rbac<br/>Role-based access control"]:::untouched
	appUi -->|"POST /auth/:provider buttons"| appSessions
	appSessions -->|"oauth_connections table"| d1AppDb
	appSessions -->|"2FA gate on sign-in"| rbac
	accountExport -->|"export + deletion targets"| d1AppDb
	classDef touched fill:#1a7f37,color:#fff
	classDef extended fill:#9a6700,color:#fff
	classDef added fill:#cf222e,color:#fff
	classDef untouched fill:#57606a,color:#fff
```

Derive message and edge labels from the diff (routes, migrations, guards,
capabilities). Prefer the sequence diagram for "what happens in what order?".
Add a system map only when reviewers also need "which primitives does this PR
connect?".
