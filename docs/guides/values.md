---
id: values
title: Persist named state
summary:
  Map leftover named rows to memories, package storage, repos, or secrets.
unadvertised: true
category: platform
---

# Persist named state

Use the destination that matches the job. Do not invent a thinner kv primitive.

## Destination map

| Job                                  | Destination           | How                                                                                   |
| ------------------------------------ | --------------------- | ------------------------------------------------------------------------------------- |
| Durable facts and preferences        | memories              | `meta_memory_verify`, then `meta_memory_upsert`. Verify-first; do not upsert blindly. |
| Package runtime state, caches, knobs | `packageStorage()`    | `get` / `set` (or SQL) in the owning package.                                         |
| Versioned calibration or documents   | a repo                | Edit the package repo or a plain repo; live-at-HEAD for plain repos.                  |
| Credentials, tokens, API keys        | secrets               | Prefill `/account/secrets/new?...` — never paste into chat.                           |
| OAuth client ids and connections     | integrations          | `/connect/oauth?provider=...` or `integration_*`.                                     |
| Ids several packages share           | owning package export | One package holds the id; others statically import that export.                       |

`packageStorage().get` / `set` is the named-read API for package state.
