---
id: search_and_execute
title: Search and execute
summary:
  Kody's MCP surface is two tools. search finds capabilities, guides, packages,
  integrations, and secrets. execute runs an ephemeral module that calls what
  you found. Covers how they work together and the inputs an agent actually
  passes.
category: platform
---

# Search and execute

<!--
Agent notes — for AI agents explaining or using these two tools:

- This page is the playbook for the public MCP surface. Load it when someone
  asks what search and execute are, how to call them, or why Kody is not a
  long tool list.
- Official guides load with search({ entity: "{id}:guide" }). Capability
  detail includes a ready-to-run execute snippet; adapt that snippet, then
  execute.
- Search returns markdown (`# Search results`), not a matches JSON object.
  Pass conversationId back unchanged on follow-up search and execute calls.
- For the factory loop that uses these tools, load how_kody_works next.
-->

Your agent connects to Kody over MCP and starts with two tools. That is the
whole public surface: **search** finds the right thing, then **execute** runs
it. Capabilities, saved packages, integrations, secrets, and official guides
stay behind those two doors instead of appearing as a tool list.

This page is the playbook for those two calls. The same tools drive the loop in
[How Kody works](./how-kody-works.md).

## Search

**search** finds built-in capabilities, official guides, saved packages, saved
integrations, and secret references (names and metadata — never secret values).
Public community listings live in the `community` domain (`communitySearch`,
`communityGet`); see [Public packages](../use/community-packages.md).

### What search enables

An agent can describe a goal in natural language and get a ranked shortlist —
type, title, one-line summary, and an entity ref — instead of loading hundreds
of tools. Capability hits include a domain id and, for the top few, a compact
call shape so the next step is often a single **execute**.

### How an agent calls it

Three useful shapes:

- **Natural language** — `{ "query": "send a message" }` ranks matches for that
  task. Task-specific wording ("send an email to Kent") stays in ranked results.
- **Domain browse** — an empty call `{}` or a broad question ("what can you do
  with email") returns a **domain index**: each row has the domain id, a
  one-line description, a capability count, and a few sample names. Follow up
  with `{ "domain": "email" }` to list that domain, or
  `{ "query": "…", "domain": "email" }` to rank only there. Domain ids include
  builtins (`email`, `jobs`, `packages`) and connected MCP servers
  (`mcp:linear`, `mcp:home`).
- **Entity lookup** — `{ "entity": "{id}:{type}" }` opens one hit. `type` is
  `capability`, `guide`, `integration`, `package`, or `secret`. Pass an array of
  1–10 refs to load related details in one call. Guide refs accept `#{heading}`
  to open one section.

Capability detail includes a ready-to-run **execute** snippet plus input and
output types. Guide detail is the official markdown when it fits the response
budget; oversized guides return a table of contents.

## Execute

**execute** runs one ephemeral ESM module inside Kody's runtime. The module uses
ordinary imports and exports and **default exports** the function Kody invokes.

### What execute enables

One tool surface reaches the whole platform: call a discovered capability,
import a saved package export, fetch with a secret placeholder, compose several
steps, and return a structured result. The agent adapts a short module instead
of learning a new MCP tool per capability.

### How an agent calls it

Pass **`code`**: a single module string. Import runtime helpers from
`kody:runtime` and call builtins as `kody.capabilityId(input)`. MCP server tools
are `kody.mcp["name"].tool_name(input)`. Known package exports use a static
`kody:@scope/package/export` import.

Optional **`params`** is a JSON object passed as the first argument to that
default export. Capability search detail already emits the module; adapt it,
then execute.

```ts
import { kody } from 'kody:runtime'

export default async function main(input = {}) {
	return await kody.emailSend(input)
}
```

`emailSend` notifies the account's own address (`subject` plus `text` or
`html`). See [Execute and workflows](../use/execute.md) for `kody:runtime`
helpers, workflows, and timeouts.

## Search first, then execute

1. **Search** for the outcome — a query, a domain list, or a known entity ref.
2. **Read** the ranked hit or entity detail. Capability detail includes the
   execute module and input type.
3. **Execute** with that adapted snippet (and `params` when the default export
   should receive structured input).
4. **Reuse `conversationId`** from the tool response on the next search or
   execute in the same conversation.
5. **Save** the working module as a package when the behavior should live past
   this chat — [Package lifecycle](./package-lifecycle.md).

Official guides load with `search({ entity: "{id}:guide" })`. Prefer that over
executing `codingGuideGet` just to read a guide.

## Example agent inputs

Copy-pasteable argument objects. Field names match the MCP tool schemas.

### search

Empty call — domain index:

```json
{}
```

Natural language:

```json
{ "query": "send a message" }
```

Rank inside one domain:

```json
{ "query": "send a message", "domain": "email" }
```

List one domain in registry order:

```json
{ "domain": "jobs" }
```

Open one official guide:

```json
{ "entity": "package_authoring:guide" }
```

Open several related guides:

```json
{
	"entity": ["package_authoring:guide", "package_lifecycle:guide"]
}
```

Open a capability (returns the execute snippet):

```json
{ "entity": "emailSend:capability" }
```

Open a saved integration, package, or secret reference:

```json
{ "entity": "github:integration" }
```

```json
{ "entity": "my-package:package" }
```

```json
{ "entity": "githubPat:secret" }
```

Open one guide heading:

```json
{ "entity": "package_subscriptions:guide#repo.pushed" }
```

Optional `memoryContext` (task plus a couple of entities) can travel with a
ranked query so relevant memories surface as compact subject — summary
one-liners. Entity lookups and domain listings skip that attachment.

### execute

Module plus optional params — `params` become `input` on the default export:

```json
{
	"code": "import { kody } from 'kody:runtime'\n\nexport default async function main(input = {}) {\n\treturn await kody.emailSend(input)\n}",
	"params": {
		"subject": "Hello from Kody",
		"text": "Notify-self mail from an execute module."
	}
}
```

The same module, written as source (this is the `code` string):

```ts
import { kody } from 'kody:runtime'

export default async function main(input = {}) {
	return await kody.emailSend(input)
}
```

Call a saved package export whose name is known when you write the module:

```ts
import whatShipped from 'kody:@you/favorite-bot-ships/whatShipped'

export default async function main() {
	return await whatShipped()
}
```

```json
{
	"code": "import whatShipped from 'kody:@you/favorite-bot-ships/whatShipped'\n\nexport default async function main() {\n\treturn await whatShipped()\n}"
}
```

When the target name is data (caller-owned or forked modules), use
`import(specifier)` instead of a static `kody:@...` import.

## Where to go next

- **See the loop** — [How Kody works](./how-kody-works.md) plays one
  conversation that uses these two tools from question to owned export.
- **Map the factory** — [The factory map](./kody-factory.md) places search and
  execute among secrets, packages, jobs, and memories.
- **Reference** — [Search](../use/search.md) and
  [Execute and workflows](../use/execute.md) are the MCP-level field contracts.
- **Connect** — [Connect your agent](./connect-your-agent.md) if the host is not
  wired yet.
