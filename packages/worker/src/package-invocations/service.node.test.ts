import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	createExecutePackageInvokeTools,
	createPackageRuntimeInvokeTools,
	createPackageEventTools,
	deliverPackageEvent,
	invokePackageExport,
	invokePackageSubscription,
} from './service.ts'
import { clearInvokeContractCachesForTests } from './invoke-contract-cache.ts'
import { maxStoredInvocationResponseJsonBytes } from './repo.ts'

const repoMockModule = vi.hoisted(() => {
	const loadPackageManifestBySourceId = vi.fn()
	return {
		getSavedPackageById: vi.fn(),
		getSavedPackageByKodyId: vi.fn(),
		listSavedPackagesByUserId: vi.fn(),
		loadPackageManifestBySourceId,
		// The invoke path loads the source row and manifest separately (see
		// loadInvokeManifestBySourceId); default to the same per-test data the
		// combined mock is configured with.
		loadPackageSourceRowForUser: vi.fn(
			async (input: { sourceId: string; userId: string }) =>
				(await loadPackageManifestBySourceId(input)).source,
		),
		loadPackageManifestForSource: vi.fn(
			async (input: { source: { id: string }; userId: string }) =>
				await loadPackageManifestBySourceId({
					...input,
					sourceId: input.source.id,
				}),
		),
		loadPackageSourceBySourceId: vi.fn(),
		getEntitySourceById: vi.fn(),
		loadPublishedBundleArtifactByIdentity: vi.fn(),
		persistPublishedBundleArtifact: vi.fn(),
		typecheckPackageEntrypointsFromSourceFiles: vi.fn(),
		runBundledModuleWithRegistry: vi.fn(),
		recordAgentPackageConversationUse: vi.fn(),
		recordSuccessfulPackageRun: vi.fn(),
		dispatchRunErrorSubscriptionEvents: vi.fn(),
	}
})

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		repoMockModule.getSavedPackageByKodyId(...args),
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		repoMockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageManifestBySourceId(...args),
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		repoMockModule.loadPackageSourceBySourceId(...args),
	loadPackageSourceRowForUser: (...args: Array<unknown>) =>
		repoMockModule.loadPackageSourceRowForUser(...args),
	loadPackageManifestForSource: (...args: Array<unknown>) =>
		repoMockModule.loadPackageManifestForSource(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (...args: Array<unknown>) =>
		repoMockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/package-runtime/published-bundle-artifacts.ts', () => ({
	loadPublishedBundleArtifactByIdentity: (...args: Array<unknown>) =>
		repoMockModule.loadPublishedBundleArtifactByIdentity(...args),
	persistPublishedBundleArtifact: (...args: Array<unknown>) =>
		repoMockModule.persistPublishedBundleArtifact(...args),
}))

vi.mock('#worker/repo/checks.ts', () => ({
	typecheckPackageEntrypointsFromSourceFiles: (...args: Array<unknown>) =>
		repoMockModule.typecheckPackageEntrypointsFromSourceFiles(...args),
}))

vi.mock('#mcp/run-kody-registry.ts', () => ({
	runBundledModuleWithRegistry: (...args: Array<unknown>) =>
		repoMockModule.runBundledModuleWithRegistry(...args),
}))

vi.mock('#worker/usage/agent-package-conversation-uses.ts', () => ({
	recordAgentPackageConversationUse: (...args: Array<unknown>) =>
		repoMockModule.recordAgentPackageConversationUse(...args),
}))

vi.mock('#worker/usage/activation.ts', () => ({
	recordSuccessfulPackageRun: (...args: Array<unknown>) =>
		repoMockModule.recordSuccessfulPackageRun(...args),
}))

vi.mock('#worker/run-records/package-subscriptions.ts', () => ({
	dispatchRunErrorSubscriptionEvents: (...args: Array<unknown>) =>
		repoMockModule.dispatchRunErrorSubscriptionEvents(...args),
}))

type FakeLedgerRow = {
	id: string
	tokenId: string
	packageId: string
	packageKodyId: string
	exportName: string
	idempotencyKey: string
	requestHash: string
	source: string | null
	topic: string | null
	status: 'in_progress' | 'completed' | 'failed'
	responseJson: string | null
	createdAt: string
	updatedAt: string
}

/**
 * In-memory stand-in for the RunLog Durable Object's package-invocation
 * ledger RPCs (the real DO semantics are covered by
 * run-records/invocation-ledger.workers.test.ts against the actual binding).
 */
