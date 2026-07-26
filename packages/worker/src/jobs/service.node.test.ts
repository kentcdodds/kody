import { expect, test, vi, afterEach } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { repoBackedModuleEntrypointExportErrorMessage } from '#worker/repo/repo-kody-execution.ts'
import { silenceIncidentalRuntimeWarnings } from '#worker/test-support/incidental-runtime-warnings.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { createCapabilitySecretAccessDeniedMessage } from '#mcp/secrets/errors.ts'
import { saveSecret } from '#mcp/secrets/service.ts'
import { saveValue } from '#mcp/values/service.ts'
import { buildPublishedSourceSnapshotKvKey } from '#worker/package-runtime/published-runtime-artifacts.ts'
import { buildJobSourceFiles } from '#worker/repo/source-templates.ts'
import {
	createJob,
	deleteJob,
	executeJobOnce,
	getJob,
	getJobInspection,
	inspectJobsForUser,
	runJobNow,
	syncPackageJobsForPackage,
	updateJob,
} from './service.ts'
import { listJobRowsByUserId } from './repo.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import {
	type JobCreateInput,
	type JobRecord,
	type PersistedJobCallerContext,
} from './types.ts'

const repoMockModule = vi.hoisted(() => ({
	ensureEntitySource: vi.fn(),
	syncArtifactSourceSnapshot: vi.fn(),
	cleanupArtifactReposForSource: vi.fn(async () => ({
		deleted: 0,
		artifactAccessUnavailable: false,
	})),
	listRepoSessionsBySource: vi.fn(async () => []),
	deleteRepoSessionsBySourceForUser: vi.fn(async () => 0),
	cleanupSessionBranch: vi.fn(async () => ({ ok: true })),
}))

const jobManagerMockModule = vi.hoisted(() => ({
	syncJobManagerAlarm: vi.fn(),
	getJobManagerDebugState: vi.fn(),
}))

vi.mock('#worker/repo/source-service.ts', () => ({
	ensureEntitySource: (...args: Array<unknown>) =>
		repoMockModule.ensureEntitySource(...args),
}))

vi.mock('#worker/repo/source-sync.ts', () => ({
	syncArtifactSourceSnapshot: (...args: Array<unknown>) =>
		repoMockModule.syncArtifactSourceSnapshot(...args),
}))

vi.mock('#worker/repo/artifact-repo-cleanup.ts', () => ({
	cleanupArtifactReposForSource: (...args: Array<unknown>) =>
		repoMockModule.cleanupArtifactReposForSource(...args),
}))

vi.mock('#worker/repo/repo-sessions.ts', () => ({
	listRepoSessionsBySource: (...args: Array<unknown>) =>
		repoMockModule.listRepoSessionsBySource(...args),
	deleteRepoSessionsBySourceForUser: (...args: Array<unknown>) =>
		repoMockModule.deleteRepoSessionsBySourceForUser(...args),
}))

vi.mock('#worker/repo/repo-session-do.ts', () => ({
	repoSessionRpc: () => ({
		cleanupSessionBranch: (...args: Array<unknown>) =>
			repoMockModule.cleanupSessionBranch(...args),
	}),
}))

vi.mock('./manager-client.ts', () => ({
	syncJobManagerAlarm: (...args: Array<unknown>) =>
		jobManagerMockModule.syncJobManagerAlarm(...args),
	getJobManagerDebugState: (...args: Array<unknown>) =>
		jobManagerMockModule.getJobManagerDebugState(...args),
}))

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- this legacy suite restores global spies across many integration-style tests.
afterEach(() => {
	vi.restoreAllMocks()
	repoMockModule.cleanupArtifactReposForSource.mockClear()
	repoMockModule.cleanupArtifactReposForSource.mockResolvedValue({
		deleted: 0,
		artifactAccessUnavailable: false,
	})
	repoMockModule.listRepoSessionsBySource.mockClear()
	repoMockModule.listRepoSessionsBySource.mockResolvedValue([])
	repoMockModule.deleteRepoSessionsBySourceForUser.mockClear()
	repoMockModule.deleteRepoSessionsBySourceForUser.mockResolvedValue(0)
	repoMockModule.cleanupSessionBranch.mockClear()
	repoMockModule.cleanupSessionBranch.mockResolvedValue({ ok: true })
	jobManagerMockModule.syncJobManagerAlarm.mockClear()
	jobManagerMockModule.getJobManagerDebugState.mockReset()
	jobManagerMockModule.getJobManagerDebugState.mockResolvedValue({
		bindingAvailable: false,
		status: 'missing_binding',
		storedUserId: null,
		alarmScheduledFor: null,
		nextRunnableJobId: null,
		nextRunnableRunAt: null,
		alarmInSync: null,
	})
})

function mockRepoPersistence() {
	repoMockModule.ensureEntitySource.mockImplementation(
		async ({ db, id, userId, entityKind, entityId, sourceRoot }) => {
			const sourceId =
				typeof id === 'string' && id.length > 0
					? id
					: `${entityKind}-${entityId}`
			await insertPublishedEntitySource({
				db,
				userId,
				sourceId,
				entityKind,
				entityId,
				publishedCommit: 'published-commit-1',
				manifestPath: entityKind === 'package' ? 'package.json' : 'kody.json',
				sourceRoot: sourceRoot ?? '/',
			})
			return {
				id: sourceId,
				user_id: userId,
				entity_kind: entityKind,
				entity_id: entityId,
				repo_id: `${entityKind}-${entityId}`,
				published_commit: 'published-commit-1',
				indexed_commit: null,
				manifest_path: entityKind === 'package' ? 'package.json' : 'kody.json',
				source_root: sourceRoot ?? '/',
				created_at: '2026-04-18T00:00:00.000Z',
				updated_at: '2026-04-18T00:00:00.000Z',
				bootstrapAccess: null,
			}
		},
	)
	repoMockModule.syncArtifactSourceSnapshot.mockImplementation(
		async ({ env, userId, sourceId, files }) => {
			if (typeof sourceId !== 'string' || !sourceId) {
				return 'published-commit-1'
			}
			const existing = await (env.APP_DB as ReturnType<typeof createDatabase>)
				.prepare(`SELECT * FROM entity_sources WHERE id = ?`)
				.bind(sourceId)
				.first<Record<string, unknown>>()
			if (existing) {
				await insertPublishedEntitySource({
					db: env.APP_DB as ReturnType<typeof createDatabase>,
					userId,
					sourceId,
					entityKind:
						(existing['entity_kind'] as 'job' | 'package' | undefined) ?? 'job',
					entityId: String(existing['entity_id'] ?? sourceId),
					publishedCommit: 'published-commit-1',
					manifestPath: String(existing['manifest_path'] ?? 'kody.json'),
					sourceRoot: String(existing['source_root'] ?? '/'),
				})
				if (env.BUNDLE_ARTIFACTS_KV) {
					const { writePublishedSourceSnapshot } =
						await import('#worker/package-runtime/published-runtime-artifacts.ts')
					await writePublishedSourceSnapshot({
						env,
						source: {
							id: sourceId,
							user_id: String(existing['user_id']),
							entity_kind:
								(existing['entity_kind'] as 'job' | 'package') ?? 'job',
							entity_id: String(existing['entity_id'] ?? sourceId),
							repo_id: String(existing['repo_id'] ?? sourceId),
							published_commit: 'published-commit-1',
							indexed_commit: null,
							manifest_path: String(existing['manifest_path'] ?? 'kody.json'),
							source_root: String(existing['source_root'] ?? '/'),
							created_at: String(
								existing['created_at'] ?? '2026-04-16T00:00:00.000Z',
							),
							updated_at: String(
								existing['updated_at'] ?? '2026-04-16T00:00:00.000Z',
							),
						},
						files,
					})
				}
			}
			return 'published-commit-1'
		},
	)
}

function createPackageJobManifest(input: {
	packageName: string
	kodyId: string
	description: string
	jobName: string
	schedule?: Record<string, unknown>
	entry?: string
	exportPath?: string
}) {
	return {
		name: input.packageName,
		exports: {
			'.': input.exportPath ?? './src/index.ts',
		},
		kody: {
			id: input.kodyId,
			description: input.description,
			jobs: {
				[input.jobName]: {
					entry: input.entry ?? './src/job.ts',
					schedule: input.schedule ?? {
						type: 'once',
						runAt: '2026-04-17T15:00:00Z',
					},
				},
			},
		},
	}
}

function createPackageJobManifestText(
	input: Parameters<typeof createPackageJobManifest>[0],
) {
	return JSON.stringify(createPackageJobManifest(input))
}

vi.mock('@cloudflare/worker-bundler', () => ({
	createFileSystemSnapshot: vi.fn(
		async (files: AsyncIterable<[string, string]>) => {
			const snapshotFiles = new Map<string, string>()
			for await (const [path, content] of files) {
				snapshotFiles.set(path, content)
			}
			return {
				read(path: string) {
					return snapshotFiles.get(path) ?? null
				},
			}
		},
	),
	createWorker: vi.fn(
		async ({
			files,
			entryPoint,
		}: {
			files: Record<string, string>
			entryPoint?: string
		}) => {
			const mainModule = 'dist/bundled-entry.js'
			const selectedEntryPoint = entryPoint ?? 'index.ts'
			return {
				mainModule,
				modules: {
					[mainModule]: files[selectedEntryPoint] ?? '',
				},
				warnings: [],
			}
		},
	),
}))

vi.mock('@cloudflare/worker-bundler/typescript', () => ({
	createTypescriptLanguageService: vi.fn(async () => ({
		fileSystem: {
			read: vi.fn(() => null),
			write: vi.fn(),
		},
		languageService: {
			getSemanticDiagnostics: vi.fn((entryPoint: string) =>
				entryPoint === '.__kody_repo_module_check__.ts' ||
				entryPoint === 'src/job.ts'
					? []
					: [{ messageText: `missing ${entryPoint}` }],
			),
		},
	})),
}))

