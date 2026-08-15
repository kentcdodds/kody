import { expect, test } from 'vitest'
import {
	howKodyWorksPackageFiles,
	howKodyWorksTranscriptActs,
} from './how-kody-works-transcript.ts'

test('factory transcript covers ask, invoke, and a quiet daily email', () => {
	expect(howKodyWorksTranscriptActs.map((act) => act.id)).toEqual([
		'ask',
		'invoke',
	])

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
	// Git / repo lane — never the old package_save path.
	expect(
		tools.every((tool) =>
			tool.inputs.every((input) => !input.value.includes('package_save')),
		),
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

	const agentLines = howKodyWorksTranscriptActs.flatMap((act) =>
		act.lines.flatMap((line) => (line.role === 'agent' ? [line.text] : [])),
	)
	expect(
		agentLines.some((text) => /webhook/i.test(text) && /cron/i.test(text)),
	).toBe(true)
})