function createFakeRunLog(options: { failClaim?: boolean } = {}) {
	const ledgerRows: Array<FakeLedgerRow> = []
	const runRows = new Map<string, Record<string, unknown>>()
	const jobObservability = new Map<
		string,
		{
			jobId: string
			lastRunAt: string | null
			lastRunStatus: 'success' | 'error' | null
			lastRunError: string | null
			lastDurationMs: number | null
			runCount: number
			successCount: number
			errorCount: number
			updatedAt: string
		}
	>()
	const packageRunSuccesses = new Map<
		string,
		{ packageId: string; successCount: number; updatedAt: string }
	>()
	const activationMilestones = new Map<
		string,
		{ milestone: string; reachedAt: string; packageId: string | null }
	>()
	const clone = <T>(value: T): T => structuredClone(value)
	const findByKey = (key: {
		tokenId: string
		packageId: string
		exportName: string
		idempotencyKey: string
	}) =>
		ledgerRows.find(
			(row) =>
				row.tokenId === key.tokenId &&
				row.packageId === key.packageId &&
				row.exportName === key.exportName &&
				row.idempotencyKey === key.idempotencyKey,
		) ?? null
	const rpc = {
		async claimPackageInvocation(input: {
			invocation: Omit<
				FakeLedgerRow,
				'status' | 'responseJson' | 'createdAt' | 'updatedAt'
			>
			staleBefore: string
			run: Record<string, unknown> | null
		}) {
			if (options.failClaim) throw new Error('RunLog unavailable')
			const now = new Date().toISOString()
			const existing = findByKey(input.invocation)
			if (existing) {
				const reclaimable =
					existing.status === 'in_progress' &&
					existing.requestHash === input.invocation.requestHash &&
					existing.updatedAt <= input.staleBefore
				if (!reclaimable) {
					return { outcome: 'existing' as const, record: clone(existing) }
				}
				existing.updatedAt = now
				if (input.run) {
					runRows.set(
						String(input.run['id']),
						clone({ ...input.run, invocationId: existing.id }),
					)
				}
				return {
					outcome: 'claimed' as const,
					invocationId: existing.id,
					claimUpdatedAt: now,
					reclaimed: true,
				}
			}
			ledgerRows.push({
				...clone(input.invocation),
				status: 'in_progress',
				responseJson: null,
				createdAt: now,
				updatedAt: now,
			})
			if (input.run) {
				runRows.set(
					String(input.run['id']),
					clone({ ...input.run, invocationId: input.invocation.id }),
				)
			}
			return {
				outcome: 'claimed' as const,
				invocationId: input.invocation.id,
				claimUpdatedAt: now,
				reclaimed: false,
			}
		},
		async getPackageInvocation(key: {
			tokenId: string
			packageId: string
			exportName: string
			idempotencyKey: string
		}) {
			const row = findByKey(key)
			return row ? clone(row) : null
		},
		async finishPackageInvocation(input: {
			invocationId: string
			claimUpdatedAt: string
			status: 'completed' | 'failed'
			responseJson: string | null
			run: Record<string, unknown> | null
			logs: Array<unknown>
		}) {
			const row =
				ledgerRows.find((candidate) => candidate.id === input.invocationId) ??
				null
			let ledgerUpdated = false
			if (
				row &&
				row.status === 'in_progress' &&
				row.updatedAt === input.claimUpdatedAt
			) {
				row.status = input.status
				row.responseJson = input.responseJson
				row.updatedAt = new Date().toISOString()
				ledgerUpdated = true
			}
			if (input.run) {
				const previous = runRows.get(String(input.run['id']))
				const previousStatus =
					previous && typeof previous['status'] === 'string'
						? String(previous['status'])
						: null
				runRows.set(String(input.run['id']), clone(input.run))
				// Mirror RunLog terminal side effects used by finish seeding:
				// activation increments and job observability for genuine new
				// terminal writes (replay of an already-terminal row is a no-op).
				const runStatus = String(input.run['status'] ?? '')
				const alreadyTerminal =
					previousStatus === 'success' || previousStatus === 'error'
				if (!alreadyTerminal && runStatus === 'success') {
					const packageId =
						typeof input.run['packageId'] === 'string'
							? input.run['packageId'].trim()
							: ''
					const surface =
						typeof input.run['surface'] === 'string'
							? input.run['surface']
							: null
					// Match RunLog: once global package_activated exists, counters
					// stop changing for every package.
					if (
						packageId &&
						surface !== 'webhook' &&
						surface !== 'app_fetch' &&
						!activationMilestones.has('package_activated')
					) {
						const reachedAt =
							typeof input.run['finishedAt'] === 'string'
								? input.run['finishedAt']
								: new Date().toISOString()
						const existing = packageRunSuccesses.get(packageId)
						const successCount = (existing?.successCount ?? 0) + 1
						packageRunSuccesses.set(packageId, {
							packageId,
							successCount,
							updatedAt: reachedAt,
						})
						if (!activationMilestones.has('package_run_succeeded')) {
							activationMilestones.set('package_run_succeeded', {
								milestone: 'package_run_succeeded',
								reachedAt,
								packageId,
							})
						}
						if (successCount >= 2) {
							activationMilestones.set('package_activated', {
								milestone: 'package_activated',
								reachedAt,
								packageId,
							})
						}
					}
				}
				if (
					!alreadyTerminal &&
					(runStatus === 'success' || runStatus === 'error')
				) {
					const jobId =
						typeof input.run['jobId'] === 'string'
							? input.run['jobId'].trim()
							: ''
					if (jobId) {
						const existing = jobObservability.get(jobId)
						const ranAt =
							typeof input.run['finishedAt'] === 'string'
								? input.run['finishedAt']
								: new Date().toISOString()
						const durationMs =
							typeof input.run['durationMs'] === 'number'
								? input.run['durationMs']
								: null
						const error =
							runStatus === 'error' &&
							typeof input.run['errorMessage'] === 'string'
								? input.run['errorMessage']
								: null
						jobObservability.set(jobId, {
							jobId,
							lastRunAt: ranAt,
							lastRunStatus: runStatus,
							lastRunError: error,
							lastDurationMs: durationMs,
							runCount: (existing?.runCount ?? 0) + 1,
							successCount:
								(existing?.successCount ?? 0) +
								(runStatus === 'success' ? 1 : 0),
							errorCount:
								(existing?.errorCount ?? 0) + (runStatus === 'error' ? 1 : 0),
							updatedAt: ranAt,
						})
					}
				}
			}
			return {
				ledgerUpdated,
				record: ledgerUpdated ? null : row ? clone(row) : null,
			}
		},
		async releasePackageInvocation(input: {
			invocationId: string
			claimUpdatedAt: string
			runId: string | null
		}) {
			const index = ledgerRows.findIndex(
				(candidate) => candidate.id === input.invocationId,
			)
			const row = index >= 0 ? ledgerRows[index] : null
			let released = false
			if (
				row &&
				row.status === 'in_progress' &&
				row.updatedAt === input.claimUpdatedAt
			) {
				ledgerRows.splice(index, 1)
				released = true
			}
			if (input.runId) {
				const run = runRows.get(input.runId)
				if (run && run['status'] === 'running') {
					runRows.delete(input.runId)
				}
			}
			return {
				released,
				record: released || !row ? null : clone(row),
			}
		},
		async getJobRunObservability(input: { jobId: string }) {
			const row = jobObservability.get(input.jobId)
			return row ? clone(row) : null
		},
	}
	return {
		namespace: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => rpc,
		},
		ledgerRows,
		runRows,
		corruptStoredResponses() {
			for (const row of ledgerRows) {
				row.responseJson = '{"status":200,"body":null}'
			}
		},
		seedStaleInvocation(idempotencyKey: string) {
			const completed = ledgerRows[0]
			if (!completed) throw new Error('Expected completed invocation seed.')
			const row: FakeLedgerRow = {
				...structuredClone(completed),
				id: crypto.randomUUID(),
				idempotencyKey,
				status: 'in_progress',
				responseJson: null,
				createdAt: '2026-01-01T00:00:00.000Z',
				updatedAt: '2026-01-01T00:00:00.000Z',
			}
			ledgerRows.push(row)
			return structuredClone(row)
		},
		seedFreshInvocation(idempotencyKey: string) {
			const completed = ledgerRows[0]
			if (!completed) throw new Error('Expected completed invocation seed.')
			const now = new Date().toISOString()
			ledgerRows.push({
				...structuredClone(completed),
				id: crypto.randomUUID(),
				idempotencyKey,
				status: 'in_progress',
				responseJson: null,
				createdAt: now,
				updatedAt: now,
			})
		},
		completeInvocation(idempotencyKey: string) {
			const row = ledgerRows.find(
				(candidate) => candidate.idempotencyKey === idempotencyKey,
			)
			const completed = ledgerRows[0]
			if (!row || !completed) throw new Error('Expected invocation rows.')
			row.status = 'completed'
			row.responseJson = completed.responseJson
			row.updatedAt = new Date().toISOString()
		},
	}
}

/**
 * Fake D1 that rejects EVERY `package_invocations` statement (the table is
 * dropped; the ledger lives in the RunLog DO) and every write. Keyed tests
 * passing against this is the proof that no D1 ledger read or write remains
 * anywhere on the invoke path.
 */
function createDatabase(options: { failClaim?: boolean } = {}) {
	const runLog = createFakeRunLog(options)
	const db = {
		prepare(query: string) {
			if (query.includes('package_invocations')) {
				throw new Error(
					`Unexpected D1 access to the dropped package_invocations table: ${query}`,
				)
			}
			return {
				bind() {
					return {
						async first<T = Record<string, unknown>>() {
							return null as T | null
						},
						async all<T = Record<string, unknown>>() {
							return { results: [] as Array<T>, success: true }
						},
						async run() {
							throw new Error(
								`Unexpected D1 write on the keyed invocation path: ${query}`,
							)
						},
					}
				},
			}
		},
		runLog,
	} as unknown as D1Database & {
		runLog: ReturnType<typeof createFakeRunLog>
	}
	return db
}

function createEnv(db: ReturnType<typeof createDatabase>) {
	return {
		APP_DB: db,
		RUN_LOG: db.runLog.namespace,
		BUNDLE_ARTIFACTS_KV: {
			get: async () => null,
			put: async () => undefined,
			delete: async () => undefined,
		},
	} as unknown as Env
}

function createToken(
	overrides: Partial<{
		packageIds: Array<string>
		packageKodyIds: Array<string>
		exportNames: Array<string>
		sources: Array<string>
		remoteConnectors: Array<{ instanceId: string }>
	}> = {},
) {
	return {
		tokenId: 'discord-gateway',
		userId: 'user-123',
		email: 'me@example.com',
		displayName: 'me',
		packageIds: overrides.packageIds,
		packageKodyIds: overrides.packageKodyIds ?? ['discord-gateway'],
		exportNames: overrides.exportNames ?? ['./dispatch-message-created'],
		sources: overrides.sources ?? ['discord-gateway'],
		remoteConnectors: overrides.remoteConnectors,
	} as const
}

