# MCP Server Patterns

_Patterns learned from analyzing high-quality MCP server implementations_

This document summarizes patterns learned from analyzing the following MCP
server implementations:

- [Linear MCP Server](https://github.com/iceener/linear-streamable-mcp-server)
- [Google Calendar MCP Server](https://github.com/iceener/google-calendar-streamable-mcp-server)
- [Google Maps MCP Server](https://github.com/iceener/maps-streamable-mcp-server)
- [Tesla MCP Server](https://github.com/iceener/tesla-streamable-mcp-server)

---

## 1. Server Instructions

### What Great Servers Do

Provide comprehensive server-level instructions that act as an "onboarding
guide" for the AI. This is the first thing the AI reads when connecting.

**Avoid duplication:** Server instructions should not repeat tool descriptions
or tool argument docs. Keep tool-specific behavior and defaults in the tool
description + schemas, and keep server instructions focused on workflows and
cross-tool conventions.

**Suggested format:**

```
Quick start
- What to call first
- Most common workflows
- How to chain tools

Default behavior
- What happens when optional params are omitted
- Timezone handling
- Date format expectations

How to chain tools safely
- Which IDs come from which tools
- Dependency order
- Verification patterns

Common patterns & examples
- "To do X, first call Y, then Z"
```

**Example from Linear:**

```
Quick start
- Call 'workspace_metadata' first to fetch canonical identifiers you will reuse across tools.
- Then use 'list_issues' with teamId/projectId and filters to locate targets.
- To modify, use 'update_issues', then verify with 'list_issues'.
```

**Example in this repo:** Server-level instructions are intentionally short and
avoid repeating tool-level docs. Tool-specific behavior/defaults live with the
tool description + schemas.

---

## 2. Tool Descriptions

### What Great Servers Do

Tools have _structured descriptions_ that **complement** the schemas
(`inputSchema` and `outputSchema`) rather than duplicating them.

Include:

1. **What the tool does** (1-2 sentences)
2. **Behavior & gotchas** - semantics that aren't obvious from types alone
   (cross-field rules, default meaning, side effects)
3. **Outputs & return semantics** - what the structured result means and how to
   use it (the _shape_ lives in `outputSchema`)
4. **Errors & recovery** - common failure modes and what to do next
5. **Examples** - concrete, copy/pasteable payloads

**Avoid duplication:**

- Do not re-list every input parameter (name/type/required/default) if the
  `inputSchema` already documents it (see section 4).
- Do not re-list the full output object shape if an `outputSchema` exists (see
  section 4).
- Mention inputs only when they are necessary to explain behavior or cross-field
  semantics.
- Avoid boilerplate that only points to schemas (for example "Input details: see
  input schema"). The schemas should stand on their own.
- Avoid protocol field names (for example `content` or `structuredContent`) in
  tool descriptions. Describe behavior and meaning conceptually; let schemas and
  examples carry the structure.

**Suggested format:**

```
Brief description of what the tool does.

Behavior:
- Important semantic rule...
- Cross-field constraint...

Examples:
- "Do X" → { ... }
- "Do Y" → { ... }

Next:
- Use tool_a to verify. Pass id to tool_b.
```

**Example from Google Calendar (trimmed to the non-obvious behavior):**

```
Search events across ALL calendars by default. Returns merged results sorted by start time.

FILTERING BY TIME (important!):
- Today's events: timeMin=start of day, timeMax=end of day
- This week: timeMin=Monday 00:00, timeMax=Sunday 23:59:59

Next: Use eventId AND calendarId with 'update_event' or 'delete_event'.
```

**Example in this repo:** Tool descriptions focus on semantics/examples and next
steps, while argument docs live in `inputSchema` and structured output docs live
in `outputSchema`.

---

## 3. Tool Annotations

### What Great Servers Do

Every tool includes annotations that help the AI understand the tool's behavior:

```typescript
annotations: {
  readOnlyHint: true,      // Does not modify state
  destructiveHint: false,  // Does not delete data
  idempotentHint: true,    // Safe to call multiple times
  openWorldHint: true,     // May access external resources
}
```

**Guidelines:**

| Annotation        | When to use `true`                      |
| ----------------- | --------------------------------------- |
| `readOnlyHint`    | GET/LIST operations                     |
| `destructiveHint` | DELETE operations, irreversible changes |
| `idempotentHint`  | Same input always produces same result  |
| `openWorldHint`   | Accesses external APIs/resources        |

**Example in this repo:** All tools now provide annotations via the
`server.registerTool()` config.

---

## 4. Schema Patterns (Input & Output)

### What Great Servers Do

Rich, descriptive schemas with:

- **Clear descriptions** for each field
- **Default values** explained (where defaults exist)
- **Valid values** listed (especially for enums)
- **Format expectations** (dates, IDs, etc.)

Use:

- `inputSchema` to document tool arguments (types, defaults, constraints).
- `outputSchema` to document the shape of `structuredContent` on success. If an
  `outputSchema` is provided, the SDK validates that `structuredContent` exists
  and matches the schema for non-error tool results.

**Example (input schema):**

```typescript
z.object({
	calendarId: z
		.union([z.literal('all'), z.string(), z.array(z.string())])
		.optional()
		.default('all')
		.describe(
			'Calendar ID(s). Use "all" (default) to search all calendars, a single ID, or array of IDs',
		),

	timeMin: z
		.string()
		.optional()
		.describe(
			'Start of time range (RFC3339 with timezone, e.g., 2025-12-06T19:00:00Z)',
		),

	maxResults: z
		.number()
		.int()
		.min(1)
		.max(250)
		.optional()
		.default(50)
		.describe('Max events to return (1-250, default: 50)'),
})
```

**Example (output schema):**

```typescript
outputSchema: {
	expression: z.string().describe('Expression string, e.g. "8 + 4"'),
	result: z.number().finite().describe('Exact numeric result (not rounded)'),
	precisionUsed: z.number().int().min(0).max(15),
}
```

**Example in this repo:** Tool schemas describe defaults, valid values, and
format expectations (where applicable), and tools provide `outputSchema` for the
shape of `structuredContent` on success.

---

## 5. Response Formatting

### What Great Servers Do

Return **both** human-readable text AND structured content:

```typescript
return {
	content: [
		{
			type: 'text',
			text: `✓ Event created: [${title}](${htmlLink})\n  when: ${start}\n  meet: ${meetLink}`,
		},
	],
	structuredContent: {
		id: event.id,
		summary: event.summary,
		// ... full structured data
	},
}
```

**Human-readable text patterns:**

- Use **markdown** formatting (links, bold, lists)
- Use **emojis** for status (✓, ⚠️, 🟢, 🔴)
- Include **context** (what calendar, which feed)
- Provide **next steps** in the text

**Example from Tesla:**

```
## Model 3

**Status**: asleep
**Locked**: Yes ✓
**Sentry Mode**: On

### Battery
- Level: 78%
- Range: 312 km
- Charging: Not charging

### ⚠️ Open
- Trunk
```

**Example in this repo:** Tools now return human-readable markdown in `content`
and machine-friendly data in `structuredContent`. Tool descriptions should not
mention these protocol field names.

---

## 6. Tool Modules (One Tool Per File)

### What Great Servers Do

Prefer **one tool per file**, with the tool's description, annotations, schemas,
and handler colocated. Keep a small `register-tools` module that imports each
tool module and registers them.

```typescript
// mcp/tools/do-math.ts
export async function registerDoMathTool(agent: MCP) {
	agent.server.registerTool(
		'do_math',
		{
			/* metadata + schemas */
		},
		async (args) => {
			// handler
		},
	)
}

// mcp/register-tools.ts
import { registerDoMathTool } from './tools/do-math.ts'
export async function registerTools(agent: MCP) {
	await registerDoMathTool(agent)
}
```

**Benefits:**

- Smaller diffs and less merge conflict
- Tool docs/schemas/handler stay in sync
- Easier to add/remove tools without touching unrelated tools

**Example in this repo:** Server instructions live in `mcp/index.ts`, and tool
metadata is colocated with tool registration + schemas in `mcp/tools/do-math.ts`
(with `mcp/register-tools.ts` as the small aggregator).

---

## 7. Tool Naming Conventions

### What Great Servers Do

| Pattern    | Example                    | Use Case              |
| ---------- | -------------------------- | --------------------- |
| `list_*`   | `list_feeds`, `list_users` | Get multiple items    |
| `get_*`    | `get_feed`, `get_issue`    | Get single item by ID |
| `create_*` | `create_feed`              | Create new item       |
| `update_*` | `update_feed`              | Modify existing item  |
| `delete_*` | `delete_feed`              | Remove item           |
| `browse_*` | `browse_media`             | Navigate/explore      |
| `search_*` | `search_events`            | Query with filters    |

**Consistency rules:**

- Use `snake_case` for tool names
- Group related tools with common prefix
- Use singular nouns for get/create, plural for list

**Example in this repo:** Tool names use `snake_case`.

---

## 8. Error Handling

### What Great Servers Do

Provide helpful, actionable error messages:

```typescript
if (!feed) {
	return {
		content: [
			{
				type: 'text',
				text: `Feed "${feedId}" not found.\n\nNext: Use list_feeds to see available feeds.`,
			},
		],
		isError: true,
	}
}
```

**Patterns:**

- Explain **what went wrong**
- Suggest **how to fix it**
- Reference **related tools** that can help
- Include **valid values** when applicable

**Example in this repo:** Tool error responses now include actionable next steps
(including which tool to call next).

---

## 9. Pagination & Limiting

### What Great Servers Do

Consistent pagination patterns:

```typescript
return {
  content: [...],
  structuredContent: {
    items: [...],
    pagination: {
      hasMore: boolean,
      nextCursor: string | undefined,
      itemsReturned: number,
      limit: number,
    },
  },
}
```

**In schemas + descriptions:**

```
Put the output shape in `outputSchema` (for `structuredContent`), and describe
the chaining semantics in the tool description:

Next:
- Pass `pagination.nextCursor` to fetch the next page.
```

**Example in this repo:** The example tool does not paginate, but this pattern
is recommended for future list-style tools.

---

## 10. Resource Patterns

### What Great Servers Do

Resources provide **read-only data access** with:

- Clear URI schemes (`media://feeds`, `media://feeds/{id}`)
- Proper MIME types
- Descriptions that explain the data structure

**Good resource examples:**

- `media://server` — Server info and statistics
- `media://feeds` — All feeds list
- `media://feeds/{id}` — Individual feed details
- `media://directories` — Available media directories

**Example in this repo:** Resources are not currently registered, but this
pattern is recommended for exposing read-only docs and server metadata.

---

## 11. Prompt Patterns

### What Great Servers Do

Prompts are **task-oriented conversation starters**:

- Guide the user through **multi-step workflows**
- Provide **context** about available tools
- Include **concrete next steps**
- Support **optional parameters** to customize the task

**Example prompt:**

```
I want to create a new feed. Please help me decide:

1. Should this be a directory feed (automatically includes all media from a folder)?
2. Or a curated feed (manually select specific content)?

Available media roots:
- audio: /media/audio
- video: /media/video

Please ask me some questions to understand what I'm trying to create, then help me set it up.
```

**Example in this repo:** Prompts are not currently registered, but this pattern
is recommended for guiding multi-step workflows.
