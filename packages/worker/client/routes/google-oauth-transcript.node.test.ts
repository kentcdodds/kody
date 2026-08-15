import { expect, test } from 'vitest'
import { googleOauthTranscriptActs } from './google-oauth-transcript.ts'

test('google oauth transcript covers Lane B discover, console, and connect', () => {
	expect(googleOauthTranscriptActs.map((act) => act.id)).toEqual([
		'discover',
		'console',
		'connect',
	])

	const tools = googleOauthTranscriptActs.flatMap((act) =>
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
		tools.every((tool) =>
			tool.inputs.every(
				(input) =>
					!input.value.includes('package_save') &&
					!input.value.includes('community_fork') &&
					!input.value.includes('packages.invoke'),
			),
		),
	).toBe(true)
	expect(
		googleOauthTranscriptActs.every((act) =>
			act.lines.every((line) => line.role !== 'files'),
		),
	).toBe(true)

	const agentLines = googleOauthTranscriptActs.flatMap((act) =>
		act.lines.flatMap((line) => (line.role === 'agent' ? [line.text] : [])),
	)
	expect(
		agentLines.every(
			(text) =>
				!text.includes('{{secret:') &&
				!/GOCSPX-|ya29\.|Bearer [A-Za-z0-9_-]{20}/.test(text),
		),
	).toBe(true)
	expect(
		tools.every(
			(tool) =>
				!tool.result.includes('{{secret:') && !tool.note.includes('{{secret:'),
		),
	).toBe(true)

	const discoverTools = googleOauthTranscriptActs
		.find((act) => act.id === 'discover')
		?.lines.flatMap((line) => (line.role === 'tools' ? line.tools : []))
	expect(
		discoverTools?.some((tool) =>
			tool.inputs.some(
				(input) =>
					input.name === 'code' &&
					input.value.includes('integration_bootstrap') &&
					input.value.includes('provider_google'),
			),
		),
	).toBe(true)

	const connectUrlAgent = agentLines.find(
		(text) =>
			text.includes('authorizeUrl=') &&
			text.includes('/connect/oauth?provider=google'),
	)
	expect(connectUrlAgent).toBeTruthy()
	expect(connectUrlAgent).toContain('gmail.readonly')

	expect(
		tools.some((tool) =>
			tool.inputs.some(
				(input) =>
					input.name === 'code' &&
					input.value.includes("createAuthenticatedFetch('google')") &&
					input.value.includes(
						'https://gmail.googleapis.com/gmail/v1/users/me/profile',
					),
			),
		),
	).toBe(true)
})
