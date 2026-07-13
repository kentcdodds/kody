import { expect, test, vi } from 'vitest'
import {
	consoleError,
	consoleWarn,
	silenceExpectedConsoleErrors,
} from '#worker/test-support/console-spies.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

function mockPackageServiceNamespace(): DurableObjectNamespace {
	return {
		idFromName(name: string) {
			return { toString: () => name } as DurableObjectId
		},
		get(id: DurableObjectId) {
			return {
				fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }))),
				id,
			} as unknown as DurableObjectStub
		},
	} as DurableObjectNamespace
}

const mockModule = vi.hoisted(() => ({
	buildPackageSearchProjection: vi.fn(),
	buildSavedPackageEmbedText: vi.fn(),
	buildPublishedPackageArtifacts: vi.fn(),
	refreshPackageRetrieverManifestCache: vi.fn(),
	removePackageRetrieverManifestCacheEntries: vi.fn(),
	deleteJobRow: vi.fn(),
	deleteEntitySource: vi.fn(),
	deleteSavedPackage: vi.fn(),
	deleteSavedPackageVector: vi.fn(),
	getSavedPackageById: vi.fn(),
	insertSavedPackage: vi.fn(),
	listSavedPackageServices: vi.fn(),
	listJobRowsByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	packageServiceRpc: vi.fn(),
	syncJobManagerAlarm: vi.fn(),
	syncPackageJobsForPackage: vi.fn(),
	updateSavedPackage: vi.fn(),
	upsertSavedPackageVector: vi.fn(),
	cleanupArtifactReposForPackage: vi.fn(),
	deleteAllPackageScopedSecrets: vi.fn(),
	removeAllSecretApprovalsForPackage: vi.fn(),
}))

vi.mock('./manifest.ts', () => ({
	buildPackageSearchProjection: (...args: Array<unknown>) =>
		mockModule.buildPackageSearchProjection(...args),
}))

vi.mock('./embed.ts', () => ({
	buildSavedPackageEmbedText: (...args: Array<unknown>) =>
		mockModule.buildSavedPackageEmbedText(...args),
}))

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	rebuildPublishedPackageArtifacts: (...args: Array<unknown>) =>
		mockModule.buildPublishedPackageArtifacts(...args),
}))

vi.mock('#worker/package-runtime/module-graph.ts', () => ({
	buildKodyAppBundle: vi.fn(),
	buildKodyModuleBundle: vi.fn(),
}))

vi.mock('#worker/package-runtime/package-service.ts', () => ({
	listSavedPackageServices: (...args: Array<unknown>) =>
		mockModule.listSavedPackageServices(...args),
	packageServiceRpc: (...args: Array<unknown>) =>
		mockModule.packageServiceRpc(...args),
}))

vi.mock('#worker/package-retrievers/manifest-cache.ts', () => ({
	refreshPackageRetrieverManifestCache: (...args: Array<unknown>) =>
		mockModule.refreshPackageRetrieverManifestCache(...args),
	removePackageRetrieverManifestCacheEntries: (...args: Array<unknown>) =>
		mockModule.removePackageRetrieverManifestCacheEntries(...args),
}))

vi.mock('./repo.ts', () => ({
	deleteSavedPackage: (...args: Array<unknown>) =>
		mockModule.deleteSavedPackage(...args),
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	insertSavedPackage: (...args: Array<unknown>) =>
		mockModule.insertSavedPackage(...args),
	updateSavedPackage: (...args: Array<unknown>) =>
		mockModule.updateSavedPackage(...args),
}))