function seedPackageResolution() {
	repoMockModule.getSavedPackageById.mockResolvedValue(null)
	repoMockModule.getSavedPackageByKodyId.mockResolvedValue({
		id: 'pkg-1',
		userId: 'user-123',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord gateway helpers',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hidden: false,
		isPrivate: false,
		createdAt: '2026-04-27T00:00:00.000Z',
		updatedAt: '2026-04-27T00:00:00.000Z',
	})
	repoMockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			user_id: 'user-123',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-27T00:00:00.000Z',
			updated_at: '2026-04-27T00:00:00.000Z',
		},
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway helpers',
				app: {
					entry: './src/app.ts',
				},
			},
		},
	})
	repoMockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			user_id: 'user-123',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-27T00:00:00.000Z',
			updated_at: '2026-04-27T00:00:00.000Z',
		},
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway helpers',
				app: {
					entry: './src/app.ts',
				},
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/discord-gateway',
				exports: {
					'./dispatch-message-created': './src/dispatch-message-created.ts',
				},
				kody: {
					id: 'discord-gateway',
					description: 'Discord gateway helpers',
					app: {
						entry: './src/app.ts',
					},
				},
			}),
			'src/dispatch-message-created.ts':
				'export default async function run(){ return { ok: true } }',
		},
	})
	repoMockModule.getEntitySourceById.mockResolvedValue({
		id: 'source-1',
		user_id: 'user-123',
		entity_kind: 'package',
		entity_id: 'pkg-1',
		repo_id: 'repo-1',
		published_commit: 'commit-1',
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-04-27T00:00:00.000Z',
		updated_at: '2026-04-27T00:00:00.000Z',
	})
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: {
			id: 'artifact-1',
		},
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: './dispatch-message-created',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			entryPoint: 'src/dispatch-message-created.ts',
			mainModule: 'dist/index.js',
			modules: {
				'dist/index.js':
					'export default async function run(){ return { ok: true } }',
			},
			dependencies: [],
			packageContext: {
				packageId: 'pkg-1',
				kodyId: 'discord-gateway',
				sourceId: 'source-1',
			},
			serviceContext: null,
			createdAt: '2026-04-27T00:00:00.000Z',
		},
	})
	repoMockModule.typecheckPackageEntrypointsFromSourceFiles.mockResolvedValue({
		ok: true,
		message: 'ok',
	})
	repoMockModule.persistPublishedBundleArtifact.mockResolvedValue('kv:key')
}

function createSavedPackage(input: {
	id: string
	sourceId: string
	name: string
	kodyId: string
	description?: string
}) {
	return {
		id: input.id,
		userId: 'user-123',
		name: input.name,
		kodyId: input.kodyId,
		description: input.description ?? `${input.kodyId} package`,
		tags: [],
		searchText: null,
		sourceId: input.sourceId,
		hasApp: false,
		hidden: false,
		isPrivate: false,
		createdAt: '2026-05-10T00:00:00.000Z',
		updatedAt: '2026-05-10T00:00:00.000Z',
	}
}

function createSource(input: { id: string; entityId: string; commit: string }) {
	return {
		id: input.id,
		user_id: 'user-123',
		entity_kind: 'package',
		entity_id: input.entityId,
		repo_id: `repo-${input.id}`,
		published_commit: input.commit,
		indexed_commit: null,
		manifest_path: 'package.json',
		source_root: '/',
		created_at: '2026-05-10T00:00:00.000Z',
		updated_at: '2026-05-10T00:00:00.000Z',
	}
}

function createManifest(input: {
	name: string
	kodyId: string
	exportName: string
	entryPoint: string
	emits?: Record<
		string,
		{ description: string; payloadSchema?: Record<string, unknown> }
	>
	subscriptions?: Record<
		string,
		{
			handler: string
			description?: string
			filters?: Record<string, unknown>
		}
	>
}) {
	return {
		name: input.name,
		exports: {
			[input.exportName]: input.entryPoint,
		},
		kody: {
			id: input.kodyId,
			description: `${input.kodyId} package`,
			emits: input.emits,
			subscriptions: input.subscriptions,
		},
	}
}

function createModuleArtifact(input: {
	sourceId: string
	publishedCommit: string
	artifactName: string
	entryPoint: string
	mainModule: string
	packageContext: {
		packageId: string
		kodyId: string
		sourceId: string
	}
}) {
	return {
		row: {
			id: `artifact-${input.packageContext.packageId}`,
		},
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: input.artifactName,
			sourceId: input.sourceId,
			publishedCommit: input.publishedCommit,
			entryPoint: input.entryPoint,
			mainModule: input.mainModule,
			modules: {
				[input.mainModule]:
					'export default async function run(){ return { ok: true } }',
			},
			dependencies: [],
			packageContext: input.packageContext,
			serviceContext: null,
			createdAt: '2026-05-10T00:00:00.000Z',
		},
	}
}

function seedRuntimeDispatchPackages() {
	const gateway = createSavedPackage({
		id: 'pkg-gateway',
		sourceId: 'source-gateway',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
	})
	const subscriber = createSavedPackage({
		id: 'pkg-subscriber',
		sourceId: 'source-subscriber',
		name: '@kentcdodds/discord-general-chat',
		kodyId: 'discord-general-chat',
	})
	const sources = new Map([
		[
			'source-gateway',
			createSource({
				id: 'source-gateway',
				entityId: 'pkg-gateway',
				commit: 'gateway-commit-1',
			}),
		],
		[
			'source-subscriber',
			createSource({
				id: 'source-subscriber',
				entityId: 'pkg-subscriber',
				commit: 'subscriber-commit-1',
			}),
		],
	])
	const manifests = new Map([
		[
			'source-gateway',
			createManifest({
				name: gateway.name,
				kodyId: gateway.kodyId,
				exportName: './dispatch-message-created',
				entryPoint: './src/dispatch-message-created.ts',
				emits: {
					'@kentcdodds/discord.message.created': {
						description: 'A Discord message was created.',
					},
				},
			}),
		],
		[
			'source-subscriber',
			createManifest({
				name: subscriber.name,
				kodyId: subscriber.kodyId,
				exportName: './handle-discord-message-created',
				entryPoint: './src/handle-discord-message-created.ts',
				subscriptions: {
					'@kentcdodds/discord.message.created': {
						handler: './src/handle-discord-message-created.ts',
						description: 'Handle Discord message events.',
					},
				},
			}),
		],
	])
	const sourceFiles = new Map([
		[
			'source-gateway',
			{
				'package.json': JSON.stringify(manifests.get('source-gateway')),
				'src/dispatch-message-created.ts':
					'export default async function dispatchMessageCreated(input: Record<string, unknown>) { return input }',
			},
		],
		[
			'source-subscriber',
			{
				'package.json': JSON.stringify(manifests.get('source-subscriber')),
				'src/handle-discord-message-created.ts': `/**
 * Handle a Discord message-created event.
 */
export default async function handleDiscordMessageCreated(input: { event: { id: string }, dryRun?: boolean }): Promise<{ handled: boolean }> {
	return { handled: true }
}`,
			},
		],
	])
	repoMockModule.getSavedPackageById.mockResolvedValue(null)
	repoMockModule.getSavedPackageByKodyId.mockImplementation(
		async (_db: unknown, input: { userId: string; kodyId: string }) => {
			expect(input.userId).toBe('user-123')
			if (input.kodyId === gateway.kodyId) return gateway
			if (input.kodyId === subscriber.kodyId) return subscriber
			return null
		},
	)
	repoMockModule.listSavedPackagesByUserId.mockImplementation(
		async (_db: unknown, input: { userId: string }) => {
			expect(input.userId).toBe('user-123')
			return [gateway, subscriber]
		},
	)
	repoMockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => ({
			source: sources.get(input.sourceId),
			manifest: manifests.get(input.sourceId),
		}),
	)
	repoMockModule.loadPackageSourceBySourceId.mockImplementation(
		async (input: { sourceId: string }) => ({
			source: sources.get(input.sourceId),
			manifest: manifests.get(input.sourceId),
			files: sourceFiles.get(input.sourceId) ?? {},
		}),
	)
	repoMockModule.getEntitySourceById.mockImplementation(
		async (_db: unknown, sourceId: string) => sources.get(sourceId) ?? null,
	)
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockImplementation(
		async (input: {
			sourceId: string
			artifactName: string
			entryPoint: string
		}) => {
			if (input.sourceId === 'source-gateway') {
				return createModuleArtifact({
					sourceId: 'source-gateway',
					publishedCommit: 'gateway-commit-1',
					artifactName: './dispatch-message-created',
					entryPoint: 'src/dispatch-message-created.ts',
					mainModule: 'dist/gateway.js',
					packageContext: {
						packageId: gateway.id,
						kodyId: gateway.kodyId,
						sourceId: gateway.sourceId,
					},
				})
			}
			if (input.sourceId === 'source-subscriber') {
				return createModuleArtifact({
					sourceId: 'source-subscriber',
					publishedCommit: 'subscriber-commit-1',
					artifactName:
						input.artifactName ===
						'subscription:@kentcdodds/discord.message.created'
							? 'subscription:@kentcdodds/discord.message.created'
							: './handle-discord-message-created',
					entryPoint: 'src/handle-discord-message-created.ts',
					mainModule: 'dist/subscriber.js',
					packageContext: {
						packageId: subscriber.id,
						kodyId: subscriber.kodyId,
						sourceId: subscriber.sourceId,
					},
				})
			}
			return null
		},
	)
	return { gateway, manifests, sourceFiles, sources, subscriber }
}

