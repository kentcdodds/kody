import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { parsePackageAccessRequiredMessage } from './errors.ts'

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
	assertPackageCanAccessResolvedSecret,
	buildPackageApprovalErrorForMounts,
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

test('package-owned secrets do not require an allowed-packages grant', async () => {
	await expect(
		assertPackageCanAccessResolvedSecret({
			env: { APP_DB: {} as D1Database },
			baseUrl: 'https://example.com',
			userId: 'user-1',
			storageContext: {
				sessionId: null,
				packageId: 'pkg-1',
			},
			secretName: 'packageToken',
			resolved: {
				found: true,
				value: 'secret',
				scope: 'package',
				allowedHosts: [],
				allowedCapabilities: [],
				allowedPackages: [],
			},
		}),
	).resolves.toBeUndefined()
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
})

test('self-authored packages may use user secrets without an allowed-packages grant', async () => {
	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce(null)

	await expect(
		assertPackageCanAccessResolvedSecret({
			env: { APP_DB: {} as D1Database },
			baseUrl: 'https://example.com',
			userId: 'user-1',
			storageContext: {
				sessionId: null,
				packageId: 'pkg-1',
			},
			secretName: 'userToken',
			resolved: {
				found: true,
				value: 'secret',
				scope: 'user',
				allowedHosts: [],
				allowedCapabilities: [],
				allowedPackages: [],
			},
		}),
	).resolves.toBeUndefined()
	expect(mockModule.getCommunityForkByForkedPackageId).toHaveBeenCalledWith(
		expect.anything(),
		{ forkerUserId: 'user-1', forkedPackageId: 'pkg-1' },
	)
})

test('community-forked packages require an allowed-packages grant for user secrets', async () => {
	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce(
		communityFork,
	)

	await expect(
		assertPackageCanAccessResolvedSecret({
			env: { APP_DB: {} as D1Database },
			baseUrl: 'https://example.com',
			userId: 'user-1',
			storageContext: {
				sessionId: null,
				packageId: 'pkg-1',
			},
			secretName: 'userToken',
			resolved: {
				found: true,
				value: 'secret',
				scope: 'user',
				allowedHosts: [],
				allowedCapabilities: [],
				allowedPackages: [],
			},
		}),
	).rejects.toSatisfy((error: unknown) => {
		if (!(error instanceof PackageSecretAccessDeniedError)) return false
		if (!(error instanceof McpCallerError)) return false
		const parsed = parsePackageAccessRequiredMessage(error.message)
		return (
			parsed?.secretName === 'userToken' &&
			parsed.packageName === 'discord-gateway' &&
			error.message.includes('/account/secrets/user/userToken')
		)
	})
})

test('community-forked packages with an allowed-packages grant may use user secrets', async () => {
	await expect(
		assertPackageCanAccessResolvedSecret({
			env: { APP_DB: {} as D1Database },
			baseUrl: 'https://example.com',
			userId: 'user-1',
			storageContext: {
				sessionId: null,
				packageId: 'pkg-1',
			},
			secretName: 'userToken',
			resolved: {
				found: true,
				value: 'secret',
				scope: 'user',
				allowedHosts: [],
				allowedCapabilities: [],
				allowedPackages: ['pkg-1'],
			},
		}),
	).resolves.toBeUndefined()
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()
})

test('adopted community forks may use user secrets without an allowed-packages grant', async () => {
	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce({
		...communityFork,
		adoptedAt: '2026-07-01T00:00:00.000Z',
		adoptionNote: 'Reviewed source; trusted for my use.',
	})

	await expect(
		assertPackageCanAccessResolvedSecret({
			env: { APP_DB: {} as D1Database },
			baseUrl: 'https://example.com',
			userId: 'user-1',
			storageContext: {
				sessionId: null,
				packageId: 'pkg-1',
			},
			secretName: 'userToken',
			resolved: {
				found: true,
				value: 'secret',
				scope: 'user',
				allowedHosts: [],
				allowedCapabilities: [],
				allowedPackages: [],
			},
		}),
	).resolves.toBeUndefined()
})

test('adopted community forks still require an allowed-packages grant for mutate', async () => {
	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)

	await expect(
		assertPackageCanAccessResolvedSecret({
			env: { APP_DB: {} as D1Database },
			baseUrl: 'https://example.com',
			userId: 'user-1',
			storageContext: {
				sessionId: null,
				packageId: 'pkg-1',
			},
			secretName: 'userToken',
			resolved: {
				found: true,
				value: 'secret',
				scope: 'user',
				allowedHosts: [],
				allowedCapabilities: [],
				allowedPackages: [],
			},
			intent: 'mutate',
		}),
	).rejects.toSatisfy((error: unknown) => {
		return (
			error instanceof PackageSecretAccessDeniedError &&
			error instanceof McpCallerError &&
			parsePackageAccessRequiredMessage(error.message)?.packageName ===
				'discord-gateway'
		)
	})
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()
})

test('mutate intent requires an allowed-packages grant even for self-authored packages', async () => {
	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)

	await expect(
		assertPackageCanAccessResolvedSecret({
			env: { APP_DB: {} as D1Database },
			baseUrl: 'https://example.com',
			userId: 'user-1',
			storageContext: {
				sessionId: null,
				packageId: 'pkg-1',
			},
			secretName: 'userToken',
			resolved: {
				found: true,
				value: 'secret',
				scope: 'user',
				allowedHosts: [],
				allowedCapabilities: [],
				allowedPackages: [],
			},
			intent: 'mutate',
		}),
	).rejects.toSatisfy((error: unknown) => {
		if (!(error instanceof PackageSecretAccessDeniedError)) return false
		if (!(error instanceof McpCallerError)) return false
		const parsed = parsePackageAccessRequiredMessage(error.message)
		return (
			parsed?.secretName === 'userToken' &&
			parsed.packageName === 'discord-gateway' &&
			error.message.includes('/account/secrets/user/userToken')
		)
	})
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()

	await expect(
		assertPackageCanAccessResolvedSecret({
			env: { APP_DB: {} as D1Database },
			baseUrl: 'https://example.com',
			userId: 'user-1',
			storageContext: {
				sessionId: null,
				packageId: 'pkg-1',
			},
			secretName: 'userToken',
			resolved: {
				found: true,
				value: 'secret',
				scope: 'user',
				allowedHosts: [],
				allowedCapabilities: [],
				allowedPackages: ['pkg-1'],
			},
			intent: 'mutate',
		}),
	).resolves.toBeUndefined()
	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(1)
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()
})

test('resolvePackageMountedSecret rejects package runtime calls without a matching packageId', async () => {
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
})

test('resolvePackageMountedSecret resolves approved user secret when package id matches', async () => {
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

test('package access helpers treat missing approvals consistently', () => {
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
	expect(batchMessage).toContain('bulkApprovalUrl')
	expect(batchMessage).toContain('/account/secrets/approve?')
	expect(batchMessage).toContain('names=discordBotToken')
})

test('findMissingPackageApprovals skips self-authored and adopted forks, reports unapproved community forks', async () => {
	const { findMissingPackageApprovals } = await import('./package-access.ts')
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