function createDatabase(
	initialRows: {
		users?: Array<Record<string, unknown>>
		jobs?: Array<Record<string, unknown>>
	} = {},
) {
	const tables = new Map<string, Array<Record<string, unknown>>>([
		['secret_buckets', []],
		['secret_entries', []],
		['value_buckets', []],
		['value_entries', []],
		['entity_sources', []],
		['published_bundle_artifacts', []],
		['archived_job_artifacts', []],
		['jobs', (initialRows.jobs ?? []).map((row) => ({ ...row }))],
		['users', (initialRows.users ?? []).map((row) => ({ ...row }))],
	])

	const clone = <T>(value: T): T => structuredClone(value)

	function getTable(name: string) {
		const table = tables.get(name)
		if (!table) {
			throw new Error(`Unknown table ${name}`)
		}
		return table
	}

	function selectOne(
		tableName: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) {
		return clone(getTable(tableName).find(predicate) ?? null)
	}

	function selectAll(
		tableName: string,
		predicate: (row: Record<string, unknown>) => boolean = () => true,
	) {
		return clone(getTable(tableName).filter(predicate))
	}

	function upsert(
		tableName: string,
		keyPredicate: (row: Record<string, unknown>) => boolean,
		row: Record<string, unknown>,
	) {
		const table = getTable(tableName)
		const index = table.findIndex(keyPredicate)
		if (index >= 0) table[index] = clone(row)
		else table.push(clone(row))
	}

	function deleteWhere(
		tableName: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) {
		const table = getTable(tableName)
		const before = table.length
		const remaining = table.filter((row) => !predicate(row))
		tables.set(tableName, remaining)
		return before - remaining.length
	}

	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T = Record<string, unknown>>() {
							if (query.includes('SELECT plan, stripe_plan FROM users')) {
								return selectOne(
									'users',
									(row) => row['email'] === params[0],
								) as T | null
							}
							if (query.includes('SELECT COUNT(*) AS count FROM jobs')) {
								return {
									count: selectAll(
										'jobs',
										(row) => row['user_id'] === params[0],
									).length,
								} as T
							}
							if (query.includes('FROM secret_buckets')) {
								return selectOne(
									'secret_buckets',
									(row) =>
										row['user_id'] === params[0] &&
										row['scope'] === params[1] &&
										row['binding_key'] === params[2],
								) as T | null
							}
							if (query.includes('FROM secret_entries')) {
								return selectOne(
									'secret_entries',
									(row) =>
										row['bucket_id'] === params[0] && row['name'] === params[1],
								) as T | null
							}
							if (query.includes('FROM value_buckets')) {
								return selectOne(
									'value_buckets',
									(row) =>
										row['user_id'] === params[0] &&
										row['scope'] === params[1] &&
										row['binding_key'] === params[2],
								) as T | null
							}
							if (query.includes('FROM value_entries')) {
								return selectOne(
									'value_entries',
									(row) =>
										row['bucket_id'] === params[0] && row['name'] === params[1],
								) as T | null
							}
							if (query.includes('FROM jobs WHERE id = ? AND user_id = ?')) {
								return selectOne(
									'jobs',
									(row) =>
										row['id'] === params[0] && row['user_id'] === params[1],
								) as T | null
							}
							if (
								query.includes(
									'SELECT * FROM entity_sources WHERE id = ? AND user_id = ?',
								)
							) {
								return selectOne(
									'entity_sources',
									(row) =>
										row['id'] === params[0] && row['user_id'] === params[1],
								) as T | null
							}
							if (query.includes('SELECT * FROM entity_sources WHERE id = ?')) {
								return selectOne(
									'entity_sources',
									(row) => row['id'] === params[0],
								) as T | null
							}
							if (
								query.includes('SELECT * FROM entity_sources') &&
								query.includes(
									'WHERE user_id = ? AND entity_kind = ? AND entity_id = ?',
								)
							) {
								return selectOne(
									'entity_sources',
									(row) =>
										row['user_id'] === params[0] &&
										row['entity_kind'] === params[1] &&
										row['entity_id'] === params[2],
								) as T | null
							}
							if (
								query.includes(
									'SELECT id FROM archived_job_artifacts WHERE job_id = ? AND user_id = ?',
								)
							) {
								return selectOne(
									'archived_job_artifacts',
									(row) =>
										row['job_id'] === params[0] && row['user_id'] === params[1],
								) as T | null
							}
							if (
								query.includes('FROM published_bundle_artifacts') &&
								query.includes(
									'WHERE user_id = ? AND source_id = ? AND artifact_kind = ?',
								)
							) {
								return selectOne(
									'published_bundle_artifacts',
									(row) =>
										row['user_id'] === params[0] &&
										row['source_id'] === params[1] &&
										row['artifact_kind'] === params[2] &&
										String(row['artifact_name'] ?? '') ===
											String(params[3] ?? '') &&
										row['entry_point'] === params[4],
								) as T | null
							}
							if (
								query.includes('FROM entity_sources') &&
								query.includes('user_id = ?') &&
								query.includes('entity_kind = ?') &&
								query.includes('entity_id = ?')
							) {
								return selectOne(
									'entity_sources',
									(row) =>
										row['user_id'] === params[0] &&
										row['entity_kind'] === params[1] &&
										row['entity_id'] === params[2],
								) as T | null
							}
							if (query.includes('FROM jobs') && query.includes('LIMIT 1')) {
								const rows = selectAll(
									'jobs',
									(row) =>
										row['user_id'] === params[0] &&
										row['enabled'] === 1 &&
										row['kill_switch_enabled'] === 0,
								).sort((left, right) =>
									String(left['next_run_at']).localeCompare(
										String(right['next_run_at']),
									),
								)
								return (rows[0] ?? null) as T | null
							}
							// Finite max-plan storage enforcement always counts D1
							// bytes; this mock has no storage surfaces seeded.
							if (query.includes('COALESCE(SUM(')) {
								return { count: 0 } as T
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async all<T = Record<string, unknown>>() {
							if (query.includes('FROM jobs WHERE user_id = ? ORDER BY')) {
								return {
									results: selectAll(
										'jobs',
										(row) => row['user_id'] === params[0],
									).sort((left, right) =>
										String(left['next_run_at']).localeCompare(
											String(right['next_run_at']),
										),
									) as T[],
								}
							}
							if (
								query.includes('FROM jobs') &&
								query.includes('next_run_at <= ?')
							) {
								return {
									results: selectAll(
										'jobs',
										(row) =>
											row['user_id'] === params[0] &&
											row['enabled'] === 1 &&
											row['kill_switch_enabled'] === 0 &&
											String(row['next_run_at']) <= String(params[1]),
									).sort((left, right) =>
										String(left['next_run_at']).localeCompare(
											String(right['next_run_at']),
										),
									) as T[],
								}
							}
							if (
								query.includes('FROM value_entries') &&
								query.includes('ORDER BY')
							) {
								return {
									results: selectAll(
										'value_entries',
										(row) => row['bucket_id'] === params[3],
									)
										.map((row) => ({
											scope: params[0],
											binding_key: params[1],
											name: row['name'],
											description: row['description'],
											value: row['value'],
											created_at: row['created_at'],
											updated_at: row['updated_at'],
											expires_at: params[2],
										}))
										.sort((left, right) =>
											String(left['name']).localeCompare(String(right['name'])),
										) as T[],
								}
							}
							if (
								query.includes('FROM secret_entries') &&
								query.includes('ORDER BY')
							) {
								return {
									results: selectAll(
										'secret_entries',
										(row) => row['bucket_id'] === params[4],
									)
										.map((row) => ({
											scope: params[0],
											binding_key: params[1],
											name: row['name'],
											description: row['description'],
											allowed_hosts: row['allowed_hosts'],
											allowed_capabilities: row['allowed_capabilities'],
											created_at: row['created_at'],
											updated_at: row['updated_at'],
											expires_at: params[2],
										}))
										.sort((left, right) =>
											String(left['name']).localeCompare(String(right['name'])),
										) as T[],
								}
							}
							if (
								query.includes('FROM archived_job_artifacts') &&
								query.includes('WHERE retain_until <= ?')
							) {
								return {
									results: selectAll(
										'archived_job_artifacts',
										(row) => String(row['retain_until']) <= String(params[0]),
									).sort((left, right) =>
										String(left['retain_until']).localeCompare(
											String(right['retain_until']),
										),
									) as T[],
								}
							}
							if (
								query.includes('FROM published_bundle_artifacts') &&
								query.includes('WHERE user_id = ? AND source_id = ?')
							) {
								return {
									results: selectAll(
										'published_bundle_artifacts',
										(row) =>
											row['user_id'] === params[0] &&
											row['source_id'] === params[1],
									).sort((left, right) =>
										String(right['updated_at']).localeCompare(
											String(left['updated_at']),
										),
									) as T[],
								}
							}
							if (
								query.includes('FROM published_bundle_artifacts') &&
								query.includes('WHERE source_id = ?')
							) {
								return {
									results: selectAll(
										'published_bundle_artifacts',
										(row) => row['source_id'] === params[0],
									).sort((left, right) =>
										String(right['updated_at']).localeCompare(
											String(left['updated_at']),
										),
									) as T[],
								}
							}
							throw new Error(`Unsupported all query: ${query}`)
						},
						async run() {
							if (query.startsWith('UPDATE users')) {
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('INSERT INTO secret_buckets')) {
								const row = {
									id: params[0],
									user_id: params[1],
									scope: params[2],
									binding_key: params[3],
									expires_at: params[4],
									created_at: params[5],
									updated_at: params[6],
								}
								upsert(
									'secret_buckets',
									(existing) =>
										existing['user_id'] === row.user_id &&
										existing['scope'] === row.scope &&
										existing['binding_key'] === row.binding_key,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('INSERT INTO secret_entries')) {
								const row = {
									bucket_id: params[0],
									name: params[1],
									description: params[2],
									encrypted_value: params[3],
									allowed_hosts: params[4],
									allowed_capabilities: params[5],
									created_at: params[6],
									updated_at: params[7],
								}
								upsert(
									'secret_entries',
									(existing) =>
										existing['bucket_id'] === row.bucket_id &&
										existing['name'] === row.name,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('INSERT INTO value_buckets')) {
								const row = {
									id: params[0],
									user_id: params[1],
									scope: params[2],
									binding_key: params[3],
									expires_at: params[4],
									created_at: params[5],
									updated_at: params[6],
								}
								upsert(
									'value_buckets',
									(existing) =>
										existing['user_id'] === row.user_id &&
										existing['scope'] === row.scope &&
										existing['binding_key'] === row.binding_key,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('INSERT INTO value_entries')) {
								const row = {
									bucket_id: params[0],
									name: params[1],
									description: params[2],
									value: params[3],
									created_at: params[4],
									updated_at: params[5],
								}
								upsert(
									'value_entries',
									(existing) =>
										existing['bucket_id'] === row.bucket_id &&
										existing['name'] === row.name,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('INSERT INTO jobs')) {
								const row = {
									id: params[0],
									user_id: params[1],
									name: params[2],
									source_id: params[3],
									published_commit: params[4],
									repo_check_policy_json: params[5],
									storage_id: params[6],
									params_json: params[7],
									schedule_json: params[8],
									timezone: params[9],
									enabled: params[10],
									kill_switch_enabled: params[11],
									caller_context_json: params[12],
									created_at: params[13],
									updated_at: params[14],
									last_run_at: params[15],
									last_run_status: params[16],
									last_run_error: params[17],
									last_duration_ms: params[18],
									next_run_at: params[19],
									run_count: params[20],
									success_count: params[21],
									error_count: params[22],
								}
								upsert(
									'jobs',
									(existing) =>
										existing['id'] === row.id &&
										existing['user_id'] === row.user_id,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('UPDATE jobs SET')) {
								const existingJob = selectOne(
									'jobs',
									(existing) =>
										existing['id'] === params[20] &&
										existing['user_id'] === params[21],
								)
								const row = {
									id: params[20],
									user_id: params[21],
									name: params[0],
									source_id: params[1],
									published_commit: params[2],
									repo_check_policy_json: params[3],
									storage_id: params[4],
									params_json: params[5],
									schedule_json: params[6],
									timezone: params[7],
									enabled: params[8],
									kill_switch_enabled: params[9],
									caller_context_json: params[10],
									updated_at: params[11],
									last_run_at: params[12],
									last_run_status: params[13],
									last_run_error: params[14],
									last_duration_ms: params[15],
									next_run_at: params[16],
									run_count: params[17],
									success_count: params[18],
									error_count: params[19],
									created_at: existingJob?.['created_at'] ?? params[11],
								}
								upsert(
									'jobs',
									(existing) =>
										existing['id'] === row.id &&
										existing['user_id'] === row.user_id,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('INSERT INTO entity_sources')) {
								const row = {
									id: params[0],
									user_id: params[1],
									entity_kind: params[2],
									entity_id: params[3],
									repo_id: params[4],
									published_commit: params[5],
									indexed_commit: params[6],
									manifest_path: params[7],
									source_root: params[8],
									created_at: params[9],
									updated_at: params[10],
								}
								upsert(
									'entity_sources',
									(existing) => existing['id'] === row.id,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('UPDATE entity_sources')) {
								const existing = selectOne(
									'entity_sources',
									(row) => row['id'] === params[params.length - 2],
								)
								if (!existing) {
									return { meta: { changes: 0, last_row_id: 0 } }
								}
								// Specific update patterns used in tests/codepaths.
								const id = params[params.length - 2]
								const userId = params[params.length - 1]
								upsert(
									'entity_sources',
									(entry) => entry['id'] === id && entry['user_id'] === userId,
									{
										...existing,
										repo_id: params[0] ?? existing['repo_id'],
										published_commit:
											params.length > 3
												? params[1]
												: existing['published_commit'],
										indexed_commit:
											params.length > 3
												? params[2]
												: existing['indexed_commit'],
										manifest_path:
											params.length > 3 ? params[3] : existing['manifest_path'],
										source_root:
											params.length > 4 ? params[4] : existing['source_root'],
										updated_at: params[params.length - 3],
									},
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('DELETE FROM entity_sources')) {
								return {
									meta: {
										changes: deleteWhere(
											'entity_sources',
											(row) =>
												row['id'] === params[0] && row['user_id'] === params[1],
										),
										last_row_id: 0,
									},
								}
							}
							if (query.startsWith('INSERT INTO published_bundle_artifacts')) {
								const row = {
									id: params[0],
									user_id: params[1],
									source_id: params[2],
									published_commit: params[3],
									artifact_kind: params[4],
									artifact_name: params[5],
									entry_point: params[6],
									kv_key: params[7],
									dependencies_json: params[8],
									created_at: params[9],
									updated_at: params[10],
								}
								upsert(
									'published_bundle_artifacts',
									(existing) => existing['id'] === row.id,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('UPDATE published_bundle_artifacts')) {
								const id = params[9]
								const existing = selectOne(
									'published_bundle_artifacts',
									(row) => row['id'] === id,
								)
								if (!existing) {
									return { meta: { changes: 0, last_row_id: 0 } }
								}
								upsert(
									'published_bundle_artifacts',
									(row) => row['id'] === id,
									{
										...existing,
										user_id: params[0],
										source_id: params[1],
										published_commit: params[2],
										artifact_kind: params[3],
										artifact_name: params[4],
										entry_point: params[5],
										kv_key: params[6],
										dependencies_json: params[7],
										updated_at: params[8],
									},
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('DELETE FROM published_bundle_artifacts')) {
								return {
									meta: {
										changes: deleteWhere(
											'published_bundle_artifacts',
											(row) => row['source_id'] === params[0],
										),
										last_row_id: 0,
									},
								}
							}
							if (query.startsWith('INSERT INTO archived_job_artifacts')) {
								const row = {
									id: params[0],
									job_id: params[1],
									user_id: params[2],
									source_id: params[3],
									published_commit: params[4],
									storage_id: params[5],
									retain_until: params[6],
									created_at: params[7],
									updated_at: params[8],
								}
								upsert(
									'archived_job_artifacts',
									(existing) => existing['id'] === row.id,
									row,
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('UPDATE archived_job_artifacts')) {
								const id = params[5]
								const existing = selectOne(
									'archived_job_artifacts',
									(row) => row['id'] === id,
								)
								if (!existing) {
									return { meta: { changes: 0, last_row_id: 0 } }
								}
								upsert('archived_job_artifacts', (row) => row['id'] === id, {
									...existing,
									source_id: params[0],
									published_commit: params[1],
									storage_id: params[2],
									retain_until: params[3],
									updated_at: params[4],
								})
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('DELETE FROM archived_job_artifacts')) {
								return {
									meta: {
										changes: deleteWhere(
											'archived_job_artifacts',
											(row) => row['id'] === params[0],
										),
										last_row_id: 0,
									},
								}
							}
							if (query.startsWith('DELETE FROM jobs')) {
								return {
									meta: {
										changes: deleteWhere(
											'jobs',
											(row) =>
												row['id'] === params[0] && row['user_id'] === params[1],
										),
										last_row_id: 0,
									},
								}
							}
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function createBundleArtifactsKv() {
	const store = new Map<string, string>()
	return {
		async get(key: string, type?: 'text' | 'json') {
			const value = store.get(key) ?? null
			if (value == null) return null
			if (type === 'json') {
				return JSON.parse(value)
			}
			return value
		},
		async put(key: string, value: string | ArrayBuffer | ArrayBufferView) {
			if (typeof value === 'string') {
				store.set(key, value)
				return
			}
			const view =
				value instanceof ArrayBuffer
					? new Uint8Array(value)
					: new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
			store.set(key, Buffer.from(view).toString('utf8'))
		},
		async delete(key: string) {
			store.delete(key)
		},
	} as unknown as KVNamespace
}

async function insertPublishedEntitySource(input: {
	db: ReturnType<typeof createDatabase>
	userId: string
	env?: Env
	kv?: KVNamespace
	sourceId: string
	entityKind?: 'job' | 'package'
	entityId: string
	publishedCommit: string
	manifestPath?: string
	sourceRoot?: string
	files?: Record<string, string>
}) {
	await input.db
		.prepare(
			`INSERT INTO entity_sources (
				id, user_id, entity_kind, entity_id, repo_id, published_commit, indexed_commit,
				manifest_path, source_root, created_at, updated_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.sourceId,
			input.userId,
			input.entityKind ?? 'job',
			input.entityId,
			`${input.entityKind ?? 'job'}-${input.entityId}`,
			input.publishedCommit,
			null,
			input.manifestPath ?? 'kody.json',
			input.sourceRoot ?? '/',
			'2026-04-16T00:00:00.000Z',
			'2026-04-16T00:00:00.000Z',
		)
		.run()
	const snapshotEnv =
		input.env ??
		(input.kv
			? ({
					BUNDLE_ARTIFACTS_KV: input.kv,
				} as Env)
			: null)
	if (snapshotEnv && input.files) {
		const { writePublishedSourceSnapshot } =
			await import('#worker/package-runtime/published-runtime-artifacts.ts')
		await writePublishedSourceSnapshot({
			env: snapshotEnv,
			source: {
				id: input.sourceId,
				user_id: input.userId,
				entity_kind: input.entityKind ?? 'job',
				entity_id: input.entityId,
				repo_id: `${input.entityKind ?? 'job'}-${input.entityId}`,
				published_commit: input.publishedCommit,
				indexed_commit: null,
				manifest_path: input.manifestPath ?? 'kody.json',
				source_root: input.sourceRoot ?? '/',
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
			},
			files: input.files,
		})
	}
}

function createBaseCallerContext(): PersistedJobCallerContext {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
		storageContext: {
			sessionId: null,
			appId: 'app-123',
		},
	}) as PersistedJobCallerContext
}

test('package job sync reports scheduler changes for add, update, and remove only', async () => {
	const env = {
		APP_DB: createDatabase(),
	} as Env
	const input = {
		env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		packageId: 'package-1',
		sourceId: 'source-1',
	}
	const createManifest = (jobs: Record<string, unknown>) =>
		parseAuthoredPackageJson({
			content: JSON.stringify({
				name: '@kentcdodds/cloudflare',
				exports: {
					'.': './index.ts',
				},
				kody: {
					id: 'cloudflare',
					description: 'Cloudflare package',
					jobs,
				},
			}),
		})

	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest({}),
		}),
	).toBe(false)

	const intervalJob = {
		'event-runner': {
			entry: './src/jobs/event-runner.ts',
			schedule: { type: 'interval', every: '1m' },
			timezone: 'America/Denver',
			enabled: true,
		},
	}
	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest(intervalJob),
		}),
	).toBe(true)
	const rowsAfterAdd = await listJobRowsByUserId(env.APP_DB, input.userId)
	expect(rowsAfterAdd).toHaveLength(1)
	const nextRunAtAfterAdd = rowsAfterAdd[0]?.record.nextRunAt

	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest(intervalJob),
		}),
	).toBe(false)
	const rowsAfterNoOp = await listJobRowsByUserId(env.APP_DB, input.userId)
	expect(rowsAfterNoOp[0]?.record.nextRunAt).toBe(nextRunAtAfterAdd)

	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest({
				'event-runner': {
					...intervalJob['event-runner'],
					schedule: { type: 'interval', every: '5m' },
				},
			}),
		}),
	).toBe(true)
	const rowsAfterUpdate = await listJobRowsByUserId(env.APP_DB, input.userId)
	expect(rowsAfterUpdate[0]?.record.schedule).toEqual({
		type: 'interval',
		every: '5m',
	})

	expect(
		await syncPackageJobsForPackage({
			...input,
			manifest: createManifest({}),
		}),
	).toBe(true)
	expect(await listJobRowsByUserId(env.APP_DB, input.userId)).toEqual([])
})

test('create, update, and delete jobs sync the job manager alarm', async () => {
	const env = {
		APP_DB: createDatabase(),
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
	} as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()

	const intervalJob = await createJob({
		env,
		callerContext,
		body: {
			name: 'Deploy Worker',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		} satisfies JobCreateInput,
	})

	expect(intervalJob.schedule).toEqual({
		type: 'interval',
		every: '15m',
	})
	expect(intervalJob.storageId).toBe(`job:${intervalJob.id}`)
	expect(jobManagerMockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: callerContext.user.userId,
	})

	jobManagerMockModule.syncJobManagerAlarm.mockClear()
	const onceJob = await createJob({
		env,
		callerContext,
		body: {
			name: 'Sync job manager on create',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		},
	})
	expect(jobManagerMockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: callerContext.user.userId,
	})
	expect(onceJob.storageId).toBe(`job:${onceJob.id}`)

	jobManagerMockModule.syncJobManagerAlarm.mockClear()
	const created = await createJob({
		env,
		callerContext,
		body: {
			name: 'Sync job manager on update',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})

	await updateJob({
		env,
		callerContext,
		body: {
			id: created.id,
			schedule: {
				type: 'interval',
				every: '30m',
			},
		},
	})

	expect(jobManagerMockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: callerContext.user.userId,
	})
	jobManagerMockModule.syncJobManagerAlarm.mockClear()
	repoMockModule.listRepoSessionsBySource.mockResolvedValueOnce([
		{ id: 'session-1' },
	])
	repoMockModule.cleanupArtifactReposForSource.mockResolvedValueOnce({
		deleted: 1,
		artifactAccessUnavailable: false,
	})

	await deleteJob({
		env,
		userId: callerContext.user.userId,
		jobId: created.id,
	})

	expect(repoMockModule.cleanupArtifactReposForSource).toHaveBeenCalledWith({
		env,
		userId: callerContext.user.userId,
		sourceId: created.sourceId,
	})
	expect(repoMockModule.deleteRepoSessionsBySourceForUser).toHaveBeenCalledWith(
		env.APP_DB,
		{
			userId: callerContext.user.userId,
			sourceId: created.sourceId,
		},
	)
	expect(repoMockModule.cleanupSessionBranch).not.toHaveBeenCalled()
	expect(jobManagerMockModule.syncJobManagerAlarm).toHaveBeenCalledWith({
		env,
		userId: callerContext.user.userId,
	})
})

function createPlanUserCallerContext(input: { userId: string; email: string }) {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: input.userId,
			email: input.email,
			displayName: 'Plan User',
		},
		storageContext: {
			sessionId: null,
			appId: 'app-123',
		},
	}) as PersistedJobCallerContext
}

function buildEntitlementTestJobBody(index: number): JobCreateInput {
	return {
		name: `Quota job ${index}`,
		code: 'export default async () => ({ ok: true })',
		schedule: {
			type: 'interval',
			every: '15m',
		},
	}
}

test('createJob enforces scheduled job entitlements for plan users and denies at the max plan ceiling', async () => {
	const plannedEmail = 'planned@example.com'
	const plannedUserId = await createStableUserIdFromEmail(plannedEmail)
	const plannedEnv = {
		APP_DB: createDatabase({
			users: [{ email: plannedEmail, plan: 'free' }],
		}),
	} as Env
	mockRepoPersistence()
	const plannedCallerContext = createPlanUserCallerContext({
		userId: plannedUserId,
		email: plannedEmail,
	})
	const freeLimit = planLimits.free.maxScheduledJobs

	for (let index = 0; index < freeLimit; index += 1) {
		await createJob({
			env: plannedEnv,
			callerContext: plannedCallerContext,
			body: buildEntitlementTestJobBody(index),
		})
	}

	const freeError = await createJob({
		env: plannedEnv,
		callerContext: plannedCallerContext,
		body: buildEntitlementTestJobBody(freeLimit),
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!isEntitlementLimitError(freeError)) {
		throw new Error('Expected an EntitlementLimitError from createJob.')
	}
	expect(freeError.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'scheduled_jobs',
		plan: 'free',
		limit: freeLimit,
		current: freeLimit,
	})

	const maxEmail = 'max@example.com'
	const maxUserId = await createStableUserIdFromEmail(maxEmail)
	const maxLimit = planLimits.max.maxScheduledJobs
	const belowMaxEnv = {
		APP_DB: createDatabase({
			users: [{ email: maxEmail, plan: 'max' }],
			jobs: Array.from(
				{ length: planLimits.pro.maxScheduledJobs },
				(_, index) => ({
					id: `below-max-job-${index}`,
					user_id: maxUserId,
				}),
			),
		}),
	} as Env
	mockRepoPersistence()
	const maxCallerContext = createPlanUserCallerContext({
		userId: maxUserId,
		email: maxEmail,
	})
	await createJob({
		env: belowMaxEnv,
		callerContext: maxCallerContext,
		body: buildEntitlementTestJobBody(0),
	})

	const atCeilingEnv = {
		APP_DB: createDatabase({
			users: [{ email: maxEmail, plan: 'max' }],
			jobs: Array.from({ length: maxLimit }, (_, index) => ({
				id: `max-job-${index}`,
				user_id: maxUserId,
			})),
		}),
	} as Env
	const maxError = await createJob({
		env: atCeilingEnv,
		callerContext: maxCallerContext,
		body: buildEntitlementTestJobBody(1),
	}).then(
		() => null,
		(thrown: unknown) => thrown,
	)
	if (!isEntitlementLimitError(maxError)) {
		throw new Error('Expected an EntitlementLimitError at the max job ceiling.')
	}
	expect(maxError.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'scheduled_jobs',
		plan: 'max',
		limit: maxLimit,
		current: maxLimit,
	})
})

test('updateJob and deleteJob reject another user trying to mutate or remove a job by id', async () => {
	const env = {
		APP_DB: createDatabase(),
	} as Env
	mockRepoPersistence()
	const ownerCallerContext = createBaseCallerContext()
	const created = await createJob({
		env,
		callerContext: ownerCallerContext,
		body: {
			name: 'Owner job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	const otherCallerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-999',
			email: 'other@example.com',
			displayName: 'Other User',
		},
		storageContext: {
			sessionId: null,
			appId: 'app-999',
		},
	}) as PersistedJobCallerContext

	const updateError = await updateJob({
		env,
		callerContext: otherCallerContext,
		body: {
			id: created.id,
			enabled: false,
		},
	}).catch((caught: unknown) => caught)
	expect(updateError).toBeInstanceOf(McpCallerError)
	expect(updateError).toMatchObject({
		message: `Job "${created.id}" was not found.`,
	})

	let inspection = await getJobInspection({
		env,
		userId: ownerCallerContext.user.userId,
		jobId: created.id,
	})
	expect(inspection.job.enabled).toBe(true)

	const deleteError = await deleteJob({
		env,
		userId: 'user-999',
		jobId: created.id,
	}).catch((caught: unknown) => caught)
	expect(deleteError).toBeInstanceOf(McpCallerError)
	expect(deleteError).toMatchObject({
		message: `Job "${created.id}" was not found.`,
	})

	inspection = await getJobInspection({
		env,
		userId: ownerCallerContext.user.userId,
		jobId: created.id,
	})
	expect(inspection.job.id).toBe(created.id)
})

test('missing job ids throw McpCallerError from get/inspect/run-now', async () => {
	const env = {
		APP_DB: createDatabase(),
	} as Env
	const missingJobId = 'missing-job-id'
	const userId = createBaseCallerContext().user.userId

	const getError = await getJob({
		env,
		userId,
		jobId: missingJobId,
	}).catch((caught: unknown) => caught)
	expect(getError).toBeInstanceOf(McpCallerError)
	expect(getError).toMatchObject({
		message: `Job "${missingJobId}" was not found.`,
	})

	const inspectionError = await getJobInspection({
		env,
		userId,
		jobId: missingJobId,
	}).catch((caught: unknown) => caught)
	expect(inspectionError).toBeInstanceOf(McpCallerError)
	expect(inspectionError).toMatchObject({
		message: `Job "${missingJobId}" was not found.`,
	})

	const runNowError = await runJobNow({
		env,
		userId,
		jobId: missingJobId,
	}).catch((caught: unknown) => caught)
	expect(runNowError).toBeInstanceOf(McpCallerError)
	expect(runNowError).toMatchObject({
		message: `Job "${missingJobId}" was not found.`,
	})
})

test('updateJob clears params, updates timezone, and disables a job', async () => {
	const env = {
		APP_DB: createDatabase(),
	} as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const created = await createJob({
		env,
		callerContext,
		body: {
			name: 'Mutable job',
			code: 'export default async () => ({ ok: true })',
			params: {
				room: 'office',
			},
			schedule: {
				type: 'cron',
				expression: '0 9 * * 1',
			},
			timezone: 'UTC',
		},
	})

	const updated = await updateJob({
		env,
		callerContext,
		body: {
			id: created.id,
			params: null,
			timezone: 'America/Denver',
			enabled: false,
		},
	})

	expect(updated.params).toBeUndefined()
	expect(updated.timezone).toBe('America/Denver')
	expect(updated.enabled).toBe(false)

	const emptyCodeError = await updateJob({
		env,
		callerContext,
		body: {
			id: created.id,
			code: '   ',
		},
	}).catch((caught: unknown) => caught)
	expect(emptyCodeError).toBeInstanceOf(McpCallerError)
	expect(emptyCodeError).toMatchObject({
		message: 'Jobs require non-empty code.',
	})
})

test('createJob and updateJob reject modules without a default export as McpCallerError', async () => {
	const env = {
		APP_DB: createDatabase(),
	} as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const bareArrowSnippet = 'async () => ({ ok: true })'

	const createError = await createJob({
		env,
		callerContext,
		body: {
			name: 'Missing default export',
			code: bareArrowSnippet,
			schedule: {
				type: 'once',
				runAt: new Date(Date.now() + 60_000).toISOString(),
			},
		},
	}).catch((caught: unknown) => caught)

	expect(createError).toBeInstanceOf(McpCallerError)
	expect(createError).toMatchObject({
		message: repoBackedModuleEntrypointExportErrorMessage,
	})

	const created = await createJob({
		env,
		callerContext,
		body: {
			name: 'Mutable job for export check',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'once',
				runAt: new Date(Date.now() + 60_000).toISOString(),
			},
		},
	})

	const updateError = await updateJob({
		env,
		callerContext,
		body: {
			id: created.id,
			code: bareArrowSnippet,
		},
	}).catch((caught: unknown) => caught)

	expect(updateError).toBeInstanceOf(McpCallerError)
	expect(updateError).toMatchObject({
		message: repoBackedModuleEntrypointExportErrorMessage,
	})
})

test('inspectJobsForUser returns persisted job fields with alarm debug state', async () => {
	const env = {
		APP_DB: createDatabase(),
	} as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const created = await createJob({
		env,
		callerContext,
		body: {
			name: 'Inspect recurring job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	const jobRow = await (
		await import('./repo.ts')
	).getJobRowById(env.APP_DB, callerContext.user.userId, created.id)
	if (!jobRow) {
		throw new Error('Expected created job row.')
	}
	jobRow.record.lastRunAt = '2026-04-20T10:05:00.000Z'
	jobRow.record.lastRunStatus = 'error'
	jobRow.record.lastRunError = 'Worker fetch failed'
	jobRow.record.lastDurationMs = 321
	jobRow.record.runCount = 3
	jobRow.record.successCount = 1
	jobRow.record.errorCount = 2
	jobRow.record.nextRunAt = '2026-04-20T10:00:00.000Z'
	jobRow.record.updatedAt = '2026-04-20T10:05:00.000Z'
	await (
		await import('./repo.ts')
	).updateJobRow({
		db: env.APP_DB,
		userId: callerContext.user.userId,
		job: jobRow.record,
		callerContextJson: jobRow.callerContextJson,
	})
	jobManagerMockModule.getJobManagerDebugState.mockResolvedValue({
		bindingAvailable: true,
		status: 'armed',
		storedUserId: callerContext.user.userId,
		alarmScheduledFor: '2026-04-20T10:00:00.000Z',
		nextRunnableJobId: created.id,
		nextRunnableRunAt: '2026-04-20T10:00:00.000Z',
		alarmInSync: true,
	})

	const inspected = await inspectJobsForUser({
		env,
		userId: callerContext.user.userId,
		now: new Date('2026-04-20T10:10:00.000Z'),
	})

	expect(jobManagerMockModule.getJobManagerDebugState).toHaveBeenCalledWith({
		env,
		userId: callerContext.user.userId,
	})
	expect(inspected.alarm).toEqual({
		bindingAvailable: true,
		status: 'armed',
		storedUserId: 'user-123',
		alarmScheduledFor: '2026-04-20T10:00:00.000Z',
		nextRunnableJobId: created.id,
		nextRunnableRunAt: '2026-04-20T10:00:00.000Z',
		alarmInSync: true,
	})
	expect(inspected.jobs).toEqual([
		expect.objectContaining({
			id: created.id,
			name: 'Inspect recurring job',
			sourceId: created.sourceId,
			storageId: created.storageId,
			lastRunAt: '2026-04-20T10:05:00.000Z',
			lastRunStatus: 'error',
			lastRunError: 'Worker fetch failed',
			lastDurationMs: 321,
			runCount: 3,
			successCount: 1,
			errorCount: 2,
		}),
	])
})

test('getJobInspection reports alarm state, source code, and artifact gaps', async () => {
	const env = {
		APP_DB: createDatabase(),
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
	} as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const created = await createJob({
		env,
		callerContext,
		body: {
			name: 'Inspect one job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'once',
				runAt: '2026-04-20T18:30:00Z',
			},
		},
	})
	jobManagerMockModule.getJobManagerDebugState.mockResolvedValue({
		bindingAvailable: true,
		status: 'out_of_sync',
		storedUserId: callerContext.user.userId,
		alarmScheduledFor: '2026-04-20T18:35:00.000Z',
		nextRunnableJobId: created.id,
		nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
		alarmInSync: false,
	})

	const inspected = await getJobInspection({
		env,
		userId: callerContext.user.userId,
		jobId: created.id,
		now: new Date('2026-04-20T18:00:00.000Z'),
	})

	expect(inspected.job).toMatchObject({
		id: created.id,
		name: 'Inspect one job',
		sourceId: created.sourceId,
		storageId: created.storageId,
		lastRunAt: undefined,
		lastRunStatus: undefined,
		lastRunError: undefined,
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	})
	expect(inspected.alarm).toEqual({
		bindingAvailable: true,
		status: 'out_of_sync',
		storedUserId: 'user-123',
		alarmScheduledFor: '2026-04-20T18:35:00.000Z',
		nextRunnableJobId: created.id,
		nextRunnableRunAt: '2026-04-20T18:30:00.000Z',
		alarmInSync: false,
	})
	expect(inspected).not.toHaveProperty('source')

	const code =
		'export default async function main() { return { custom: true } }'
	await insertPublishedEntitySource({
		db: env.APP_DB as ReturnType<typeof createDatabase>,
		env,
		userId: callerContext.user.userId,
		sourceId: created.sourceId,
		entityId: created.id,
		publishedCommit: 'published-commit-2',
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Inspect source job',
				description: 'Job source fixture',
				entrypoint: 'src/custom-job.ts',
			}),
			'src/custom-job.ts': code,
		},
	})

	const inspectedWithSource = await getJobInspection({
		env,
		userId: callerContext.user.userId,
		jobId: created.id,
		includeCode: true,
	})

	expect(inspectedWithSource.source).toEqual({
		entrypoint: 'src/custom-job.ts',
		code,
		error: null,
	})

	const missingEntrypointJob = await createJob({
		env,
		callerContext,
		body: {
			name: 'Missing source job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	await insertPublishedEntitySource({
		db: env.APP_DB as ReturnType<typeof createDatabase>,
		env,
		userId: callerContext.user.userId,
		sourceId: missingEntrypointJob.sourceId,
		entityId: missingEntrypointJob.id,
		publishedCommit: 'published-commit-2',
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Missing source job',
				description: 'Missing entrypoint fixture',
				entrypoint: 'src/missing-job.ts',
			}),
		},
	})

	const missingEntrypointInspection = await getJobInspection({
		env,
		userId: callerContext.user.userId,
		jobId: missingEntrypointJob.id,
		includeCode: true,
	})

	expect(missingEntrypointInspection.job.id).toBe(missingEntrypointJob.id)
	expect(missingEntrypointInspection.source).toEqual({
		entrypoint: 'src/missing-job.ts',
		code: null,
		error: 'Job entrypoint "src/missing-job.ts" was not found.',
	})

	const bundleKv = createBundleArtifactsKv()
	const manifestEnv = {
		APP_DB: createDatabase(),
		BUNDLE_ARTIFACTS_KV: bundleKv,
	} as Env
	const missingManifestJob = await createJob({
		env: manifestEnv,
		callerContext,
		body: {
			name: 'Missing manifest job',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	await insertPublishedEntitySource({
		db: manifestEnv.APP_DB as ReturnType<typeof createDatabase>,
		env: manifestEnv,
		userId: callerContext.user.userId,
		sourceId: missingManifestJob.sourceId,
		entityId: missingManifestJob.id,
		publishedCommit: 'published-commit-2',
	})
	await bundleKv.put(
		buildPublishedSourceSnapshotKvKey({
			sourceId: missingManifestJob.sourceId,
			publishedCommit: 'published-commit-2',
		}),
		JSON.stringify({
			version: 1,
			sourceId: missingManifestJob.sourceId,
			repoId: `job-${missingManifestJob.id}`,
			entityKind: 'job',
			entityId: missingManifestJob.id,
			publishedCommit: 'published-commit-2',
			manifestPath: 'kody.json',
			sourceRoot: '/',
			files: {
				'src/job.ts': 'export default async () => ({ ok: true })',
			},
			createdAt: '2026-04-16T00:00:00.000Z',
		}),
	)

	const missingManifestInspection = await getJobInspection({
		env: manifestEnv,
		userId: callerContext.user.userId,
		jobId: missingManifestJob.id,
		includeCode: true,
	})

	expect(missingManifestInspection.job.id).toBe(missingManifestJob.id)
	expect(missingManifestInspection.source).toEqual({
		entrypoint: null,
		code: null,
		error: 'Job manifest "kody.json" was not found.',
	})
})

test('executeJobOnce binds writable storage and overrides persisted interactive origin', async () => {
	// Usage rollup writes are best-effort and fail against this fake env.
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
		STORAGE_RUNNER: {
			idFromName(name: string) {
				return name as unknown as DurableObjectId
			},
			get() {
				return {
					getValue: async () => ({ key: 'count', value: 2 }),
					setValue: async () => ({ ok: true, key: 'count' }),
					deleteValue: async () => ({ ok: true, key: 'count', deleted: true }),
					clearStorage: async () => ({ ok: true }),
					listValues: async () => ({
						entries: [],
						estimatedBytes: 0,
						truncated: false,
						nextStartAfter: null,
						pageSize: 250,
					}),
					exportStorage: async () => ({
						entries: [],
						estimatedBytes: 0,
						truncated: false,
						nextStartAfter: null,
						pageSize: 250,
					}),
					sqlQuery: async () => ({
						columns: ['value'],
						rows: [{ value: 2 }],
						rowCount: 1,
						rowsRead: 1,
						rowsWritten: 0,
					}),
				}
			},
		},
	} as unknown as Env
	mockRepoPersistence()
	const callerContext = {
		...createBaseCallerContext(),
		executionOrigin: 'interactive' as const,
	}

	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Storage bridge',
			code: 'export default async (params) => { await storage.set("count", params.stepCount); return await storage.sql("select 2 as value") }',
			params: {
				stepCount: 2,
			},
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		},
	})
	await insertPublishedEntitySource({
		db,
		env,
		userId: callerContext.user.userId,
		sourceId: jobView.sourceId,
		entityKind: 'job',
		entityId: jobView.id,
		publishedCommit: 'published-commit-1',
		manifestPath: 'kody.json',
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Storage bridge',
				description: 'Runs once at 2026-04-17T15:00:00.000Z',
				sourceRoot: '/',
				entrypoint: 'src/job.ts',
			}),
			'src/job.ts':
				'export default async (params) => { await storage.set("count", params.stepCount); return await storage.sql("select 2 as value") }',
		},
	})

	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: {
				value: 2,
			},
			logs: ['storage helper executed'],
		})

	try {
		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: `job-runtime-${jobView.id}`,
				source_id: jobView.sourceId,
				source_root: '/',
				base_commit: 'published-commit-1',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'published-commit-1',
				manifest_path: 'package.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(async () => ({
				ok: true,
				results: [],
				manifest: createPackageJobManifest({
					packageName: '@kody/storage-bridge',
					kodyId: 'storage-bridge',
					description: 'Runs from repo',
					jobName: 'Storage bridge',
				}),
			})),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'package.json'
						? createPackageJobManifestText({
								packageName: '@kody/storage-bridge',
								kodyId: 'storage-bridge',
								description: 'Runs from repo',
								jobName: 'Storage bridge',
							})
						: 'export default async (params) => { await storage.set("count", params.stepCount); return await storage.sql("select 2 as value") }',
			})),
			tree: vi.fn(async () => ({
				path: '',
				name: '',
				type: 'directory' as const,
				size: 0,
				children: [
					{
						path: 'src/job.ts',
						name: 'job.ts',
						type: 'file' as const,
						size: 1,
					},
				],
			})),
			discardSession: vi.fn(),
		}
		const repoSessionRpcSpy = vi
			.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
			.mockReturnValue(sessionClient as never)
		const row = await (
			await import('./repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		if (!row) {
			throw new Error('Expected created job row.')
		}
		expect(row.record.storageId).toBe(`job:${jobView.id}`)
		expect(row.callerContext?.executionOrigin).toBe('interactive')
		const outcome = await executeJobOnce({
			env,
			job: row.record,
			callerContext: row.callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: {
				value: 2,
			},
			logs: ['storage helper executed'],
		})
		expect(executeSpy).toHaveBeenCalledWith(
			env,
			expect.objectContaining({
				executionOrigin: 'background',
			}),
			expect.any(Object),
			expect.any(Object),
			expect.any(Object),
		)
		repoSessionRpcSpy.mockRestore()
	} finally {
		executeSpy.mockRestore()
	}
})

test('executeJobOnce runs repo-backed one-off jobs from kody.json manifests', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
		STORAGE_RUNNER: {
			idFromName(name: string) {
				return name as unknown as DurableObjectId
			},
			get() {
				return {
					getValue: async () => ({ key: 'count', value: 2 }),
					setValue: async () => ({ ok: true, key: 'count' }),
					deleteValue: async () => ({ ok: true, key: 'count', deleted: true }),
					clearStorage: async () => ({ ok: true }),
					listValues: async () => ({
						entries: [],
						estimatedBytes: 0,
						truncated: false,
						nextStartAfter: null,
						pageSize: 250,
					}),
					exportStorage: async () => ({
						entries: [],
						estimatedBytes: 0,
						truncated: false,
						nextStartAfter: null,
						pageSize: 250,
					}),
					sqlQuery: async () => ({
						columns: ['value'],
						rows: [{ value: 2 }],
						rowCount: 1,
						rowsRead: 1,
						rowsWritten: 0,
					}),
				}
			},
		},
	} as unknown as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()

	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Capability-created one-off job',
			code: 'export default async () => ({ ok: true, adHoc: true })',
			params: {
				step: 'lights-off',
			},
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		},
	})
	await insertPublishedEntitySource({
		db,
		env,
		userId: callerContext.user.userId,
		sourceId: jobView.sourceId,
		entityKind: 'job',
		entityId: jobView.id,
		publishedCommit: 'published-commit-1',
		manifestPath: 'kody.json',
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Capability-created one-off job',
				description: 'Runs once at 2026-04-17T15:00:00.000Z',
				sourceRoot: '/',
				entrypoint: 'src/job.ts',
			}),
			'src/job.ts': 'export default async () => ({ ok: true, adHoc: true })',
		},
	})

	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: {
				ok: true,
				adHoc: true,
			},
			logs: ['ad hoc job executed'],
		})

	try {
		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: `job-runtime-${jobView.id}`,
				source_id: jobView.sourceId,
				source_root: '/',
				base_commit: 'published-commit-1',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'published-commit-1',
				manifest_path: 'kody.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'kody.json'
						? JSON.stringify({
								version: 1,
								kind: 'job',
								title: 'Capability-created one-off job',
								description: 'Runs once at 2026-04-17T15:00:00.000Z',
								sourceRoot: '/',
								entrypoint: 'src/job.ts',
							})
						: 'export default async () => ({ ok: true, adHoc: true })',
			})),
			tree: vi.fn(async () => ({
				path: '',
				name: '',
				type: 'directory' as const,
				size: 0,
				children: [
					{
						path: 'kody.json',
						name: 'kody.json',
						type: 'file' as const,
						size: 1,
					},
					{
						path: 'src/job.ts',
						name: 'job.ts',
						type: 'file' as const,
						size: 1,
					},
				],
			})),
			discardSession: vi.fn(),
		}
		const repoSessionRpcSpy = vi
			.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
			.mockReturnValue(sessionClient as never)
		const row = await (
			await import('./repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		if (!row) {
			throw new Error('Expected created job row.')
		}
		const outcome = await executeJobOnce({
			env,
			job: row.record,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: {
				ok: true,
				adHoc: true,
			},
			logs: ['ad hoc job executed'],
		})
		expect(sessionClient.runChecks).not.toHaveBeenCalled()
		expect(sessionClient.readFile).not.toHaveBeenCalled()
		expect(executeSpy).toHaveBeenCalledTimes(1)
		expect(executeSpy.mock.calls[0]?.[1]).toMatchObject({
			repoContext: expect.objectContaining({
				entityKind: 'job',
				entityId: jobView.id,
				manifestPath: 'kody.json',
			}),
		})
		expect(executeSpy.mock.calls[0]?.[4]).toMatchObject({
			storageTools: {
				userId: 'user-123',
				storageId: `job:${jobView.id}`,
				writable: true,
			},
			runRecord: {
				surface: 'job',
				name: 'Capability-created one-off job',
				jobId: jobView.id,
				storageId: `job:${jobView.id}`,
				sourceId: jobView.sourceId,
				publishedCommit: 'published-commit-1',
			},
		})
		expect(executeSpy.mock.calls[0]?.[4]).not.toHaveProperty(
			'runRecord.packageId',
		)
		expect(executeSpy.mock.calls[0]?.[4]).not.toHaveProperty('runRecord.kodyId')
		repoSessionRpcSpy.mockRestore()
	} finally {
		executeSpy.mockRestore()
	}
})

test('executeJobOnce preserves kody secret and value semantics', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		COOKIE_SECRET: 'test-secret-0123456789abcdef0123456789',
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
	} as unknown as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()

	await saveSecret({
		env,
		userId: callerContext.user.userId,
		scope: 'user',
		name: 'apiToken',
		value: 'very-secret-token',
		storageContext: callerContext.storageContext,
	})
	await saveValue({
		env,
		userId: callerContext.user.userId,
		scope: 'app',
		name: 'projectId',
		value: 'alpha-project',
		storageContext: callerContext.storageContext,
	})

	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Use kody semantics',
			code: 'export default async () => ({ ok: true })',
			params: {
				step: 'deploy',
			},
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		},
	})
	await insertPublishedEntitySource({
		db,
		env,
		userId: callerContext.user.userId,
		sourceId: jobView.sourceId,
		entityKind: 'job',
		entityId: jobView.id,
		publishedCommit: 'published-commit-1',
		manifestPath: 'kody.json',
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Use kody semantics',
				description: 'Runs once at 2026-04-17T15:00:00.000Z',
				sourceRoot: '/',
				entrypoint: 'src/job.ts',
			}),
			'src/job.ts': 'export default async () => ({ ok: true })',
		},
	})

	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: {
				secretValue: 'very-secret-token',
				value: 'alpha-project',
				userId: 'user-123',
				storageId: `job:${jobView.id}`,
			},
			logs: ['kody executed'],
		})

	try {
		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: `job-runtime-${jobView.id}`,
				source_id: jobView.sourceId,
				source_root: '/',
				base_commit: 'published-commit-1',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'published-commit-1',
				manifest_path: 'package.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(async () => ({
				ok: true,
				results: [],
				manifest: createPackageJobManifest({
					packageName: '@kody/kody-semantics',
					kodyId: 'kody-semantics',
					description: 'Runs from repo',
					jobName: 'Use kody semantics',
				}),
			})),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'package.json'
						? createPackageJobManifestText({
								packageName: '@kody/kody-semantics',
								kodyId: 'kody-semantics',
								description: 'Runs from repo',
								jobName: 'Use kody semantics',
							})
						: 'export default async () => ({ ok: true })',
			})),
			tree: vi.fn(async () => ({
				path: '',
				name: '',
				type: 'directory' as const,
				size: 0,
				children: [
					{
						path: 'src/job.ts',
						name: 'job.ts',
						type: 'file' as const,
						size: 1,
					},
				],
			})),
			discardSession: vi.fn(),
		}
		const repoSessionRpcSpy = vi
			.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
			.mockReturnValue(sessionClient as never)
		const row = await (
			await import('./repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		if (!row) {
			throw new Error('Expected created job row.')
		}
		const outcome = await executeJobOnce({
			env,
			job: row.record,
			callerContext,
		})

		expect(executeSpy).toHaveBeenCalledTimes(1)

		expect(outcome.execution).toEqual({
			ok: true,
			result: {
				secretValue: 'very-secret-token',
				value: 'alpha-project',
				userId: 'user-123',
				storageId: `job:${jobView.id}`,
			},
			logs: ['kody executed'],
		})
		expect(executeSpy.mock.calls[0]?.[2]).toMatchObject({
			mainModule: 'dist/bundled-entry.js',
		})
		repoSessionRpcSpy.mockRestore()
	} finally {
		executeSpy.mockRestore()
	}
})

test('executeJobOnce refreshes repo sessions when base commit moves', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-1',
		entityKind: 'package',
		entityId: 'job-repo-1',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
		files: {
			'package.json': createPackageJobManifestText({
				packageName: '@kody/repo-backed-job',
				kodyId: 'repo-backed-job',
				description: 'Runs from repo',
				jobName: 'Repo-backed job',
				entry: './src/job.ts',
			}),
			'src/job.ts':
				'export default async () => ({ ok: true, repoBacked: true })',
		},
		env: {
			APP_DB: db,
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
	})
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-1',
		userId: callerContext.user.userId,
		name: 'Repo-backed job',
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		storageId: 'job:job-repo-1',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
	const sessionClient = {
		openSession: vi
			.fn()
			.mockResolvedValueOnce({
				id: 'job-runtime-job-repo-1',
				source_id: 'source-1',
				source_root: '/',
				base_commit: 'base-1',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'commit-1',
				manifest_path: 'package.json',
				entity_type: 'job',
			})
			.mockResolvedValueOnce({
				id: 'job-runtime-job-repo-1',
				source_id: 'source-1',
				source_root: '/',
				base_commit: 'commit-1',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'commit-1',
				manifest_path: 'package.json',
				entity_type: 'job',
			}),
		runChecks: vi.fn(async () => ({
			ok: true,
			results: [],
			manifest: createPackageJobManifest({
				packageName: '@kody/repo-backed-job',
				kodyId: 'repo-backed-job',
				description: 'Runs from repo',
				jobName: 'Repo-backed job',
				entry: './src/job.ts',
			}),
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? createPackageJobManifestText({
							packageName: '@kody/repo-backed-job',
							kodyId: 'repo-backed-job',
							description: 'Runs from repo',
							jobName: 'Repo-backed job',
							entry: './src/job.ts',
						})
					: 'export default async () => ({ ok: true, repoBacked: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'job-runtime-job-repo-1',
			deleted: true,
		})),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true, repoBacked: true },
			logs: ['repo-backed kody executed'],
		})

	try {
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: { ok: true, repoBacked: true },
			logs: ['repo-backed kody executed'],
		})
		expect(executeSpy).toHaveBeenCalledTimes(1)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('executeJobOnce rebuilds stale published job bundles after the source commit changes', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-stale-bundle',
		entityKind: 'job',
		entityId: 'job-stale-bundle',
		publishedCommit: 'commit-1',
		manifestPath: 'kody.json',
		kv: bundleKv,
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Stale bundle job',
				description: 'Runs stale bundle test',
				keywords: ['job'],
				searchText: 'Runs stale bundle test',
				entrypoint: 'src/job.ts',
			}),
			'src/job.ts': 'export default async () => ({ version: "old" })',
		},
	})
	const { persistPublishedBundleArtifact } =
		await import('#worker/package-runtime/published-bundle-artifacts.ts')
	const source = await (
		await import('#worker/repo/entity-sources.ts')
	).getEntitySourceById(db, 'source-stale-bundle')
	if (!source) {
		throw new Error('Expected source row.')
	}
	await persistPublishedBundleArtifact({
		env: {
			APP_DB: db,
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
		userId: 'user-123',
		source,
		kind: 'job',
		artifactName: 'job-stale-bundle',
		entryPoint: 'src/job.ts',
		mainModule: 'dist/bundled-entry.js',
		modules: {
			'dist/bundled-entry.js':
				'export default async () => ({ version: "old-bundle" })',
		},
		dependencies: [],
		packageContext: null,
	})
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-stale-bundle',
		entityKind: 'job',
		entityId: 'job-stale-bundle',
		publishedCommit: 'commit-2',
		manifestPath: 'kody.json',
		kv: bundleKv,
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Stale bundle job',
				description: 'Runs stale bundle test',
				keywords: ['job'],
				searchText: 'Runs stale bundle test',
				entrypoint: 'src/job.ts',
			}),
			'src/job.ts':
				'export default async () => { console.log("canary"); return { version: "new" } }',
		},
	})
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-stale-bundle',
		userId: callerContext.user.userId,
		name: 'Stale bundle job',
		sourceId: 'source-stale-bundle',
		publishedCommit: 'commit-2',
		storageId: 'job:job-stale-bundle',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true, version: 'new' },
			logs: ['canary'],
		})

	try {
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: { ok: true, version: 'new' },
			logs: ['canary'],
		})
		expect(executeSpy).toHaveBeenCalledTimes(1)
		const executedBundle = executeSpy.mock.calls[0]?.[2]
		const executedModules = Object.values(executedBundle?.modules ?? {}).join(
			'\n',
		)
		expect(executedModules).toContain('userEntrypoint')
		expect(executedModules).not.toContain('old-bundle')
	} finally {
		executeSpy.mockRestore()
	}
})

test('executeJobOnce executes package-backed jobs from published artifacts', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-strict',
		entityKind: 'package',
		entityId: 'job-repo-typecheck-strict',
		publishedCommit: 'commit-strict',
		manifestPath: 'package.json',
		kv: bundleKv,
		files: {
			'package.json': createPackageJobManifestText({
				packageName: '@kody/repo-typecheck-strict',
				kodyId: 'repo-typecheck-strict',
				description: 'Runs from repo',
				jobName: 'Repo-backed strict typecheck job',
				entry: './src/custom-job.ts',
			}),
			'src/custom-job.ts': 'export default async () => ({ ok: true })',
		},
	})
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-typecheck-strict',
		userId: callerContext.user.userId,
		name: 'Repo-backed strict typecheck job',
		sourceId: 'source-strict',
		publishedCommit: 'commit-strict',
		storageId: 'job:job-repo-typecheck-strict',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-typecheck-strict',
			source_id: 'source-strict',
			source_root: '/',
			base_commit: 'commit-strict',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-strict',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: false,
			results: [
				{
					kind: 'typecheck' as const,
					ok: false,
					message: "src/custom-job.ts:1:28 Cannot find name 'kody'.",
				},
			],
			manifest: createPackageJobManifest({
				packageName: '@kody/repo-typecheck-strict',
				kodyId: 'repo-typecheck-strict',
				description: 'Runs from repo',
				jobName: 'Repo-backed strict typecheck job',
				entry: './src/custom-job.ts',
			}),
			runId: 'check-run-strict',
			treeHash: 'tree-hash-strict',
			checkedAt: '2026-04-16T00:00:00.000Z',
		})),
		readFile: vi.fn(),
		discardSession: vi.fn(),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true, repoBacked: true },
			logs: ['repo-backed kody executed'],
		})

	try {
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: { ok: true, repoBacked: true },
			logs: ['repo-backed kody executed'],
		})
		expect(sessionClient.readFile).not.toHaveBeenCalled()
		expect(executeSpy).toHaveBeenCalledTimes(1)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('executeJobOnce bypasses typecheck-only failures when the stored repo policy allows it', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-bypass',
		entityKind: 'package',
		entityId: 'job-repo-typecheck-bypass',
		publishedCommit: 'commit-bypass',
		manifestPath: 'package.json',
		files: {
			'package.json': createPackageJobManifestText({
				packageName: '@kody/repo-typecheck-bypass',
				kodyId: 'repo-typecheck-bypass',
				description: 'Runs from repo',
				jobName: 'Repo-backed bypass typecheck job',
			}),
			'src/job.ts': 'export default async () => ({ ok: true, bypassed: true })',
		},
		env: {
			APP_DB: db,
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
	})
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-typecheck-bypass',
		userId: callerContext.user.userId,
		name: 'Repo-backed bypass typecheck job',
		sourceId: 'source-bypass',
		publishedCommit: 'commit-bypass',
		repoCheckPolicy: {
			allowTypecheckFailures: true,
		},
		storageId: 'job:job-repo-typecheck-bypass',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-typecheck-bypass',
			source_id: 'source-bypass',
			source_root: '/',
			base_commit: 'commit-bypass',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-bypass',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: false,
			results: [
				{
					kind: 'typecheck' as const,
					ok: false,
					message: "src/job.ts:1:28 Cannot find name 'kody'.",
				},
			],
			manifest: createPackageJobManifest({
				packageName: '@kody/repo-typecheck-bypass',
				kodyId: 'repo-typecheck-bypass',
				description: 'Runs from repo',
				jobName: 'Repo-backed bypass typecheck job',
			}),
			runId: 'check-run-bypass',
			treeHash: 'tree-hash-bypass',
			checkedAt: '2026-04-16T00:00:00.000Z',
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? createPackageJobManifestText({
							packageName: '@kody/repo-typecheck-bypass',
							kodyId: 'repo-typecheck-bypass',
							description: 'Runs from repo',
							jobName: 'Repo-backed bypass typecheck job',
						})
					: 'export default async () => ({ ok: true, bypassed: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true, bypassed: true },
			logs: ['repo-backed kody executed'],
		})

	try {
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: { ok: true, bypassed: true },
			logs: ['repo-backed kody executed'],
		})
		expect(executeSpy).toHaveBeenCalledTimes(1)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('executeJobOnce preserves bypass audit logs when execution fails after a typecheck-only bypass', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-bypass-failure',
		entityKind: 'package',
		entityId: 'job-repo-typecheck-bypass-failure',
		publishedCommit: 'commit-bypass-failure',
		manifestPath: 'package.json',
		files: {
			'package.json': createPackageJobManifestText({
				packageName: '@kody/repo-bypass-failure',
				kodyId: 'repo-bypass-failure',
				description: 'Runs from repo',
				jobName: 'Repo-backed bypass failure job',
			}),
			'src/job.ts': 'export default async () => ({ ok: true, bypassed: true })',
		},
		env: {
			APP_DB: db,
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
	})
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-typecheck-bypass-failure',
		userId: callerContext.user.userId,
		name: 'Repo-backed bypass failure job',
		code: null,
		sourceId: 'source-bypass-failure',
		publishedCommit: 'commit-bypass-failure',
		repoCheckPolicy: {
			allowTypecheckFailures: true,
		},
		storageId: 'job:job-repo-typecheck-bypass-failure',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-typecheck-bypass-failure',
			source_id: 'source-bypass-failure',
			source_root: '/',
			base_commit: 'commit-bypass-failure',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-bypass-failure',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: false,
			results: [
				{
					kind: 'typecheck' as const,
					ok: false,
					message: "src/job.ts:1:28 Cannot find name 'kody'.",
				},
			],
			manifest: createPackageJobManifest({
				packageName: '@kody/repo-bypass-failure',
				kodyId: 'repo-bypass-failure',
				description: 'Runs from repo',
				jobName: 'Repo-backed bypass failure job',
			}),
			runId: 'check-run-bypass-failure',
			treeHash: 'tree-hash-bypass-failure',
			checkedAt: '2026-04-16T00:00:00.000Z',
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? createPackageJobManifestText({
							packageName: '@kody/repo-bypass-failure',
							kodyId: 'repo-bypass-failure',
							description: 'Runs from repo',
							jobName: 'Repo-backed bypass failure job',
						})
					: 'export default async () => ({ ok: true, bypassed: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi.spyOn(
		await import('#mcp/run-kody-registry.ts'),
		'runBundledModuleWithRegistry',
	)
	const formatJobErrorSpy = vi.spyOn(
		await import('./schedule.ts'),
		'formatJobError',
	)

	try {
		executeSpy.mockRejectedValueOnce(new Error('Executor import failed'))

		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: false,
			error: 'Executor import failed',
			logs: [],
		})
		expect(formatJobErrorSpy).toHaveBeenCalled()
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
		formatJobErrorSpy.mockRestore()
	}
})

test('executeJobOnce succeeds for repo-backed jobs with repo-session absolute paths and migrated entrypoints', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-absolute-paths',
		entityKind: 'package',
		entityId: 'job-repo-absolute-paths',
		publishedCommit: 'commit-absolute',
		manifestPath: 'package.json',
		files: {
			'package.json': createPackageJobManifestText({
				packageName: '@kody/repo-absolute-path-job',
				kodyId: 'repo-absolute-path-job',
				description: 'Runs from repo session files',
				jobName: 'Repo-backed absolute path job',
				exportPath: './src/job.ts',
			}),
			'src/job.ts':
				'export default async () => ({ ok: true, normalized: true })',
		},
		env: {
			APP_DB: db,
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
	})
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-absolute-paths',
		userId: callerContext.user.userId,
		name: 'Repo-backed absolute path job',
		code: null,
		sourceId: 'source-absolute-paths',
		publishedCommit: 'commit-absolute',
		storageId: 'job:job-repo-absolute-paths',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}

	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-absolute-paths',
			source_id: 'source-absolute-paths',
			source_root: '/',
			base_commit: 'commit-absolute',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-absolute',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => {
			const { runRepoChecks } = await import('#worker/repo/checks.ts')
			return runRepoChecks({
				workspace: {
					async readFile(path: string) {
						const file = workspaceFiles.get(path)
						return file ?? workspaceFiles.get(path.replace(/^\/+/, '')) ?? null
					},
					async glob() {
						return Array.from(workspaceFiles.keys()).map((path) => ({
							path,
							type: 'file',
						}))
					},
				},
				manifestPath: '/session/package.json',
				sourceRoot: '/session/',
			})
		}),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? createPackageJobManifestText({
							packageName: '@kody/repo-absolute-path-job',
							kodyId: 'repo-absolute-path-job',
							description: 'Runs from repo session files',
							jobName: 'Repo-backed absolute path job',
							exportPath: './src/job.ts',
						})
					: 'export default async () => ({ ok: true, normalized: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
				{
					path: 'package.json',
					name: 'package.json',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'job-runtime-job-repo-absolute-paths',
			deleted: true,
		})),
	}
	const workspaceFiles = new Map<string, string>([
		[
			'/session/package.json',
			createPackageJobManifestText({
				packageName: '@kody/repo-absolute-path-job',
				kodyId: 'repo-absolute-path-job',
				description: 'Runs from repo session files',
				jobName: 'Repo-backed absolute path job',
				exportPath: './src/job.ts',
			}),
		],
		['/session/src/job.ts', 'export default async () => ({ ok: true })\n'],
	])

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true, normalized: true },
			logs: ['repo-backed kody executed'],
		})

	try {
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: { ok: true, normalized: true },
			logs: ['repo-backed kody executed'],
		})
		expect(executeSpy).toHaveBeenCalledTimes(1)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('executeJobOnce fails instead of reusing a stale repo session when discard fails', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-1',
		entityKind: 'package',
		entityId: 'job-repo-discard-failure',
		publishedCommit: 'commit-1',
		manifestPath: 'package.json',
	})
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-discard-failure',
		userId: callerContext.user.userId,
		name: 'Repo-backed job discard failure',
		code: null,
		sourceId: 'source-1',
		publishedCommit: 'commit-1',
		storageId: 'job:job-repo-discard-failure',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}

	const discardFailure = new Error('D1 delete failed')
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-discard-failure',
			source_id: 'source-1',
			source_root: '/',
			base_commit: 'base-1',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-1',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(),
		readFile: vi.fn(),
		discardSession: vi.fn(async () => {
			throw discardFailure
		}),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const formatJobErrorSpy = vi.spyOn(
		await import('./schedule.ts'),
		'formatJobError',
	)
	const executeSpy = vi.spyOn(
		await import('#mcp/run-kody-registry.ts'),
		'runBundledModuleWithRegistry',
	)

	try {
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: false,
			error:
				'Published snapshot for source "source-1" at commit "commit-1" was not found.',
			logs: [],
		})
		expect(executeSpy).not.toHaveBeenCalled()
		expect(formatJobErrorSpy).toHaveBeenCalled()
	} finally {
		repoSessionRpcSpy.mockRestore()
		formatJobErrorSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('executeJobOnce bundles and runs ESM repo-backed job entrypoints', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-job-repo-module',
		entityKind: 'package',
		entityId: 'job-repo-module',
		publishedCommit: 'commit-abc',
		manifestPath: 'package.json',
		env: {
			APP_DB: db,
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
		files: {
			'package.json': createPackageJobManifestText({
				packageName: '@kody/repo-module-job',
				kodyId: 'repo-module-job',
				description: 'Runs from repo',
				jobName: 'Repo-backed module job',
			}),
			'src/job.ts':
				'export default async () => ({ ok: true, repoBacked: "module" })',
			'src/lib.ts': 'export const value = 1',
		},
	})
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-repo-module',
		userId: callerContext.user.userId,
		name: 'Repo-backed module job',
		code: null,
		sourceId: 'source-job-repo-module',
		publishedCommit: 'commit-abc',
		storageId: 'job:job-repo-module',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}

	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: 'job-runtime-job-repo-module',
			source_id: 'source-job-repo-module',
			source_root: '/',
			base_commit: 'commit-abc',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-abc',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: true,
			results: [],
			manifest: createPackageJobManifest({
				packageName: '@kody/repo-module-job',
				kodyId: 'repo-module-job',
				description: 'Runs from repo',
				jobName: 'Repo-backed module job',
			}),
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? createPackageJobManifestText({
							packageName: '@kody/repo-module-job',
							kodyId: 'repo-module-job',
							description: 'Runs from repo',
							jobName: 'Repo-backed module job',
						})
					: 'export default async () => ({ ok: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
				{
					path: 'src/lib.ts',
					name: 'lib.ts',
					type: 'file' as const,
					size: 1,
				},
				{
					path: 'package.json',
					name: 'package.json',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(async () => ({
			ok: true as const,
			sessionId: 'job-runtime-job-repo-module',
			deleted: true,
		})),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi.spyOn(
		await import('#mcp/run-kody-registry.ts'),
		'runBundledModuleWithRegistry',
	)
	const bundleSpy = vi.spyOn(
		await import('#worker/package-runtime/module-graph.ts'),
		'buildKodyModuleBundle',
	)
	const loadFilesSpy = vi.spyOn(
		await import('#worker/repo/repo-kody-execution.ts'),
		'loadRepoSourceFilesFromSession',
	)

	try {
		loadFilesSpy.mockResolvedValue({
			'package.json': JSON.stringify({
				name: 'repo-module-job',
				private: true,
			}),
			'src/job.ts':
				'export default async () => ({ ok: true, repoBacked: "module" })',
			'src/lib.ts': 'export const value = 1',
		})
		bundleSpy.mockResolvedValue({
			mainModule: 'dist/job.js',
			modules: {
				'dist/job.js':
					'export default async () => ({ ok: true, repoBacked: "module" })',
			},
			dependencies: [],
		})
		executeSpy.mockResolvedValue({
			result: { ok: true, repoBacked: 'module' },
			logs: ['repo-backed kody executed'],
		})
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})

		expect(outcome.execution).toEqual({
			ok: true,
			result: { ok: true, repoBacked: 'module' },
			logs: ['repo-backed kody executed'],
		})
		expect(executeSpy).toHaveBeenCalledTimes(1)
		expect(executeSpy.mock.calls[0]?.[4]).toMatchObject({
			storageTools: {
				userId: 'user-123',
				storageId: 'job:job-repo-module',
				writable: true,
			},
			packageContext: {
				packageId: 'job-repo-module',
				kodyId: 'repo-module-job',
			},
		})
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
		bundleSpy.mockRestore()
		loadFilesSpy.mockRestore()
	}
})

test('executeJobOnce returns an error when kody secret policy would reject execution', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-secret-policy',
		entityKind: 'package',
		entityId: 'job-1',
		publishedCommit: 'commit-secret-policy',
		manifestPath: 'package.json',
		files: {
			'package.json': createPackageJobManifestText({
				packageName: '@kody/forbidden-secret-access',
				kodyId: 'forbidden-secret-access',
				description: 'Runs from repo',
				jobName: 'Forbidden secret access',
			}),
			'src/job.ts': 'export default async () => ({ ok: true })',
		},
		env: {
			APP_DB: db,
			BUNDLE_ARTIFACTS_KV: bundleKv,
		} as Env,
	})
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	const job: JobRecord = {
		version: 1,
		id: 'job-1',
		userId: callerContext.user.userId,
		name: 'Forbidden secret access',
		sourceId: 'source-secret-policy',
		publishedCommit: 'commit-secret-policy',
		storageId: 'job:job-1',
		schedule: {
			type: 'once',
			runAt: '2026-04-17T15:00:00Z',
		},
		timezone: 'UTC',
		enabled: true,
		killSwitchEnabled: false,
		createdAt: '2026-04-16T00:00:00.000Z',
		updatedAt: '2026-04-16T00:00:00.000Z',
		nextRunAt: '2026-04-17T15:00:00.000Z',
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}

	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			error: createCapabilitySecretAccessDeniedMessage(
				'apiToken',
				'secret_set',
				'https://example.com/account/secrets/user/apiToken?capability=secret_set',
			),
			logs: [],
		})

	try {
		const sessionClient = {
			openSession: vi.fn(async () => ({
				id: 'job-runtime-job-1',
				source_id: 'source-secret-policy',
				source_root: '/',
				base_commit: 'commit-secret-policy',
				conversation_id: null,
				last_checkpoint_commit: null,
				last_check_run_id: null,
				last_check_tree_hash: null,
				expires_at: null,
				created_at: '2026-04-16T00:00:00.000Z',
				updated_at: '2026-04-16T00:00:00.000Z',
				published_commit: 'commit-secret-policy',
				manifest_path: 'package.json',
				entity_type: 'job' as const,
			})),
			runChecks: vi.fn(async () => ({
				ok: true,
				results: [],
				manifest: createPackageJobManifest({
					packageName: '@kody/forbidden-secret-access',
					kodyId: 'forbidden-secret-access',
					description: 'Runs from repo',
					jobName: 'Forbidden secret access',
				}),
			})),
			readFile: vi.fn(async ({ path }: { path: string }) => ({
				path,
				content:
					path === 'package.json'
						? createPackageJobManifestText({
								packageName: '@kody/forbidden-secret-access',
								kodyId: 'forbidden-secret-access',
								description: 'Runs from repo',
								jobName: 'Forbidden secret access',
							})
						: 'export default async () => ({ ok: true })',
			})),
			tree: vi.fn(async () => ({
				path: '',
				name: '',
				type: 'directory' as const,
				size: 0,
				children: [
					{
						path: 'src/job.ts',
						name: 'job.ts',
						type: 'file' as const,
						size: 1,
					},
				],
			})),
			discardSession: vi.fn(),
		}
		const repoSessionRpcSpy = vi
			.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
			.mockReturnValue(sessionClient as never)
		const outcome = await executeJobOnce({
			env,
			job,
			callerContext,
		})
		expect(outcome.execution).toEqual({
			ok: false,
			error:
				'Secret "apiToken" is not allowed for capability "secret_set". If this capability should be able to use the secret, ask the user whether to approve that capability in the account secrets UI, then retry after they approve that policy change. Approval link: https://example.com/account/secrets/user/apiToken?capability=secret_set',
			logs: [],
		})
		repoSessionRpcSpy.mockRestore()
	} finally {
		executeSpy.mockRestore()
	}
})

test('runJobNow deletes vectors for once jobs', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	const bundleKv = createBundleArtifactsKv()
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: bundleKv,
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
	} as Env & { CAPABILITY_VECTOR_INDEX?: Pick<VectorizeIndex, 'deleteByIds'> }
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Run once and delete vector',
			code: 'export default async () => ({ ok: true })',
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		},
	})
	const deleteByIds = vi.fn(async () => {})
	env.CAPABILITY_VECTOR_INDEX = {
		deleteByIds,
	}
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: `job-runtime-${jobView.id}`,
			source_id: `${jobView.id}`,
			source_root: '/',
			base_commit: 'published-commit-1',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'published-commit-1',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: true,
			results: [],
			manifest: {
				name: '@kody/run-once',
				exports: {
					'.': './src/index.ts',
				},
				kody: {
					id: 'run-once',
					description: 'Runs from repo',
					jobs: {
						'Run once and delete vector': {
							entry: './src/job.ts',
							schedule: {
								type: 'once',
								runAt: '2026-04-17T15:00:00Z',
							},
						},
					},
				},
			},
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? JSON.stringify({
							name: '@kody/run-once',
							exports: {
								'.': './src/index.ts',
							},
							kody: {
								id: 'run-once',
								description: 'Runs from repo',
								jobs: {
									'Run once and delete vector': {
										entry: './src/job.ts',
										schedule: {
											type: 'once',
											runAt: '2026-04-17T15:00:00Z',
										},
									},
								},
							},
						})
					: 'export default async () => ({ ok: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(),
	}
	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true },
			logs: [],
		})

	try {
		const result = await runJobNow({
			env: env as Env,
			userId: callerContext.user.userId,
			jobId: jobView.id,
			callerContext,
		})
		expect(result.execution).toEqual({
			ok: true,
			result: { ok: true },
			logs: [],
		})
		expect(deleteByIds).toHaveBeenCalledWith([`job_${jobView.id}`])
		const row = await (
			await import('./repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		expect(row).toBeNull()
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('runJobNow can use a one-off repo check policy override without changing the stored job', async () => {
	silenceIncidentalRuntimeWarnings()
	const db = createDatabase()
	await insertPublishedEntitySource({
		db,
		userId: 'user-123',
		sourceId: 'source-run-now-override',
		entityKind: 'package',
		entityId: 'job-repo-run-now-override',
		publishedCommit: 'commit-run-now-override',
		manifestPath: 'package.json',
	})
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
		LOADER: {} as WorkerLoader,
	} as Env
	const callerContext = createBaseCallerContext()
	mockRepoPersistence()
	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Repo-backed run-now override',
			code: 'export default async () => ({ ok: true })',
			sourceId: 'source-run-now-override',
			publishedCommit: 'commit-run-now-override',
			schedule: {
				type: 'interval',
				every: '15m',
			},
		},
	})
	await insertPublishedEntitySource({
		db,
		env,
		userId: callerContext.user.userId,
		sourceId: jobView.sourceId,
		entityKind: 'job',
		entityId: jobView.id,
		publishedCommit: 'published-commit-1',
		manifestPath: 'kody.json',
		files: buildJobSourceFiles({
			job: jobView,
			moduleSource:
				'export default async function run() { return { ok: true, override: true } }',
		}),
	})

	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: `job-runtime-${jobView.id}`,
			source_id: 'source-run-now-override',
			source_root: '/',
			base_commit: 'commit-run-now-override',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'commit-run-now-override',
			manifest_path: 'package.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(async () => ({
			ok: false,
			results: [
				{
					kind: 'typecheck' as const,
					ok: false,
					message: "src/job.ts:1:28 Cannot find name 'kody'.",
				},
			],
			manifest: {
				name: '@kody/run-now-override',
				exports: {
					'.': './src/index.ts',
				},
				kody: {
					id: 'run-now-override',
					description: 'Runs from repo',
					jobs: {
						'Repo-backed run-now override': {
							entry: './src/job.ts',
							schedule: {
								type: 'interval',
								every: '15m',
							},
						},
					},
				},
			},
			runId: 'check-run-run-now-override',
			treeHash: 'tree-hash-run-now-override',
			checkedAt: '2026-04-16T00:00:00.000Z',
		})),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'package.json'
					? JSON.stringify({
							name: '@kody/run-now-override',
							exports: {
								'.': './src/index.ts',
							},
							kody: {
								id: 'run-now-override',
								description: 'Runs from repo',
								jobs: {
									'Repo-backed run-now override': {
										entry: './src/job.ts',
										schedule: {
											type: 'interval',
											every: '15m',
										},
									},
								},
							},
						})
					: 'export default async () => ({ ok: true, override: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(),
	}

	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValue({
			result: { ok: true, override: true },
			logs: ['repo-backed kody executed'],
		})

	try {
		const result = await runJobNow({
			env,
			userId: callerContext.user.userId,
			jobId: jobView.id,
			callerContext,
			repoCheckPolicyOverride: {
				allowTypecheckFailures: true,
			},
		})

		expect(result.execution).toEqual({
			ok: true,
			result: { ok: true, override: true },
			logs: ['repo-backed kody executed'],
		})
		const row = await (
			await import('./repo.ts')
		).getJobRowById(db, callerContext.user.userId, jobView.id)
		expect(row?.record.repoCheckPolicy).toBeUndefined()
		expect(executeSpy).toHaveBeenCalledTimes(1)
	} finally {
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})

test('executeJobOnce records job_run usage for success and failure without changing execution outcomes', async () => {
	const usageModule = await import('#worker/usage/record-usage.ts')
	const recordUsageSpy = vi
		.spyOn(usageModule, 'recordUsage')
		.mockResolvedValue(undefined)
	const db = createDatabase()
	const env = {
		APP_DB: db,
		CLOUDFLARE_ACCOUNT_ID: 'acct-test',
		CLOUDFLARE_API_TOKEN: 'token-test',
		BUNDLE_ARTIFACTS_KV: createBundleArtifactsKv(),
		LOADER: {} as WorkerLoader,
		REPO_SESSION: {} as DurableObjectNamespace,
		STORAGE_RUNNER: {
			idFromName(name: string) {
				return name as unknown as DurableObjectId
			},
			get() {
				return {
					getValue: async () => ({ key: 'count', value: 2 }),
					setValue: async () => ({ ok: true, key: 'count' }),
					deleteValue: async () => ({ ok: true, key: 'count', deleted: true }),
					clearStorage: async () => ({ ok: true }),
					listValues: async () => ({
						entries: [],
						estimatedBytes: 0,
						truncated: false,
						nextStartAfter: null,
						pageSize: 250,
					}),
					exportStorage: async () => ({
						entries: [],
						estimatedBytes: 0,
						truncated: false,
						nextStartAfter: null,
						pageSize: 250,
					}),
					sqlQuery: async () => ({
						columns: ['value'],
						rows: [{ value: 2 }],
						rowCount: 1,
						rowsRead: 1,
						rowsWritten: 0,
					}),
				}
			},
		},
	} as unknown as Env
	mockRepoPersistence()
	const callerContext = createBaseCallerContext()
	const jobView = await createJob({
		env,
		callerContext,
		body: {
			name: 'Usage-metered job',
			code: 'export default async () => ({ ok: true, metered: true })',
			schedule: {
				type: 'once',
				runAt: '2026-04-17T15:00:00Z',
			},
		},
	})
	await insertPublishedEntitySource({
		db,
		env,
		userId: callerContext.user.userId,
		sourceId: jobView.sourceId,
		entityKind: 'job',
		entityId: jobView.id,
		publishedCommit: 'published-commit-1',
		manifestPath: 'kody.json',
		files: {
			'kody.json': JSON.stringify({
				version: 1,
				kind: 'job',
				title: 'Usage-metered job',
				description: 'Runs once at 2026-04-17T15:00:00.000Z',
				sourceRoot: '/',
				entrypoint: 'src/job.ts',
			}),
			'src/job.ts': 'export default async () => ({ ok: true, metered: true })',
		},
	})
	const executeSpy = vi
		.spyOn(
			await import('#mcp/run-kody-registry.ts'),
			'runBundledModuleWithRegistry',
		)
		.mockResolvedValueOnce({
			result: {
				ok: true,
				metered: true,
			},
			logs: ['metered job executed'],
		})
		.mockResolvedValueOnce({
			error: 'metered job failed',
			result: null,
			logs: ['metered job error'],
		})
	const sessionClient = {
		openSession: vi.fn(async () => ({
			id: `job-runtime-${jobView.id}`,
			source_id: jobView.sourceId,
			source_root: '/',
			base_commit: 'published-commit-1',
			conversation_id: null,
			last_checkpoint_commit: null,
			last_check_run_id: null,
			last_check_tree_hash: null,
			expires_at: null,
			created_at: '2026-04-16T00:00:00.000Z',
			updated_at: '2026-04-16T00:00:00.000Z',
			published_commit: 'published-commit-1',
			manifest_path: 'kody.json',
			entity_type: 'job' as const,
		})),
		runChecks: vi.fn(),
		readFile: vi.fn(async ({ path }: { path: string }) => ({
			path,
			content:
				path === 'kody.json'
					? JSON.stringify({
							version: 1,
							kind: 'job',
							title: 'Usage-metered job',
							description: 'Runs once at 2026-04-17T15:00:00.000Z',
							sourceRoot: '/',
							entrypoint: 'src/job.ts',
						})
					: 'export default async () => ({ ok: true, metered: true })',
		})),
		tree: vi.fn(async () => ({
			path: '',
			name: '',
			type: 'directory' as const,
			size: 0,
			children: [
				{
					path: 'kody.json',
					name: 'kody.json',
					type: 'file' as const,
					size: 1,
				},
				{
					path: 'src/job.ts',
					name: 'job.ts',
					type: 'file' as const,
					size: 1,
				},
			],
		})),
		discardSession: vi.fn(),
	}
	const repoSessionRpcSpy = vi
		.spyOn(await import('#worker/repo/repo-session-do.ts'), 'repoSessionRpc')
		.mockReturnValue(sessionClient as never)
	const row = await (
		await import('./repo.ts')
	).getJobRowById(db, callerContext.user.userId, jobView.id)
	if (!row) {
		throw new Error('Expected created job row.')
	}

	try {
		const successOutcome = await executeJobOnce({
			env,
			job: row.record,
			callerContext,
		})
		expect(successOutcome.execution).toEqual({
			ok: true,
			result: {
				ok: true,
				metered: true,
			},
			logs: ['metered job executed'],
		})
		expect(successOutcome.durationMs).toEqual(expect.any(Number))
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(env, {
			userId: row.record.userId,
			eventType: 'job_run',
			entityId: jobView.id,
			durationMs: successOutcome.durationMs,
			outcome: 'success',
		})
		expect(successOutcome.durationMs).toBeGreaterThanOrEqual(0)

		recordUsageSpy.mockClear()
		const failureOutcome = await executeJobOnce({
			env,
			job: row.record,
			callerContext,
		})
		expect(failureOutcome.execution).toEqual({
			ok: false,
			error: 'metered job failed',
			logs: ['metered job error'],
		})
		expect(failureOutcome.durationMs).toEqual(expect.any(Number))
		expect(recordUsageSpy).toHaveBeenCalledTimes(1)
		expect(recordUsageSpy).toHaveBeenCalledWith(env, {
			userId: row.record.userId,
			eventType: 'job_run',
			entityId: jobView.id,
			durationMs: failureOutcome.durationMs,
			outcome: 'error',
		})
		expect(failureOutcome.durationMs).toBeGreaterThanOrEqual(0)
	} finally {
		recordUsageSpy.mockRestore()
		repoSessionRpcSpy.mockRestore()
		executeSpy.mockRestore()
	}
})