function createRuntimeDispatchTools(db: D1Database) {
	return createPackageRuntimeInvokeTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext: createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId: 'user-123',
				email: 'me@example.com',
				displayName: 'Me',
			},
		}),
		packageContext: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
		},
		parentRunRecord: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
			surface: 'export',
			name: './dispatch-message-created',
			idempotencyKey: 'message-1',
		},
		packageInvokeDepth: 0,
	})
}

function createRuntimeEventTools(
	db: D1Database,
	options: {
		envOverrides?: Record<string, unknown>
		packageInvokeDepth?: number
	} = {},
) {
	return createPackageEventTools({
		env: {
			...(createEnv(db) as unknown as Record<string, unknown>),
			...options.envOverrides,
		} as unknown as Env,
		baseUrl: 'https://kody.dev',
		callerContext: createMcpCallerContext({
			baseUrl: 'https://kody.dev',
			user: {
				userId: 'user-123',
				email: 'me@example.com',
				displayName: 'Me',
			},
		}),
		packageContext: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
		},
		parentRunRecord: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
			surface: 'export',
			name: './dispatch-message-created',
			idempotencyKey: 'message-1',
		},
		packageInvokeDepth: options.packageInvokeDepth ?? 0,
	})
}

test('invokePackageExport executes a scoped package export successfully', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})

	const response = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			remoteConnectors: [{ instanceId: 'home' }],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-1',
			topic: 'discord.message.created',
		},
	})

	expect(response.status).toBe(200)
	expect(response.body).toMatchObject({
		ok: true,
		exportName: './dispatch-message-created',
		idempotency: {
			key: 'evt-1',
			replayed: false,
		},
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			remoteConnectors: [{ instanceId: 'home' }],
		}),
		expect.anything(),
		expect.anything(),
		expect.anything(),
	)
	const runOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[4]
	expect(runOptions).toMatchObject({
		packageContext: {
			packageId: 'pkg-1',
			kodyId: 'discord-gateway',
			sourceId: 'source-1',
		},
	})
	expect(
		(runOptions as { packageInvokeTools?: { invoke?: unknown } })
			.packageInvokeTools?.invoke,
	).toEqual(expect.any(Function))
})

test('package runtime can dynamically invoke the current published export from another package', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	let subscriberVersion = 'v1'
	repoMockModule.runBundledModuleWithRegistry.mockImplementation(
		async (
			_env: unknown,
			_callerContext: unknown,
			bundle: { mainModule: string },
			params: { event?: { id?: string } } | undefined,
			options: {
				packageInvokeTools?: {
					invoke(input: Record<string, unknown>): Promise<unknown>
				}
			},
		) => {
			if (bundle.mainModule === 'dist/gateway.js') {
				return {
					result: await options.packageInvokeTools?.invoke({
						kodyId: 'discord-general-chat',
						exportName: './handle-discord-message-created',
						params: { event: params?.event },
					}),
					logs: [],
				}
			}
			if (bundle.mainModule === 'dist/subscriber.js') {
				return {
					result: {
						version: subscriberVersion,
						eventId: params?.event?.id,
					},
					logs: [],
				}
			}
			throw new Error(`Unexpected bundle ${bundle.mainModule}`)
		},
	)

	const first = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: {
			...createToken(),
			packageKodyIds: ['discord-gateway'],
			exportNames: ['./dispatch-message-created'],
		},
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: './dispatch-message-created',
			params: { event: { id: 'message-1' } },
			idempotencyKey: 'gateway-message-1',
		},
	})
	subscriberVersion = 'v2'
	const second = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: {
			...createToken(),
			packageKodyIds: ['discord-gateway'],
			exportNames: ['./dispatch-message-created'],
		},
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: './dispatch-message-created',
			params: { event: { id: 'message-2' } },
			idempotencyKey: 'gateway-message-2',
		},
	})

	expect(first.status).toBe(200)
	expect(first.body).toMatchObject({
		ok: true,
		result: {
			version: 'v1',
			eventId: 'message-1',
		},
	})
	expect(second.status).toBe(200)
	expect(second.body).toMatchObject({
		ok: true,
		result: {
			version: 'v2',
			eventId: 'message-2',
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(4)
	const firstGatewayRunOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[4]
	const firstSubscriberRunOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[1]?.[4]
	expect(
		(firstGatewayRunOptions as { packageInvokeTools?: { invoke?: unknown } })
			.packageInvokeTools?.invoke,
	).toEqual(expect.any(Function))
	expect(firstSubscriberRunOptions).toMatchObject({
		packageContext: {
			packageId: 'pkg-subscriber',
			kodyId: 'discord-general-chat',
			sourceId: 'source-subscriber',
		},
	})
	expect(
		(firstSubscriberRunOptions as { packageInvokeTools?: { invoke?: unknown } })
			.packageInvokeTools?.invoke,
	).toEqual(expect.any(Function))
})

test('key-less packages.invoke takes the lean path: re-executes on repeat and writes no ledger row', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	let executionCount = 0
	repoMockModule.runBundledModuleWithRegistry.mockImplementation(async () => {
		executionCount += 1
		return { result: { handled: true, executionCount }, logs: [] }
	})
	const tools = createRuntimeDispatchTools(db)

	const request = {
		kodyId: 'discord-general-chat',
		exportName: './handle-discord-message-created',
		params: { event: { id: 'message-1' } },
	}
	const first = await tools.invoke(request)
	const second = await tools.invoke(request)

	// Ephemeral semantics: identical key-less calls execute independently.
	expect(first).toEqual({ handled: true, executionCount: 1 })
	expect(second).toEqual({ handled: true, executionCount: 2 })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(2)
	const runOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[4]
	// No ledger row exists, so the run record carries neither an invocation id
	// nor an idempotency key (which downgrades it to on-failure persistence).
	expect(runOptions).toMatchObject({
		runRecord: {
			surface: 'export',
			invocationId: null,
			idempotencyKey: null,
		},
	})
})

test('keyed packages.invoke keeps exactly-once semantics: repeat calls replay the stored response', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	let executionCount = 0
	repoMockModule.runBundledModuleWithRegistry.mockImplementation(async () => {
		executionCount += 1
		return { result: { handled: true, executionCount }, logs: [] }
	})
	const tools = createRuntimeDispatchTools(db)

	const request = {
		kodyId: 'discord-general-chat',
		exportName: './handle-discord-message-created',
		params: { event: { id: 'message-1' } },
		idempotencyKey: 'evt-keyed-1',
	}
	const first = await tools.invoke(request)
	const second = await tools.invoke(request)

	expect(first).toEqual({ handled: true, executionCount: 1 })
	expect(second).toEqual({ handled: true, executionCount: 1 })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	const runOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[4]
	// The keyed path owns its run record (claimed together with the ledger
	// row in one DO call), so the registry must not open a second one.
	expect(runOptions).toMatchObject({ runRecord: null })
	const ledgerRow = db.runLog.ledgerRows.find(
		(row) => row.idempotencyKey === 'evt-keyed-1',
	)
	expect(ledgerRow).toMatchObject({ status: 'completed' })
	const runRow = [...db.runLog.runRows.values()].find(
		(row) => row['idempotencyKey'] === 'evt-keyed-1',
	)
	expect(runRow).toMatchObject({
		surface: 'export',
		status: 'success',
		invocationId: ledgerRow?.id,
		idempotencyKey: 'evt-keyed-1',
	})
})

test('runtime invoke tools expose only the supported invoke helper', () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	const tools = createRuntimeDispatchTools(db) as Record<string, unknown>

	expect(typeof tools.invoke).toBe('function')
	// Sandbox teaching stubs reject unsupported names; the host tool set
	// exposes only invoke.
	expect(tools.check).toBeUndefined()
	expect(tools.invokeChecked).toBeUndefined()
})

