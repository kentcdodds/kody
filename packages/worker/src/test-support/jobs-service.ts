export * from './jobs-service-mocks.ts'
import { repoMockModule } from './jobs-service-mocks.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import {
	createInMemoryUserMeterEnv,
	createPermissiveAccountWriteLeaseDbHooks,
} from '#worker/test-support/user-meter.ts'
import { buildJobSourceFiles } from '#worker/repo/source-templates.ts'
import { syncPackageJobsForPackage } from '#worker/jobs/service.ts'
import { jobsData } from '#worker/jobs/jobs-data.ts'
import { computeNextRunAt, toJobView } from '#worker/jobs/schedule.ts'
import { createJobStorageId } from '#worker/storage-runner.ts'
import { parseAuthoredPackageJson } from '#worker/package-registry/manifest.ts'
import { buildPackageJobId } from '#worker/jobs/package-job-id.ts'
import {
	type JobRecord,
	type JobSchedule,
	type PersistedJobCallerContext,
} from '#worker/jobs/types.ts'
export function mockRepoPersistence() {
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

export function createPackageJobManifest(input: {
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

export function createPackageJobManifestText(
	input: Parameters<typeof createPackageJobManifest>[0],
) {
	return JSON.stringify(createPackageJobManifest(input))
}
export function createDatabase(
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
		['user_storage_buckets', []],
		['jobs', (initialRows.jobs ?? []).map((row) => ({ ...row }))],
		['users', (initialRows.users ?? []).map((row) => ({ ...row }))],
	])
	const writeLeaseDb = createPermissiveAccountWriteLeaseDbHooks()

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
		async batch(statements: Array<{ run: () => Promise<unknown> }>) {
			const results = []
			for (const statement of statements) {
				results.push(await statement.run())
			}
			return results
		},
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T = Record<string, unknown>>() {
							if (writeLeaseDb.supportsDeletingAtQuery(query)) {
								return writeLeaseDb.deletingAtFirstResult() as T
							}
							if (query.includes('SELECT plan, stripe_plan FROM users')) {
								const pairLookup = query.includes('email = ?')
								return selectOne('users', (row) =>
									pairLookup
										? row['email'] === params[0] &&
											row['stable_user_id'] === params[1]
										: row['stable_user_id'] === params[0],
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
							// Cold bootstrap probes for a users row; none seeded here so
							// null triggers synthetic-context free-plan allow.
							if (query.includes('SELECT 1 AS present FROM users')) {
								return selectOne(
									'users',
									(row) => row['stable_user_id'] === params[0],
								)
									? ({ present: 1 } as T)
									: null
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
											allowed_packages: row['allowed_packages'],
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
									allowed_packages: params[5],
									expires_at: params[6],
									created_at: params[7],
									updated_at: params[8],
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
									preserved: params[12],
									expires_at: params[13],
									caller_context_json: params[14],
									created_at: params[15],
									updated_at: params[16],
									last_run_at: params[17],
									last_run_status: params[18],
									next_run_at: params[19],
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
							if (
								query.startsWith('UPDATE jobs SET') &&
								query.includes('expires_at IS NOT NULL') &&
								query.includes('expires_at <= ?')
							) {
								const nowIso = String(params[0])
								const userId = params[1]
								const cutoff = String(params[2])
								let changes = 0
								for (const row of selectAll(
									'jobs',
									(existing) =>
										existing['user_id'] === userId &&
										Number(existing['enabled']) === 1 &&
										existing['expires_at'] != null &&
										String(existing['expires_at']) <= cutoff,
								)) {
									upsert(
										'jobs',
										(existing) =>
											existing['id'] === row['id'] &&
											existing['user_id'] === row['user_id'],
										{
											...row,
											enabled: 0,
											updated_at: nowIso,
										},
									)
									changes += 1
								}
								return { meta: { changes, last_row_id: 0 } }
							}
							if (
								query.startsWith('UPDATE jobs SET') &&
								query.includes(
									'source_id = ?, published_commit = ?, caller_context_json = ?, updated_at = ?',
								)
							) {
								const existingJob = selectOne(
									'jobs',
									(existing) =>
										existing['id'] === params[4] &&
										existing['user_id'] === params[5],
								)
								if (!existingJob) {
									return { meta: { changes: 0, last_row_id: 0 } }
								}
								upsert(
									'jobs',
									(existing) =>
										existing['id'] === params[4] &&
										existing['user_id'] === params[5],
									{
										...existingJob,
										source_id: params[0],
										published_commit: params[1],
										caller_context_json: params[2],
										updated_at: params[3],
									},
								)
								return { meta: { changes: 1, last_row_id: 0 } }
							}
							if (query.startsWith('UPDATE jobs SET')) {
								const existingJob = selectOne(
									'jobs',
									(existing) =>
										existing['id'] === params[17] &&
										existing['user_id'] === params[18],
								)
								const row = {
									id: params[17],
									user_id: params[18],
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
									preserved: params[10],
									expires_at: params[11],
									caller_context_json: params[12],
									updated_at: params[13],
									last_run_at: params[14],
									last_run_status: params[15],
									next_run_at: params[16],
									created_at: existingJob?.['created_at'] ?? params[13],
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
							if (query.startsWith('DELETE FROM user_storage_buckets')) {
								return {
									meta: {
										changes: deleteWhere(
											'user_storage_buckets',
											(row) =>
												row['user_id'] === params[0] &&
												row['storage_id'] === params[1],
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

export function createJobServiceTestEnv(
	bindings: Record<string, unknown> & {
		APP_DB: ReturnType<typeof createDatabase>
	},
	meter?: ReturnType<typeof createInMemoryUserMeterEnv>,
) {
	const userMeter = meter ?? createInMemoryUserMeterEnv()
	return {
		...bindings,
		USER_METER: userMeter.env.USER_METER,
	} as Env
}

export function createStorageRunnerBinding() {
	return {
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
	}
}

export function createBundleArtifactsKv() {
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

export async function insertPublishedEntitySource(input: {
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

export function createBaseCallerContext(): PersistedJobCallerContext {
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

export async function insertLeftoverJob(input: {
	env: Env
	callerContext: PersistedJobCallerContext
	body: {
		name: string
		schedule: JobSchedule
		code?: string
		params?: Record<string, unknown>
		timezone?: string | null
		enabled?: boolean
		sourceId?: string | null
		publishedCommit?: string | null
	}
}) {
	const now = new Date().toISOString()
	const jobId = crypto.randomUUID()
	const sourceId = input.body.sourceId ?? `job-${jobId}`
	const publishedCommit = input.body.publishedCommit ?? 'published-commit-1'
	const timezone = input.body.timezone ?? 'UTC'
	const job: JobRecord = {
		version: 1,
		id: jobId,
		userId: input.callerContext.user.userId,
		name: input.body.name,
		sourceId,
		publishedCommit,
		storageId: createJobStorageId(jobId),
		params: input.body.params,
		schedule: input.body.schedule,
		timezone,
		enabled: input.body.enabled ?? true,
		killSwitchEnabled: false,
		preserved: false,
		expiresAt: null,
		createdAt: now,
		updatedAt: now,
		nextRunAt: computeNextRunAt({
			schedule: input.body.schedule,
			timezone,
		}),
		runCount: 0,
		successCount: 0,
		errorCount: 0,
	}
	if (input.body.sourceId == null) {
		const jobView = toJobView(job)
		await insertPublishedEntitySource({
			db: input.env.APP_DB as ReturnType<typeof createDatabase>,
			env: input.env.BUNDLE_ARTIFACTS_KV ? input.env : undefined,
			userId: input.callerContext.user.userId,
			sourceId,
			entityKind: 'job',
			entityId: jobId,
			publishedCommit,
			files: input.env.BUNDLE_ARTIFACTS_KV
				? buildJobSourceFiles({
						job: jobView,
						moduleSource:
							input.body.code ?? 'export default async () => ({ ok: true })',
					})
				: undefined,
		})
	}
	await jobsData(input.env).insertJob({
		userId: input.callerContext.user.userId,
		job,
		callerContextJson: JSON.stringify(input.callerContext),
	})
	return toJobView(job)
}

export async function syncSinglePackageJob(input: {
	env: Env
	userId: string
	baseUrl: string
	packageId: string
	sourceId: string
	jobName: string
	schedule?: Record<string, unknown>
	publishedCommit?: string
}) {
	await insertPublishedEntitySource({
		db: input.env.APP_DB as ReturnType<typeof createDatabase>,
		userId: input.userId,
		sourceId: input.sourceId,
		entityKind: 'package',
		entityId: input.packageId,
		publishedCommit: input.publishedCommit ?? 'package-published-commit',
		manifestPath: 'package.json',
	})
	await syncPackageJobsForPackage({
		env: input.env,
		userId: input.userId,
		baseUrl: input.baseUrl,
		packageId: input.packageId,
		sourceId: input.sourceId,
		manifest: parseAuthoredPackageJson({
			content: JSON.stringify({
				name: `@owner/${input.packageId}`,
				exports: { '.': './index.ts' },
				kody: {
					id: input.packageId,
					description: 'Package job fixture',
					jobs: {
						[input.jobName]: {
							entry: './job.ts',
							schedule: input.schedule ?? {
								type: 'interval',
								every: '15m',
							},
						},
					},
				},
			}),
		}),
	})
	const jobId = buildPackageJobId(input.packageId, input.jobName)
	const row = await (
		await import('@kody-internal/shared/jobs/repo.ts')
	).getJobRowById(input.env.APP_DB, input.userId, jobId)
	if (!row) {
		throw new Error(`Expected package job "${jobId}".`)
	}
	return toJobView(row.record)
}
