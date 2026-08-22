import { expect, test } from 'vitest'
import { howKodyWorksTranscriptActs } from './how-kody-works-transcript.ts'
import {
	executeTextReturn,
	searchTextReturn,
} from './interactive-guide-transcript.ts'

const sampleMemory = {
	id: 'mem-watch-login',
	subject: 'Favorite bot',
	summary: 'kody-bot is the favorite bot to watch.',
}

test('search and execute text returns memories as one-liners, not structured JSON', () => {
	const search = searchTextReturn({
		conversationId: 'conv-1',
		body: '# Search results\n\n1. **secret** `githubAccessToken`',
		memories: [sampleMemory],
	})
	expect(search).toContain('## Relevant memories')
	expect(search).toContain(
		'- **Favorite bot** — kody-bot is the favorite bot to watch.',
	)
	expect(search).not.toContain('"surfaced"')
	expect(search).not.toContain(sampleMemory.id)

	const execute = executeTextReturn({
		conversationId: 'conv-1',
		value: [{ title: 'kody-bot/lantern v1.4.0' }],
		memories: [sampleMemory],
	})
	expect(execute).toContain('## Relevant memories')
	expect(execute).toContain(
		'- **Favorite bot** — kody-bot is the favorite bot to watch.',
	)
	expect(execute).not.toContain('"surfaced"')
	expect(execute).not.toContain(sampleMemory.id)
})

test('homepage factory-loop tool results do not dump memory structured content', () => {
	const toolResults = howKodyWorksTranscriptActs.flatMap((act) =>
		act.lines.flatMap((line) =>
			line.role === 'tools' ? line.tools.map((tool) => tool.result) : [],
		),
	)
	expect(
		toolResults.some((result) => result.includes('## Relevant memories')),
	).toBe(true)
	expect(toolResults.every((result) => !result.includes('"surfaced"'))).toBe(
		true,
	)
})