test('package runtime dispatch enqueues declared events to the package events queue', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	const send = vi.fn<(message: unknown) => Promise<undefined>>(
		async () => undefined,
	)
	const tools = createRuntimeEventTools(db, {
		envOverrides: { PACKAGE_EVENTS_DISPATCH_QUEUE: { send } },
	})

	const result = await tools.dispatch({
		topic: '@kentcdodds/discord.message.created',
		idempotencyKey: 'discord:message-create:123',
		payload: {
			messageId: '123',
			channelId: '456',
		},
	})

	expect(send).toHaveBeenCalledTimes(1)
	expect(send).toHaveBeenCalledWith({
		userId: 'user-123',
		topic: '@kentcdodds/discord.message.created',
		idempotencyKey: 'discord:message-create:123',
		payload: {
			messageId: '123',
			channelId: '456',
		},
		source: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		invokeDepth: 1,
	})
	// Queued delivery never invokes subscribers inside the emitting request.
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
	expect(result).toEqual({
		topic: '@kentcdodds/discord.message.created',
		source: {
			type: 'package',
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		idempotencyKey: 'discord:message-create:123',
		status: 'enqueued',
	})

	await expect(
		tools.dispatch({
			topic: '@kentcdodds/discord.reaction.created',
			idempotencyKey: 'discord:reaction-create:123',
			payload: {
				reactionId: '123',
			},
		}),
	).rejects.toThrow(
		/does not declare emitted event "@kentcdodds\/discord.reaction.created"/,
	)
	expect(send).toHaveBeenCalledTimes(1)

	await expect(
		tools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:huge',
			payload: { blob: 'x'.repeat(65 * 1024) },
		}),
	).rejects.toThrow(/payload is \d+ bytes; the maximum is 65536 bytes/)
	expect(send).toHaveBeenCalledTimes(1)

	const depthCappedTools = createRuntimeEventTools(db, {
		envOverrides: { PACKAGE_EVENTS_DISPATCH_QUEUE: { send } },
		packageInvokeDepth: 8,
	})
	await expect(
		depthCappedTools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:deep',
			payload: {},
		}),
	).rejects.toThrow(/exceeded the maximum nested invocation depth/)
	expect(send).toHaveBeenCalledTimes(1)
})

test('package runtime dispatch validates payloads against the declared payloadSchema', async () => {
	const db = createDatabase()
	const { manifests, sourceFiles } = seedRuntimeDispatchPackages()
	const gatewayManifest = manifests.get('source-gateway') as {
		kody: {
			emits?: Record<
				string,
				{ description: string; payloadSchema?: Record<string, unknown> }
			>
		}
	}
	gatewayManifest.kody.emits = {
		'@kentcdodds/discord.message.created': {
			description: 'A Discord message was created.',
			payloadSchema: {
				type: 'object',
				properties: {
					messageId: { type: 'string', minLength: 1 },
					channelId: { type: 'string' },
				},
				required: ['messageId'],
				additionalProperties: false,
			},
		},
	}
	// Keep the serialized source snapshot in sync with the mutated manifest
	// so every manifest loader observes the same emits declaration.
	const gatewayFiles = sourceFiles.get('source-gateway')
	if (gatewayFiles) {
		gatewayFiles['package.json'] = JSON.stringify(gatewayManifest)
	}
	const send = vi.fn<(message: unknown) => Promise<undefined>>(
		async () => undefined,
	)
	const tools = createRuntimeEventTools(db, {
		envOverrides: { PACKAGE_EVENTS_DISPATCH_QUEUE: { send } },
	})

	await expect(
		tools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:bad',
			payload: { channelId: '456', extra: true },
		}),
	).rejects.toThrow(
		/payload does not match the declared payloadSchema[\s\S]*missing required property "messageId"[\s\S]*unexpected property "extra"/,
	)
	expect(send).not.toHaveBeenCalled()

	await expect(
		tools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:ok',
			payload: { messageId: '123', channelId: '456' },
		}),
	).resolves.toMatchObject({ status: 'enqueued' })
	expect(send).toHaveBeenCalledTimes(1)
})

test('package events deliver to same-user package subscriptions with idempotent replay', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockImplementation(
		async (
			_env: unknown,
			_callerContext: unknown,
			_bundle: unknown,
			params: Record<string, unknown> | undefined,
			options: { packageEventTools?: { dispatch?: unknown } },
		) => ({
			result: {
				received: params,
				hasEventDispatch:
					typeof options.packageEventTools?.dispatch === 'function',
			},
			logs: [],
		}),
	)
	const message = {
		userId: 'user-123',
		topic: '@kentcdodds/discord.message.created',
		idempotencyKey: 'discord:message-create:123',
		payload: {
			messageId: '123',
			channelId: '456',
		},
		source: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		invokeDepth: 1,
	}

	const first = await deliverPackageEvent({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		message,
	})
	const second = await deliverPackageEvent({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		message,
	})

	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[3],
	).toEqual({
		event: '@kentcdodds/discord.message.created',
		source: {
			type: 'package',
			package_id: 'pkg-gateway',
			kody_id: 'discord-gateway',
		},
		idempotency_key: 'discord:message-create:123',
		payload: {
			messageId: '123',
			channelId: '456',
		},
	})
	expect(first).toMatchObject({
		topic: '@kentcdodds/discord.message.created',
		source: {
			type: 'package',
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		delivered: 1,
		failed: 0,
		subscribers: [
			{
				packageId: 'pkg-subscriber',
				kodyId: 'discord-general-chat',
				handler: 'src/handle-discord-message-created.ts',
				status: 'completed',
			},
		],
	})
	expect(second).toMatchObject({
		delivered: 1,
		failed: 0,
		subscribers: [
			{
				packageId: 'pkg-subscriber',
				kodyId: 'discord-general-chat',
				status: 'replayed',
			},
		],
	})

	const { manifests, sources } = seedRuntimeDispatchPackages()
	repoMockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-subscriber') {
				throw new Error('manifest unavailable')
			}
			return {
				source: sources.get(input.sourceId),
				manifest: manifests.get(input.sourceId),
			}
		},
	)
	await expect(
		deliverPackageEvent({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			message: { ...message, idempotencyKey: 'discord:manifest-error' },
		}),
	).rejects.toThrow(
		/Failed to load package manifest for package event dispatch/,
	)
})

test('package event subscription filters gate delivery on payload values', async () => {
	const db = createDatabase()
	const { manifests, sourceFiles } = seedRuntimeDispatchPackages()
	const subscriberManifest = manifests.get('source-subscriber') as {
		kody: {
			subscriptions?: Record<
				string,
				{ handler: string; filters?: Record<string, unknown> }
			>
		}
	}
	subscriberManifest.kody.subscriptions = {
		'@kentcdodds/discord.message.created': {
			handler: './src/handle-discord-message-created.ts',
			filters: { channelId: '456' },
		},
	}
	const subscriberFiles = sourceFiles.get('source-subscriber')
	if (subscriberFiles) {
		subscriberFiles['package.json'] = JSON.stringify(subscriberManifest)
	}
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true },
		logs: [],
	})
	const baseMessage = {
		userId: 'user-123',
		topic: '@kentcdodds/discord.message.created',
		payload: {},
		source: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
		},
		invokeDepth: 1,
	}

	const filteredOut = await deliverPackageEvent({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		message: {
			...baseMessage,
			idempotencyKey: 'discord:other-channel',
			payload: { messageId: '1', channelId: '999' },
		},
	})
	expect(filteredOut).toMatchObject({ delivered: 0, failed: 0 })
	expect(filteredOut.subscribers).toEqual([])
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()

	const matching = await deliverPackageEvent({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		message: {
			...baseMessage,
			idempotencyKey: 'discord:matching-channel',
			payload: { messageId: '2', channelId: '456' },
		},
	})
	expect(matching).toMatchObject({ delivered: 1, failed: 0 })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
})

