# Search

The **search** tool finds **built-in capabilities**, **saved packages**,
**persisted values**, **saved connectors**, and **user secret references**
(metadata only, not secret values).

## Queries and ranking

Pass a **`query`** string that describes what you want to do. Results are
ranked; order in the response matters. Query responses are intentionally
compact: the markdown response is a short list of matches with the result type,
title, one-line summary, and entity reference when applicable.

When a tool call also includes **`memoryContext`**, Kody may include relevant
long-term memory metadata in structured content, but broad query markdown stays
focused on the ranked matches.

Search responses also return top-level **`timing`** metadata with
**`startedAt`**, **`endedAt`**, and **`durationMs`** so hosts can reason about
how long the ranked lookup or entity lookup took.

Optional **`limit`** caps how many ranked hits return. Optional
**`maxResponseSize`** trims low-ranked matches against the compact list when the
response must stay small.

## Single-entity detail

To get **full markdown and call shapes for one hit** (for example a capability’s
`inputTypeDefinition` / `outputTypeDefinition`), call **search** again with
**`entity`** set to `"{id}:{type}"` where **`type`** is `capability`, `value`,
`connector`, `package`, or `secret`.

Examples:

- `kody_official_guide:capability`
- `user:preferred_org:value`
- `github:connector`
- `my-package:package`
- `spotify:connector`
- `spotify-access-token:secret`

There is **no separate `detail` flag** on search. Deeper inspection of one
entity uses **`entity`**, not a different mode of the same ranked query.

Top-level ranked result cards include an explicit entity ref for each hit when
applicable, using that same `"{id}:{type}"` format, so you can immediately copy
the ref into a follow-up `entity` lookup when needed.

## When results look thin

If ranked search misses what you need, **rephrase the query** or use
**`meta_list_capabilities`** to read the live capability registry (including
dynamic entries such as home connector tools). **`entity`** does not help when a
**`query`** returned no matches — **`entity`** looks up a known id, not a fix
for an empty ranked list.

## Authentication

Saved **packages** require a signed-in MCP user. Capabilities and built-in
behavior work without user-scoped data.

Package and connector query hits stay summary-only. Exact package detail
(`entity: "my-package:package"`) includes package app, export, job, retriever,
and README metadata. Exact connector detail (`entity: "github:connector"`)
includes operational details such as token URL, API base URL, required hosts,
and related stored value/secret names.

Long-term memory retrieval also requires a signed-in MCP user.

Use **search** as the default way to discover whether a connector or secret
already exists before switching to **execute**. Runtime code inside **execute**
can call **`codemode.secret_list(...)`** when it needs secret metadata, but
**search** is the primary discovery path.
