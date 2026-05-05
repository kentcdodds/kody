# Progressive disclosure of MCP contextual facts

This is the plan for GitHub issue #127. It is intentionally a design document,
not an implementation.

## Goal

Move Kody's MCP guidance from large static instructions and tool descriptions
toward contextual facts that are disclosed only when they become relevant to the
agent's current workflow.

The intended result:

- initial MCP tool descriptions stay short enough to scan quickly
- tool responses provide just-in-time guidance for the facts implied by the
  current call, result, or error
- repeated facts are suppressed per `conversationId`
- facts are maintained as reviewed source artifacts, not scattered strings

## Non-goals

- Do not replace tool schemas. Argument and output shapes still belong in
  `inputSchema` and `outputSchema`.
- Do not implement user-controlled memory. Disclosure facts are product
  guidance owned by Kody; memory remains user-specific state retrieved with
  `memoryContext`.
- Do not make the first version adaptive with an LLM. Triggering should be
  deterministic and testable.
- Do not remove long-form usage docs. Disclosures can link to those docs when
  the agent needs depth.

## Current prototype

`search` already demonstrates the desired behavior for the search preamble:

- each public call resolves or returns a `conversationId`
- the MCP Durable Object state tracks `searchConversationIdsWithPreamble`
- `search` includes the preamble on the first relevant call for that
  conversation and suppresses it afterward

The progressive-disclosure system should generalize that pattern from one
hard-coded preamble to many named facts.

## Fact format

Store each fact as structured metadata plus a concise markdown body. A
frontmatter-backed markdown file is the easiest authoring format, while a
generated or build-time loaded registry can expose the same shape to runtime
code.

Example source file:

```markdown
---
id: execute.secret-placeholders
version: 1
title: Secret placeholders in execute
status: active
audience: mcp-agent
tools:
  - execute
triggers:
  - type: tool-first-use
    tool: execute
  - type: search-result-type
    resultType: secret
  - type: error-code
    code: secret-placeholder-host-not-approved
priority: 40
dedupeScope: conversation
docs:
  - docs/use/secrets-and-values.md
---

Use `{{secret:name}}` or `{{secret:name|scope=user}}` only in execute-time
`fetch` URL, header, or body fields, or in capability inputs explicitly marked
with `x-kody-secret: true`. Placeholders do not resolve in arbitrary returned
strings.
```

Recommended fields:

| Field | Purpose |
| --- | --- |
| `id` | Stable lower-dot identifier, grouped by surface (`execute.*`, `search.*`). |
| `version` | Increment when content or trigger semantics materially change. |
| `title` | Human-readable label for review, logs, and tests. |
| `status` | `active`, `draft`, or `retired`. Only `active` facts emit. |
| `audience` | Usually `mcp-agent`; leaves room for future UI/admin audiences. |
| `tools` | Tool names most associated with the fact. |
| `domains` | Optional capability domains such as `secrets`, `packages`, or `home`. |
| `entityTypes` | Optional search result types such as `secret`, `connector`, `value`. |
| `triggers` | Deterministic trigger rules. See below. |
| `priority` | Ordering when multiple facts match; lower numbers can emit first. |
| `dedupeScope` | `conversation` by default; `call` only for facts that should repeat. |
| `docs` | Repo docs for deeper reading. |
| body | Short markdown, written as text suitable for direct MCP response inclusion. |

Authoring rules:

- Keep a fact focused on one operational idea.
- Prefer one or two short paragraphs or bullets.
- Include copy-pasteable syntax only when it is directly useful at that moment.
- Link to usage docs for exhaustive rules.
- Avoid embedding secrets, user-specific values, or deployment-specific hostnames
  in fact bodies.
- Retire facts instead of deleting them immediately when a ledger may still
  reference an old id/version.

## Trigger design

Triggers should be derived from data already available while handling a tool
call. Avoid expensive follow-up queries solely to decide whether to disclose a
fact.

### Reactive triggers

Reactive triggers fire after the agent takes an action or receives a specific
failure:

- `tool-first-use`: the first `execute`, `open_generated_ui`, or future public
  tool call in a `conversationId`.