test('package events fall back to inline delivery without a queue binding', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true },
		logs: [],
	})
	const tools = createRuntimeEventTools(db)

	const result = await tools.dispatch({
		topic: '@kentcdodds/discord.message.created',
		idempotencyKey: 'discord:message-create:inline',
		payload: { messageId: 'inline-1' },
	})

	expect(result).toMatchObject({ status: 'delivered_inline' })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[3],
	).toMatchObject({
		event: '@kentcdodds/discord.message.created',
		payload: { messageId: 'inline-1' },
	})

	// Inline delivery failures are logged, never surfaced to the emitter.
	const { manifests, sources } = seedRuntimeDispatchPackages()
	repoMockModule.loadPackageManifestBySourceId.mockImplementation(
		async (input: { sourceId: string }) => {
			if (input.sourceId === 'source-subscriber') {
				throw new Error('manifest unavailable')
			}
			return {
				source: sources.get(input.sourceId),
				manifest: manifests.get(input.sourceId),
			}
		},
	)
	consoleError.mockImplementation(() => {})
	await expect(
		tools.dispatch({
			topic: '@kentcdodds/discord.message.created',
			idempotencyKey: 'discord:message-create:inline-error',
			payload: { messageId: 'inline-2' },
		}),
	).resolves.toMatchObject({ status: 'delivered_inline' })
	expect(consoleError).toHaveBeenCalledWith(
		'package-events-inline-delivery-failed',
		expect.objectContaining({
			topic: '@kentcdodds/discord.message.created',
		}),
	)
})

test('deliverPackageEvent surfaces retryable infrastructure failures', async () => {
	const db = createDatabase({ failClaim: true })
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	consoleError.mockImplementation(() => {})

	await expect(
		deliverPackageEvent({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			message: {
				userId: 'user-123',
				topic: '@kentcdodds/discord.message.created',
				idempotencyKey: 'discord:message-create:claim-failure',
				payload: { messageId: '1' },
				source: {
					packageId: 'pkg-gateway',
					kodyId: 'discord-gateway',
				},
				invokeDepth: 1,
			},
		}),
	).rejects.toThrow('Package event dispatch was incomplete.')
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('package runtime invoke contract-checks once and executes the target', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true, eventId: 'message-1' },
		logs: [],
	})
	repoMockModule.loadPackageManifestForSource.mockClear()
	const tools = createRuntimeDispatchTools(db)

	const result = await tools.invoke({
		kodyId: 'discord-general-chat',
		exportName: 'handle-discord-message-created',
		params: { event: { id: 'message-1' }, dryRun: true },
		idempotencyKey: 'message-1',
		topic: 'discord.message.created',
	})

	expect(result).toEqual({ handled: true, eventId: 'message-1' })
	// One logical call resolves its package exactly once: the mandatory
	// contract check preloads the manifest and the invoke phase reuses it.
	expect(repoMockModule.loadPackageManifestForSource).toHaveBeenCalledTimes(1)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
})

test('execute runtime invoke invokes target package with execute provenance', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { handled: true, eventId: 'message-1' },
		logs: [],
	})
	repoMockModule.recordAgentPackageConversationUse.mockClear()
	repoMockModule.recordAgentPackageConversationUse.mockResolvedValue(undefined)
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'Me',
		},
	})
	const tools = createExecutePackageInvokeTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext,
		conversationId: 'conv-execute-1',
	})

	const result = await tools.invoke({
		kodyId: 'discord-general-chat',
		exportName: './handle-discord-message-created',
		params: { event: { id: 'message-1' } },
	})

	expect(result).toEqual({ handled: true, eventId: 'message-1' })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	const runCall = repoMockModule.runBundledModuleWithRegistry.mock.calls[0]
	expect(runCall?.[1]).toMatchObject({
		user: {
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'Me',
		},
		storageContext: {
			appId: 'pkg-subscriber',
			storageId: 'package:pkg-subscriber',
		},
	})
	expect(runCall?.[4]).toMatchObject({
		packageContext: {
			packageId: 'pkg-subscriber',
			kodyId: 'discord-general-chat',
			sourceId: 'source-subscriber',
		},
		runRecord: {
			packageId: 'pkg-subscriber',
			kodyId: 'discord-general-chat',
			surface: 'export',
			metadata: {
				exportName: './handle-discord-message-created',
				source: 'execute',
				topic: null,
			},
		},
	})
	expect(
		(runCall?.[4] as { packageInvokeTools?: unknown } | undefined)
			?.packageInvokeTools,
	).toBeDefined()
	expect(repoMockModule.recordAgentPackageConversationUse).toHaveBeenCalledWith(
		expect.anything(),
		{
			userId: 'user-123',
			packageId: 'pkg-subscriber',
			conversationId: 'conv-execute-1',
		},
	)
})

test('package runtime dispatch rejects invalid targets before and during invocation', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	const tools = createRuntimeDispatchTools(db)

	repoMockModule.runBundledModuleWithRegistry.mockClear()
	await expect(
		tools.invoke({
			kodyId: 'missing-package',
			exportName: './handle-discord-message-created',
			params: {},
		}),
	).rejects.toThrow(
		'packages.invoke contract check failed: Saved package "missing-package" was not found for this user.',
	)
	await expect(
		tools.invoke({
			kodyId: '@kentcdodds/discord-general-chat',
			exportName: './handle-discord-message-created',
			params: {},
		}),
	).rejects.toThrow(
		'packages.invoke contract check failed: Saved package "@kentcdodds/discord-general-chat" was not found for this user. Dynamic package invocation uses the bare kodyId (for example, "github"), not the npm-scoped package name (for example, "@kentcdodds/github").',
	)
	await expect(
		tools.invoke({
			kodyId: 'discord-general-chat',
			exportName: './missing-export',
			params: {},
		}),
	).rejects.toThrow(
		'packages.invoke contract check failed: Package "discord-general-chat" does not define export "./missing-export".',
	)
	await expect(
		tools.invoke({
			kodyId: 'discord-general-chat',
			exportName: './handle-discord-message-created',
			params: 'not-an-object',
		}),
	).rejects.toThrow(
		'packages.invoke params must be a JSON object when provided.',
	)
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()

	const createTools = () =>
		createPackageRuntimeInvokeTools({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			callerContext: createMcpCallerContext({
				baseUrl: 'https://kody.dev',
				user: {
					userId: 'user-123',
					email: 'me@example.com',
					displayName: 'Me',
				},
			}),
			packageContext: {
				packageId: 'pkg-gateway',
				kodyId: 'discord-gateway',
				sourceId: 'source-gateway',
			},
			parentRunRecord: {
				packageId: 'pkg-gateway',
				kodyId: 'discord-gateway',
				sourceId: 'source-gateway',
				surface: 'export',
				name: './dispatch-message-created',
				idempotencyKey: 'message-1',
			},
			packageInvokeDepth: 0,
		})

	repoMockModule.getSavedPackageByKodyId.mockResolvedValue(null)
	await expect(
		createTools().invoke({
			kodyId: 'missing-package',
			exportName: './handle-discord-message-created',
		}),
	).rejects.toThrow(
		'packages.invoke contract check failed: Saved package "missing-package" was not found for this user.',
	)

	repoMockModule.getSavedPackageByKodyId.mockReset()
	seedRuntimeDispatchPackages()
	await expect(
		createTools().invoke({
			kodyId: 'discord-general-chat',
			exportName: './missing-export',
			params: { event: { id: 'message-1' } },
		}),
	).rejects.toThrow(
		'packages.invoke contract check failed: Package "discord-general-chat" does not define export "./missing-export".',
	)
})

// Auto-generated idempotency keys were removed with the lean key-less path:
// nested key-less invokes are ephemeral and always re-execute, regardless of
// the parent run's identity. Exactly-once now requires an explicit key.
test('key-less nested invokes re-execute for every parent run', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	repoMockModule.runBundledModuleWithRegistry.mockImplementation(
		async (
			_env: unknown,
			_callerContext: unknown,
			bundle: { mainModule: string },
			params: { marker?: string; value?: number } | undefined,
		) => {
			expect(bundle.mainModule).toBe('dist/subscriber.js')
			return {
				result: {
					marker: params?.marker,
					value: params?.value,
				},
				logs: [],
			}
		},
	)
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'Me',
		},
	})
	const packageContext = {
		packageId: 'pkg-gateway',
		kodyId: 'discord-gateway',
		sourceId: 'source-gateway',
	}
	const createToolsForParent = (name: string) =>
		createPackageRuntimeInvokeTools({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			callerContext,
			packageContext,
			parentRunRecord: {
				packageId: 'pkg-gateway',
				kodyId: 'discord-gateway',
				sourceId: 'source-gateway',
				surface: 'export',
				name,
				idempotencyKey: 'shared-domain-event',
			},
			packageInvokeDepth: 0,
		})

	const first = await createToolsForParent('./first-parent').invoke({
		kodyId: 'discord-general-chat',
		exportName: './handle-discord-message-created',
		params: { marker: 'same-child-call', value: 1 },
	})
	const second = await createToolsForParent('./second-parent').invoke({
		kodyId: 'discord-general-chat',
		exportName: './handle-discord-message-created',
		params: { marker: 'same-child-call', value: 1 },
	})

	expect(first).toEqual({ marker: 'same-child-call', value: 1 })
	expect(second).toEqual({ marker: 'same-child-call', value: 1 })
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(2)
})

