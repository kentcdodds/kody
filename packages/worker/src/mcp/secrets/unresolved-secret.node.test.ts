import { expect, test, vi } from 'vitest'
import {
	createMissingSecretMessage,
	parseMissingSecretMessage,
	parseSecretScopeUnavailableMessage,
} from './errors.ts'

const mockModule = vi.hoisted(() => ({
	listSecretLocationsByNameForUser: vi.fn(),
	getSavedPackageById: vi.fn(),
}))

vi.mock('./repo.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('./repo.ts')>()
	return {
		...actual,
		listSecretLocationsByNameForUser: (...args: Array<unknown>) =>
			mockModule.listSecretLocationsByNameForUser(...args),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

const { createUnresolvedSecretMessage } = await import('./unresolved-secret.ts')

test('unresolved secret errors distinguish inaccessible scopes from a true miss', async () => {
	const env = { APP_DB: {} as D1Database }
	const userId = 'user-1'
	const baseUrl = 'https://example.com'
	const secretName = 'discordBotToken'

	mockModule.listSecretLocationsByNameForUser.mockResolvedValue([])
	await expect(
		createUnresolvedSecretMessage({
			env,
			userId,
			name: secretName,
			baseUrl,
		}),
	).resolves.toBe(createMissingSecretMessage(secretName))

	mockModule.listSecretLocationsByNameForUser.mockResolvedValue([
		{
			scope: 'package',
			binding_key: 'pkg-1',
			name: secretName,
			expires_at: null,
		},
	])
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'pkg-1',
		kodyId: 'discord-gateway',
		name: '@user/discord-gateway',
	})
	const packageMiss = await createUnresolvedSecretMessage({
		env,
		userId,
		name: secretName,
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: null,
			storageId: null,
		},
		baseUrl,
	})
	expect(parseMissingSecretMessage(packageMiss)).toBeNull()
	expect(parseSecretScopeUnavailableMessage(packageMiss)).toEqual({
		secretName,
		scope: 'package',
		packageName: 'discord-gateway',
	})
	expect(packageMiss).toContain(
		'Either invoke this work through the owning package',
	)
	expect(packageMiss).toContain(
		'https://example.com/account/secrets/package/pkg-1/discordBotToken',
	)
	expect(mockModule.getSavedPackageById).toHaveBeenCalledWith(env.APP_DB, {
		userId,
		packageId: 'pkg-1',
	})

	const visibleInPackageRuntime = await createUnresolvedSecretMessage({
		env,
		userId,
		name: secretName,
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: 'pkg-1',
			storageId: 'pkg-1',
		},
		baseUrl,
	})
	expect(visibleInPackageRuntime).toBe(createMissingSecretMessage(secretName))

	mockModule.listSecretLocationsByNameForUser.mockResolvedValue([
		{
			scope: 'user',
			binding_key: '',
			name: secretName,
			expires_at: null,
		},
	])
	const pinnedPackageMiss = await createUnresolvedSecretMessage({
		env,
		userId,
		name: secretName,
		scope: 'package',
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: null,
			storageId: null,
		},
		baseUrl,
	})
	expect(parseSecretScopeUnavailableMessage(pinnedPackageMiss)).toEqual({
		secretName,
		scope: 'user',
		packageName: null,
	})
	expect(pinnedPackageMiss).toContain(
		'https://example.com/account/secrets/user/discordBotToken',
	)

	mockModule.listSecretLocationsByNameForUser.mockRejectedValue(
		new Error('d1 unavailable'),
	)
	await expect(
		createUnresolvedSecretMessage({
			env,
			userId,
			name: secretName,
			baseUrl,
		}),
	).resolves.toBe(createMissingSecretMessage(secretName))
})