vi.mock('./source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageManifestBySourceId(...args),
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('./vectorize.ts', () => ({
	deleteSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.deleteSavedPackageVector(...args),
	upsertSavedPackageVector: (...args: Array<unknown>) =>
		mockModule.upsertSavedPackageVector(...args),
}))

vi.mock('#worker/jobs/repo.ts', () => ({
	deleteJobRow: (...args: Array<unknown>) => mockModule.deleteJobRow(...args),
	listJobRowsByUserId: (...args: Array<unknown>) =>
		mockModule.listJobRowsByUserId(...args),
}))

vi.mock('#worker/jobs/manager-client.ts', () => ({
	syncJobManagerAlarm: (...args: Array<unknown>) =>
		mockModule.syncJobManagerAlarm(...args),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	deleteAllPackageScopedSecrets: (...args: Array<unknown>) =>
		mockModule.deleteAllPackageScopedSecrets(...args),
	removeAllSecretApprovalsForPackage: (...args: Array<unknown>) =>
		mockModule.removeAllSecretApprovalsForPackage(...args),
}))

vi.mock('#worker/jobs/service.ts', () => ({
	syncPackageJobsForPackage: (...args: Array<unknown>) =>
		mockModule.syncPackageJobsForPackage(...args),
}))

vi.mock('#worker/repo/artifact-repo-cleanup.ts', () => ({
	cleanupArtifactReposForPackage: (...args: Array<unknown>) =>
		mockModule.cleanupArtifactReposForPackage(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	deleteEntitySource: (...args: Array<unknown>) =>
		mockModule.deleteEntitySource(...args),
}))

const { deleteSavedPackageProjection, refreshSavedPackageProjection } =
	await import('./service.ts')

function createEnv() {
	return {
		APP_DB: {},
		PACKAGE_SERVICE_INSTANCE: mockPackageServiceNamespace(),
	} as Env
}

function createProjection() {
	return {
		name: '@kentcdodds/shade-automation',
		kodyId: 'shade-automation',
		description: 'Shade automation package',
		tags: ['home', 'shades'],
		searchText: 'shade automation',
		hasApp: false,
		hidden: false,
	}
}

function setupDefaultMocks() {
	mockModule.buildPackageSearchProjection.mockReturnValue(createProjection())
	mockModule.buildSavedPackageEmbedText.mockReturnValue('saved package embed')
	mockModule.upsertSavedPackageVector.mockResolvedValue(undefined)
	mockModule.buildPublishedPackageArtifacts.mockResolvedValue(undefined)
	mockModule.syncPackageJobsForPackage.mockResolvedValue(undefined)
	mockModule.syncJobManagerAlarm.mockResolvedValue(undefined)
	mockModule.refreshPackageRetrieverManifestCache.mockResolvedValue(undefined)
	mockModule.removePackageRetrieverManifestCacheEntries.mockResolvedValue(
		undefined,
	)
	mockModule.updateSavedPackage.mockResolvedValue(undefined)
	mockModule.insertSavedPackage.mockResolvedValue(undefined)
	mockModule.deleteEntitySource.mockResolvedValue(undefined)
	mockModule.deleteSavedPackage.mockResolvedValue(undefined)
	mockModule.deleteSavedPackageVector.mockResolvedValue(undefined)
	mockModule.deleteJobRow.mockResolvedValue(undefined)
	mockModule.cleanupArtifactReposForPackage.mockResolvedValue(0)
	mockModule.listSavedPackageServices.mockResolvedValue({
		savedPackage: {
			id: 'package-1',
			kodyId: 'shade-automation',
		},
		services: [],
	})
	mockModule.packageServiceRpc.mockReturnValue({
		start: vi.fn().mockResolvedValue({ ok: true }),
		stop: vi.fn().mockResolvedValue({ ok: true }),
	})
}

test('refreshSavedPackageProjection resyncs the job manager after syncing package jobs', async () => {
	setupDefaultMocks()
	const env = createEnv()
	const manifest = {
		name: '@kentcdodds/shade-automation',
		kody: {
			id: 'shade-automation',
			description: 'Shade automation package',
			tags: ['home', 'shades'],
			searchText: 'shade automation',
			services: {
				'realtime-supervisor': {
					entry: './src/services/realtime-supervisor.ts',
					autoStart: true,
				},
			},
			jobs: {
				'event-runner': {
					entry: './src/jobs/event-runner.ts',
					schedule: { type: 'interval', every: '1m' },
					timezone: 'America/Denver',
					enabled: true,
				},
			},
		},
	}
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest,
		files: { 'package.json': '{}' },
	})
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/shade-automation',
		kodyId: 'shade-automation',
		description: 'Old description',
		tags: ['home'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
	})

	await refreshSavedPackageProjection({
		env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		packageId: 'package-1',
		sourceId: 'source-1',
	})

	expect(mockModule.syncPackageJobsForPackage).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		packageId: 'package-1',
		sourceId: 'source-1',
		manifest,
	})
	expect(mockModule.buildPublishedPackageArtifacts).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		source: undefined,
		savedPackage: expect.objectContaining({
			id: 'package-1',
			userId: 'user-1',
			name: '@kentcdodds/shade-automation',
			kodyId: 'shade-automation',
			description: 'Shade automation package',
			tags: ['home', 'shades'],
			searchText: 'shade automation',
			sourceId: 'source-1',
			hasApp: false,
			hidden: false,
			createdAt: '2026-04-20T00:00:00.000Z',
		}),
		manifest,
		buildAppBundle: expect.any(Function),
		buildModuleBundle: expect.any(Function),
		buildImportableModuleBundle: expect.any(Function),
	})
	expect(mockModule.refreshPackageRetrieverManifestCache).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		source: undefined,
		savedPackage: expect.objectContaining({
			id: 'package-1',
			kodyId: 'shade-automation',
			sourceId: 'source-1',
		}),
		manifest,
	})
	const savedPackageArg = mockModule.buildPublishedPackageArtifacts.mock
		.calls[0]?.[0]?.savedPackage as { updatedAt: string } | undefined
	expect(savedPackageArg?.updatedAt).toMatch(
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
	)
	expect(savedPackageArg?.updatedAt).not.toBe('2026-04-20T00:00:00.000Z')
	expect(mockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
	})
	expect(mockModule.getSavedPackageById).toHaveBeenCalledTimes(1)
	expect(
		mockModule.syncJobManagerAlarm.mock.invocationCallOrder[0],
	).toBeGreaterThan(
		mockModule.syncPackageJobsForPackage.mock.invocationCallOrder[0],
	)
})