- `error-code`: structured errors such as an unapproved secret host, missing
  connector token, missing secret reference, storage write disabled, or
  capability validation failure.
- `execute-runtime-surface`: detected use of runtime imports or structured
  sandbox metadata, such as `storageId` being bound or package context being
  active.
- `capability-input-annotation`: a capability input schema includes
  `x-kody-secret: true`, write-risk confirmation fields, or connector metadata.

### Proactive triggers

Proactive triggers fire because a result indicates the agent is likely to need a
fact next:

- `search-result-type`: search results include `secret`, `value`, `connector`,
  `package`, or future result types.
- `search-result-domain`: ranked results include domains such as `secrets`,
  `jobs`, `packages`, `services`, or `home`.
- `entity-detail-type`: `search({ entity })` returns a detail page for a secret,
  connector, saved package, package job, or capability with special semantics.
- `connector-status`: a remote connector is down or degraded in the result
  metadata.
- `official-guide-needed`: search results or package metadata indicate an
  integration flow that should start with `kody_official_guide`.

### Trigger evaluation order

1. Build a trigger context from the tool name, resolved `conversationId`, input
   shape, result metadata, structured error, search matches, caller context, and
   capability metadata already loaded for the call.
2. Match active facts against that context.
3. Remove facts already disclosed for the same `conversationId` at the same
   `id` and `version`.
4. Sort by `priority`, then by `id`.
5. Emit a small bounded number of facts. Start with one or two facts per
   response; include an overflow hint only if more matched.
6. Record emitted facts in the ledger after the response is assembled.

Do not parse arbitrary user code as the primary trigger mechanism. Lightweight
signals, such as whether an `execute` call binds `storageId` or whether a
capability schema advertises secret placeholders, are more reliable and easier
to test.

## Response placement

Disclosures should be appended to the human-readable text content after the
primary result, under a stable heading such as `Context for next steps`. This
keeps the main result first and makes the guidance easy for agents to identify.

Structured responses should include a compact `disclosures` block for debugging
and tests:

```ts
{
  disclosures: {
    emitted: [
      {
        id: 'execute.secret-placeholders',
        version: 1,
        trigger: 'tool-first-use:execute',
      },
    ],
    suppressedCount: 3,
  },
}
```

The markdown body is for the agent to read. The structured block is for
observability, regression tests, and future tooling.

## ConversationId disclosure ledger

Generalize `searchConversationIdsWithPreamble` into a disclosure ledger keyed by
`conversationId`.

Suggested in-memory/state shape:

```ts
type DisclosureLedgerState = {
  schemaVersion: 1
  ledgers: Record<
    string,
    {
      firstSeenAt: string
      lastSeenAt: string
      disclosures: Record<
        string,
        {
          factVersion: number
          contentHash: string
          disclosedAt: string
          trigger: string
          tool: string
        }
      >
    }
  >
}
```

Ledger key details:

- Use `fact.id` as the disclosure key.
- Store `factVersion` and `contentHash` so revised facts can be emitted again
  when needed.
- Update `lastSeenAt` on every call with that `conversationId`.
- Treat a missing caller-provided `conversationId` as a new generated
  conversation. If the agent ignores the returned id, Kody cannot reliably
  suppress repeats.
- Keep ledger state separate from user memory and do not expose it through memory
  capabilities.

Pruning:

- Drop old ledgers by `lastSeenAt` after a short retention window appropriate
  for MCP sessions.
- Cap the number of ledgers retained in the Durable Object state.
- Cap disclosures per ledger; if the cap is reached, remove oldest retired or
  least-recently-seen facts first.

Versioning:

- Bump the ledger `schemaVersion` only when the runtime state shape changes.
- Bump a fact `version` when the body or trigger meaning changes enough that an
  already-running conversation should see it again.
- Keep retired facts in source until all supported deployments can ignore older
  ledger entries safely.

## Storage recommendation

Use source-owned disclosure files as the default storage mechanism. Load them
into a typed registry at build time or module initialization.

### Option 1: source files

Recommended for the first implementation.

Benefits:

