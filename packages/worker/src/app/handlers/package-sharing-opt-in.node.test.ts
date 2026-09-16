import { expect, test, vi } from 'vitest'
import { logAuditEventSpy } from '#worker/test-support/audit-log-spy.ts'
import { packageShareGrantsFlagKey } from '#universal/feature-flags/registry.ts'
import { routes } from '#universal/routes.ts'
import type * as FeatureFlagService from '#worker/feature-flags/service.ts'
import { createPackageSharingOptInHandler } from './package-sharing-opt-in.ts'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(),
	setFeatureFlagUserOverride: vi.fn(async () => undefined),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#worker/feature-flags/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof FeatureFlagService>()
	return {
		...actual,
		setFeatureFlagUserOverride: (
			...args: Parameters<typeof actual.setFeatureFlagUserOverride>
		) => mockModule.setFeatureFlagUserOverride(...args),
	}
})

function createEnv() {
	return {
		APP_DB: {} as D1Database,
	} as Env
}

function createUser() {
	return {
		sessionUserId: '7',
		userId: 7,
		username: 'jane',
		email: 'jane@example.com',
		emailVerified: true,
		emailVerificationDelivery: null,
		displayName: 'jane',
		roles: ['user'] as const,
		permissions: [],
		artifactOwnerIds: ['7'],
		mcpUser: {
			userId: 'a'.repeat(64),
			email: 'jane@example.com',
			username: 'jane',
			displayName: 'jane',
		},
	}
}

function createPostRequest() {
	return {
		request: new Request('https://kody.example/docs/package-sharing/opt-in', {
			method: 'POST',
		}),
		params: {},
		url: new URL('https://kody.example/docs/package-sharing/opt-in'),
	} as never
}

test('package sharing opt-in sends signed-out users to login and turns the flag on for a signed-in user', async () => {
	const env = createEnv()
	const handler = createPackageSharingOptInHandler(env)

	mockModule.readAuthenticatedAppUser.mockResolvedValue(null)
	const loginResponse = await handler.handler(createPostRequest())
	expect(loginResponse.status).toBe(302)
	expect(loginResponse.headers.get('Location')).toBe(
		'https://kody.example/login?redirectTo=%2Fdocs%2Fpackage-sharing',
	)
	expect(mockModule.setFeatureFlagUserOverride).not.toHaveBeenCalled()
	expect(logAuditEventSpy).not.toHaveBeenCalled()

	mockModule.readAuthenticatedAppUser.mockResolvedValue(createUser())
	const optedIn = await handler.handler(createPostRequest())
	expect(optedIn.status).toBe(302)
	expect(optedIn.headers.get('Location')).toBe(
		`https://kody.example${routes.docDetail.href({ slug: 'package-sharing' })}`,
	)
	expect(mockModule.setFeatureFlagUserOverride).toHaveBeenCalledWith(
		env.APP_DB,
		{
			key: packageShareGrantsFlagKey,
			userId: 7,
			enabled: true,
			updatedBy: 7,
		},
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'feature_flag_self_opt_in',
			result: 'success',
			email: 'jane@example.com',
			reason: `key=${packageShareGrantsFlagKey}`,
		}),
	)

	const again = await handler.handler(createPostRequest())
	expect(again.status).toBe(302)
	expect(mockModule.setFeatureFlagUserOverride).toHaveBeenCalledTimes(2)
})