test('refreshSavedPackageProjection omits files when artifact rebuild is skipped', async () => {
	setupDefaultMocks()
	const env = createEnv()
	const manifest = {
		name: '@kentcdodds/shade-automation',
		kody: {
			id: 'shade-automation',
			description: 'Shade automation package',
		},
	}
	mockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			entity_id: 'package-1',
			entity_kind: 'package',
		},
		manifest,
	})
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/shade-automation',
		kodyId: 'shade-automation',
		description: 'Shade automation package',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
	})

	const refreshed = await refreshSavedPackageProjection({
		env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		packageId: 'package-1',
		sourceId: 'source-1',
		rebuildArtifacts: false,
	})

	expect(refreshed).not.toHaveProperty('files')
	expect(mockModule.loadPackageSourceBySourceId).not.toHaveBeenCalled()
	expect(mockModule.buildPublishedPackageArtifacts).not.toHaveBeenCalled()
})

test('refreshSavedPackageProjection continues best-effort cleanup when dependent steps fail', async () => {
	consoleError.mockImplementation(() => {})
	setupDefaultMocks()
	const manifest = {
		name: '@kentcdodds/shade-automation',
		kody: {
			id: 'shade-automation',
			description: 'Shade automation package',
			tags: ['home', 'shades'],
			searchText: 'shade automation',
			services: {
				'realtime-supervisor': {
					entry: './src/services/realtime-supervisor.ts',
					autoStart: true,
				},
			},
		},
	}
	const savedPackage = {
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/shade-automation',
		kodyId: 'shade-automation',
		description: 'Old description',
		tags: ['home'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
	}
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest,
		files: { 'package.json': '{}' },
	})
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage)

	mockModule.refreshPackageRetrieverManifestCache.mockRejectedValue(
		new Error('kv unavailable'),
	)
	const envAfterRetrieverFailure = createEnv()
	await refreshSavedPackageProjection({
		env: envAfterRetrieverFailure,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		packageId: 'package-1',
		sourceId: 'source-1',
	})
	expect(mockModule.syncPackageJobsForPackage).toHaveBeenCalledWith({
		env: envAfterRetrieverFailure,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		packageId: 'package-1',
		sourceId: 'source-1',
		manifest,
	})
	expect(mockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env: envAfterRetrieverFailure,
		userId: 'user-1',
	})
	// The swallowed retriever-cache failure is still logged for operators.
	expect(consoleError).toHaveBeenCalledTimes(1)

	setupDefaultMocks()
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest,
		files: { 'package.json': '{}' },
	})
	mockModule.getSavedPackageById.mockResolvedValue(savedPackage)
	mockModule.packageServiceRpc.mockReturnValue({
		start: vi.fn().mockRejectedValue(new Error('service start failed')),
	})
	const envAfterServiceFailure = {
		APP_DB: {},
		PACKAGE_SERVICE_INSTANCE: {
			idFromName(name: string) {
				return name as unknown as DurableObjectId
			},
			get() {
				return {} as DurableObjectStub
			},
		},
	} as Env
	await refreshSavedPackageProjection({
		env: envAfterServiceFailure,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		packageId: 'package-1',
		sourceId: 'source-1',
	})
	expect(mockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env: envAfterServiceFailure,
		userId: 'user-1',
	})
})

