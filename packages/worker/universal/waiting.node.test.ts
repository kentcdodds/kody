import { expect, test } from 'vitest'
import {
	buildWaitingItems,
	isElevatedUserErrorRate,
	isUnexpiredEpochMs,
	isWaitingMcpServerState,
	type WaitingSignals,
} from './waiting.ts'

const emptySignals: WaitingSignals = {
	emailVerified: true,
	onboardingDismissed: true,
	onboardingRemaining: [],
	mcpServers: [],
	integrationAuth: [],
	expiredSecrets: [],
	lockedPackages: [],
	pendingEmailChange: null,
	errorRate: null,
	entitlementCaps: [],
}

test('waiting items are a current-state you-queue and skip noise', () => {
	expect(isWaitingMcpServerState('authenticating')).toBe(true)
	expect(isWaitingMcpServerState('failed')).toBe(true)
	expect(isWaitingMcpServerState('disconnected')).toBe(true)
	expect(isWaitingMcpServerState('ready')).toBe(false)
	expect(isWaitingMcpServerState('connecting')).toBe(false)

	expect(isElevatedUserErrorRate({ errorCount: 10, eventCount: 10 })).toBe(true)
	expect(isElevatedUserErrorRate({ errorCount: 5, eventCount: 20 })).toBe(true)
	expect(isElevatedUserErrorRate({ errorCount: 4, eventCount: 10 })).toBe(false)
	expect(isElevatedUserErrorRate({ errorCount: 5, eventCount: 40 })).toBe(false)

	const now = new Date('2026-08-31T00:00:00.000Z')
	expect(isUnexpiredEpochMs(now.getTime() + 1, now)).toBe(true)
	expect(isUnexpiredEpochMs(now.getTime(), now)).toBe(false)
	expect(isUnexpiredEpochMs(Number.NaN, now)).toBe(false)

	expect(buildWaitingItems(emptySignals)).toEqual([])

	const items = buildWaitingItems({
		emailVerified: false,
		onboardingDismissed: false,
		onboardingRemaining: ['verify-email', 'connect-agent'],
		mcpServers: [
			{
				id: 'srv-auth',
				name: 'Notion',
				state: 'authenticating',
				error: null,
			},
			{
				id: 'srv-down',
				name: 'Linear',
				state: 'disconnected',
				error: null,
			},
			{
				id: 'srv-ready',
				name: 'Ready',
				state: 'ready',
				error: null,
			},
		],
		integrationAuth: [],
		expiredSecrets: [],
		lockedPackages: [
			{ id: 'pkg-1', name: 'gmail-drafts', kodyId: 'gmail-drafts' },
		],
		pendingEmailChange: 'new@example.com',
		errorRate: { errorCount: 12, eventCount: 20 },
		entitlementCaps: [{ resource: 'saved_packages', label: 'Saved packages' }],
	})

	expect(items.map((item) => item.id)).toEqual([
		'verify-email',
		'mcp-server:srv-auth',
		'publish-lock:pkg-1',
		'email-change',
		'mcp-server:srv-down',
		'entitlement:saved_packages',
		'error-rate',
		'onboarding:connect-agent',
	])
	expect(items.every((item) => item.who === 'you')).toBe(true)
	expect(items.find((item) => item.id === 'onboarding:verify-email')).toBe(
		undefined,
	)
	expect(items.find((item) => item.id === 'mcp-server:srv-ready')).toBe(
		undefined,
	)

	const notion = items.find((item) => item.id === 'mcp-server:srv-auth')
	expect(notion).toMatchObject({
		title: 'Notion needs authorization',
		doLabel: 'Complete authorization',
		href: '/account/mcp-servers/srv-auth',
		severity: 'block',
	})

	const failed = buildWaitingItems({
		...emptySignals,
		mcpServers: [
			{
				id: 'srv-fail',
				name: 'GitHub',
				state: 'failed',
				error: 'Token exchange failed.',
			},
		],
	})
	expect(failed[0]).toMatchObject({
		id: 'mcp-server:srv-fail',
		title: 'GitHub failed to connect',
		why: 'Token exchange failed.',
		doLabel: 'Reconnect',
		href: '/account/mcp-servers/srv-fail',
		severity: 'degraded',
	})

	const emptyAfterDismiss = buildWaitingItems({
		...emptySignals,
		onboardingDismissed: true,
		onboardingRemaining: ['connect-agent'],
	})
	expect(emptyAfterDismiss).toEqual([])

	const connectionHealth = buildWaitingItems({
		...emptySignals,
		mcpServers: [
			{
				id: 'srv-outage',
				name: 'Linear',
				state: 'failed',
				error: 'HTTP 503 from upstream',
			},
		],
		integrationAuth: [
			{
				name: 'google',
				accountLabel: 'kent@gmail.com',
				lane: 'user',
				reason: 'provider_rejected',
			},
			{
				name: 'spotify',
				accountLabel: null,
				lane: 'user',
				reason: 'provider_unavailable',
			},
		],
		expiredSecrets: [
			{ name: 'githubAccessToken' },
			{ name: 'one' },
			{ name: 'two' },
			{ name: 'three' },
		],
	})
	expect(connectionHealth.map((item) => item.id)).toEqual([
		'integration-auth:google',
		'secret-expired:githubAccessToken',
		'secret-expired:one',
		'secret-expired:two',
		'secret-expired-more',
	])
	expect(
		connectionHealth.find((item) => item.id === 'mcp-server:srv-outage'),
	).toBeUndefined()
	expect(
		connectionHealth.find((item) => item.id === 'integration-auth:spotify'),
	).toBeUndefined()
	expect(
		connectionHealth.find((item) => item.id === 'integration-auth:google'),
	).toMatchObject({
		who: 'you',
		doLabel: 'Reconnect',
		href: '/connect/oauth?provider=google&loginHint=kent%40gmail.com',
		severity: 'block',
	})
})
