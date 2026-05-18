# AI chat package guide

This guide describes the shape of a package-owned AI chat app for a Kody
instance. It intentionally avoids references to any production package identity.

## Package shape

Use a saved package when chat behavior should be owned by user/package source
rather than a built-in Kody primitive.

Recommended manifest shape:

```json
{
	"name": "@your-scope/ai-chat",
	"type": "module",
	"exports": {
		".": "./src/index.ts",
		"./app": "./src/app.ts",
		"./types": "./src/types.ts"
	},
	"kody": {
		"id": "ai-chat",
		"description": "Hosted AI chat app with package-owned tool-using turns.",
		"tags": ["ai", "chat", "agent", "tools"],
		"app": {
			"entry": "./src/app.ts"
		}
	}
}
```

Keep the package surface split:

- `src/index.ts` exposes reusable server-side agent-turn helpers.
- `src/app.ts` exposes the hosted package app fetch handler.
- `src/types.ts` defines shared message/event/result types.

## Agent turn behavior

The reusable turn helper should:

- accept a system prompt and conversation messages
- stream assistant deltas as they arrive
- emit tool-call started/finished events
- emit a final completion event with assistant text, stop reason, and tool
  traces
- expose only package/runtime capabilities that are available in that Kody
  instance

If the package relies on optional capabilities such as `search` or `execute`,
detect absence gracefully and return a clear tool result instead of throwing an
opaque runtime error.

## Hosted app behavior

The hosted app should:

- serve a responsive HTML UI from `GET /`
- expose a streaming endpoint, for example `POST /api/chat`
- return `text/event-stream` for the streaming endpoint
- render assistant text incrementally
- show reasoning/progress and tool calls in accessible `<details>` sections
- use semantic form controls and an `aria-live` status region
- follow system color preferences with CSS such as `prefers-color-scheme`
  instead of an app-specific light/dark toggle

## Manual smoke tests

Run these examples through Kody `execute` after saving and publishing the
package. Replace `@your-scope/ai-chat` with the saved package name for the Kody
instance under test.

### Basic turn

```ts
import runAgentTurn from 'kody:@your-scope/ai-chat'

export default async function main() {
	const result = await runAgentTurn({
		sessionId: `ai-chat-basic-smoke-${Date.now()}`,
		system:
			'You are a smoke-test assistant. Reply exactly with package-ok. Do not call tools.',
		messages: [{ role: 'user', content: 'Reply exactly: package-ok' }],
		maxSteps: 2,
	})

	return {
		ok: result.ok,
		assistantText: result.result?.assistantText ?? null,
		stopReason: result.result?.stopReason ?? null,
		toolCalls: result.result?.toolCalls ?? [],
		error: result.error ?? null,
	}
}
```

Expected: `ok` is `true`, `assistantText` contains `package-ok`, and no tool
errors are present.

### Search tool path

```ts
import runAgentTurn from 'kody:@your-scope/ai-chat'

export default async function main() {
	const result = await runAgentTurn({
		sessionId: `ai-chat-search-smoke-${Date.now()}`,
		system:
			'You are a smoke-test assistant. Use the search tool exactly once when asked to search, then answer briefly.',
		messages: [{ role: 'user', content: 'Search Kody for package_save.' }],
		maxSteps: 4,
	})
	const toolCalls = result.result?.toolCalls ?? []

	return {
		ok: result.ok,
		assistantText: result.result?.assistantText ?? null,
		toolCalls: toolCalls.map((toolCall) => ({
			toolName: toolCall.toolName,
			input: toolCall.input,
			hasOutput: toolCall.output !== undefined,
			error: toolCall.error ?? null,
		})),
		error: result.error ?? null,
	}
}
```

Expected: a `search` tool call either succeeds with output or returns a clear
unavailable/fallback result for Kody instances that do not expose search as a
package-callable capability.

### Hosted app fetch handler

```ts
import appFetch from 'kody:@your-scope/ai-chat/app'

export default async function main() {
	const getResponse = await appFetch(new Request('https://package.test/'))
	const html = await getResponse.text()
	const postResponse = await appFetch(
		new Request('https://package.test/api/chat', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				sessionId: `app-smoke-${Date.now()}`,
				messages: [{ role: 'user', content: 'Reply exactly: app-ok' }],
			}),
		}),
	)
	const streamText = await postResponse.text()

	return {
		getStatus: getResponse.status,
		hasTitle: html.includes('AI Chat'),
		hasTextarea: html.includes('textarea'),
		hasDetails: html.includes('details'),
		hasAriaLive: html.includes('aria-live'),
		hasSystemDarkMode: html.includes('prefers-color-scheme'),
		postStatus: postResponse.status,
		postContentType: postResponse.headers.get('content-type'),
		streamHasDone: streamText.includes('event: done'),
		streamPreview: streamText.slice(0, 1000),
	}
}
```

Expected: `GET /` returns HTML with the app UI, and `POST /api/chat` returns an
SSE stream with completion events.
