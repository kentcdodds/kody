import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	parsePackageAccessRequiredBatchMessage,
	parsePackageAccessRequiredMessage,
} from './errors.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getCommunityForkByForkedPackageId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	resolveSecret: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityForkByForkedPackageId: (...args: Array<unknown>) =>
		mockModule.getCommunityForkByForkedPackageId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageManifestBySourceId(...args),
}))

vi.mock('./service.ts', () => ({
	resolveSecret: (...args: Array<unknown>) => mockModule.resolveSecret(...args),
}))

const {
	assertCanSetSecrets,
	assertPackageCanAccessResolvedSecret,
	buildPackageApprovalErrorForMounts,
	findMissingPackageApprovals,
	PackageSecretAccessDeniedError,
	resolvePackageMountedSecret,
} = await import('./package-access.ts')

const savedPackage = {
	id: 'pkg-1',
	kodyId: 'discord-gateway',
	name: '@kentcdodds/discord-gateway',
	sourceId: 'source-1',
}

const communityFork = {
	id: 'fork-1',
	listingId: 'listing-1',
	forkerUserId: 'user-1',
	originCommit: 'abc123',
	forkedPackageId: 'pkg-1',
	forkedSourceId: 'source-1',
	targetKodyId: 'discord-gateway',
	createdAt: '2026-01-01T00:00:00.000Z',
	adoptedAt: null,
	adoptionNote: null,
}

const userSecretResolved = {
	found: true as const,
	value: 'secret',
	scope: 'user' as const,
	allowedHosts: [] as Array<string>,
	allowedCapabilities: [] as Array<string>,
	allowedPackages: [] as Array<string>,
}

function accessInput(
	overrides: Partial<
		Parameters<typeof assertPackageCanAccessResolvedSecret>[0]
	> = {},
) {
	return {
		env: { APP_DB: {} as D1Database },
		baseUrl: 'https://example.com',
		userId: 'user-1',
		storageContext: {
			sessionId: null,
			packageId: 'pkg-1',
		},
		secretName: 'userToken',
		resolved: userSecretResolved,
		...overrides,
	}
}

function expectAccessDenied(error: unknown, secretName = 'userToken') {
	expect(error).toBeInstanceOf(PackageSecretAccessDeniedError)
	expect(error).toBeInstanceOf(McpCallerError)
	expect(parsePackageAccessRequiredMessage((error as Error).message)).toEqual({
		secretName,
		packageName: 'discord-gateway',
	})
}

test('package secret access grants cover owned, self-authored, forked, adopted, and mutate intents', async () => {
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({
				secretName: 'packageToken',
				resolved: {
					...userSecretResolved,
					scope: 'package',
				},
			}),
		),
	).resolves.toBeUndefined()
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce(null)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).resolves.toBeUndefined()
	expect(mockModule.getCommunityForkByForkedPackageId).toHaveBeenCalledWith(
		expect.anything(),
		{ forkerUserId: 'user-1', forkedPackageId: 'pkg-1' },
	)

	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce(
		communityFork,
	)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).rejects.toSatisfy((error: unknown) => {
		expectAccessDenied(error)
		return true
	})

	mockModule.getSavedPackageById.mockClear()
	mockModule.getCommunityForkByForkedPackageId.mockClear()
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({
				resolved: {
					...userSecretResolved,
					allowedPackages: ['pkg-1'],
				},
			}),
		),
	).resolves.toBeUndefined()
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce({
		...communityFork,
		adoptedAt: '2026-07-01T00:00:00.000Z',
		adoptionNote: 'Reviewed source; trusted for my use.',
	})
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).resolves.toBeUndefined()

	// Mutate always needs an allowed-packages grant (self-authored and adopted
	// forks alike); the fork lookup is skipped for mutate.
	mockModule.getSavedPackageById.mockClear()
	mockModule.getCommunityForkByForkedPackageId.mockClear()
	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput({ intent: 'mutate' })),
	).rejects.toSatisfy((error: unknown) => {
		expectAccessDenied(error)
		return true
	})
	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(1)
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockClear()
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({
				intent: 'mutate',
				resolved: {
					...userSecretResolved,
					allowedPackages: ['pkg-1'],
				},
			}),
		),
	).resolves.toBeUndefined()
	// Grant short-circuits before package/fork lookups.
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()
})

test('assertCanSetSecrets fails closed for mutate grants before any provider work', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)
	mockModule.resolveSecret.mockResolvedValue({
		found: true,
		value: 'secret',
		scope: 'user',
		allowedHosts: [],
		allowedCapabilities: [],
		allowedPackages: [],
	})

	await expect(
		assertCanSetSecrets({
			env: {
				APP_DB: {} as D1Database,
				SECRET_STORE_KEY: 'test-secret-store-key-32-chars-minimum',
			},
			userId: 'user-1',
			baseUrl: 'https://example.com',
			secrets: [
				{ name: 'xRefreshToken', scope: 'user' },
				{ name: 'xAccessToken', scope: 'user' },
			],
			storageContext: {
				sessionId: null,
				packageId: 'pkg-1',
			},
		}),
	).rejects.toBeInstanceOf(PackageSecretAccessDeniedError)
	expect(mockModule.resolveSecret).toHaveBeenCalled()
})

