# Search

The **search** tool finds **builtin capabilities**, **saved skills**, **saved
apps** (MCP App artifacts), and **user secret references** (metadata only, not
values).

## Queries and ranking

Pass a **`query`** string that describes what you want to do. Results are
ranked; order in the response matters.

When a tool call also includes **`memoryContext`**, Kody may attach a small
number of relevant long-term memories that have not already been surfaced for
that **`conversationId`**.

Optional **`limit`** caps how many ranked hits return. Optional
**`maxResponseSize`** trims low-ranked matches when the response must stay
small.

Optional **`skill_collection`** narrows saved skills to one collection slug
while still searching capabilities, apps, and secrets normally.

## Single-entity detail

To get **full markdown and schemas for one hit** (for example a capability’s
`inputSchema` / `outputSchema`), call **search** again with **`entity`** set to
`"{id}:{type}"` where **`type`** is `capability`, `skill`, `app`, or `secret`.

Examples:

- `page_to_markdown:capability`
- `my-skill-name:skill`

There is **no separate `detail` flag** on search. Deeper inspection of one
entity uses **`entity`**, not a different mode of the same ranked query.

## When results look thin

If ranked search misses what you need, **rephrase the query** or use
**`meta_list_capabilities`** to read the live capability registry (including
dynamic entries such as home connector tools). **`entity`** does not help when a
**`query`** returned no matches — **`entity`** looks up a known id, not a fix
for an empty ranked list.

## Authentication

Saved **skills** and **apps** require a signed-in MCP user. Capabilities and
builtin behavior still work without user-scoped data.

Long-term memory retrieval also requires a signed-in MCP user.
