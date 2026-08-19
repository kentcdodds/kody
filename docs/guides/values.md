---
id: values
title: Persist outside values
summary:
  Do not write new values. Map existing named rows to memories, package storage,
  repos, secrets, or integrations, then delete the value.
category: platform
---

# Persist outside values

Do not store new named config or state with `value_set`. Existing rows stay
readable through `value_get` / `value_list` and `/account/values` so you can
move them. Load this guide before writing or migrating a value.

## Destination map

| Job                                  | Destination           | How                                                                                   |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------- |
| Durable facts and preferences        | memories              | `meta_memory_verify`, then `meta_memory_upsert`. Verify-first; do not upsert blindly. |
| Package runtime state, caches, knobs | `packageStorage()`    | `get` / `set` (or SQL) in the owning package.                                         |
| Versioned calibration or documents   | a repo                | Edit the package repo or a plain repo; live-at-HEAD for plain repos.                  |
| Credentials, tokens, API keys        | secrets               | Prefill `/account/secrets/new?...` — never paste into chat.                           |
| OAuth client ids and connections     | integrations          | `/connect/oauth?provider=...` or `integration_*`.                                     |
| Ids several packages share           | owning package export | One package holds the id; others `packages.invoke` or a static import.                |

Do not invent a new kv primitive. `packageStorage().get` / `set` is the
named-read API.

## Migrate an existing name

1. `value_list({})` or `search` for the name. Entity detail includes the stored
   string.
2. Pick a row from the table above. Facts go to memories; package state goes to
   that package's `packageStorage()`; files go in a repo; credentials go to
   secrets.
3. Write the destination, then `value_delete`. For secrets, verify only the
   saved secret reference or metadata — never read the raw secret into chat. For
   other destinations, confirm a read-back first.
4. Update callers that used `value_get({ name })`.

Do not copy a value into a memory without `meta_memory_verify`. Do not put
tokens or passwords in values — they are searchable and returned in entity
detail.

## Reads during retirement

`value_get`, `value_list`, and the `value` search entity remain so agents can
find leftover names. `value_set` still writes, but every new row is work to
undo. Prefer the destination on the first persist.

Contributor plan:
https://github.com/kentcdodds/kody/blob/main/docs/contributing/architecture/values-retirement-runbook.md
