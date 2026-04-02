# Progressive context disclosure plan for MCP

This document records the proposed architecture for issue #127. It is a plan,
not implemented behavior.

## Summary

Kody already has one working prototype of progressive disclosure: `search`
suppresses its "How to run matches" preamble after the first call in a
conversation by tracking `conversationId` in the MCP Durable Object state.

The plan is to generalize that pattern so static MCP descriptions stay short and
Kody discloses contextual facts only when they become relevant. Facts remain
source-controlled and bundled with the Worker, while a per-`conversationId`
ledger in Durable Object state prevents repetition inside the same conversation.

## Why this change exists

Today, Kody front-loads a large amount of tool guidance at connection time and
tool-load time:

- server instructions in `packages/worker/src/mcp/server-instructions.ts`
- the `search` tool description in `packages/worker/src/mcp/tools/search.ts`
- the `execute` tool description in `packages/worker/src/mcp/tools/execute.ts`

The biggest example is `execute`, whose static description currently includes:

- OAuth helper guidance
- secret placeholder syntax
- `x-kody-secret` behavior
- `secret_list` and `secret_set` semantics
- `value_get` and `value_list`
- approval-path recovery guidance

That text is useful, but not all at once. Most tasks only need a small slice of
it, and often not until after the first `search` or first `execute`.

## Current baseline in code

The plan builds on behavior that already exists:

### `conversationId`

- Public tools accept `conversationId` through shared schema in
  `packages/worker/src/mcp/tools/tool-call-context.ts`.
- When omitted, Kody generates one and returns it in the tool result.

### Search preamble suppression

- `packages/worker/src/mcp/tools/search.ts` checks whether the current
  `conversationId` appears in `searchConversationIdsWithPreamble`.
- `packages/worker/src/mcp/tools/search-format.ts` includes the preamble only
  when `includePreamble` is true.

### Existing MCP state storage

- `packages/worker/src/mcp/index.ts` defines the MCP Durable Object `State`.
- That state already stores `searchConversationIdsWithPreamble`, proving that a
  per-conversation disclosure ledger fits the current runtime model.

## Goals

- Keep static MCP tool descriptions minimal and easier to parse.
- Disclose contextual facts when they are actually relevant.
- Prevent repeated disclosure inside the same `conversationId`.
- Keep facts structured, versioned, reviewable, and portable across deployments.
- Reuse the current `search` preamble suppression pattern instead of inventing a
  separate state model.

## Non-goals

- No user-authored fact editing in the first implementation.
- No network fetch on the hot path just to load default facts.
- No semantic memory retrieval or long-term personalization.
- No attempt to persist disclosure history across independent conversations.

## Proposed fact model

Each disclosure becomes a structured fact definition, not an ad hoc markdown
string inside a tool handler.

### Fact fields

Each fact definition should include at least:

| Field        | Purpose                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `id`         | Stable identifier, for example `execute.fetch.secret-placeholders`       |
| `version`    | Increment when emitted content changes materially                        |
| `title`      | Short heading for text rendering                                         |
| `body`       | Markdown or plain text shown to the model                                |
| `kind`       | `proactive` or `reactive`                                                |
| `scope`      | Usually `conversation`, optionally `tool_call` for non-ledgered hints    |
| `triggers`   | Structured conditions that decide when the fact is eligible              |
| `priority`   | Ordering when multiple facts are eligible on one call                    |
| `charBudget` | Optional per-fact or per-batch size cap                                  |
| `docs`       | Optional follow-up link into `docs/use/*`                                |
| `tags`       | Searchable authoring metadata, for example `execute`, `oauth`, `secrets` |

### Trigger model

Triggers should be declarative enough to review in code, but not so generic that
they become a second programming language.

Recommended trigger families:

- `tool_first_use`
  - Example: first `execute` in a conversation
- `search_results_include_type`
  - Example: search results include `skill`, `app`, or `secret`
- `search_results_include_flag`
  - Example: results include a connector-backed capability or a home-domain hit
- `entity_detail_flag`
  - Example: a capability detail shows secret-aware inputs