test('deleteSavedPackageProjection resyncs the job manager after removing package jobs', async () => {
	setupDefaultMocks()
	const env = createEnv()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
	})
	mockModule.listSavedPackageServices.mockResolvedValue({
		savedPackage: {
			id: 'package-1',
			kodyId: 'shade-automation',
		},
		services: [
			{
				name: 'realtime-supervisor',
				entry: './src/services/realtime-supervisor.ts',
				autoStart: true,
				mode: 'persistent',
				timeoutMs: null,
			},
		],
	})
	mockModule.listJobRowsByUserId.mockResolvedValue([
		{ id: 'job-1', source_id: 'source-1' },
		{ id: 'job-2', source_id: 'source-other' },
	])

	await deleteSavedPackageProjection({
		env,
		userId: 'user-1',
		packageId: 'package-1',
	})

	expect(mockModule.cleanupArtifactReposForPackage).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		sourceId: 'source-1',
	})
	expect(mockModule.deleteEntitySource).toHaveBeenCalledWith(
		{},
		{
			id: 'source-1',
			userId: 'user-1',
		},
	)
	expect(
		mockModule.deleteEntitySource.mock.invocationCallOrder[0],
	).toBeGreaterThan(
		mockModule.cleanupArtifactReposForPackage.mock.invocationCallOrder[0],
	)
	expect(mockModule.packageServiceRpc).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		packageId: 'package-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
		baseUrl: 'https://package-service.invalid',
		serviceName: 'realtime-supervisor',
	})
	expect(mockModule.deleteJobRow).toHaveBeenCalledTimes(1)
	expect(mockModule.deleteJobRow).toHaveBeenCalledWith({}, 'user-1', 'job-1')
	expect(mockModule.deleteAllPackageScopedSecrets).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		packageId: 'package-1',
	})
	expect(mockModule.removeAllSecretApprovalsForPackage).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		packageId: 'package-1',
	})
	expect(mockModule.deleteSavedPackage).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			packageId: 'package-1',
		},
	)
	expect(
		mockModule.removePackageRetrieverManifestCacheEntries,
	).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		packageId: 'package-1',
	})
	expect(mockModule.deleteSavedPackageVector).toHaveBeenCalledWith(
		env,
		'package-1',
	)
	expect(mockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
	})
	expect(
		mockModule.syncJobManagerAlarm.mock.invocationCallOrder[0],
	).toBeGreaterThan(mockModule.deleteSavedPackage.mock.invocationCallOrder[0])
})