- facts are version-controlled and code-reviewed with related MCP changes
- every deployment receives the same defaults without extra database setup
- local development, tests, and preview deploys are deterministic
- authoring can use normal markdown and schema validation

Tradeoffs:

- changing a fact requires a deploy
- user- or deployment-specific overrides are not available at first

### Option 2: GitHub fetch on demand

Useful later for official guides, but not ideal as the primary fact source.

Benefits:

- docs can be updated independently of a Worker deploy
- mirrors the existing official-guide pattern

Tradeoffs:

- runtime fetches add latency and failure modes
- facts can drift from deployed code and trigger behavior
- caching, pinning, and content integrity become mandatory

If this option is used, fetch by a pinned commit or release manifest, cache in
Worker memory/KV, and fall back to bundled facts.

### Option 3: D1/database

Useful for administrative overrides, not for initial defaults.

Benefits:

- facts can be edited without a deploy
- per-deployment or per-user customization is possible

Tradeoffs:

- harder to review and version with code
- migrations and admin tooling are required
- multi-deployment portability gets worse unless seed data is maintained

### Option 4: hybrid

Recommended as the long-term extension: source-owned defaults plus optional
database overrides.

Rules for the hybrid model:

- bundled source facts are canonical defaults
- DB overrides can disable, replace, or add deployment-specific facts
- override records include `baseFactId`, `baseVersion`, author, timestamps, and
  reason
- source facts win when safety-sensitive behavior changes and an override is
  stale

Start with option 1, design the registry so option 4 can be added without
rewriting tool handlers.

## Middleware design

Add one disclosure step around public MCP tool handlers rather than embedding
fact matching in each tool.

Conceptual flow:

1. Tool handler resolves `conversationId` and performs its normal work.
2. Handler returns the primary MCP response plus a small internal
   `DisclosureContext`, or a wrapper derives that context from the response.
3. Disclosure middleware evaluates triggers against the registry and ledger.
4. Middleware appends disclosure markdown to `content`.
5. Middleware adds structured disclosure metadata.
6. Middleware updates the ledger in MCP Durable Object state.

Initial hook points:

- `search`: replace the hard-coded preamble check with a `search.preamble` fact,
  then add result-type facts.
- `execute`: disclose sandbox facts on first use and error-specific facts on
  secret, value, OAuth, storage, package, or approval failures.
- `open_generated_ui`: disclose UI/session handoff facts only when the tool is
  used or search results point to an app flow.

Keep tool-specific knowledge close to the existing tool modules by letting each
tool contribute a typed trigger context. Keep registry loading, matching,
dedupe, formatting, and ledger updates in one shared module.

## Migration path

1. Add the fact registry and ledger helpers behind tests, with no behavior
   changes.
2. Convert the existing `search` preamble into a `search.preamble` fact. The
   emitted text should remain equivalent so the first rollout is low-risk.
3. Move low-risk facts out of the `execute` description:
   - secret placeholder syntax
   - host approval recovery
   - persisted values
   - OAuth connector helpers
   - generated UI for credential collection
4. Trim static server instructions and tool descriptions after the corresponding
   facts are covered by triggers and tests.
5. Add proactive search result disclosures for `secret`, `value`, `connector`,
   `package`, and `home` matches.
6. Add observability for emitted/suppressed fact counts and top fact ids.
7. Remove obsolete duplicated prose from usage docs only when a long-form page
   has become inaccurate. Usage docs remain the canonical deep reference.

## Concrete examples from current `execute` guidance

### Secret placeholders

- Fact id: `execute.secret-placeholders`
- Triggers:
  - first `execute` call in a conversation
  - search result includes a `secret`
  - error indicates secret placeholder misuse
- Body:

```markdown
Use `{{secret:name}}` or `{{secret:name|scope=user}}` only in execute-time
`fetch` URL, header, or body fields, or in capability inputs explicitly marked
with `x-kody-secret: true`. Placeholders do not resolve in arbitrary returned
strings.
```

### Secret placeholder leakage

- Fact id: `execute.secret-placeholder-leakage`
- Triggers:
  - first disclosure of `execute.secret-placeholders`
  - error indicates unresolved placeholder text in user-visible content
