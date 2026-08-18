import { expect, test, vi } from 'vitest'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(async () => ({ status: 200, body: {} })),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

const {
	buildIntegrationAuthFailedReconnectUrl,
	dispatchIntegrationAuthFailedSubscriptionEvents,
	integrationAuthFailedTopic,
} = await import('./package-subscriptions.ts')

test('reconnect URLs add loginHint only when the account label is an email', () => {
	expect(
		buildIntegrationAuthFailedReconnectUrl({
			baseUrl: 'https://example.com',
			integrationName: 'google',
		}),
	).toBe('https://example.com/connect/oauth?provider=google')
	expect(
		buildIntegrationAuthFailedReconnectUrl({
			baseUrl: 'https://example.com',
			integrationName: 'google-business',
			accountLabel: 'Work',
		}),
	).toBe('https://example.com/connect/oauth?provider=google-business')
	expect(
		buildIntegrationAuthFailedReconnectUrl({
			baseUrl: 'https://example.com',
			integrationName: 'google',
			accountLabel: 'kent.c.dodds@gmail.com',
		}),
	).toBe(
		'https://example.com/connect/oauth?provider=google&loginHint=kent.c.dodds%40gmail.com',
	)
})

function createEnv() {
	return {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
	} as Env
}

function subscribedManifest(input: {
	name: string
	kodyId: string
	handler?: string
}) {
	return {
		manifest: {
			name: input.name,
			kody: {
				id: input.kodyId,
				description: 'Auth notifier',
				subscriptions: {
					[integrationAuthFailedTopic]: {
						handler: input.handler ?? './src/on-integration-auth-failed.ts',
					},
				},
			},
		},
	}
}

test('integration.auth.failed fans out only to owning-user packages with a lean payload', async () => {
	const savedPackage = {
		id: 'package-1',
		userId: 'user-1',
		sourceId: 'source-1',
		kodyId: 'auth-notifier',
		name: '@user/auth-notifier',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([savedPackage])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce(
		subscribedManifest({
			name: '@user/auth-notifier',
			kodyId: 'auth-notifier',
		}),
	)
	const env = createEnv()

	const results = await dispatchIntegrationAuthFailedSubscriptionEvents({
		env,
		userId: 'user-1',
		eventId: 'event-1',
		occurredAt: '2026-08-18T17:00:00.000Z',
		integration: {
			name: 'google',
			lane: 'platform',
			account_label: 'Work',
			description: 'Personal Gmail',
			provider: 'google',
			platform_app_slug: 'google',
			scopes: ['openid', 'email', 'https://www.googleapis.com/auth/calendar'],
			connected_at: '2026-01-01T00:00:00.000Z',
			token_refreshed_at: '2026-08-01T00:00:00.000Z',
		},
		reason: 'provider_rejected',
		provider: {
			error: 'invalid_grant',
			error_description: 'Token has been expired or revoked.',
			http_status: 400,
		},
	})

	expect(results).toHaveLength(1)
	expect(mocks.listSavedPackagesByUserId).toHaveBeenCalledWith(env.APP_DB, {
		userId: 'user-1',
	})
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: integrationAuthFailedTopic,
			idempotencyKey: `integration-auth-failed:event-1:package-1`,
			source: 'integrations',
			params: {
				event: integrationAuthFailedTopic,
				event_id: 'event-1',
				integration: {
					name: 'google',
					lane: 'platform',
					account_label: 'Work',
					description: 'Personal Gmail',
					provider: 'google',
					platform_app_slug: 'google',
					scopes: [
						'openid',
						'email',
						'https://www.googleapis.com/auth/calendar',
					],
					connected_at: '2026-01-01T00:00:00.000Z',
					token_refreshed_at: '2026-08-01T00:00:00.000Z',
				},
				reason: 'provider_rejected',
				provider: {
					error: 'invalid_grant',
					error_description: 'Token has been expired or revoked.',
					http_status: 400,
				},
				reconnect_url: 'https://example.com/connect/oauth?provider=google',
				account_url: 'https://example.com/account/integrations/google',
				occurred_at: '2026-08-18T17:00:00.000Z',
			},
		}),
	)
	const params = mocks.invokePackageSubscription.mock.calls[0]?.[0]?.params as
		| Record<string, unknown>
		| undefined
	expect(params).not.toHaveProperty('access_token')
	expect(params).not.toHaveProperty('refresh_token')
	expect(params).not.toHaveProperty('client_secret')
})

