---
name: visual-recap
description:
  Generate and maintain the system recap block in a PR description - a
  GitHub-rendered visual summary of which system primitives a change touches,
  how risky it is, and what changed. Use when planning a non-trivial change
  (plan mode), when creating or updating a pull request (recap mode), or when
  the user asks for a visual recap, visual plan, system review, or PR recap.
---

# System recap (visual plan / visual recap)

Produce a high-altitude, visual review aid directly in the PR description. No
deployment, no third-party service: GitHub renders the block (including mermaid
diagrams), and the PR itself is the storage. A future viewer app can ingest the
same marker-delimited block via the GitHub API, so follow the format exactly.

The recap is informational and non-blocking. It supplements the PR description
and normal code review; it never replaces reading the diff.

## Two modes, one format

- **Plan mode** (before/while implementing): describe the intended change
  against the current system. If no PR exists yet, put the block in the plan
  document or message; move it into the PR description once the PR exists.
- **Recap mode** (PR creation and every meaningful update): describe what the
  diff actually does. Replaces a plan-mode block if one exists.

## Source-of-truth rules (non-negotiable)

1. **Recap mode reads the diff, not memory.** Generate the recap from
   `git diff <base>...HEAD` (plus `git diff --stat`) against the PR base branch.
   Session context may explain intent, but every claim about what changed must
   be checkable against the diff.
2. **Classification uses the primitives taxonomy.** Read
   [`docs/contributing/architecture/primitives.yaml`](../../../docs/contributing/architecture/primitives.yaml)
   for stable `id` / `name` / `group` values. Prefer the classifier script over
   hand-matching paths:

   ```bash
   node .agents/skills/visual-recap/scripts/classify-primitives.mjs --base <base> --head HEAD
   # or: git diff --name-only <base>...HEAD | node .../classify-primitives.mjs --stdin --json
   ```

3. **The taxonomy is not a feature changelog.** Update `primitives.yaml` only
   when this PR **adds, removes, or materially reshapes** a primitive (new `id`,
   renamed meaning, or ownership roots that must change). Do **not** edit
   `summary` for ordinary feature work — put behavioral detail in the linked
   architecture docs under `docs:`. Run `npm run primitives:check` after map
   edits.

## Risk classification

Classify each touched primitive, then roll up to the highest severity as the
overall classification (`adds` > `extends` > `composes`):

| Classification | Meaning                                                    | Risk   |
| -------------- | ---------------------------------------------------------- | ------ |
| `composes`     | Uses existing primitives as-is; wiring and call sites only | Low    |
| `extends`      | Changes a primitive's behavior, shape, or contract         | Medium |
| `adds`         | Introduces a new primitive (must update primitives.yaml)   | High   |

A change touching invariants from `primitives.yaml` (for example per-user
isolation) is called out explicitly regardless of classification.

The classifier reports which primitives' `code` roots the diff touches; you
still decide `composes` vs `extends` from the diff (and `adds` when you create a
new map entry).

## Block format

The block lives in the PR description between HTML comment markers, wrapped in
`<details>`. Fixed section order — a future ingestion process parses this
structure. Omit optional sections rather than leaving them empty.

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

### System map

_One sentence: what this diagram shows and the main path through the change._

**Legend:** green = composes (wiring only) · amber = extended by this PR · red =
new primitive · gray = context (unchanged, included only when an edge crosses
it).

```mermaid
flowchart LR
	mcpServer["mcp-server<br/>MCP endpoint"]:::touched
	capabilityRegistry["capability-registry<br/>Capability registry"]:::untouched
	d1AppDb["d1-app-db<br/>D1 app database"]:::extended
	mcpServer -->|"search/execute"| capabilityRegistry
	capabilityRegistry -->|"jobs.retry_count column"| d1AppDb
	classDef touched fill:#1a7f37,color:#fff
	classDef extended fill:#9a6700,color:#fff
	classDef added fill:#cf222e,color:#fff
	classDef untouched fill:#57606a,color:#fff
```

### Change flow

_Optional: a mermaid flowchart or sequence diagram of the specific change._

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

Format rules:

