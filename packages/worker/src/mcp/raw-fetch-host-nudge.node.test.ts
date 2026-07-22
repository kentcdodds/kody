import { expect, test, vi } from 'vitest'
import {
	applyRawFetchHostCounts,
	codeUsesIntegrationAuthHelpers,
	createRawFetchHostSink,
	formatRawFetchHostNudge,
	listHostsApproachingRawFetchNudge,
	maxRawFetchHostConversations,
	maxRawFetchHostsPerConversation,
	rawFetchHostNudgeThreshold,
	readBaseUrlHostname,
	readHostnameFromFetchInput,
	readLiteralRequestHostname,
	wrapOutboundFetcherRecordingHosts,
} from '#mcp/raw-fetch-host-nudge.ts'

test('raw-fetch host nudge counts hosts, tips at threshold once, excludes covered/own hosts, and evicts capped state', async () => {
	expect(readLiteralRequestHostname('https://API.Notion.com/v1/pages')).toBe(
		'api.notion.com',
	)
	expect(readLiteralRequestHostname('/relative')).toBe('')
	expect(readLiteralRequestHostname('not a url')).toBe('')
	expect(readBaseUrlHostname('https://heykody.dev/mcp')).toBe('heykody.dev')
	expect(
		readHostnameFromFetchInput(
			new Request('https://api.kit.com/v4/subscribers'),
		),
	).toBe('api.kit.com')

	const { sink, hostCounts } = createRawFetchHostSink()
	const outboundFetch = vi.fn(async () => new Response('ok'))
	const outbound = { fetch: outboundFetch } as unknown as Fetcher
	const wrapped = wrapOutboundFetcherRecordingHosts(outbound, sink, {
		excludedHostname: 'heykody.dev',
	})

	await wrapped.fetch('https://api.notion.com/v1/pages')
	await wrapped.fetch(new URL('https://API.Notion.com/v1/users'))
	await wrapped.fetch(new Request('https://heykody.dev/account'))
	await wrapped.fetch('/local-path')
	await wrapped.fetch('https://api.kit.com/v4/subscribers')

	expect(outboundFetch).toHaveBeenCalledTimes(5)
	expect(Object.fromEntries(hostCounts())).toEqual({
		'api.notion.com': 2,
		'api.kit.com': 1,
	})

	const belowThreshold = applyRawFetchHostCounts({
		state: null,
		conversationId: 'conv-a',
		hostCounts: new Map([['api.notion.com', 2]]),
	})
	expect(belowThreshold.nudges).toEqual([])
	expect(
		belowThreshold.state.byConversation['conv-a']?.hosts['api.notion.com'],
	).toEqual({ count: 2, nudged: false })
	expect(
		listHostsApproachingRawFetchNudge({
			state: belowThreshold.state,
			conversationId: 'conv-a',
			hostCounts: new Map([['api.notion.com', 1]]),
		}),
	).toEqual(['api.notion.com'])

	const tip = applyRawFetchHostCounts({
		state: belowThreshold.state,
		conversationId: 'conv-a',
		hostCounts: { 'api.notion.com': 1 },
	})
	expect(tip.nudges).toEqual([
		formatRawFetchHostNudge({
			hostname: 'api.notion.com',
			count: rawFetchHostNudgeThreshold,
		}),
	])
	expect(tip.state.byConversation['conv-a']?.hosts['api.notion.com']).toEqual({
		count: 3,
		nudged: true,
	})

	const secondTipAttempt = applyRawFetchHostCounts({
		state: tip.state,
		conversationId: 'conv-a',
		hostCounts: { 'api.notion.com': 5 },
	})
	expect(secondTipAttempt.nudges).toEqual([])
	expect(
		secondTipAttempt.state.byConversation['conv-a']?.hosts['api.notion.com']
			?.count,
	).toBe(8)

	const covered = applyRawFetchHostCounts({
		state: null,
		conversationId: 'conv-b',
		hostCounts: { 'api.transistor.fm': 3 },
		coveredHosts: ['api.transistor.fm'],
	})
	expect(covered.nudges).toEqual([])
	expect(
		covered.state.byConversation['conv-b']?.hosts['api.transistor.fm'],
	).toEqual({ count: 3, nudged: false })

	let hostCapState = applyRawFetchHostCounts({
		state: null,
		conversationId: 'conv-hosts',
		hostCounts: Object.fromEntries(
			Array.from({ length: maxRawFetchHostsPerConversation }, (_, index) => [
				`host-${index}.example`,
				1,
			]),
		),
	}).state
	hostCapState = applyRawFetchHostCounts({
		state: hostCapState,
		conversationId: 'conv-hosts',
		hostCounts: { 'host-overflow.example': 1 },
	}).state
	const cappedHosts = hostCapState.byConversation['conv-hosts']
	expect(cappedHosts?.hostOrder).toHaveLength(maxRawFetchHostsPerConversation)
	expect(cappedHosts?.hosts['host-0.example']).toBeUndefined()
	expect(cappedHosts?.hosts['host-overflow.example']?.count).toBe(1)

	let conversationCapState = null as
		| ReturnType<typeof applyRawFetchHostCounts>['state']
		| null
	for (let index = 0; index < maxRawFetchHostConversations; index += 1) {
		conversationCapState = applyRawFetchHostCounts({
			state: conversationCapState,
			conversationId: `conv-${index}`,
			hostCounts: { 'api.example.com': 1 },
		}).state
	}
	conversationCapState = applyRawFetchHostCounts({
		state: conversationCapState,
		conversationId: 'conv-overflow',
		hostCounts: { 'api.example.com': 1 },
	}).state
	expect(conversationCapState.conversationOrder).toHaveLength(
		maxRawFetchHostConversations,
	)
	expect(conversationCapState.byConversation['conv-0']).toBeUndefined()
	expect(
		conversationCapState.byConversation['conv-overflow']?.hosts[
			'api.example.com'
		]?.count,
	).toBe(1)

	const sameRunTip = applyRawFetchHostCounts({
		state: null,
		conversationId: 'conv-burst',
		hostCounts: { 'api.notion.com': 3 },
	})
	expect(sameRunTip.nudges).toEqual([
		formatRawFetchHostNudge({
			hostname: 'api.notion.com',
			count: 3,
		}),
	])

	expect(codeUsesIntegrationAuthHelpers('const x = 1')).toBe(false)
	expect(
		codeUsesIntegrationAuthHelpers(
			`import { createAuthenticatedFetch } from 'kody:runtime'`,
		),
	).toBe(true)
	expect(
		codeUsesIntegrationAuthHelpers(
			`import { refreshAccessToken } from 'kody:runtime'`,
		),
	).toBe(true)

	const authHelperTip = applyRawFetchHostCounts({
		state: null,
		conversationId: 'conv-oauth',
		hostCounts: { 'gmail.googleapis.com': 3 },
		usedIntegrationAuthHelpers: true,
	})
	const authHelperNudge = formatRawFetchHostNudge({
		hostname: 'gmail.googleapis.com',
		count: 3,
		usedIntegrationAuthHelpers: true,
	})
	const plainNudge = formatRawFetchHostNudge({
		hostname: 'gmail.googleapis.com',
		count: 3,
	})
	expect(authHelperTip.nudges).toEqual([authHelperNudge])
	expect(authHelperNudge).not.toBe(plainNudge)
	expect(authHelperNudge).toContain('gmail.googleapis.com')
})