test('deleteSavedPackageProjection continues best-effort cleanup when dependent steps fail', async () => {
	silenceExpectedConsoleErrors([
		/"message":"package retriever projection update failed"/,
	])
	consoleWarn.mockImplementation(() => {})
	setupDefaultMocks()
	const env = createEnv()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
	})
	mockModule.listJobRowsByUserId.mockResolvedValue([])
	mockModule.deleteEntitySource.mockRejectedValueOnce(
		new Error('d1 unavailable'),
	)
	await deleteSavedPackageProjection({
		env,
		userId: 'user-1',
		packageId: 'package-1',
	})
	expect(mockModule.deleteSavedPackage).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			packageId: 'package-1',
		},
	)
	expect(mockModule.deleteSavedPackageVector).toHaveBeenCalledWith(
		env,
		'package-1',
	)
	expect(mockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
	})
	// The swallowed entity source cleanup failure is still logged.
	expect(consoleWarn).toHaveBeenCalledTimes(1)

	setupDefaultMocks()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
	})
	mockModule.listJobRowsByUserId.mockResolvedValue([])
	mockModule.removePackageRetrieverManifestCacheEntries.mockRejectedValue(
		new Error('kv unavailable'),
	)
	await deleteSavedPackageProjection({
		env,
		userId: 'user-1',
		packageId: 'package-1',
	})
	expect(mockModule.deleteSavedPackageVector).toHaveBeenCalledWith(
		env,
		'package-1',
	)
	expect(mockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
	})

	setupDefaultMocks()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		kodyId: 'shade-automation',
		sourceId: 'source-1',
	})
	mockModule.listSavedPackageServices.mockResolvedValue({
		savedPackage: {
			id: 'package-1',
			kodyId: 'shade-automation',
		},
		services: [
			{
				name: 'realtime-supervisor',
				entry: 'services/realtime-supervisor.ts',
				autoStart: true,
				mode: 'persistent',
				timeoutMs: null,
			},
		],
	})
	mockModule.listJobRowsByUserId.mockResolvedValue([
		{ id: 'job-1', source_id: 'source-1' },
	])
	mockModule.packageServiceRpc.mockImplementation(() => {
		throw new Error('stub unavailable')
	})
	mockModule.deleteSavedPackage.mockClear()
	mockModule.deleteSavedPackageVector.mockClear()
	mockModule.syncJobManagerAlarm.mockClear()
	await expect(
		deleteSavedPackageProjection({
			env,
			userId: 'user-1',
			packageId: 'package-1',
		}),
	).rejects.toThrow('stub unavailable')
	expect(mockModule.deleteJobRow).not.toHaveBeenCalled()
	expect(mockModule.deleteSavedPackage).not.toHaveBeenCalled()
	expect(mockModule.deleteSavedPackageVector).not.toHaveBeenCalled()
	expect(mockModule.syncJobManagerAlarm).not.toHaveBeenCalled()
})

test('deleteSavedPackageProjection cleans secrets when package projection is missing', async () => {
	setupDefaultMocks()
	const env = createEnv()
	mockModule.getSavedPackageById.mockResolvedValue(null)

	await deleteSavedPackageProjection({
		env,
		userId: 'user-1',
		packageId: 'missing-package',
	})

	expect(mockModule.deleteAllPackageScopedSecrets).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		packageId: 'missing-package',
	})
	expect(mockModule.removeAllSecretApprovalsForPackage).toHaveBeenCalledWith({
		env,
		userId: 'user-1',
		packageId: 'missing-package',
	})
})

