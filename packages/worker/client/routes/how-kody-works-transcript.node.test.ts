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
	])
	expect(howKodyWorksTranscriptActs[0]?.scene).toBeUndefined()
	expect(howKodyWorksTranscriptActs[1]?.scene).toBe('phone')

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
			.find((act) => act.id === 'invoke')
			?.lines.every((line) => line.role !== 'files'),
	).toBe(true)

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
