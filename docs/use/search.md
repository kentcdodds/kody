# Search

The **search** tool finds **built-in capabilities**, **saved packages**,
**persisted values**, **saved connectors**, and **user secret references**
(metadata only, not secret values).

## Queries and ranking

Pass a **`query`** string that describes what you want to do. Results are
ranked; order in the response matters.

When a tool call also includes **`memoryContext`**, Kody may attach a small
number of relevant long-term memories that have not already been surfaced for
that **`conversationId`**.

Optional **`limit`** caps how many ranked hits return. Optional
**`maxResponseSize`** trims low-ranked matches when the response must stay
small.

## Single-entity detail

To get **full markdown and schemas for one hit** (for example a capability’s
`inputSchema` / `outputSchema`), call **search** again with **`entity`** set to
`"{id}:{type}"` where **`type`** is `capability`, `value`, `connector`,
`package`, or `secret`.

Examples:

- `kody_official_guide:capability`
- `user:preferred_org:value`
- `github:connector`
- `my-package:package`
- `spotify:connector`
- `spotify-access-token:secret`

There is **no separate `detail` flag** on search. Deeper inspection of one
entity uses **`entity`**, not a different mode of the same ranked query.

## When results look thin

If ranked search misses what you need, **rephrase the query** or use
**`meta_list_capabilities`** to read the live capability registry (including
dynamic entries such as home connector tools). **`entity`** does not help when a
**`query`** returned no matches — **`entity`** looks up a known id, not a fix
for an empty ranked list.

## Authentication

Saved **packages** require a signed-in MCP user. Capabilities and builtin
behavior still work without user-scoped data.

Package search hits summarize whether the package has an app surface. Package
detail nests exports, jobs, tags, and app metadata under the package itself.

Long-term memory retrieval also requires a signed-in MCP user.

Use **search** as the default way to discover whether a connector or secret
already exists before switching to **execute**. Runtime helpers such as
**`codemode.secret_list(...)`** are still useful when code running inside
**execute** needs current secret metadata, but they are no longer the primary
discovery path.
