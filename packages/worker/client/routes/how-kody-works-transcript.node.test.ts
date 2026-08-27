import { expect, test } from 'vitest'
import { highlightSnippetKey } from '#universal/highlighted-code.ts'
import {
	collectHowKodyWorksSnippets,
	howKodyWorksPackageFiles,
	howKodyWorksTranscriptActs,
} from './how-kody-works-transcript.ts'

test('factory transcript covers ask, invoke, and a quiet daily email', () => {
	expect(howKodyWorksTranscriptActs.map((act) => act.id)).toEqual([
		'ask',
		'invoke',
		'notify',
	])
	expect(howKodyWorksTranscriptActs[0]?.scene).toBeUndefined()
	expect(howKodyWorksTranscriptActs[1]?.scene).toBe('phone')
	expect(howKodyWorksTranscriptActs[2]?.scene).toBe('phone')

	const tools = howKodyWorksTranscriptActs.flatMap((act) =>
		act.lines.flatMap((line) => (line.role === 'tools' ? line.tools : [])),
	)
	const toolNames = new Set(tools.map((tool) => tool.name))
	expect(toolNames).toEqual(new Set(['search', 'execute']))
	expect(
		tools
			.filter((tool) => tool.name === 'execute')
			.every((tool) => tool.inputs.some((input) => input.name === 'code')),
	).toBe(true)
	expect(
		tools.some((tool) =>
			tool.inputs.some((input) =>
				input.value.includes('package_get_git_remote'),
			),
		),
	).toBe(true)
	expect(
		tools.some((tool) =>
			tool.inputs.some((input) =>
				input.value.includes('package_publish_external_push'),
			),
		),
	).toBe(true)
	expect(
		tools.some((tool) =>
			tool.inputs.some((input) => input.value.includes('repo_edit_files')),
		),
	).toBe(true)

	const fileLines = howKodyWorksTranscriptActs.flatMap((act) =>
		act.lines.flatMap((line) => (line.role === 'files' ? [line] : [])),
	)
	expect(fileLines.length).toBeGreaterThan(0)
	expect(
		howKodyWorksTranscriptActs
			.filter((act) => act.id === 'invoke' || act.id === 'notify')
			.every((act) => act.lines.every((line) => line.role !== 'files')),
	).toBe(true)

	const conversationIds = howKodyWorksTranscriptActs.map((act) => {
		const ids = new Set<string>()
		for (const line of act.lines) {
			if (line.role !== 'tools') continue
			for (const tool of line.tools) {
				const minted = /^conversationId: (\S+)/m.exec(tool.result)
				if (minted?.[1]) ids.add(minted[1])
				for (const input of tool.inputs) {
					if (input.name !== 'conversationId') continue
					const value = /"([^"]+)"/.exec(input.value)
					if (value?.[1]) ids.add(value[1])
				}
			}
		}
		return [...ids]
	})
	expect(conversationIds.every((ids) => ids.length === 1)).toBe(true)
	expect(new Set(conversationIds.flat()).size).toBe(3)

	expect(howKodyWorksPackageFiles['src/what-shipped.ts']).toContain(
		"Authorization: 'Bearer {{secret:githubAccessToken}}'",
	)
	expect(howKodyWorksPackageFiles['src/daily-digest.ts']).toContain(
		'email_send',
	)
	expect(howKodyWorksPackageFiles['src/daily-digest.ts']).toContain(
		'shipped.length === 0',
	)
	expect(howKodyWorksPackageFiles['package.json']).toContain('"enabled": true')

	const snippets = collectHowKodyWorksSnippets()
	expect(snippets.length).toBeGreaterThan(0)
	expect(
		snippets.some(
			(snippet) =>
				snippet.code === howKodyWorksPackageFiles['src/daily-digest.ts'] &&
				snippet.lang === 'ts',
		),
	).toBe(true)
	expect(
		snippets.some(
			(snippet) =>
				snippet.code === howKodyWorksPackageFiles['package.json'] &&
				snippet.lang === 'json',
		),
	).toBe(true)
	expect(
		new Set(snippets.map((snippet) => highlightSnippetKey(snippet))).size,
	).toBeGreaterThan(0)
})