- `execute_code_signal`
  - Example: code references `refreshAccessToken`, `createAuthenticatedFetch`,
    or a `{{secret:...}}` placeholder
- `error_match`
  - Example: host approval failure, missing secret, auth-required connector

### Example shape

```ts
type DisclosureFact = {
	id: string
	version: number
	title: string
	body: string
	kind: 'proactive' | 'reactive'
	scope: 'conversation' | 'tool_call'
	priority: number
	docs?: { path: string; anchor?: string }
	tags: Array<string>
	triggers: Array<
		| {
				type: 'tool_first_use'
				tool: 'search' | 'execute' | 'open_generated_ui'
		  }
		| {
				type: 'search_results_include_type'
				resultType: 'capability' | 'skill' | 'app' | 'secret'
		  }
		| {
				type: 'search_results_include_flag'
				flag: 'connector_oauth' | 'home_capability' | 'secret_aware_inputs'
		  }
		| {
				type: 'entity_detail_flag'
				flag: 'connector_oauth' | 'secret_aware_inputs'
		  }
		| {
				type: 'execute_code_signal'
				signal:
					| 'secret_placeholder'
					| 'refresh_access_token'
					| 'create_authenticated_fetch'
		  }
		| { type: 'error_match'; code: string }
	>
}
```

This is intentionally narrow. The point is to make disclosures predictable to
author and easy to audit in code review.

## Storage recommendation

### Options

| Option                          | Strengths                                                                            | Weaknesses                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| In source code                  | Reviewable, versioned, portable across deployments, zero runtime fetch, easy to test | Requires deploy for changes                                                                      |
| GitHub-hosted fetched on demand | Can update prose without deploy                                                      | Adds runtime fetch, version skew, availability risk, awkward for private/self-hosted deployments |
| D1 / database                   | Can be edited dynamically per deployment                                             | Harder to review, harder to version, weak default portability, more migration burden             |
| Hybrid                          | Strong defaults plus room for future overrides                                       | More moving parts if introduced too early                                                        |

### Recommendation

Use a **hybrid architecture with a source-controlled default registry**, but
only implement the **source-controlled default layer** in the first phase.

That means:

- Default facts live in the repository and ship with the Worker bundle.
- The runtime does **not** fetch defaults from GitHub.
- D1 remains available for a later override layer only if real customization
  needs appear.

This recommendation best fits the issue requirements:

- **Version control and review:** facts change through normal pull requests.
- **Multi-deployment portability:** any Kody deployment gets the same defaults
  just by running the code.
- **Runtime performance:** no network roundtrip to load facts during a tool
  call.
- **Authoring ease:** maintainers edit structured files alongside the code that
  emits them.

### Recommended file layout

The runtime-facing registry should live with MCP code, not under `docs/`.

One reasonable layout is:

```text
packages/worker/src/mcp/disclosures/
  types.ts
  registry.ts
  facts/
    search.ts
    execute.ts
    open-generated-ui.ts
```

Long-form explanations remain in `docs/use/*`, and fact bodies can point there
with short links instead of duplicating the full docs.

## Disclosure middleware design

### High-level idea

Replace bespoke one-off disclosure logic with a shared response finalization
step:

1. Resolve `conversationId`.
2. Run the tool handler and collect normal result data.
3. Build a disclosure evaluation context from the request, result, and error.
4. Load the current ledger for the `conversationId`.
5. Select eligible facts from the registry.
6. Filter out facts already emitted for that conversation.
7. Apply batch limits and ordering.
8. Append the selected facts to the text response and structured content.
9. Persist the updated ledger back into Durable Object state.

### Best hook point

The cleanest seam is around the existing response helpers in
`packages/worker/src/mcp/tools/`.

Today:

- `prependToolMetadataContent(...)` adds the `conversationId` text block.
- Each tool handler returns its own final `content` and `structuredContent`.

Planned direction:

- Introduce a shared helper such as `finalizeToolResponse(...)`.
- That helper keeps the current `conversationId` metadata behavior and adds
  disclosure rendering plus ledger updates.
- `search`, `execute`, and `open_generated_ui` become clients of the same
  disclosure pipeline instead of each hand-rolling response text.

