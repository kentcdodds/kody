import { expect, test } from 'vitest'
import { googleOauthTranscriptActs } from './google-oauth-transcript.ts'

test('google oauth transcript covers Lane B, console beats, connect, and smoke test', () => {
	expect(googleOauthTranscriptActs.map((act) => act.id)).toEqual([
		'discover',
		'console',
		'connect',
	])

	const tools = googleOauthTranscriptActs.flatMap((act) =>
		act.lines.flatMap((line) => (line.role === 'tools' ? line.tools : [])),
	)
	expect(tools.some((tool) => tool.name === 'search')).toBe(true)
	expect(tools.some((tool) => tool.name === 'execute')).toBe(true)
	expect(
		tools.every((tool) => tool.name === 'search' || tool.name === 'execute'),
	).toBe(true)
	expect(tools.every((tool) => tool.note.trim().length > 0)).toBe(true)
	expect(tools.every((tool) => tool.result.trim().length > 0)).toBe(true)
	expect(
		tools.every((tool) =>
			tool.inputs.every((input) => input.value.trim().length > 0),
		),
	).toBe(true)
	expect(tools.some((tool) => tool.name.startsWith('meta_memory_'))).toBe(false)
	expect(
		tools
			.filter((tool) => tool.name === 'execute')
			.every((tool) => tool.inputs.some((input) => input.name === 'code')),
	).toBe(true)
	expect(
		tools
			.filter((tool) => tool.name === 'execute')
			.every((tool) =>
				tool.inputs.some((input) => input.name === 'memoryContext'),
			),
	).toBe(true)
	expect(
		tools
			.filter((tool) => tool.name === 'execute')
			.every((tool) => tool.result.startsWith('conversationId: ')),
	).toBe(true)
	expect(
		tools
			.filter((tool) => tool.name === 'search')
			.every((tool) => {
				const isEntityDetail = tool.inputs.some(
					(input) => input.name === 'entity',
				)
				return isEntityDetail
					? tool.result.includes('# Capability —')
					: tool.result.includes('# Search results')
			}),
	).toBe(true)
	expect(tools.every((tool) => !tool.result.includes('"matches"'))).toBe(true)
	expect(
		tools.every(
			(tool) =>
				!tool.result.includes('{{secret:') && !tool.note.includes('{{secret:'),
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

	const discoverLines = googleOauthTranscriptActs.find(
		(act) => act.id === 'discover',
	)?.lines
	const firstUser = discoverLines?.find((line) => line.role === 'user')
	expect(firstUser && 'text' in firstUser ? firstUser.text : '').toMatch(
		/Gmail|inbox|invoice/i,
	)
	const firstReasoning = discoverLines?.find(
		(line) => line.role === 'agent' && line.tone === 'reasoning',
	)
	expect(
		firstReasoning && 'text' in firstReasoning ? firstReasoning.text : '',
	).not.toMatch(/Lane B|7-day|invalid_grant/i)

	const discoverTools = discoverLines?.flatMap((line) =>
		line.role === 'tools' ? line.tools : [],
	)
	expect(
		discoverTools?.some((tool) =>
			tool.inputs.some(
				(input) =>
					input.name === 'query' && /google|gmail|oauth/i.test(input.value),
			),
		),
	).toBe(true)
	expect(
		discoverTools?.some((tool) =>
			tool.inputs.some(
				(input) =>
					input.name === 'memoryContext' && input.value.includes('Gmail'),
			),
		),
	).toBe(true)
	expect(
		discoverTools?.some((tool) =>
			tool.inputs.some(
				(input) =>
					input.name === 'entity' &&
					input.value.includes('coding_guide_get:capability'),
			),
		),
	).toBe(true)
	expect(
		discoverTools?.some((tool) =>
			tool.inputs.some(
				(input) =>
					input.name === 'code' &&
					input.value.includes('integration_bootstrap') &&
					input.value.includes('oauth') &&
					input.value.includes('provider_google'),
			),
		),
	).toBe(true)
	expect(
		discoverTools?.every(
			(tool) => !tool.result.includes('## Relevant memories'),
		),
	).toBe(true)

	expect(
		agentLines.some((text) =>
			/gmail\.readonly|Lane B|bring-your-own/i.test(text),
		),
	).toBe(true)
	expect(
		agentLines.some((text) =>
			text.includes('https://kody.codes/connect/oauth'),
		),
	).toBe(true)
	expect(
		agentLines.some((text) => /7-day|seven days|invalid_grant/i.test(text)),
	).toBe(true)
	expect(
		agentLines.some((text) =>
			/never paste|do not paste|client secret/i.test(text),
		),
	).toBe(true)
	expect(
		agentLines.some(
			(text) =>
				/redirect URI/i.test(text) &&
				text.includes('https://kody.codes/connect/oauth'),
		),
	).toBe(true)

	const userLines = googleOauthTranscriptActs.flatMap((act) =>
		act.lines.flatMap((line) => (line.role === 'user' ? [line.text] : [])),
	)
	expect(
		userLines.some((text) => /done|what.?s next|what is next/i.test(text)),
	).toBe(true)
	expect(userLines.some((text) => /created a project/i.test(text))).toBe(true)
	expect(userLines.some((text) => /redirect URI/i.test(text))).toBe(true)
	expect(userLines.some((text) => /paste|client secret/i.test(text))).toBe(true)
	expect(userLines.some((text) => /Testing|works in Testing/i.test(text))).toBe(
		true,
	)
	expect(userLines.some((text) => /authorized/i.test(text))).toBe(true)

	const connectUrlAgent = agentLines.find(
		(text) =>
			text.includes('authorizeUrl=') &&
			text.includes('/connect/oauth?provider=google'),
	)
	expect(connectUrlAgent).toBeTruthy()
	expect(connectUrlAgent).toContain('gmail.readonly')
	expect(connectUrlAgent).toContain('gmail.googleapis.com')
	expect(connectUrlAgent).toContain('confidential')
	expect(connectUrlAgent).toMatch(/access_type|offline/)
	expect(connectUrlAgent).toMatch(/prompt|consent/)

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
})