test('resolvePackageMountedSecret requires matching package runtime context and resolves approved mounts', async () => {
	const runtimeError =
		'Package secret access requires a matching server-side package runtime context.'
	const baseInput = {
		env: {} as Env,
		packageId: 'pkg-1',
		alias: 'discordBotToken',
		callerContext: {
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
			remoteConnectors: null,
			repoContext: null,
		},
	}

	await expect(
		resolvePackageMountedSecret({
			...baseInput,
			callerContext: {
				...baseInput.callerContext,
				storageContext: {
					sessionId: null,
					packageId: null,
					storageId: 'pkg-1',
				},
			},
		}),
	).rejects.toThrow(runtimeError)

	await expect(
		resolvePackageMountedSecret({
			...baseInput,
			callerContext: {
				...baseInput.callerContext,
				storageContext: {
					sessionId: null,
					packageId: 'pkg-2',
					storageId: 'pkg-1',
				},
			},
		}),
	).rejects.toThrow(runtimeError)

	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.loadPackageManifestBySourceId.mockResolvedValueOnce({
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway',
				secretMounts: {
					discordBotToken: {
						name: 'discordBotTokenKentPersonalAutomation',
						scope: 'user',
					},
				},
			},
		},
	})
	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'bot-token',
		scope: 'user',
		allowedPackages: ['pkg-1'],
	})

	await expect(
		resolvePackageMountedSecret({
			env: { APP_DB: {} as D1Database } as Env,
			packageId: 'pkg-1',
			alias: 'discordBotToken',
			callerContext: {
				baseUrl: 'https://example.com',
				user: {
					userId: 'user-1',
					email: 'user@example.com',
					displayName: 'User',
				},
				remoteConnectors: null,
				repoContext: null,
				storageContext: {
					sessionId: null,
					packageId: 'pkg-1',
					storageId: 'pkg-1',
				},
			},
		}),
	).resolves.toMatchObject({
		alias: 'discordBotToken',
		name: 'discordBotTokenKentPersonalAutomation',
		value: 'bot-token',
		scope: 'user',
		packageId: 'pkg-1',
		kodyId: 'discord-gateway',
	})

	expect(mockModule.resolveSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			name: 'discordBotTokenKentPersonalAutomation',
			scope: 'user',
			storageContext: {
				sessionId: null,
				appId: null,
				packageId: 'pkg-1',
				storageId: 'pkg-1',
			},
		}),
	)
})

test('package approval helpers parse structured messages and skip trusted packages', async () => {
	expect(buildPackageApprovalErrorForMounts({ entries: [] })).toBeNull()
	const approvalMessage = buildPackageApprovalErrorForMounts({
		entries: [
			{
				secretName: 'discordBotTokenKentPersonalAutomation',
				packageId: 'pkg-1',
				kodyId: 'discord-gateway',
				approvalUrl: 'https://example.com/account/secrets/user/discordBotToken',
			},
		],
	})
	expect(parsePackageAccessRequiredMessage(approvalMessage ?? '')).toEqual({
		secretName: 'discordBotTokenKentPersonalAutomation',
		packageName: 'discord-gateway',
	})

	const batchMessage = buildPackageApprovalErrorForMounts({
		baseUrl: 'https://example.com',
		entries: [
			{
				secretName: 'discordBotToken',
				packageId: 'pkg-1',
				kodyId: 'release',
				approvalUrl:
					'https://example.com/account/secrets/user/discordBotToken?package_id=pkg-1',
			},
			{
				secretName: 'xAccessToken',
				packageId: 'pkg-1',
				kodyId: 'release',
				approvalUrl:
					'https://example.com/account/secrets/user/xAccessToken?package_id=pkg-1',
			},
		],
	})
	const batchParsed = parsePackageAccessRequiredBatchMessage(batchMessage ?? '')
	expect(batchParsed?.entries).toEqual([
		expect.objectContaining({
			secretName: 'discordBotToken',
			packageId: 'pkg-1',
			kodyId: 'release',
		}),
		expect.objectContaining({
			secretName: 'xAccessToken',
			packageId: 'pkg-1',
			kodyId: 'release',
		}),
	])
	expect(batchParsed?.bulkApprovalUrl).toContain('/account/secrets/approve?')

	const mounts = {
		discordBotToken: {
			name: 'discordBotTokenKentPersonalAutomation',
			scope: 'user' as const,
		},
	}
	const storageContext = {
		sessionId: null,
		appId: null,
		packageId: 'pkg-1',
		storageId: 'pkg-1',
	}

	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce(null)
	await expect(
		findMissingPackageApprovals({
			env: { APP_DB: {} as D1Database } as Env,
			baseUrl: 'https://example.com',
			userId: 'user-1',
			packageId: 'pkg-1',
			mounts,
			storageContext,
		}),
	).resolves.toEqual([])
	expect(mockModule.resolveSecret).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce({
		...communityFork,
		adoptedAt: '2026-07-01T00:00:00.000Z',
		adoptionNote: 'Reviewed source; trusted for my use.',
	})
	await expect(
		findMissingPackageApprovals({
			env: { APP_DB: {} as D1Database } as Env,
			baseUrl: 'https://example.com',
			userId: 'user-1',
			packageId: 'pkg-1',
			mounts,
			storageContext,
		}),
	).resolves.toEqual([])
	expect(mockModule.resolveSecret).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce(
		communityFork,
	)
	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'bot-token',
		scope: 'user',
		allowedPackages: [],
	})
	const entries = await findMissingPackageApprovals({
		env: { APP_DB: {} as D1Database } as Env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		packageId: 'pkg-1',
		mounts,
		storageContext,
	})
	expect(entries).toHaveLength(1)
	expect(entries[0]).toMatchObject({
		secretName: 'discordBotTokenKentPersonalAutomation',
		packageId: 'pkg-1',
		kodyId: 'discord-gateway',
	})
	expect(mockModule.loadPackageManifestBySourceId).not.toHaveBeenCalled()
})
