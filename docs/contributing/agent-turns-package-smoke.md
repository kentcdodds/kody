# Agent turns package smoke test

Use these manual Kody `execute` smoke tests to verify the production
`@kentcdodds/agent-turns` package after MCP auth is available.

## Basic turn

```ts
import runAgentTurn from 'kody:@kentcdodds/agent-turns'

export default async function main() {
	const result = await runAgentTurn({
		sessionId: `agent-turns-basic-smoke-${Date.now()}`,
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

## Search tool path

```ts
import runAgentTurn from 'kody:@kentcdodds/agent-turns'

export default async function main() {
	const result = await runAgentTurn({
		sessionId: `agent-turns-search-smoke-${Date.now()}`,
		system:
			'You are a smoke-test assistant. Use the actual search tool exactly once when asked to search, then answer briefly.',
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

Expected: at least one `search` tool call has `hasOutput: true` and
`error: null`.

## Execute tool path

```ts
import runAgentTurn from 'kody:@kentcdodds/agent-turns'

export default async function main() {
	const result = await runAgentTurn({
		sessionId: `agent-turns-execute-smoke-${Date.now()}`,
		system:
			'You are a smoke-test assistant. Use the actual execute tool exactly once when asked to execute code, then answer briefly.',
		messages: [
			{
				role: 'user',
				content:
					'Execute code that default exports a function returning { marker: "execute-ok" }.',
			},
		],
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
			outputPreview: JSON.stringify(toolCall.output).slice(0, 500),
		})),
		error: result.error ?? null,
	}
}
```

Expected: at least one `execute` tool call has `hasOutput: true`, `error: null`,
and `outputPreview` includes `execute-ok`.