- The `<summary>` line always carries the overall classification and risk in
  bold so reviewers see it without expanding.
- Blank line after `<summary>` and around every fenced block, or GitHub will not
  render the markdown/mermaid inside `<details>`.
- **System map**: a PR-scoped **change map** — how touched primitives interact
  _because of this diff_, not the full architecture. Rules:
  - Open with one sentence naming the main flow (e.g. "Social login flows from
    the login UI through session auth into D1.").
  - Include the **legend** line (colors and what they mean) directly above the
    diagram, using the fixed wording from the template.
  - Include only primitives the diff touches plus neighbors needed to show a
    crossing edge — not all ~25 nodes, and no gray context nodes unless this PR
    actually calls through them.
  - **Label every edge** with what this PR does across that boundary: route,
    handler, table/column, guard, capability, env var, etc. Unlabeled arrows are
    forbidden; they read as meaningless topology and are the main failure mode
    reviewers report.
  - Node labels: primitive `id` plus the `name` from `primitives.yaml` on a
    second line via `<br/>` (e.g.
    `appSessions["app-sessions<br/>Browser sessions"]`).
  - Color nodes with the four `classDef` styles (`touched` = composes,
    `extended`, `added`, `untouched` for context-only nodes).
  - Prefer fewer, labeled edges over chaining unlabeled `A --> B --> C` hops.
    Split long chains only when each hop has its own label.
  - Quote node labels containing spaces or special characters.
  - When a sequence diagram already in **Change flow** covers the same path, the
    system map may omit duplicate edges — but still include storage or
    cross-cutting hops (DB, RBAC, export) that the sequence diagram skips.
- Keep the whole block scannable: prefer tables and diagrams over prose, and
  keep it well under ~120 lines.

## Workflow

### Recap mode (PR create/update)

1. Resolve base/head (`gh pr view <n> --json baseRefName,headRefName`).
2. Classify paths:

   ```bash
   node .agents/skills/visual-recap/scripts/classify-primitives.mjs --base <base> --head HEAD --json
   ```

3. Read the full diff for anything you did not author this session; decide
   composes/extends/adds per matched primitive (and note important unmatched
   paths if they introduce a new surface).
4. Author the block following the format above. Use map `name` for diagram
   labels; pull behavioral detail from architecture docs / the diff, not by
   rewriting map summaries.
5. Upsert it into the PR description:

   ```bash
   node .agents/skills/visual-recap/scripts/upsert-recap-block.mjs <pr-number> <block-file>
   ```

   The script replaces the content between the markers, or appends the block to
   the end of the description on first run. It never touches text outside the
   markers.

6. Re-run steps 2-5 after pushing significant new commits to the PR.

When the recap is **medium** (`extends`) or **high** (`adds`), also load
[`.agents/skills/preview-manual-test/SKILL.md`](../preview-manual-test/SKILL.md)
and exercise the PR preview **as the seeded logged-in user with data for this
change** (`--request` / `--cookie-file`, then a UI pass). A health/login smoke
alone is not enough.

### Plan mode

Same steps, except: `**Mode:** plan`, no Base/Head commits required, "Primitives
touched" describes intended impact, and add a one-line note when the plan
requires **no** change to any primitive — that is the lowest-risk outcome and
worth stating explicitly. When implementation later diverges from the plan, the
recap's "Plan vs actual" section records the drift.

## System map example (weak vs strong)

The diagram must explain **this PR's** crossings, not restate static
architecture. Compare:

**Weak** (unlabeled topology — reviewers cannot tell what the arrows mean):

```mermaid
flowchart LR
	appUi["app-ui"]:::touched
	appSessions["app-sessions"]:::extended
	d1AppDb["d1-app-db"]:::extended
	appUi --> appSessions --> d1AppDb
```

**Strong** (intro, legend, human names, labeled edges):

Social login flows from the login UI through session auth into D1; account
export picks up the new table.

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

Derive edge labels from the diff (routes, migrations, guards, capabilities). The
**Change flow** sequence diagram can stay for request timing; the system map
answers "which primitives does this PR connect, and how?"
