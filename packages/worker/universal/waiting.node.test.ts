import { expect, test } from 'vitest'
import { onboardingChecklistItems } from './onboarding-process.ts'
import {
	buildWaitingItems,
	isElevatedUserErrorRate,
	isUnexpiredEpochMs,
	isWaitingMcpServerState,
	waitingFirstUseIds,
	type WaitingFirstUseId,
	type WaitingSignals,
} from './waiting.ts'

const emptySignals: WaitingSignals = {
	username: 'kentcdodds',
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
	firstUseMissing: [],
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
	expect(isElevatedUserErrorRate({ errorCount: 0, eventCount: 162103 })).toBe(
		false,
	)

	const now = new Date('2026-08-31T00:00:00.000Z')
	expect(isUnexpiredEpochMs(now.getTime() + 1, now)).toBe(true)
	expect(isUnexpiredEpochMs(now.getTime(), now)).toBe(false)
	expect(isUnexpiredEpochMs(Number.NaN, now)).toBe(false)

	expect(buildWaitingItems(emptySignals)).toEqual([])

	const items = buildWaitingItems({
		username: 'kentcdodds',
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
		firstUseMissing: [],
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
	expect(items.find((item) => item.id === 'error-rate')).toMatchObject({
		title: 'Error rate is elevated',
		why: '12 of 20 recent runs failed and still need triage. Activity is where you handle those errors.',
		doLabel: 'Open Activity',
		href: '/account/activity',
	})

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

	const allErrorsTriaged = buildWaitingItems({
		...emptySignals,
		errorRate: { errorCount: 0, eventCount: 162103 },
	})
	expect(allErrorsTriaged).toEqual([])

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

test('waiting first-use cards are discrete, skip coarse checklist ids, and ignore dismiss', () => {
	expect(
		onboardingChecklistItems.some((item) =>
			(waitingFirstUseIds as ReadonlyArray<string>).includes(item.id),
		),
	).toBe(false)

	const allMissing = buildWaitingItems({
		...emptySignals,
		onboardingDismissed: true,
		onboardingRemaining: ['give-access', 'install-starter', 'connect-agent'],
		firstUseMissing: [...waitingFirstUseIds],
	})
	expect(allMissing.map((item) => item.id)).toEqual([
		'first-use:search',
		'first-use:memory',
		'first-use:execute',
		'first-use:package',
		'first-use:job',
		'first-use:integration',
		'first-use:secret',
		'first-use:discord',
	])
	expect(allMissing.every((item) => item.kind === 'first-use')).toBe(true)
	expect(allMissing.every((item) => item.severity === 'setup')).toBe(true)
	expect(allMissing.find((item) => item.id === 'onboarding:give-access')).toBe(
		undefined,
	)
	expect(
		allMissing.find((item) => item.id === 'onboarding:install-starter'),
	).toBe(undefined)
	expect(
		allMissing.find((item) => item.id === 'onboarding:connect-agent'),
	).toBe(undefined)

	const wizardResume = buildWaitingItems({
		...emptySignals,
		onboardingDismissed: false,
		onboardingRemaining: [
			'connect-agent',
			'give-access',
			'connect-second-agent',
			'install-starter',
		],
		firstUseMissing: ['search', 'discord'],
	})
	expect(wizardResume.map((item) => item.id)).toEqual([
		'onboarding:connect-second-agent',
		'onboarding:connect-agent',
		'first-use:search',
		'first-use:discord',
	])

	const discord = wizardResume.find((item) => item.id === 'first-use:discord')
	expect(discord).toMatchObject({
		title: 'Join the Kody Discord',
		doLabel: 'Join Discord',
		href: '/discord',
		severity: 'setup',
	})

	const presentClearsCard: Array<WaitingFirstUseId> = [...waitingFirstUseIds]
	for (const id of presentClearsCard) {
		const remaining = presentClearsCard.filter((candidate) => candidate !== id)
		const items = buildWaitingItems({
			...emptySignals,
			firstUseMissing: remaining,
		})
		expect(items.find((item) => item.id === `first-use:${id}`)).toBe(undefined)
		expect(items.map((item) => item.id)).toEqual(
			remaining.map((candidate) => `first-use:${candidate}`),
		)
	}
})