### Suggested pipeline contract

```ts
type DisclosureContext = {
	tool: 'search' | 'execute' | 'open_generated_ui'
	conversationId: string
	args: unknown
	result?: unknown
	error?: { code?: string; message: string }
	derived: {
		firstToolUse?: boolean
		searchResultTypes?: Array<'capability' | 'skill' | 'app' | 'secret'>
		searchResultFlags?: Array<
			'connector_oauth' | 'home_capability' | 'secret_aware_inputs'
		>
		executeSignals?: Array<
			| 'secret_placeholder'
			| 'refresh_access_token'
			| 'create_authenticated_fetch'
		>
	}
}
```

The key point is that the disclosure system should work from **derived runtime
signals**, not from prose parsing.

### Rendering

Facts should be delivered in two places:

1. **Text output**, because many MCP hosts prioritize plain text.
2. **Structured content**, so future host integrations can inspect the emitted
   facts without scraping markdown.

Suggested structured shape:

```ts
type EmittedDisclosure = {
	id: string
	version: number
	title: string
	body: string
	reason: string
	docs?: { path: string; anchor?: string }
}
```

Suggested text placement:

- Append a small `## Context for this call` section after the main result.
- For error responses, append `## Next steps` facts after the error body.
- Emit at most a small number of facts per response so the system does not
  recreate the original context-bloat problem.

## Ledger design

### Recommendation

Store the ledger in the MCP Durable Object state, keyed by `conversationId`.

That matches the current prototype and keeps disclosure history scoped to the
runtime that is already handling the conversation.

### Proposed state shape

```ts
type State = {
	conversationDisclosures?: Record<
		string,
		{
			emittedFactKeys: Array<string> // `${factId}@${version}`
			firstSeenAt: string
			lastSeenAt: string
			toolUseCounts?: Partial<
				Record<'search' | 'execute' | 'open_generated_ui', number>
			>
		}
	>
}
```

### Why this is the right level

- It is **per conversation**, which is exactly the dedupe scope the issue asks
  for.
- It is **ephemeral runtime state**, not product data that belongs in D1.
- It does not require a schema migration for every new fact.
- It naturally supports "first use of tool X in this conversation."

### Compaction

The current prototype stores an ever-growing array of conversation ids. A
generalized ledger should add lightweight compaction:

- keep `lastSeenAt`
- opportunistically trim old conversations
- cap the number of retained ledgers per Durable Object instance

This keeps the system bounded without changing the disclosure contract.

## Migration path

### Phase 1: extract the pattern without changing behavior

- Introduce a typed disclosure registry in MCP code.
- Represent the current `search` preamble as one fact.
- Keep visible `search` behavior the same.

### Phase 2: replace the bespoke search ledger

- Replace `searchConversationIdsWithPreamble` with the generalized
  `conversationDisclosures` ledger.
- Move preamble gating out of `search.ts` and into shared disclosure
  finalization.

### Phase 3: trim static descriptions

- Shorten `execute` and `search` descriptions to the minimum needed before first
  use.
- Keep long-form workflow detail in `docs/use/*`.
- Keep server instructions focused on workflow and cross-tool conventions, not
  deep execute semantics.

### Phase 4: add just-in-time execute facts

- Emit a small first-use `execute` fact.
- Emit approval-path guidance only on host-approval errors.
- Emit OAuth helper guidance only when code or result metadata indicates an
  OAuth-backed workflow.

### Phase 5: enrich search-driven disclosures

- Add metadata flags to search results and/or entity detail where needed.
- Use those flags to trigger facts for connector-backed skills, home
  capabilities, or secret-aware capability inputs.

### Phase 6: optional future override layer

- Only if real deployment-specific customization appears, add an overlay in D1.
- Source-controlled defaults remain the canonical base layer.

## Concrete examples from the current `execute` description

The table below shows how several current `execute` facts move out of the static
tool description and into progressive disclosures.