function createEntitlementsDatabase(input: {
	users?: Array<{ email: string; plan: string | null }>
	savedPackageCount?: number
	userId: string
}) {
	const users = input.users ?? []
	const savedPackageCount = input.savedPackageCount ?? 0

	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (query.includes('SELECT plan FROM users')) {
								const user = users.find((row) => row.email === params[0])
								return (user ? { plan: user.plan } : null) as T | null
							}
							if (
								query.includes('SELECT COUNT(*) AS count FROM saved_packages')
							) {
								return { count: savedPackageCount } as T
							}
							const storageByteTables = [
								'email_attachments',
								'email_messages',
								'value_entries',
								'secret_entries',
								'mcp_memories',
								'saved_packages',
								'entity_sources',
								'jobs',
								'repo_sessions',
								'package_invocations',
								'package_runtime_runs',
								'package_runtime_logs',
								'published_bundle_artifacts',
							]
							if (
								storageByteTables.some((table) =>
									query.includes(`FROM ${table}`),
								)
							) {
								return { count: 0 } as T
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('refreshSavedPackageProjection enforces the saved packages entitlement on insert', async () => {
	setupDefaultMocks()
	const email = 'planned@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.personal.maxSavedPackages
	if (limit === null)
		throw new Error('Expected a numeric personal package limit.')
	const env = {
		APP_DB: createEntitlementsDatabase({
			users: [{ email, plan: 'personal' }],
			savedPackageCount: limit,
			userId,
		}),
		PACKAGE_SERVICE_INSTANCE: mockPackageServiceNamespace(),
	} as Env
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest: {
			name: '@kentcdodds/shade-automation',
			kody: {
				id: 'shade-automation',
				description: 'Shade automation package',
			},
		},
		files: { 'package.json': '{}' },
	})
	mockModule.getSavedPackageById.mockResolvedValue(null)

	const error = await refreshSavedPackageProjection({
		env,
		baseUrl: 'https://heykody.dev',
		userId,
		userEmail: email,
		packageId: 'package-new',
		sourceId: 'source-new',
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)

	if (!isEntitlementLimitError(error)) {
		throw new Error(
			'Expected an EntitlementLimitError from refreshSavedPackageProjection.',
		)
	}
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'saved_packages',
		plan: 'personal',
		limit,
		current: limit,
	})
	expect(mockModule.insertSavedPackage).not.toHaveBeenCalled()
})

test('refreshSavedPackageProjection preserves hidden across projection refresh', async () => {
	setupDefaultMocks()
	const env = createEnv()
	mockModule.buildPackageSearchProjection.mockReturnValue({
		...createProjection(),
		description: 'Updated description',
	})
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest: {
			name: '@kentcdodds/shade-automation',
			kody: {
				id: 'shade-automation',
				description: 'Updated description',
				tags: ['home'],
			},
		},
		files: { 'package.json': '{}' },
	})
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/shade-automation',
		kodyId: 'shade-automation',
		description: 'Old description',
		tags: ['home'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: true,
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
	})

	const refreshed = await refreshSavedPackageProjection({
		env,
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		packageId: 'package-1',
		sourceId: 'source-1',
	})

	expect(mockModule.updateSavedPackage).toHaveBeenCalled()
	const updateArg = mockModule.updateSavedPackage.mock.calls[0]?.[1] as Record<
		string,
		unknown
	>
	expect(updateArg).not.toHaveProperty('hidden')
	expect(updateArg).toMatchObject({
		userId: 'user-1',
		packageId: 'package-1',
		description: 'Updated description',
	})
	expect(refreshed.record.hidden).toBe(true)
	expect(refreshed.record.description).toBe('Updated description')
})

test('refreshSavedPackageProjection does not gate the update branch at the limit', async () => {
	setupDefaultMocks()
	const email = 'planned@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.personal.maxSavedPackages
	if (limit === null)
		throw new Error('Expected a numeric personal package limit.')
	const env = {
		APP_DB: createEntitlementsDatabase({
			users: [{ email, plan: 'personal' }],
			savedPackageCount: limit,
			userId,
		}),
		PACKAGE_SERVICE_INSTANCE: mockPackageServiceNamespace(),
	} as Env
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		manifest: {
			name: '@kentcdodds/shade-automation',
			kody: {
				id: 'shade-automation',
				description: 'Shade automation package',
			},
		},
		files: { 'package.json': '{}' },
	})
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId,
		name: '@kentcdodds/shade-automation',
		kodyId: 'shade-automation',
		description: 'Shade automation package',
		tags: ['home'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		createdAt: '2026-04-20T00:00:00.000Z',
		updatedAt: '2026-04-20T00:00:00.000Z',
	})

	await refreshSavedPackageProjection({
		env,
		baseUrl: 'https://heykody.dev',
		userId,
		userEmail: email,
		packageId: 'package-1',
		sourceId: 'source-1',
	})

	expect(mockModule.updateSavedPackage).toHaveBeenCalled()
	expect(mockModule.insertSavedPackage).not.toHaveBeenCalled()
})