test('package runtime invocation requires package context and enforces loop depth', async () => {
	const db = createDatabase()
	seedRuntimeDispatchPackages()
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://kody.dev',
		user: {
			userId: 'user-123',
			email: 'me@example.com',
			displayName: 'Me',
		},
	})
	const withoutPackageContext = createPackageRuntimeInvokeTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext,
		packageContext: null,
		packageInvokeDepth: 0,
	})

	await expect(
		withoutPackageContext.invoke({
			kodyId: 'discord-general-chat',
			exportName: './handle-discord-message-created',
		}),
	).rejects.toThrow('packages.invoke requires a package runtime context.')

	const tooDeep = createPackageRuntimeInvokeTools({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		callerContext,
		packageContext: {
			packageId: 'pkg-gateway',
			kodyId: 'discord-gateway',
			sourceId: 'source-gateway',
		},
		packageInvokeDepth: 8,
	})
	await expect(
		tooDeep.invoke({
			kodyId: 'discord-general-chat',
			exportName: './handle-discord-message-created',
		}),
	).rejects.toThrow(
		'packages.invoke exceeded the maximum nested invocation depth (8).',
	)
})

test('invokePackageExport enforces idempotency replay, mismatch, corruption, and persistence failures', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { reply: 'hello discord' },
		logs: ['dispatched'],
	})

	const replayFirst = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-replay',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	const replaySecond = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-replay',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(replayFirst.status).toBe(200)
	expect(replaySecond.status).toBe(200)
	expect(replaySecond.body).toMatchObject({
		ok: true,
		idempotency: {
			key: 'evt-replay',
			replayed: true,
		},
	})

	await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-mismatch',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	const mismatch = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'different' },
			idempotencyKey: 'evt-mismatch',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(mismatch.status).toBe(409)
	expect(mismatch.body).toEqual({
		ok: false,
		error: {
			code: 'idempotency_mismatch',
			message:
				'This idempotency key has already been used for a different package invocation request.',
		},
		idempotency: {
			key: 'evt-mismatch',
			replayed: false,
		},
	})

	const corruptFirst = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-corrupt',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	db.runLog.corruptStoredResponses()
	const corruptSecond = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-corrupt',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(corruptFirst.status).toBe(200)
	expect(corruptSecond.status).toBe(409)
	expect(corruptSecond.body).toMatchObject({
		ok: false,
		error: {
			code: 'idempotency_response_unavailable',
		},
		idempotency: {
			key: 'evt-corrupt',
			replayed: false,
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(3)

	const failingDb = createDatabase({ failClaim: true })
	seedPackageResolution()
	consoleError.mockImplementation(() => {})
	const persistenceFailure = await invokePackageExport({
		env: createEnv(failingDb),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-insert-failure',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(persistenceFailure.status).toBe(500)
	expect(persistenceFailure.body).toMatchObject({
		ok: false,
		error: {
			code: 'idempotency_persistence_failed',
		},
		idempotency: {
			key: 'evt-insert-failure',
			replayed: false,
		},
	})
	expect(consoleError).toHaveBeenCalledWith(
		'package invocation idempotency persistence failed',
		expect.any(Error),
	)
})

test('oversized terminal responses are not stored so backups stay restorable', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		// Serialized response_json above maxStoredInvocationResponseJsonBytes.
		result: { blob: 'x'.repeat(maxStoredInvocationResponseJsonBytes + 1) },
		logs: [],
	})

	const first = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-oversized',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})
	const duplicate = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-oversized',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	// The first call still returns the live response in full.
	expect(first.status).toBe(200)
	expect(first.body).toMatchObject({ ok: true })
	// The duplicate is deduplicated (no re-execution) but cannot replay the
	// dropped oversized response.
	expect(duplicate.status).toBe(409)
	expect(duplicate.body).toMatchObject({
		ok: false,
		error: { code: 'idempotency_response_unavailable' },
		idempotency: { key: 'evt-oversized', replayed: false },
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
})

test('a pre-migration-style key misses cleanly: it executes fresh instead of erroring', async () => {
	// Keys claimed before the ledger moved into the RunLog DO no longer have
	// any store to replay from (the D1 table is dropped). A redelivery for
	// such a key is indistinguishable from a brand-new key: it claims in the
	// DO and executes, without touching D1 at all (the fake D1 above throws
	// on any package_invocations statement).
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockClear()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { reply: 'executed fresh' },
		logs: [],
	})

	const response = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-from-before-the-migration',
			source: 'discord-gateway',
			topic: 'discord.message.created',
		},
	})

	expect(response.status).toBe(200)
	expect(response.body).toMatchObject({
		ok: true,
		result: { reply: 'executed fresh' },
		idempotency: { key: 'evt-from-before-the-migration', replayed: false },
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(
		db.runLog.ledgerRows.find(
			(row) => row.idempotencyKey === 'evt-from-before-the-migration',
		),
	).toMatchObject({ status: 'completed' })
})

test('invokePackageExport enforces source scopes for wildcard tokens', async () => {
	const db = createDatabase()
	seedPackageResolution()

	const disallowedSource = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-bad-source',
			source: 'other-gateway',
		},
	})

	expect(disallowedSource.status).toBe(403)
	expect(disallowedSource.body).toMatchObject({
		ok: false,
		error: {
			code: 'source_not_allowed',
		},
	})

	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { reply: 'hello trusted client' },
		logs: ['invoked'],
	})

	const allowed = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			packageIds: ['*'],
			packageKodyIds: [],
			exportNames: ['*'],
			sources: ['personal-client'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-personal-client',
			source: 'personal-client',
		},
	})

	expect(allowed.status).toBe(200)
	expect(allowed.body).toMatchObject({
		ok: true,
		exportName: './dispatch-message-created',
		source: 'personal-client',
		result: { reply: 'hello trusted client' },
	})

	const denied = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			packageIds: ['*'],
			packageKodyIds: [],
			exportNames: ['*'],
			sources: ['personal-client'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-shortcuts',
			source: 'shortcuts',
		},
	})

	expect(denied.status).toBe(403)
	expect(denied.body).toMatchObject({
		ok: false,
		error: {
			code: 'source_not_allowed',
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)

	const scopedDeniedByExport = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			packageKodyIds: ['discord-gateway'],
			exportNames: ['./other-export'],
			sources: ['discord-gateway'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-scoped-denied-export',
			source: 'discord-gateway',
		},
	})

	expect(scopedDeniedByExport.status).toBe(403)
	expect(scopedDeniedByExport.body).toMatchObject({
		ok: false,
		error: {
			code: 'export_not_allowed',
		},
	})
})

