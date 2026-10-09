import { personIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
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

const env = { APP_DB: {} as D1Database } as Env
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
const adoptedFork = {
	...communityFork,
	adoptedAt: '2026-07-01T00:00:00.000Z',
	adoptionNote: 'Reviewed source; trusted for my use.',
}
const userSecretResolved = {
	found: true as const,
	value: 'secret',
	scope: 'user' as const,
	allowedHosts: [] as Array<string>,
	allowedPackages: [] as Array<string>,
}
const grantedToPkg1 = { ...userSecretResolved, allowedPackages: ['pkg-1'] }
const discordMount = {
	discordBotToken: {
		name: 'discordBotTokenKentPersonalAutomation',
		scope: 'user' as const,
	},
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
		storageContext: { sessionId: null, packageId: 'pkg-1' },
		secretName: 'userToken',
		resolved: userSecretResolved,
		...overrides,
	}
}

function expectAccessDenied(error: unknown) {
	expect(error).toBeInstanceOf(PackageSecretAccessDeniedError)
	expect(error).toBeInstanceOf(McpCallerError)
	expect(parsePackageAccessRequiredMessage((error as Error).message)).toEqual({
		secretName: 'userToken',
		packageName: 'discord-gateway',
	})
	return true
}

function lookups(pkg: unknown, fork: unknown) {
	mockModule.getSavedPackageById.mockResolvedValueOnce(pkg)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValueOnce(fork)
}

function clearLookups() {
	mockModule.getSavedPackageById.mockClear()
	mockModule.getCommunityForkByForkedPackageId.mockClear()
}

function mountManifest(
	name: string,
	kodyId: string,
	secretMounts: Record<string, { name: string; scope: 'user' | 'package' }>,
) {
	mockModule.loadPackageManifestBySourceId.mockResolvedValueOnce({
		manifest: {
			name,
			exports: { '.': './src/index.ts' },
			kody: { id: kodyId, description: kodyId, secretMounts },
		},
	})
}

function mountCaller(
	storagePackageId: string | null,
	options: { userId?: string | null; storageId?: string } = {},
) {
	const userId = options.userId === undefined ? 'user-1' : options.userId
	return createMcpCallerContext({
		source: { kind: 'mcp-oauth' },
		baseUrl: 'https://example.com',
		user: userId
			? {
					userId: personIdFromStored(userId),
					email: `${userId}@example.com`,
					displayName: userId,
				}
			: undefined,
		repoContext: null,
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: storagePackageId,
			storageId: options.storageId ?? storagePackageId ?? 'pkg-1',
		},
	})
}

test('package secret access grants cover owned, self-authored, forked, adopted, and mutate intents', async () => {
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({
				secretName: 'packageToken',
				resolved: { ...userSecretResolved, scope: 'package' },
			}),
		),
	).resolves.toBeUndefined()
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()

	lookups(savedPackage, null)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).resolves.toBeUndefined()
	expect(mockModule.getCommunityForkByForkedPackageId).toHaveBeenCalledWith(
		expect.anything(),
		{ forkerUserId: 'user-1', forkedPackageId: 'pkg-1' },
	)

	lookups(savedPackage, communityFork)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).rejects.toSatisfy(expectAccessDenied)

	clearLookups()
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({ resolved: grantedToPkg1 }),
		),
	).resolves.toBeUndefined()
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()

	lookups(savedPackage, adoptedFork)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).resolves.toBeUndefined()

	// Mutate always needs an allowed-packages grant (self-authored and adopted
	// forks alike); the fork lookup is skipped for mutate.
	clearLookups()
	mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput({ intent: 'mutate' })),
	).rejects.toSatisfy(expectAccessDenied)
	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(1)
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()

	mockModule.getSavedPackageById.mockClear()
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({ intent: 'mutate', resolved: grantedToPkg1 }),
		),
	).resolves.toBeUndefined()
	// Grant short-circuits before package/fork lookups.
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()
})

test('package secret access authorizes the stamp package, not the importing run', async () => {
	lookups(
		{
			...savedPackage,
			id: 'pkg-2',
			kodyId: 'importer',
			name: '@user/importer',
		},
		{ ...communityFork, forkedPackageId: 'pkg-2', targetKodyId: 'importer' },
	)
	const importerRun = { sessionId: null, packageId: 'pkg-2' }
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({ storageContext: importerRun, resolved: grantedToPkg1 }),
		),
	).rejects.toBeInstanceOf(PackageSecretAccessDeniedError)
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({
				storageContext: importerRun,
				authorityPackageId: 'pkg-1',
				resolved: grantedToPkg1,
			}),
		),
	).resolves.toBeUndefined()
})