- Body:

```markdown
Never place exact secret placeholder tokens in issue bodies, comments, prompts,
logs, returned strings, or other user-visible/third-party-visible content. If
you need to describe the syntax literally, obfuscate it.
```

### Host approval recovery

- Fact id: `execute.host-approval`
- Triggers:
  - error code for unapproved host or approval-required fetch
  - search result includes a secret whose allowed hosts do not cover the likely
    target
- Body:

```markdown
If a secret-backed fetch reports that the host is not approved, use the approval
path from the error response. Do not retry blindly, and do not ask the user to
paste the secret in chat.
```

### OAuth connector helpers

- Fact id: `execute.oauth-connectors`
- Triggers:
  - search result includes an OAuth-backed connector or package
  - capability metadata indicates connector requirements
  - runtime error indicates a connector token must be refreshed
- Body:

```markdown
For OAuth-backed connectors, import `refreshAccessToken` or
`createAuthenticatedFetch` from `kody:runtime`. Prefer
`createAuthenticatedFetch(providerName)` when making API requests because it
refreshes and persists rotated tokens for that connector.
```

### Persisted values

- Fact id: `execute.persisted-values`
- Triggers:
  - search result includes a `value`
  - first entity detail response for a value
  - validation error indicates non-secret configuration is missing
- Body:

```markdown
Use `codemode.value_get({ name, scope })` and `codemode.value_list({ scope })`
for persisted non-secret configuration. Use secrets only for sensitive values.
```

## Relationship to future user-controlled memory

Progressive disclosures and memory both use `conversationId`, but they serve
different purposes:

- disclosures are product-authored guidance about Kody's tools and runtime
- memory is user-specific, durable, and retrieved from task-focused
  `memoryContext`
- disclosures suppress repeated product facts in one conversation
- memory suppresses repeated user facts in one conversation
- disclosure writes are automatic runtime bookkeeping
- memory writes require the verify-first workflow and explicit capabilities

Do not store disclosure facts as memories. If future memory uses richer
retrieval, it can still include disclosure ids in telemetry so agents and
maintainers can understand which product guidance was present during a task.

## Maintainability

Validation:

- add schema validation for every fact file
- fail tests when ids are duplicated, versions are invalid, docs links are
  missing, or trigger types are unknown
- snapshot representative rendered responses for high-value flows

Ownership:

- facts live near MCP contributor docs or in a dedicated
  `packages/worker/src/mcp/disclosures/` source directory once implemented
- every new specialized MCP behavior should include either a fact, a usage-doc
  link, or an explicit reason no disclosure is needed
- retired facts remain searchable in source until the retention window for old
  deployments has passed

Observability:

- log emitted fact ids, suppressed counts, trigger names, and ledger pruning
  events in existing MCP event logs
- avoid logging fact bodies when they might include operational details copied
  from user/deployment-specific overrides
- add dashboards or Sentry breadcrumbs only after the first implementation shows
  which signals are useful

Review checklist:

- Is the static tool description shorter after this fact moves out?
- Is the trigger deterministic and cheap?
- Is the fact useful at the moment it appears?
- Will the fact repeat only when its version changes or the agent starts a new
  conversation?
- Is the long-form documentation still accurate?

## Rollout

1. Plan review: agree on the fact schema, source-owned default storage, trigger
   list, and ledger state shape.
2. Registry foundation: add parsing, validation, tests, and a no-op middleware
   path.
3. Search parity: migrate the search preamble to the registry and verify no
   behavior regression.
4. Execute pilot: move a small set of `execute` facts behind first-use and
   error-based triggers while keeping docs links intact.
5. Static-text reduction: trim server instructions and tool descriptions only
   after telemetry and tests show the pilot disclosures fire correctly.
6. Proactive search disclosures: add result-type and domain triggers for secrets,
   values, connectors, packages, and home capabilities.
7. Hybrid readiness: if deployments need customization, add DB overrides on top
   of source defaults with validation and stale-override safeguards.
8. Ongoing gardening: treat disclosure facts like docs and tool schemas; update
   them in the same change as behavior that affects agent workflows.