| Current fact                                                                 | Proposed fact id                                 | Trigger                                                                                       | Why it belongs there                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `fetch(...)` supports `{{secret:name}}` placeholders                         | `execute.fetch.secret-placeholders`              | first `execute` or `execute_code_signal: secret_placeholder`                                  | Relevant at execute time, not tool-load time                                        |
| `x-kody-secret: true` accepts the same placeholder form                      | `execute.capability-input.secret-placeholders`   | capability entity detail or search result flag `secret_aware_inputs`                          | Only relevant when using a secret-aware capability                                  |
| Placeholders are not general string interpolation                            | `execute.placeholders.not-general-interpolation` | `execute_code_signal: secret_placeholder` or unresolved-placeholder error                     | A correction fact is most useful when an agent is actually attempting interpolation |
| `secret_list` is metadata only and `secret_set` is write-only                | `execute.secrets.metadata-only`                  | first `execute` that references secrets or first `secret` search result followed by `execute` | Helpful in a secret workflow, unnecessary otherwise                                 |
| Use the approval path from the error instead of retrying                     | `execute.fetch.host-approval-recovery`           | host approval error                                                                           | Purely reactive guidance                                                            |
| `refreshAccessToken` / `createAuthenticatedFetch` exist for OAuth connectors | `execute.oauth.helper-patterns`                  | search result flag `connector_oauth` or execute code signals for helper names                 | Useful for connector flows, noise for non-OAuth tasks                               |

### Example fact definitions

#### `execute.fetch.secret-placeholders`

```ts
{
  id: 'execute.fetch.secret-placeholders',
  version: 1,
  title: 'Secret placeholders in execute-time fetch',
  kind: 'proactive',
  scope: 'conversation',
  priority: 20,
  triggers: [{ type: 'tool_first_use', tool: 'execute' }],
  body:
    'Execute-time `fetch(...)` runs through Kody\\'s gateway. Approved hosts may use `{{secret:name}}` or `{{secret:name|scope=user}}` in the URL, headers, or body. These placeholders only resolve in secret-aware paths.',
  docs: { path: '/docs/use/secrets-and-values.md' },
  tags: ['execute', 'fetch', 'secret']
}
```

#### `execute.fetch.host-approval-recovery`

```ts
{
  id: 'execute.fetch.host-approval-recovery',
  version: 1,
  title: 'Host approval required',
  kind: 'reactive',
  scope: 'conversation',
  priority: 100,
  triggers: [{ type: 'error_match', code: 'secret_host_not_approved' }],
  body:
    'The target host is not approved for that secret. Stop retrying, surface the approval link from the error, and retry only after the user approves the host in the account admin UI.',
  docs: { path: '/docs/use/secrets-and-values.md', anchor: 'host-approval' },
  tags: ['execute', 'secret', 'approval']
}
```

## Relationship to future user-controlled memory

This disclosure ledger is related to `conversationId`, but it is **not the same
thing** as future memory.

### Disclosure ledger

- system-owned
- ephemeral
- scoped to one `conversationId`
- used for deduping emitted guidance
- deterministic and non-semantic

### Future memory

- user- or agent-supplied context
- potentially persisted and retrieved later
- task- and preference-oriented
- likely queryable or ranked

The current `memoryContext` field in
`packages/worker/src/mcp/tools/tool-call-context.ts` and `docs/use/memory.md`
stays separate from disclosures. Kody should not write emitted facts into
memory, and memory should not control whether a fact is considered already
disclosed. They can share the same `conversationId`, but they should remain
separate subsystems with different ownership and retention.

## Recommended first implementation slice

The smallest high-value slice is:

1. introduce the fact registry and generalized ledger
2. migrate the existing `search` preamble suppression to that registry
3. trim the `execute` static description
4. emit two execute facts:
   - first-use execute basics
   - host-approval recovery on error

That slice proves the architecture on both a proactive path and a reactive path,
without requiring a broad metadata expansion across all capabilities on day one.

## Open questions to resolve during implementation

- Should the text renderer prepend or append disclosures for each tool?
- Which error codes should become stable disclosure triggers versus plain error
  text?
- Which search result metadata flags should be added immediately, and which can
  wait until later?
- What retention cap is appropriate for per-conversation ledgers in Durable
  Object state?
