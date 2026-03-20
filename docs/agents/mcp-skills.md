# MCP user skills (meta domain)

Authenticated users can save **codemode** snippets as **skills**: D1 row +
Vectorize embedding keyed by `skill_<uuid>` with metadata
`{ kind: 'skill', userId }`.

**When to save:** Agents should use **`meta_save_skill`** only for workflows that are **reasonably repeatable**—patterns expected to run again with similar structure or inputs. One-off tasks, unique ad-hoc requests, and highly bespoke work should use **`execute`** only; do not persist them as skills.

## Flow

- **`search`** returns unified hits with `type: 'capability'` or `type: 'skill'`
  (skills only when the MCP caller has user context).
- **`meta_save_skill`** — persists code and trust flags; server infers static
  `codemode.*` usage with Acorn (after `normalizeCode` from
  `@cloudflare/codemode`, matching execute). Optional `uses_capabilities` merges
  explicit names when inference is incomplete.
- **`meta_get_skill`**, **`meta_run_skill`**, **`meta_delete_skill`** — load,
  execute (same sandbox path as `execute`), or remove skill + vector row.
- **`meta_update_skill`** — same payload as `meta_save_skill` plus `skill_id`;
  replaces code and metadata in place and re-embeds (D1 + Vectorize).

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

## Flags

`read_only`, `destructive`, and `idempotent` are **agent-provided** and
validated against **derived** values from inferred capability specs when
inference is trusted (non-partial and non-empty inferred set). Contradictions
(e.g. `read_only: true` with a destructive inferred capability) are rejected.

## Maintenance

Post-deploy **`/__maintenance/reindex-capabilities`** upserts builtin vectors
with `kind: 'builtin'` so semantic search can filter builtins vs skills.

For broken skills, prefer **`meta_update_skill`** to fix stored code in place;
alternatively **`meta_delete_skill`** + **`meta_save_skill`**. There is no
versioning.