test('invokePackageExport stores terminal failures for execution errors and missing exports', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		error: new Error('Discord downstream failed'),
		logs: ['before-error'],
	})

	const executionFailure = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-2',
			source: 'discord-gateway',
		},
	})

	expect(executionFailure.status).toBe(500)
	expect(executionFailure.body).toMatchObject({
		ok: false,
		error: {
			code: 'execution_failed',
			message: 'Discord downstream failed',
		},
		logs: ['before-error'],
	})

	repoMockModule.runBundledModuleWithRegistry.mockClear()
	const missingExportFirst = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			exportNames: ['./missing-export'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'missing-export',
			params: { content: 'hi' },
			idempotencyKey: 'evt-missing-export',
			source: 'discord-gateway',
		},
	})
	const missingExportSecond = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken({
			exportNames: ['./missing-export'],
		}),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'missing-export',
			params: { content: 'hi' },
			idempotencyKey: 'evt-missing-export',
			source: 'discord-gateway',
		},
	})

	expect(missingExportFirst.status).toBe(404)
	expect(missingExportFirst.body).toMatchObject({
		ok: false,
		error: {
			code: 'export_not_found',
		},
		idempotency: {
			key: 'evt-missing-export',
			replayed: false,
		},
	})
	expect(missingExportSecond.status).toBe(404)
	expect(missingExportSecond.body).toMatchObject({
		ok: false,
		error: {
			code: 'export_not_found',
		},
		idempotency: {
			key: 'evt-missing-export',
			replayed: true,
		},
	})
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('invokePackageExport asks for republish when a published artifact is missing for npm-backed source', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue(null)
	repoMockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			user_id: 'user-123',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-27T00:00:00.000Z',
			updated_at: '2026-04-27T00:00:00.000Z',
		},
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway helpers',
			},
		},
		files: {
			'package.json': JSON.stringify({
				name: '@kentcdodds/discord-gateway',
				dependencies: {
					kleur: '^4.1.5',
				},
				exports: {
					'./dispatch-message-created': './src/dispatch-message-created.ts',
				},
				kody: {
					id: 'discord-gateway',
					description: 'Discord gateway helpers',
				},
			}),
			'src/dispatch-message-created.ts':
				'import kleur from "kleur"\nexport default async function run(){ return kleur.green("ok") }',
		},
	})

	const response = await invokePackageExport({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		token: createToken(),
		request: {
			packageIdOrKodyId: 'discord-gateway',
			exportName: 'dispatch-message-created',
			params: { content: 'hi' },
			idempotencyKey: 'evt-republish-needed',
			source: 'discord-gateway',
		},
	})

	expect(response.status).toBe(500)
	expect(response.body).toMatchObject({
		ok: false,
		error: {
			code: 'invocation_failed',
			message: expect.stringContaining(
				'no published runtime bundle artifact is available yet',
			),
		},
	})
	expect(
		repoMockModule.typecheckPackageEntrypointsFromSourceFiles,
	).toHaveBeenCalledWith({
		sourceFiles: expect.objectContaining({
			'package.json': expect.any(String),
			'src/dispatch-message-created.ts': expect.any(String),
		}),
		entryPoints: [
			{
				path: 'src/dispatch-message-created.ts',
				includeStorage: true,
			},
		],
		emittedEventTopics: [],
	})
	expect(repoMockModule.persistPublishedBundleArtifact).not.toHaveBeenCalled()
	expect(repoMockModule.runBundledModuleWithRegistry).not.toHaveBeenCalled()
})

test('invokePackageSubscription uses the normal capability registry with package storage and source metadata intact', async () => {
	const db = createDatabase()
	seedPackageResolution()
	repoMockModule.loadPackageManifestBySourceId.mockResolvedValue({
		source: {
			id: 'source-1',
			user_id: 'user-123',
			entity_kind: 'package',
			entity_id: 'pkg-1',
			repo_id: 'repo-1',
			published_commit: 'commit-1',
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			created_at: '2026-04-27T00:00:00.000Z',
			updated_at: '2026-04-27T00:00:00.000Z',
		},
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./dispatch-message-created': './src/dispatch-message-created.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway helpers',
				app: {
					entry: './src/app.ts',
				},
				subscriptions: {
					'email.message.received': {
						handler: './src/email-message-received.ts',
					},
				},
			},
		},
	})
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockResolvedValue({
		row: {
			id: 'artifact-subscription-1',
		},
		artifact: {
			version: 1,
			kind: 'module',
			artifactName: 'subscription:email.message.received',
			sourceId: 'source-1',
			publishedCommit: 'commit-1',
			entryPoint: 'src/email-message-received.ts',
			mainModule: 'dist/subscription.js',
			modules: {
				'dist/subscription.js':
					'export default async function run(){ return { ok: true } }',
			},
			dependencies: [],
			packageContext: {
				packageId: 'pkg-1',
				kodyId: 'discord-gateway',
				sourceId: 'source-1',
			},
			serviceContext: null,
			createdAt: '2026-04-27T00:00:00.000Z',
		},
	})
	repoMockModule.runBundledModuleWithRegistry.mockResolvedValue({
		result: { ok: true },
		logs: [],
	})

	const savedPackage = {
		id: 'pkg-1',
		userId: 'user-123',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord gateway helpers',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hidden: false,
		isPrivate: false,
		createdAt: '2026-04-27T00:00:00.000Z',
		updatedAt: '2026-04-27T00:00:00.000Z',
	}

	const response = await invokePackageSubscription({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		savedPackage,
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			message: { id: 'message-123' },
		},
		idempotencyKey: 'email:message-123:pkg-1:email.message.received',
		source: 'email',
	})

	expect(response.status).toBe(200)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(1)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			baseUrl: 'https://kody.dev',
			user: expect.objectContaining({
				userId: 'user-123',
				displayName: 'package:discord-gateway',
			}),
			storageContext: {
				sessionId: null,
				appId: 'pkg-1',
				packageId: 'pkg-1',
				storageId: 'package:pkg-1',
			},
			repoContext: expect.objectContaining({
				sourceId: 'source-1',
			}),
		}),
		expect.anything(),
		{
			event: 'email.message.received',
			message: { id: 'message-123' },
		},
		expect.objectContaining({
			packageContext: {
				packageId: 'pkg-1',
				kodyId: 'discord-gateway',
				sourceId: 'source-1',
			},
		}),
	)
	const runOptions =
		repoMockModule.runBundledModuleWithRegistry.mock.calls[0]?.[4]
	expect(runOptions).toBeDefined()
	expect(
		(runOptions as { skipCapabilityRegistry?: boolean }).skipCapabilityRegistry,
	).toBeUndefined()
	// Package invocation runs no longer bind ambient `storage`: the package
	// bucket is reached via packageStorage(), granted through packageContext.
	expect(
		(runOptions as { storageTools?: unknown }).storageTools,
	).toBeUndefined()

	db.runLog.seedStaleInvocation(
		'email:message-stale:pkg-1:email.message.received',
	)
	const recovered = await invokePackageSubscription({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		savedPackage,
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			message: { id: 'message-123' },
		},
		idempotencyKey: 'email:message-stale:pkg-1:email.message.received',
		source: 'email',
	})
	expect(recovered.status).toBe(200)
	expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(2)

	const freshKey = 'email:message-fresh:pkg-1:email.message.received'
	db.runLog.seedFreshInvocation(freshKey)
	const completionTimer = setTimeout(() => {
		db.runLog.completeInvocation(freshKey)
	}, 150)
	try {
		const polled = await invokePackageSubscription({
			env: createEnv(db),
			baseUrl: 'https://kody.dev',
			savedPackage,
			topic: 'email.message.received',
			params: {
				event: 'email.message.received',
				message: { id: 'message-123' },
			},
			idempotencyKey: freshKey,
			source: 'email',
		})
		expect(polled.status).toBe(200)
		expect(repoMockModule.runBundledModuleWithRegistry).toHaveBeenCalledTimes(2)
	} finally {
		clearTimeout(completionTimer)
	}

	const transientKey = 'email:message-transient:pkg-1:email.message.received'
	// The commit-keyed artifact cache is warm from the invocations above and
	// would absorb the injected KV failure; this scenario is about a cold
	// artifact load failing transiently.
	clearInvokeContractCachesForTests()
	repoMockModule.loadPublishedBundleArtifactByIdentity.mockRejectedValueOnce(
		new Error('KV timeout'),
	)
	const transientFailure = await invokePackageSubscription({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		savedPackage,
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			message: { id: 'message-123' },
		},
		idempotencyKey: transientKey,
		source: 'email',
	})
	expect(transientFailure).toMatchObject({
		status: 503,
		body: { error: { code: 'artifact_preparation_failed' } },
	})
	const recoveredTransient = await invokePackageSubscription({
		env: createEnv(db),
		baseUrl: 'https://kody.dev',
		savedPackage,
		topic: 'email.message.received',
		params: {
			event: 'email.message.received',
			message: { id: 'message-123' },
		},
		idempotencyKey: transientKey,
		source: 'email',
	})
	expect(recoveredTransient.status).toBe(200)
})