test('package secret access does not resolve platform packages the caller does not own', async () => {
	const platformPackageId = '91d7d9e4-6b88-44da-ab19-01fe26845ac5'
	mockModule.getSavedPackageById.mockResolvedValueOnce(null)
	await expect(
		assertPackageCanAccessResolvedSecret(
			accessInput({
				storageContext: { sessionId: null, packageId: platformPackageId },
			}),
		),
	).rejects.toSatisfy((error: unknown) => {
		expect(error).toBeInstanceOf(PackageSecretAccessDeniedError)
		expect((error as Error).message).toBe(
			`Package "${platformPackageId}" was not found for secret access.`,
		)
		return true
	})
	expect(mockModule.getCommunityForkByForkedPackageId).not.toHaveBeenCalled()

	lookups(savedPackage, null)
	await expect(
		assertPackageCanAccessResolvedSecret(accessInput()),
	).resolves.toBeUndefined()
})

test('assertCanSetSecrets fails closed for mutate grants before any provider work', async () => {
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage)
	mockModule.getCommunityForkByForkedPackageId.mockResolvedValue(null)
	mockModule.resolveSecret.mockResolvedValue(userSecretResolved)
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
			storageContext: { sessionId: null, appId: null, packageId: 'pkg-1' },
		}),
	).rejects.toBeInstanceOf(PackageSecretAccessDeniedError)
	expect(mockModule.resolveSecret).toHaveBeenCalled()
})

test('resolvePackageMountedSecret uses the stamped package id even when the run is another package', async () => {
	const mount = { packageId: 'pkg-1', alias: 'discordBotToken' }
	await expect(
		resolvePackageMountedSecret({
			env: {} as Env,
			...mount,
			packageId: '',
			callerContext: mountCaller(null),
		}),
	).rejects.toThrow(
		'Package secret access requires a matching server-side package runtime context.',
	)
	await expect(
		resolvePackageMountedSecret({
			env: {} as Env,
			...mount,
			callerContext: mountCaller('pkg-1', { userId: null }),
		}),
	).rejects.toThrow(
		'Package secret access requires an authenticated package caller context.',
	)

	for (const runPackageId of ['pkg-1', 'pkg-2']) {
		mockModule.getSavedPackageById.mockResolvedValueOnce(savedPackage)
		mountManifest(
			'@kentcdodds/discord-gateway',
			'discord-gateway',
			discordMount,
		)
		mockModule.resolveSecret.mockResolvedValueOnce({
			found: true,
			value: 'bot-token',
			scope: 'user',
			allowedPackages: ['pkg-1'],
		})
		await expect(
			resolvePackageMountedSecret({
				env,
				...mount,
				callerContext: mountCaller(runPackageId),
			}),
		).resolves.toMatchObject({
			alias: 'discordBotToken',
			name: 'discordBotTokenKentPersonalAutomation',
			ref: '{{secret:discordBotTokenKentPersonalAutomation|scope=user}}',
			scope: 'user',
			packageId: 'pkg-1',
			kodyId: 'discord-gateway',
		})
		expect(mockModule.resolveSecret).toHaveBeenLastCalledWith(
			expect.objectContaining({
				userId: 'user-1',
				name: 'discordBotTokenKentPersonalAutomation',
				scope: 'user',
				storageContext: {
					sessionId: null,
					appId: null,
					packageId: 'pkg-1',
					storageId: runPackageId,
				},
			}),
		)
	}
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

	const batchNames = ['discordBotToken', 'xAccessToken']
	const batchMessage = buildPackageApprovalErrorForMounts({
		baseUrl: 'https://example.com',
		entries: batchNames.map((secretName) => ({
			secretName,
			packageId: 'pkg-1',
			kodyId: 'release',
			approvalUrl: `https://example.com/account/secrets/user/${secretName}?package_id=pkg-1`,
		})),
	})
	const batchParsed = parsePackageAccessRequiredBatchMessage(batchMessage ?? '')
	expect(batchParsed?.entries).toEqual(
		batchNames.map((secretName) =>
			expect.objectContaining({
				secretName,
				packageId: 'pkg-1',
				kodyId: 'release',
			}),
		),
	)
	expect(batchParsed?.bulkApprovalUrl).toContain('/account/secrets/approve?')

	const approvalsInput = {
		env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		packageId: 'pkg-1',
		mounts: discordMount,
		storageContext: {
			sessionId: null,
			appId: null,
			packageId: 'pkg-1',
			storageId: 'pkg-1',
		},
	}
	for (const trustedFork of [null, adoptedFork]) {
		lookups(savedPackage, trustedFork)
		await expect(findMissingPackageApprovals(approvalsInput)).resolves.toEqual(
			[],
		)
	}
	expect(mockModule.resolveSecret).not.toHaveBeenCalled()

	lookups(savedPackage, communityFork)
	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'bot-token',
		scope: 'user',
		allowedPackages: [],
	})
	const entries = await findMissingPackageApprovals(approvalsInput)
	expect(entries).toHaveLength(1)
	expect(entries[0]).toMatchObject({
		secretName: 'discordBotTokenKentPersonalAutomation',
		packageId: 'pkg-1',
		kodyId: 'discord-gateway',
	})
	expect(mockModule.loadPackageManifestBySourceId).not.toHaveBeenCalled()
})
