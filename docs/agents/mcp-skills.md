# MCP user skills (meta domain)

Authenticated users can save **codemode** snippets as **skills**: D1 row +
Vectorize embedding keyed by `skill_<uuid>` with metadata
`{ kind: 'skill', userId, collectionSlug? }`.

**When to save:** Agents should use **`meta_save_skill`** only for workflows
that are **reasonably repeatable**—patterns expected to run again with similar
structure or inputs. One-off tasks, unique ad-hoc requests, and highly bespoke
work should use **`execute`** only; do not persist them as skills.

## Flow

- **`search`** returns unified hits with `type: 'capability'` or `type: 'skill'`
  (skills only when the MCP caller has user context). Search accepts an optional
  `skill_collection` filter and skill hits include `collection` plus
  `collectionSlug`.
- **`meta_save_skill`** — persists code and trust flags; server infers static
  `codemode.*` usage with Acorn (after `normalizeCode` from
  `@cloudflare/codemode`, matching execute). Optional `collection` assigns the
  skill to a first-class user-defined grouping. Optional `uses_capabilities`
  merges explicit names when inference is incomplete.
- **`meta_get_skill`**, **`meta_run_skill`**, **`meta_delete_skill`** — load,
  execute (same sandbox path as `execute`), or remove skill + vector row.
- **`meta_update_skill`** — same payload as `meta_save_skill` plus `skill_id`;
  replaces code and metadata in place and re-embeds (D1 + Vectorize).
- **`meta_list_skill_collections`** — returns normalized collection names/slugs
  with skill counts for browsing and filter confirmation.

When **`meta_run_skill`** fails (`ok: false`), the structured output includes a
**`hint`** directing the client to **`meta_get_skill`** then
**`meta_update_skill`** (or delete + save).

## Parameters

Skills can declare **parameters** when saved or updated. Each parameter includes
`name`, `description`, `type`, and optional `required`/`default` values. Types
are: `string`, `number`, `boolean`, or `json`.

When running a skill, pass values via `meta_run_skill` **`params`**. The
codemode receives them as the `params` variable (and as the first function
argument when present). Missing required parameters or unknown names are
rejected; defaults are applied when provided.

Example:
`meta_run_skill({ "skill_id": "<id>", "params": { "owner": "kentcdodds" } })`

## Collections

Skills may include an optional **`collection`** string when saved or updated.
This is a first-class grouping label for related skills, separate from built-in
capability domains such as `coding`, `meta`, or `home`.

The server stores both:

- `collection`: display name with collapsed whitespace
- `collection_slug`: normalized lower-kebab-style slug for filtering and future
  browsing UX

If no collection is provided, the skill remains ungrouped. Existing skills stay
valid after migration and simply have `null` collection fields until updated.

Use `meta_list_skill_collections({})` to inspect available groupings before
reusing one, and use `search({ query, skill_collection: "<slug>" })` to narrow
saved-skill retrieval to one collection.

## Flags

`read_only`, `destructive`, and `idempotent` are **agent-provided** and
validated against **derived** values from inferred capability specs when
inference is trusted (non-partial and non-empty inferred set). Contradictions
(e.g. `read_only: true` with a destructive inferred capability) are rejected.

## Maintenance

Post-deploy **`/__maintenance/reindex-capabilities`** upserts builtin vectors
with `kind: 'builtin'` so semantic search can filter builtins vs skills.

**`POST /__maintenance/reindex-skills`** (same `Authorization: Bearer` as
capabilities, via **`CAPABILITY_REINDEX_SECRET`**) re-embeds every row in
`mcp_skills` and upserts `skill_<uuid>` vectors. Use when D1 and Vectorize are
out of sync for saved skills (e.g. after a restore or manual D1 edits).

**`POST /__maintenance/reindex-apps`** (same auth secret) re-embeds visible
saved UI artifacts and upserts `ui_artifact_<uuid>` vectors after app-search
embed text changes or any D1/Vectorize drift.

For broken skills, prefer **`meta_update_skill`** to fix stored code in place;
alternatively **`meta_delete_skill`** + **`meta_save_skill`**. There is no
versioning.