test('integration.auth.failed never throws on discovery or handler failures', async () => {
	consoleWarn.mockImplementation(() => {})
	mocks.invokePackageSubscription.mockReset()
	mocks.listSavedPackagesByUserId.mockReset()
	mocks.loadPackageManifestBySourceId.mockReset()
	const env = createEnv()

	mocks.listSavedPackagesByUserId.mockRejectedValueOnce(
		new Error('D1 unavailable'),
	)
	await expect(
		dispatchIntegrationAuthFailedSubscriptionEvents({
			env,
			userId: 'user-1',
			eventId: 'event-2',
			occurredAt: '2026-08-18T17:00:00.000Z',
			integration: {
				name: 'google',
				lane: 'user',
				account_label: null,
				description: null,
				provider: 'google',
				platform_app_slug: null,
				scopes: [],
				connected_at: null,
				token_refreshed_at: null,
			},
			reason: 'missing_refresh_token',
			provider: {
				error: null,
				error_description: null,
				http_status: null,
			},
		}),
	).resolves.toEqual([])
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
	expect(consoleWarn).toHaveBeenCalledWith(
		'integration.auth.failed package subscription discovery incomplete',
		expect.objectContaining({
			eventId: 'event-2',
			integrationName: 'google',
			errorCount: 1,
		}),
	)
	const discoveryWarn = consoleWarn.mock.calls.find(
		(call) =>
			call[0] ===
			'integration.auth.failed package subscription discovery incomplete',
	)?.[1] as Record<string, unknown> | undefined
	expect(discoveryWarn).not.toHaveProperty('userId')

	const matchingPackage = {
		id: 'package-1',
		userId: 'user-1',
		sourceId: 'source-1',
		kodyId: 'auth-notifier',
		name: '@user/auth-notifier',
	}
	const brokenPackage = {
		id: 'package-2',
		userId: 'user-1',
		sourceId: 'source-2',
		kodyId: 'broken',
		name: '@user/broken',
	}
	const sibling = {
		id: 'package-3',
		userId: 'user-1',
		sourceId: 'source-3',
		kodyId: 'notifier-b',
		name: '@user/notifier-b',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([
		matchingPackage,
		brokenPackage,
		sibling,
	])
	mocks.loadPackageManifestBySourceId
		.mockResolvedValueOnce(
			subscribedManifest({
				name: '@user/auth-notifier',
				kodyId: 'auth-notifier',
			}),
		)
		.mockRejectedValueOnce(new Error('manifest unavailable'))
		.mockResolvedValueOnce(
			subscribedManifest({
				name: '@user/notifier-b',
				kodyId: 'notifier-b',
			}),
		)
	mocks.invokePackageSubscription
		.mockRejectedValueOnce(new Error('handler boom'))
		.mockResolvedValueOnce({ status: 200, body: { ok: true } })

	await expect(
		dispatchIntegrationAuthFailedSubscriptionEvents({
			env,
			userId: 'user-1',
			eventId: 'event-3',
			occurredAt: '2026-08-18T17:00:00.000Z',
			integration: {
				name: 'google',
				lane: 'platform',
				account_label: null,
				description: null,
				provider: 'google',
				platform_app_slug: 'google',
				scopes: [],
				connected_at: null,
				token_refreshed_at: null,
			},
			reason: 'provider_rejected',
			provider: {
				error: 'invalid_grant',
				error_description: null,
				http_status: 400,
			},
		}),
	).resolves.toEqual([null, { status: 200, body: { ok: true } }])
	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		'integration.auth.failed package subscription invoke failed',
		expect.objectContaining({
			eventId: 'event-3',
			error: expect.any(Error),
		}),
	)
	expect(consoleWarn).toHaveBeenCalledWith(
		'Failed to load package manifest for integration.auth.failed subscription',
		expect.objectContaining({ packageId: 'package-2' }),
	)
})
