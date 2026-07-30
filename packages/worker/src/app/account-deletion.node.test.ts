import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
	deleteUserAccount,
	getAccountDeletionD1UserColumnCoverage,
} from './account-deletion.ts'
import { accountUserDataExcludedOwnerIds } from '#worker/account/data-targets.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import {
	AccountDeletionInProgressError,
	AccountDeletionWritersActiveError,
	assertAccountWritable,
} from '#worker/account/deletion-state.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'

type RowMap = Record<string, Array<Record<string, unknown>>>

function createTestDb(
	initial: RowMap,
	options?: {
		failSelectContaining?: string
		failRunContaining?: string
		onSelect?: (query: string) => Promise<void>
	},
): {
	db: D1Database
	rows: RowMap
} {
	const rows: RowMap = {}
	for (const [key, value] of Object.entries(initial)) {
		rows[key] = value.map((row) => ({ ...row }))
	}

	function deleteByPredicate(
		table: string,
		predicate: (row: Record<string, unknown>) => boolean,
	) {
		const remaining: Array<Record<string, unknown>> = []
		let removed = 0
		for (const row of rows[table] ?? []) {
			if (predicate(row)) {
				removed += 1
				continue
			}
			remaining.push(row)
		}
		rows[table] = remaining
		return removed
	}

	function selectIds(
		table: string,
		where: (row: Record<string, unknown>) => boolean,
	) {
		return (rows[table] ?? []).filter(where).map((row) => row['id'])
	}

	const db = {
		prepare(query: string) {
			const trimmed = query.replace(/\s+/g, ' ').trim()
			const lower = trimmed.toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							await options?.onSelect?.(lower)
							if (
								options?.failSelectContaining &&
								lower.includes(options.failSelectContaining)
							) {
								throw new Error('simulated inventory read failure')
							}
							let results: Array<unknown> = []
							const userId = params[0] as string
							if (
								lower ===
								'select deleting_at from users where stable_user_id = ?'
							) {
								results = (rows.users ?? [])
									.filter((row) => row['stable_user_id'] === userId)
									.map((row) => ({
										deleting_at: row['deleting_at'] ?? null,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select version from deployment_backfill_markers where key = ?'
							) {
								results =
									'deployment_backfill_markers' in rows
										? (rows.deployment_backfill_markers ?? [])
										: [{ version: 1 }]
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower.includes(
									'select count(*) as count from account_write_leases',
								)
							) {
								const user = (rows.users ?? []).find(
									(row) => row['id'] === params[0],
								)
								results = [
									{
										count: (rows.account_write_leases ?? []).filter(
											(row) =>
												row['user_id'] === user?.['stable_user_id'] &&
												row['released_at'] == null,
										).length,
									},
								]
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select id from saved_packages where user_id = ? and has_app = 1'
							) {
								results = (rows.saved_packages ?? [])
									.filter(
										(row) =>
											row['user_id'] === userId &&
											(row['has_app'] === 1 ||
												row['has_app'] === '1' ||
												row['has_app'] === true),
									)
									.map((row) => ({ id: row['id'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select id, published_commit from entity_sources where user_id = ?'
							) {
								results = (rows.entity_sources ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({
										id: row['id'],
										published_commit: row['published_commit'] ?? null,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select id, kody_id, source_id, has_app from saved_packages where user_id = ?'
							) {
								results = (rows.saved_packages ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({
										id: row['id'],
										kody_id: row['kody_id'],
										source_id: row['source_id'],
										has_app: row['has_app'],
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select instance_id from remote_connector_settings where user_id = ?'
							) {
								results = (rows.remote_connector_settings ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({
										instance_id: row['instance_id'],
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower ===
								'select do_id from mcp_agent_sessions where user_id = ? order by do_id'
							) {
								results = (rows.mcp_agent_sessions ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({ do_id: row['do_id'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower.includes('from package_service_states as s') &&
								lower.includes('left join saved_packages as p')
							) {
								const seen = new Set<string>()
								results = []
								for (const row of rows.package_service_states ?? []) {
									if (row['user_id'] !== userId) continue
									const savedPackage = (rows.saved_packages ?? []).find(
										(pkg) =>
											pkg['id'] === row['package_id'] &&
											pkg['user_id'] === row['user_id'],
									)
									const key = `${String(row['package_id'])}:${String(row['service_name'])}`
									if (seen.has(key)) continue
									seen.add(key)
									results.push({
										package_id: row['package_id'],
										kody_id: savedPackage?.['kody_id'] ?? null,
										source_id: savedPackage?.['source_id'] ?? null,
										name: row['service_name'],
									})
								}
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower.includes(
									'select storage_id as storageid from user_storage_buckets',
								)
							) {
								results = (rows.user_storage_buckets ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({ storageId: row['storage_id'] }))
									.sort((left, right) =>
										String(left.storageId).localeCompare(
											String(right.storageId),
										),
									)
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower.includes('from community_listings') &&
								lower.includes('entity_sources.published_commit')
							) {
								results = (rows.community_listings ?? [])
									.filter((row) => row['owner_user_id'] === userId)
									.map((row, index) => {
										const source = (rows.entity_sources ?? []).find(
											(sourceRow) =>
												sourceRow['id'] === row['source_id'] &&
												sourceRow['user_id'] === row['owner_user_id'],
										)
										return {
											account_r2_rowid: index + 1,
											id: row['id'],
											pinned_commit: row['pinned_commit'],
											source_published_commit:
												source?.['published_commit'] ?? null,
										}
									})
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower.startsWith(
									'select rowid as account_r2_rowid, id from email_messages',
								)
							) {
								const afterRowid = Number(params[1])
								const limit = Number(params[2])
								results = (rows.email_messages ?? [])
									.map((row, index) => ({
										row,
										account_r2_rowid: index + 1,
									}))
									.filter(
										(entry) =>
											entry.row['user_id'] === userId &&
											entry.account_r2_rowid > afterRowid,
									)
									.slice(0, limit)
									.map((entry) => ({
										account_r2_rowid: entry.account_r2_rowid,
										id: entry.row['id'],
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							const m = lower.match(/^select id from (\w+) where user_id = \?/)
							if (m) {
								const table = m[1] as string
								results = (rows[table] ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({ id: row['id'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							const storageMatch = lower.match(
								/^select storage_id from (\w+) where user_id = \? and storage_id is not null/,
							)
							if (storageMatch) {
								const table = storageMatch[1] as string
								results = (rows[table] ?? [])
									.filter(
										(row) =>
											row['user_id'] === userId && row['storage_id'] != null,
									)
									.map((row) => ({ storage_id: row['storage_id'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							const kvMatch = lower.match(
								/^select kv_key from (\w+) where user_id = \?/,
							)
							if (kvMatch) {
								const table = kvMatch[1] as string
								results = (rows[table] ?? [])
									.filter((row) => row['user_id'] === userId)
									.map((row) => ({ kv_key: row['kv_key'] }))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (lower === 'select avatar_key from users where id = ?') {
								const numericId = Number(params[0])
								results = (rows.users ?? [])
									.filter((row) => Number(row['id']) === numericId)
									.map((row) => ({
										avatar_key: row['avatar_key'] ?? null,
									}))
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async first<T>() {
							const result = await this.all<T>()
							return (result.results[0] ?? null) as T | null
						},
						async run() {
							if (
								options?.failRunContaining &&
								lower.includes(options.failRunContaining)
							) {
								throw new Error('simulated atomic D1 failure')
							}
							const userId = params[0] as string | number
							if (
								lower ===
								'update users set deleting_at = coalesce(deleting_at, ?), updated_at = ? where id = ?'
							) {
								let changed = 0
								for (const row of rows.users ?? []) {
									if (row['id'] !== params[2]) continue
									row['deleting_at'] ??= params[0]
									row['updated_at'] = params[1]
									changed += 1
								}
								return { meta: { changes: changed } }
							}
							const nullColumnMatch = lower.match(
								/^update (\w+) set ((?:\w+ = null)(?:, \w+ = null)*) where (\w+) = \?$/,
							)
							if (nullColumnMatch) {
								const table = nullColumnMatch[1] as string
								const assignments = nullColumnMatch[2]!
									.split(', ')
									.map((part) => part.replace(' = null', ''))
								const matchColumn = nullColumnMatch[3] as string
								let changed = 0
								for (const row of rows[table] ?? []) {
									if (row[matchColumn] !== userId) continue
									for (const column of assignments) {
										row[column] = null
									}
									changed += 1
								}
								return { meta: { changes: changed } }
							}
							const replaceJsonMatch = lower.match(
								/^update (\w+) set (\w+) = replace\(\2, \?, \?\) where \2 like \?$/,
							)
							if (replaceJsonMatch) {
								const table = replaceJsonMatch[1] as string
								const column = replaceJsonMatch[2] as string
								const search = String(params[0])
								const replacement = String(params[1])
								const likePattern = String(params[2])
								const needle = likePattern.replace(/^%/, '').replace(/%$/, '')
								let changed = 0
								for (const row of rows[table] ?? []) {
									const current = row[column]
									if (typeof current !== 'string') continue
									if (!current.includes(needle)) continue
									row[column] = current.split(search).join(replacement)
									changed += 1
								}
								return { meta: { changes: changed } }
							}
							const replaceColumnMatch = lower.match(
								/^update (\w+) set (\w+) = \? where (\w+) = \?$/,
							)
							if (replaceColumnMatch) {
								const table = replaceColumnMatch[1] as string
								const setColumn = replaceColumnMatch[2] as string
								const matchColumn = replaceColumnMatch[3] as string
								let changed = 0
								for (const row of rows[table] ?? []) {
									if (row[matchColumn] !== params[1]) continue
									row[setColumn] = params[0]
									changed += 1
								}
								return { meta: { changes: changed } }
							}
							const userColumnsMatch = lower.match(
								/^delete from (\w+) where ((?:\w+ = \?)(?: or \w+ = \?)*)$/,
							)
							if (userColumnsMatch) {
								const table = userColumnsMatch[1] as string
								const columns = userColumnsMatch[2]!
									.split(' or ')
									.map((part) => part.replace(' = ?', ''))
								const removed = deleteByPredicate(table, (row) =>
									columns.some(
										(column, index) => row[column] === params[index],
									),
								)
								return { meta: { changes: removed } }
							}
							const userIdMatch = lower.match(
								/^delete from (\w+) where user_id = \?/,
							)
							if (userIdMatch) {
								const table = userIdMatch[1] as string
								const removed = deleteByPredicate(
									table,
									(row) => row['user_id'] === userId,
								)
								return { meta: { changes: removed } }
							}
							const bucketParentMatch = lower.match(
								/^delete from (\w+) where bucket_id in \( select id from (\w+) where user_id = \? \)/,
							)
							if (bucketParentMatch) {
								const childTable = bucketParentMatch[1] as string
								const parentTable = bucketParentMatch[2] as string
								const parentIds = new Set(
									selectIds(parentTable, (row) => row['user_id'] === userId),
								)
								const removed = deleteByPredicate(childTable, (row) =>
									parentIds.has(row['bucket_id']),
								)
								return { meta: { changes: removed } }
							}
							const attachmentMatch = lower.match(
								/^delete from email_attachments where message_id in \( select id from email_messages where user_id = \? \)/,
							)
							if (attachmentMatch) {
								const messageIds = new Set(
									selectIds(
										'email_messages',
										(row) => row['user_id'] === userId,
									),
								)
								const removed = deleteByPredicate('email_attachments', (row) =>
									messageIds.has(row['message_id']),
								)
								return { meta: { changes: removed } }
							}
							const communityListingChildMatch = lower.match(
								/^delete from (\w+) where (\w+) in \( select id from community_listings where owner_user_id = \? \)/,
							)
							if (communityListingChildMatch) {
								const table = communityListingChildMatch[1] as string
								const listingColumn = communityListingChildMatch[2] as string
								const listingIds = new Set(
									selectIds(
										'community_listings',
										(row) => row['owner_user_id'] === userId,
									),
								)
								const removed = deleteByPredicate(table, (row) =>
									listingIds.has(row[listingColumn]),
								)
								return { meta: { changes: removed } }
							}
							const usersMatch = lower.match(/^delete from users where id = \?/)
							if (usersMatch) {
								const removed = deleteByPredicate(
									'users',
									(row) => row['id'] === userId,
								)
								return { meta: { changes: removed } }
							}
							return { meta: { changes: 0 } }
						},
					}
				},
			}
		},
		async batch(
			statements: Array<{ run: () => Promise<{ meta: { changes: number } }> }>,
		) {
			const snapshot = structuredClone(rows)
			try {
				const results = []
				for (const statement of statements) {
					results.push(await statement.run())
				}
				return results
			} catch (error) {
				for (const key of Object.keys(rows)) delete rows[key]
				Object.assign(rows, snapshot)
				throw error
			}
		},
	} as unknown as D1Database

	return { db, rows }
}

function createSuccessfulDeletionEnv(
	db: D1Database,
	overrides: Partial<Env> & {
		OAUTH_PROVIDER?: {
			listUserGrants: (
				userId: string,
				options: { cursor: string | undefined },
			) => Promise<{
				items: Array<{ id: string; clientId: string }>
				cursor: string | undefined
			}>
			revokeGrant: (grantId: string, userId: string) => Promise<unknown>
		}
	} = {},
) {
	const durableObjectId = (name: string) => name as unknown as DurableObjectId
	const fetchOk = async () => Response.json({ ok: true })
	return {
		APP_DB: db,
		CAPABILITY_VECTOR_INDEX: {
			deleteByIds: async () => undefined,
		},
		STORAGE_RUNNER: {
			idFromName: durableObjectId,
			get: () => ({ clearStorage: async () => ({ ok: true as const }) }),
		},
		RUN_LOG: {
			idFromName: durableObjectId,
			get: () => ({
				clearAll: async () => ({ ok: true as const }),
				listStorageIds: async () => [] as Array<string>,
			}),
		},
		JOB_MANAGER: {
			idFromName: durableObjectId,
			get: () => ({ purgeUser: async () => ({ ok: true as const }) }),
		},
		REPO_SESSION: {
			idFromName: durableObjectId,
			get: () => ({ purgeSession: async () => ({ ok: true as const }) }),
		},
		REMOTE_CONNECTOR_SESSION: {
			idFromName: durableObjectId,
			get: () => ({
				rpcPurgeUserSession: async () => ({ ok: true as const }),
			}),
		},
		MCP_CLIENT_HUB: {
			idFromName: durableObjectId,
			get: () => ({ purgeForAccountDeletion: async () => undefined }),
		},
		PACKAGE_REALTIME_SESSION: {
			idFromName: durableObjectId,
			get: () => ({ fetch: fetchOk }),
		},
		PACKAGE_SERVICE_INSTANCE: {
			idFromName: durableObjectId,
			get: () => ({ fetch: fetchOk }),
		},
		COMMUNITY_ASSETS: {
			async list() {
				return {
					objects: [],
					delimitedPrefixes: [],
					truncated: false as const,
				}
			},
			delete: async () => undefined,
		},
		EMAIL_BLOBS: {
			async list() {
				return {
					objects: [],
					delimitedPrefixes: [],
					truncated: false as const,
				}
			},
			delete: async () => undefined,
		},
		OAUTH_PROVIDER: {
			async listUserGrants() {
				return { items: [], cursor: undefined }
			},
			async revokeGrant() {
				return undefined
			},
		},
		...overrides,
	} as unknown as Parameters<typeof deleteUserAccount>[0]['env']
}

test('account deletion D1 coverage includes every live user-owned schema column', () => {
	const migrationsDir = new URL('../../migrations/', import.meta.url)
	const db = new DatabaseSync(':memory:')
	for (const fileName of readdirSync(migrationsDir)
		.filter((file) => file.endsWith('.sql'))
		.sort()) {
		db.exec(readFileSync(new URL(fileName, migrationsDir), 'utf8'))
	}
	const tables = db
		.prepare(
			`SELECT name
			FROM sqlite_schema
			WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
			ORDER BY name`,
		)
		.all() as Array<{ name: string }>
	const liveUserColumns = new Set<string>()
	for (const table of tables) {
		const columns = db
			.prepare(`PRAGMA table_info(${quoteSqlIdentifier(table.name)})`)
			.all() as Array<{ name: string }>
		for (const column of columns) {
			if (column.name === 'user_id' || column.name.endsWith('_user_id')) {
				liveUserColumns.add(`${table.name}.${column.name}`)
			}
		}
	}
	const coveredColumns = getAccountDeletionD1UserColumnCoverage()
	const missing = [...liveUserColumns].filter(
		(column) => !coveredColumns.has(column),
	)
	const stale = [...coveredColumns].filter(
		(column) => !liveUserColumns.has(column),
	)
	expect(
		missing,
		'user-owned D1 columns missing from account deletion',
	).toEqual([])
	expect(stale, 'account deletion references stale D1 columns').toEqual([])
})

test('account deletion documents and preserves operator-owned system email rows', async () => {
	const systemEmailExclusion = accountUserDataExcludedOwnerIds.find(
		(exclusion) => exclusion.ownerId === 'system:email',
	)
	expect(systemEmailExclusion?.reason).toContain('Operator-owned inbound mail')
	expect(systemEmailExclusion?.reason).toContain(
		'not be attributed to any user',
	)

	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'user@example.com' }],
		email_messages: [
			{ id: 'user-message', user_id: 'user-aaa' },
			{ id: 'system-message', user_id: 'system:email' },
		],
		email_delivery_events: [
			{ id: 'user-event', user_id: 'user-aaa' },
			{ id: 'system-event', user_id: 'system:email' },
		],
		email_inboxes: [
			{ id: 'user-inbox', user_id: 'user-aaa' },
			{ id: 'system-inbox', user_id: 'system:email' },
		],
		email_inbox_addresses: [
			{ id: 'user-address', user_id: 'user-aaa' },
			{ id: 'system-address', user_id: 'system:email' },
		],
	})

	await deleteUserAccount({
		env: createSuccessfulDeletionEnv(db),
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})

	expect(rows.email_messages).toEqual([
		{ id: 'system-message', user_id: 'system:email' },
	])
	expect(rows.email_delivery_events).toEqual([
		{ id: 'system-event', user_id: 'system:email' },
	])
	expect(rows.email_inboxes).toEqual([
		{ id: 'system-inbox', user_id: 'system:email' },
	])
	expect(rows.email_inbox_addresses).toEqual([
		{ id: 'system-address', user_id: 'system:email' },
	])
})

test('deleteUserAccount cascades user-scoped rows for the requested user', async () => {
	const userAaa = 'user-aaa'
	const userBbb = 'user-bbb'
	const packageJobId =
		'package-job:b2fda105-005a-4e2b-9f22-1513b6752da2:event-runner'
	const { db, rows } = createTestDb({
		users: [
			{
				id: 1,
				email: 'a@example.com',
				avatar_key: 'user-avatars/user-aaa/abc123.png',
			},
			{ id: 2, email: 'b@example.com' },
		],
		jobs: [
			{ id: 'job-1', user_id: userAaa, storage_id: 'job:job-1' },
			{ id: 'job-2', user_id: userAaa, storage_id: null },
			{ id: packageJobId, user_id: userAaa, storage_id: null },
			{ id: 'job-3', user_id: userBbb, storage_id: 'job:job-3' },
		],
		package_service_states: [
			{
				user_id: userAaa,
				package_id: 'pkg-1',
				service_name: 'sync',
				status: 'running',
				started_at: '2026-07-05T00:00:00.000Z',
				updated_at: '2026-07-05T00:00:00.000Z',
			},
			{
				user_id: userAaa,
				package_id: 'pkg-1',
				service_name: 'idle-worker',
				status: 'idle',
				started_at: null,
				updated_at: '2026-07-05T00:00:00.000Z',
			},
			{
				user_id: userAaa,
				package_id: 'pkg-orphan',
				service_name: 'legacy-sync',
				status: 'idle',
				started_at: null,
				updated_at: '2026-07-05T00:00:00.000Z',
			},
			{
				user_id: userBbb,
				package_id: 'pkg-2',
				service_name: 'sync',
				status: 'running',
				started_at: '2026-07-05T00:00:00.000Z',
				updated_at: '2026-07-05T00:00:00.000Z',
			},
		],
		user_storage_buckets: [
			{
				user_id: userAaa,
				storage_id: 'exec:run-2',
				kind: 'execute',
			},
			{
				user_id: userBbb,
				storage_id: 'service:pkg-2:sync',
				kind: 'service',
			},
		],
		mcp_memories: [
			{ id: 'mem-1', user_id: userAaa },
			{ id: 'mem-2', user_id: userBbb },
		],
		secret_buckets: [{ id: 'sb-1', user_id: userAaa }],
		secret_entries: [{ bucket_id: 'sb-1', name: 's', user_id: 'unused' }],
		value_buckets: [{ id: 'vb-1', user_id: userAaa }],
		value_entries: [{ bucket_id: 'vb-1', name: 'v', user_id: 'unused' }],
		remote_connector_settings: [
			{ id: 'rc-1', user_id: userAaa, instance_id: 'home' },
			{ id: 'rc-2', user_id: userBbb, instance_id: 'other' },
		],
		mcp_agent_sessions: [
			{ do_id: 'do-user-a', user_id: userAaa },
			{ do_id: 'do-user-b', user_id: userBbb },
		],
		saved_packages: [
			{
				id: 'pkg-1',
				user_id: userAaa,
				kody_id: 'demo',
				source_id: 'src-1',
				has_app: 1,
			},
			{
				id: 'pkg-2',
				user_id: userBbb,
				kody_id: 'other',
				source_id: 'src-2',
				has_app: 0,
			},
		],
		published_bundle_artifacts: [
			{ id: 'pba-1', user_id: userAaa, kv_key: 'bundle-artifact:v1:src-1' },
			{ id: 'pba-2', user_id: userBbb, kv_key: 'bundle-artifact:v1:src-2' },
		],
		archived_job_artifacts: [
			{ id: 'aja-1', user_id: userAaa, storage_id: 'job:archived-1' },
		],
		entity_sources: [
			{ id: 'src-1', user_id: userAaa, published_commit: 'abc123' },
			{ id: 'src-2', user_id: userBbb, published_commit: 'def456' },
		],
		repo_sessions: [{ id: 'rs-1', user_id: userAaa }],
		password_resets: [
			{ id: 1, user_id: 1 },
			{ id: 2, user_id: 1 },
			{ id: 3, user_id: 2 },
		],
		user_roles: [
			{ user_id: 1, role_id: 1 },
			{ user_id: 2, role_id: 2 },
		],
		passkeys: [
			{ id: 'pk-1', user_id: 1 },
			{ id: 'pk-2', user_id: 2 },
		],
		verifications: [
			{ id: 1, type: '2fa', target: '1' },
			{ id: 2, type: '2fa', target: '2' },
		],
		mcp_user_server_instructions: [{ user_id: userAaa }],
		package_invocation_tokens: [{ id: 'pit-1', user_id: userAaa }],
		agent_package_conversation_uses: [
			{
				user_id: userAaa,
				package_id: 'pkg-1',
				conversation_id: 'conv-1',
			},
		],
		workflow_runs: [{ id: 'wr-1', user_id: userAaa }],
		mcp_memory_conversation_suppressions: [
			{ user_id: userAaa, conversation_id: 'c1', memory_id: 'mem-1' },
		],
		email_inboxes: [{ id: 'in-1', user_id: userAaa }],
		email_inbox_addresses: [{ id: 'ia-1', user_id: userAaa }],
		email_threads: [{ id: 'et-1', user_id: userAaa }],
		email_messages: [
			{
				id: 'em-1',
				user_id: userAaa,
				raw_mime_key: 'email-raw:v1:user-aaa/em-1',
			},
			{ id: 'em-2', user_id: userAaa, raw_mime_key: null },
			{
				id: 'em-3',
				user_id: userBbb,
				raw_mime_key: 'email-raw:v1:user-bbb/em-3',
			},
		],
		email_attachments: [{ id: 'ea-1', message_id: 'em-1' }],
		email_delivery_events: [{ id: 'ed-1', user_id: userAaa }],
		email_sender_identities: [{ id: 'ei-1', user_id: userAaa }],
		entitlement_daily_counters: [
			{ user_id: userAaa, resource: 'email_sends_per_day', day: '2026-07-05' },
			{ user_id: userBbb, resource: 'email_sends_per_day', day: '2026-07-05' },
		],
		platform_feedback: [
			{
				id: 'feedback-submitted-by-a',
				submitter_user_id: userAaa,
				submitter_username: 'user-a',
				submitter_email: 'a@example.com',
				reviewed_by_user_id: userBbb,
				reviewed_at: '2026-07-05',
				admin_note: 'Reviewed by B.',
			},
			{
				id: 'feedback-reviewed-by-a',
				submitter_user_id: userBbb,
				submitter_username: 'user-b',
				submitter_email: 'b@example.com',
				reviewed_by_user_id: userAaa,
				reviewed_at: '2026-07-05',
				admin_note: 'Private admin note from A.',
			},
			{
				id: 'feedback-unrelated',
				submitter_user_id: userBbb,
				submitter_username: 'user-b',
				submitter_email: 'b@example.com',
				reviewed_by_user_id: userBbb,
				reviewed_at: '2026-07-05',
				admin_note: 'Reviewed by B.',
			},
		],
		community_listings: [
			{
				id: 'listing-1',
				owner_user_id: userAaa,
				pinned_commit: 'commit-1',
				source_id: 'src-1',
			},
			{ id: 'listing-2', owner_user_id: userBbb, pinned_commit: 'commit-2' },
		],
		community_forks: [
			{ id: 'fork-1', listing_id: 'listing-1', forker_user_id: userBbb },
			{ id: 'fork-2', listing_id: 'listing-2', forker_user_id: userAaa },
			{ id: 'fork-3', listing_id: 'listing-2', forker_user_id: userBbb },
		],
		community_ratings: [
			{ id: 'rating-1', listing_id: 'listing-1', user_id: userBbb },
			{ id: 'rating-2', listing_id: 'listing-2', user_id: userAaa },
			{ id: 'rating-3', listing_id: 'listing-2', user_id: userBbb },
		],
		community_stars: [
			{ listing_id: 'listing-1', user_id: userBbb },
			{ listing_id: 'listing-2', user_id: userAaa },
			{ listing_id: 'listing-2', user_id: userBbb },
		],
		community_activity_events: [
			{
				id: 'evt-1',
				actor_user_id: userAaa,
				event_type: 'listing_published',
				listing_id: 'listing-2',
			},
			{
				id: 'evt-2',
				actor_user_id: userBbb,
				event_type: 'listing_updated',
				listing_id: 'listing-1',
			},
			{
				id: 'evt-3',
				actor_user_id: userBbb,
				event_type: 'listing_published',
				listing_id: 'listing-2',
			},
		],
		user_follows: [
			{ follower_user_id: userAaa, followee_user_id: userBbb },
			{ follower_user_id: userBbb, followee_user_id: userAaa },
			{ follower_user_id: userBbb, followee_user_id: 'user-ccc' },
		],
		community_reports: [
			{
				id: 'report-1',
				listing_id: 'listing-1',
				listing_owner_user_id: userAaa,
				reporter_user_id: userBbb,
				resolved_by_user_id: null,
			},
			{
				id: 'report-2',
				listing_id: 'listing-2',
				listing_owner_user_id: userBbb,
				reporter_user_id: userAaa,
				resolved_by_user_id: null,
			},
			{
				id: 'report-3',
				listing_id: 'listing-2',
				listing_owner_user_id: userBbb,
				reporter_user_id: userBbb,
				resolved_by_user_id: userAaa,
			},
		],
		community_bans: [
			{ user_id: userAaa, banned_by_user_id: userBbb },
			{ user_id: userBbb, banned_by_user_id: userAaa },
		],
		package_codemod_run_items: [
			{
				id: 'codemod-item-1',
				run_id: 'codemod-run-1',
				user_id: userAaa,
				package_id: 'pkg-1',
				kody_id: 'demo',
				status: 'applied',
			},
			{
				id: 'codemod-item-2',
				run_id: 'codemod-run-2',
				user_id: userBbb,
				package_id: 'pkg-2',
				kody_id: 'demo-b',
				status: 'applied',
			},
		],
		package_codemod_runs: [
			{
				id: 'codemod-run-1',
				codemod_id: '0001-ambient-storage-to-package-storage',
				mode: 'apply',
				scope_user_id: userAaa,
				initiated_by_user_id: userAaa,
				filters_json: JSON.stringify({ userIds: [userAaa, userBbb] }),
				status: 'completed',
			},
			{
				id: 'codemod-run-fleet',
				codemod_id: '0001-ambient-storage-to-package-storage',
				mode: 'scan',
				scope_user_id: null,
				initiated_by_user_id: userBbb,
				filters_json: JSON.stringify({ userIds: [userAaa] }),
				status: 'completed',
			},
			{
				id: 'codemod-run-2',
				codemod_id: '0001-ambient-storage-to-package-storage',
				mode: 'apply',
				scope_user_id: userBbb,
				initiated_by_user_id: userBbb,
				filters_json: JSON.stringify({ userIds: [userBbb] }),
				status: 'completed',
			},
		],
	})

	const deletedKvKeys: Array<string> = []
	const kvStoreKeys = [
		'source-snapshot:v1:src-1:abc123',
		'source-manifest-snapshot:v1:src-1:abc123',
		'source-snapshot:v1:src-1:old456',
		'source-manifest-snapshot:v1:src-1:old456',
		'derived-cache:v1:community-icon:v1:listing-1:commit-1',
		'derived-cache:v1:community-icon:v1:listing-1:abc123',
		'derived-cache:v1:community-icon:v1:listing-1:historical',
		'source-snapshot:v1:src-2:def456',
		`package-codemod-revert:${userAaa}:item-1`,
		`package-codemod-revert:${userAaa}:item-2`,
		`package-codemod-revert:${userBbb}:item-other`,
		'package-retriever-manifest:v1:user-aaa:pkg-1:abc123',
		'package-retriever-index-entry:v1:user-aaa:search:pkg-1:notes',
		'package-retriever-index-entry:v1:user-aaa:context:pkg-1:notes',
		'package-retriever-index:v1:user-aaa:search',
		'package-retriever-index:v1:user-aaa:context',
		'package-retriever-index-entry:v1:user-bbb:search:pkg-2:notes',
		'package-retriever-index:v1:user-bbb:search',
	]
	const kv = {
		async get(key: string) {
			return kvStoreKeys.includes(key) ? '{}' : null
		},
		async delete(key: string) {
			deletedKvKeys.push(key)
		},
		async list(options?: { prefix?: string; cursor?: string }) {
			const prefix = options?.prefix ?? ''
			const matchingKeys = kvStoreKeys
				.filter((key) => key.startsWith(prefix))
				.sort()
			if (prefix === `package-retriever-index:v1:${userAaa}:`) {
				const firstPage = matchingKeys.slice(0, 1)
				if (options?.cursor === 'legacy-page-2') {
					return {
						keys: matchingKeys.slice(1).map((name) => ({ name })),
						list_complete: true,
						cursor: undefined,
					}
				}
				if (firstPage.length < matchingKeys.length) {
					return {
						keys: firstPage.map((name) => ({ name })),
						list_complete: false,
						cursor: 'legacy-page-2',
					}
				}
			}
			if (prefix === 'derived-cache:v1:community-icon:v1:listing-1:') {
				const start = options?.cursor
					? Number(options.cursor.replace('icon-page-', '')) - 1
					: 0
				const page = matchingKeys.slice(start, start + 1)
				return {
					keys: page.map((name) => ({ name })),
					list_complete: start + page.length >= matchingKeys.length,
					...(start + page.length < matchingKeys.length
						? { cursor: `icon-page-${start + 2}` }
						: {}),
				}
			}
			return {
				keys: matchingKeys.map((name) => ({ name })),
				list_complete: true,
				cursor: undefined,
			}
		},
	} as unknown as KVNamespace

	const deletedEmailBlobKeys: Array<string> = []
	const emailBlobKeys = new Set([
		'email-raw:v1:user-aaa/em-1',
		'email-raw:v1:user-aaa/em-2',
		'email-raw:v1:user-bbb/em-3',
	])
	const emailBlobs = {
		async list(options?: { prefix?: string }) {
			return {
				objects: [...emailBlobKeys]
					.filter((key) => key.startsWith(options?.prefix ?? ''))
					.map((key) => ({ key })),
				delimitedPrefixes: [],
				truncated: false as const,
			}
		},
		async delete(keys: string | Array<string>) {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				deletedEmailBlobKeys.push(key)
				emailBlobKeys.delete(key)
			}
		},
	} as unknown as R2Bucket
	const deletedCommunityAssetKeys: Array<string> = []
	const communityAssetKeys = new Set([
		'user-avatars/user-aaa/abc123.png',
		'user-avatars/user-aaa/old.png',
		'user-avatars/user-bbb/other.png',
		'community-icon:v1/listing-1/abc123/asset',
		'community-icon:v1/listing-1/commit-1/asset',
		'community-icon:v1/listing-1/historical/asset',
		'community-icon:v1/listing-2/other/asset',
	])
	const communityAssets = {
		async list(options?: { prefix?: string; cursor?: string }) {
			const matching = [...communityAssetKeys]
				.filter(
					(key) =>
						key.startsWith(options?.prefix ?? '') &&
						(!options?.cursor || key > options.cursor),
				)
				.sort()
			const page = matching.slice(0, 1)
			return {
				objects: page.map((key) => ({ key })),
				delimitedPrefixes: [],
				...(matching.length > page.length
					? { truncated: true as const, cursor: page[0]! }
					: { truncated: false as const }),
			}
		},
		async delete(keys: string | Array<string>) {
			for (const key of Array.isArray(keys) ? keys : [keys]) {
				deletedCommunityAssetKeys.push(key)
				communityAssetKeys.delete(key)
			}
		},
	} as unknown as R2Bucket

	const clearStorageMock = vi.fn(async () => ({ ok: true as const }))
	const clearRunLogMock = vi.fn(async () => ({ ok: true as const }))
	const purgeJobManagerMock = vi.fn(async () => ({ ok: true as const }))
	const purgeRepoSessionMock = vi.fn(async () => ({ ok: true as const }))
	const purgeRemoteConnectorMock = vi.fn(async () => ({ ok: true as const }))
	const purgeMcpClientHubMock = vi.fn(async () => undefined)
	const purgeMcpAgentSessionMock = vi.fn(async () => undefined)
	const doFetchMock = vi.fn(async () => Response.json({ ok: true }))
	const deleteVectorsMock = vi.fn(async () => undefined)
	const env = createSuccessfulDeletionEnv(db, {
		BUNDLE_ARTIFACTS_KV: kv,
		COMMUNITY_ASSETS: communityAssets,
		EMAIL_BLOBS: emailBlobs,
		CAPABILITY_VECTOR_INDEX: {
			deleteByIds: deleteVectorsMock,
		},
		STORAGE_RUNNER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ clearStorage: clearStorageMock }),
		},
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				clearAll: clearRunLogMock,
				listStorageIds: async () => [] as Array<string>,
			}),
		},
		JOB_MANAGER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ purgeUser: purgeJobManagerMock }),
		},
		REPO_SESSION: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ purgeSession: purgeRepoSessionMock }),
		},
		REMOTE_CONNECTOR_SESSION: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ rpcPurgeUserSession: purgeRemoteConnectorMock }),
		},
		MCP_CLIENT_HUB: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ purgeForAccountDeletion: purgeMcpClientHubMock }),
		},
		MCP_OBJECT: {
			idFromString: (id: string) => id as unknown as DurableObjectId,
			get: () => ({
				purgeForAccountDeletion: purgeMcpAgentSessionMock,
			}),
		},
		PACKAGE_REALTIME_SESSION: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ fetch: doFetchMock }),
		},
		PACKAGE_SERVICE_INSTANCE: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ fetch: doFetchMock }),
		},
	})

	// password_resets.user_id is the database integer id; the deletion
	// service must use the dbUserId (1) to clear the deleted user's reset
	// tokens while leaving the other user's tokens in place.
	const result = await deleteUserAccount({
		env,
		dbUserId: 1,
		mcpUserId: userAaa,
	})

	// Cross-user data is preserved.
	expect(rows.jobs).toEqual([
		{ id: 'job-3', user_id: userBbb, storage_id: 'job:job-3' },
	])
	expect(rows.mcp_memories).toEqual([{ id: 'mem-2', user_id: userBbb }])
	expect(rows.saved_packages).toEqual([
		{
			id: 'pkg-2',
			user_id: userBbb,
			kody_id: 'other',
			source_id: 'src-2',
			has_app: 0,
		},
	])
	expect(rows.remote_connector_settings).toEqual([
		{ id: 'rc-2', user_id: userBbb, instance_id: 'other' },
	])
	expect(rows.mcp_agent_sessions).toEqual([
		{ do_id: 'do-user-b', user_id: userBbb },
	])
	expect(rows.published_bundle_artifacts).toEqual([
		{ id: 'pba-2', user_id: userBbb, kv_key: 'bundle-artifact:v1:src-2' },
	])
	expect(rows.password_resets).toEqual([{ id: 3, user_id: 2 }])
	expect(rows.user_roles).toEqual([{ user_id: 2, role_id: 2 }])
	expect(rows.passkeys).toEqual([{ id: 'pk-2', user_id: 2 }])
	expect(rows.verifications).toEqual([{ id: 2, type: '2fa', target: '2' }])

	// User-scoped data is removed.
	expect(rows.secret_buckets).toEqual([])
	expect(rows.secret_entries).toEqual([])
	expect(rows.value_buckets).toEqual([])
	expect(rows.value_entries).toEqual([])
	expect(rows.archived_job_artifacts).toEqual([])
	expect(rows.entity_sources).toEqual([
		{ id: 'src-2', user_id: userBbb, published_commit: 'def456' },
	])
	expect(rows.repo_sessions).toEqual([])
	expect(rows.email_attachments).toEqual([])
	// The other user's message and its R2 raw-MIME blob are untouched.
	expect(rows.email_messages).toEqual([
		{
			id: 'em-3',
			user_id: userBbb,
			raw_mime_key: 'email-raw:v1:user-bbb/em-3',
		},
	])
	expect(deletedEmailBlobKeys.sort()).toEqual([
		'email-raw:v1:user-aaa/em-1',
		'email-raw:v1:user-aaa/em-2',
	])
	expect(rows.entitlement_daily_counters).toEqual([
		{ user_id: userBbb, resource: 'email_sends_per_day', day: '2026-07-05' },
	])
	expect(rows.platform_feedback).toEqual([
		{
			id: 'feedback-reviewed-by-a',
			submitter_user_id: userBbb,
			submitter_username: 'user-b',
			submitter_email: 'b@example.com',
			reviewed_by_user_id: null,
			reviewed_at: null,
			admin_note: null,
		},
		{
			id: 'feedback-unrelated',
			submitter_user_id: userBbb,
			submitter_username: 'user-b',
			submitter_email: 'b@example.com',
			reviewed_by_user_id: userBbb,
			reviewed_at: '2026-07-05',
			admin_note: 'Reviewed by B.',
		},
	])
	expect(rows.package_service_states).toEqual([
		{
			user_id: userBbb,
			package_id: 'pkg-2',
			service_name: 'sync',
			status: 'running',
			started_at: '2026-07-05T00:00:00.000Z',
			updated_at: '2026-07-05T00:00:00.000Z',
		},
	])
	expect(rows.user_storage_buckets).toEqual([
		{
			user_id: userBbb,
			storage_id: 'service:pkg-2:sync',
			kind: 'service',
		},
	])
	expect(rows.community_listings).toEqual([
		{ id: 'listing-2', owner_user_id: userBbb, pinned_commit: 'commit-2' },
	])
	expect(rows.community_forks).toEqual([
		{ id: 'fork-3', listing_id: 'listing-2', forker_user_id: userBbb },
	])
	expect(rows.community_ratings).toEqual([
		{ id: 'rating-3', listing_id: 'listing-2', user_id: userBbb },
	])
	expect(rows.community_stars).toEqual([
		{ listing_id: 'listing-2', user_id: userBbb },
	])
	expect(rows.community_activity_events).toEqual([
		{
			id: 'evt-3',
			actor_user_id: userBbb,
			event_type: 'listing_published',
			listing_id: 'listing-2',
		},
	])
	expect(rows.user_follows).toEqual([
		{ follower_user_id: userBbb, followee_user_id: 'user-ccc' },
	])
	expect(rows.community_reports).toEqual([
		{
			id: 'report-3',
			listing_id: 'listing-2',
			listing_owner_user_id: userBbb,
			reporter_user_id: userBbb,
			resolved_by_user_id: null,
			resolved_at: null,
			resolution_note: null,
		},
	])
	expect(rows.community_bans).toEqual([
		{ user_id: userBbb, banned_by_user_id: 'deleted-user' },
	])
	expect(rows.package_codemod_run_items).toEqual([
		{
			id: 'codemod-item-2',
			run_id: 'codemod-run-2',
			user_id: userBbb,
			package_id: 'pkg-2',
			kody_id: 'demo-b',
			status: 'applied',
		},
	])
	expect(rows.package_codemod_runs).toEqual([
		{
			id: 'codemod-run-1',
			codemod_id: '0001-ambient-storage-to-package-storage',
			mode: 'apply',
			scope_user_id: 'deleted-user',
			initiated_by_user_id: 'deleted-user',
			filters_json: JSON.stringify({ userIds: ['deleted-user', userBbb] }),
			status: 'completed',
		},
		{
			id: 'codemod-run-fleet',
			codemod_id: '0001-ambient-storage-to-package-storage',
			mode: 'scan',
			scope_user_id: null,
			initiated_by_user_id: userBbb,
			filters_json: JSON.stringify({ userIds: ['deleted-user'] }),
			status: 'completed',
		},
		{
			id: 'codemod-run-2',
			codemod_id: '0001-ambient-storage-to-package-storage',
			mode: 'apply',
			scope_user_id: userBbb,
			initiated_by_user_id: userBbb,
			filters_json: JSON.stringify({ userIds: [userBbb] }),
			status: 'completed',
		},
	])
	for (const run of rows.package_codemod_runs ?? []) {
		expect(String(run['filters_json'])).not.toContain(userAaa)
	}
	expect(rows.users).toEqual([{ id: 2, email: 'b@example.com' }])
	expect(result.deletedRowCounts.password_resets).toBe(2)
	expect(result.deletedRowCounts.user_roles).toBe(1)

	// Out-of-band stores for the deleted user were cleared.
	expect(deleteVectorsMock).toHaveBeenCalledWith([
		'memory_mem-1',
		'job_job-1',
		'job_job-2',
		jobVectorId(packageJobId),
		'package_pkg-1',
	])
	expect(clearStorageMock).toHaveBeenCalledTimes(7)
	expect(purgeJobManagerMock).toHaveBeenCalledTimes(1)
	expect(purgeRepoSessionMock).toHaveBeenCalledWith({
		sessionId: 'rs-1',
		userId: userAaa,
	})
	expect(purgeRemoteConnectorMock).toHaveBeenCalledWith({
		userId: userAaa,

		instanceId: 'home',
	})
	expect(doFetchMock).toHaveBeenCalledTimes(4)

	// Bundle KV keys for the deleted user were removed; the other user's keys
	// remain in storage.
	expect(deletedKvKeys.sort()).toEqual([
		'bundle-artifact:v1:src-1',
		'community-snapshot:v1:listing-1',
		'derived-cache:v1:community-icon:v1:listing-1:abc123',
		'derived-cache:v1:community-icon:v1:listing-1:commit-1',
		'derived-cache:v1:community-icon:v1:listing-1:historical',
		`package-codemod-revert:${userAaa}:item-1`,
		`package-codemod-revert:${userAaa}:item-2`,
		'package-retriever-index-entry:v1:user-aaa:context:pkg-1:notes',
		'package-retriever-index-entry:v1:user-aaa:search:pkg-1:notes',
		'package-retriever-index:v1:user-aaa:context',
		'package-retriever-index:v1:user-aaa:search',
		'package-retriever-manifest:v1:user-aaa:pkg-1:abc123',
		'source-manifest-snapshot:v1:src-1:abc123',
		'source-manifest-snapshot:v1:src-1:old456',
		'source-snapshot:v1:src-1:abc123',
		'source-snapshot:v1:src-1:old456',
	])
	expect(deletedKvKeys).not.toContain(
		'package-retriever-index-entry:v1:user-bbb:search:pkg-2:notes',
	)
	expect(deletedKvKeys).not.toContain(
		'package-retriever-index:v1:user-bbb:search',
	)
	expect(deletedKvKeys).not.toContain(
		`package-codemod-revert:${userBbb}:item-other`,
	)

	// Result accounting captures the per-table counts.
	expect(result.deletedRowCounts.jobs).toBe(3)
	expect(result.deletedRowCounts.users).toBe(1)
	expect(result.deletedRowCounts.email_attachments).toBe(1)
	expect(result.deletedRowCounts.package_service_states).toBe(3)
	expect(result.deletedRowCounts.user_storage_buckets).toBe(1)
	expect(result.deletedRowCounts.community_listings).toBe(1)
	expect(result.deletedRowCounts.community_forks).toBe(2)
	expect(result.deletedRowCounts.community_ratings).toBe(2)
	expect(result.deletedRowCounts.community_stars).toBe(2)
	expect(result.deletedRowCounts.community_activity_events).toBe(2)
	expect(result.deletedRowCounts.user_follows).toBe(2)
	expect(result.deletedRowCounts.community_reports).toBe(2)
	expect(result.updatedRowCounts.community_reports).toBe(1)
	expect(result.deletedRowCounts.community_bans).toBe(1)
	expect(result.updatedRowCounts.community_bans).toBe(1)
	expect(result.deletedRowCounts.platform_feedback).toBe(1)
	expect(result.updatedRowCounts.platform_feedback).toBe(1)
	expect(result.deletedKvKeys).toBe(16)
	expect(result.deletedCommunityAssets).toBe(5)
	expect(result.deletedEmailBlobs).toBe(2)
	// Prefix sweeps remove current and historical assets without crossing users.
	expect(deletedCommunityAssetKeys.sort()).toEqual([
		'community-icon:v1/listing-1/abc123/asset',
		'community-icon:v1/listing-1/commit-1/asset',
		'community-icon:v1/listing-1/historical/asset',
		'user-avatars/user-aaa/abc123.png',
		'user-avatars/user-aaa/old.png',
	])
	expect(communityAssetKeys).toEqual(
		new Set([
			'community-icon:v1/listing-2/other/asset',
			'user-avatars/user-bbb/other.png',
		]),
	)
	expect(result.deletedVectors).toBe(5)
	expect(result.clearedDurableObjects).toMatchObject({
		storageRunners: 7,
		runLogs: 1,
		jobManagers: 1,
		repoSessions: 1,
		remoteConnectorSessions: 1,
		// The MCP client hub is purged even when the user has no
		// mcp_server_settings rows, since the hub DO can still hold OAuth
		// tokens from failed or removed registrations.
		mcpClientHubs: 1,
		mcpAgentSessions: 1,
		packageRealtimeSessions: 1,
		packageServiceInstances: 3,
	})
	expect(clearRunLogMock).toHaveBeenCalledTimes(1)
	expect(purgeMcpClientHubMock).toHaveBeenCalledTimes(1)
	expect(purgeMcpAgentSessionMock).toHaveBeenCalledWith({
		userId: userAaa,
	})
	expect(result.warnings).toEqual([])
})

test('deleteUserAccount revokes OAuth grants and fails closed on critical cleanup errors', async () => {
	const revokeGrant = vi.fn(async () => undefined)
	const { db: revokeDb } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
	})
	const revokeResult = await deleteUserAccount({
		env: createSuccessfulDeletionEnv(revokeDb, {
			OAUTH_PROVIDER: {
				async listUserGrants() {
					return {
						items: [
							{ id: 'grant-1', clientId: 'client-1' },
							{ id: 'grant-2', clientId: 'client-2' },
						],
						cursor: undefined,
					}
				},
				revokeGrant,
			},
		}),
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(revokeGrant).toHaveBeenCalledTimes(2)
	expect(revokeResult.revokedOAuthGrants).toBe(2)
	expect(revokeResult.warnings).toEqual([])

	const { db: oauthFailureDb, rows: oauthFailureRows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
		jobs: [{ id: 'job-1', user_id: 'user-aaa', storage_id: null }],
	})
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(oauthFailureDb, {
				OAUTH_PROVIDER: {
					async listUserGrants() {
						throw new Error('OAuth provider is temporarily unavailable')
					},
					revokeGrant: vi.fn(async () => undefined),
				},
			}),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toBeInstanceOf(AccountDeletionCleanupError)
	expect(oauthFailureRows.jobs).toEqual([
		{ id: 'job-1', user_id: 'user-aaa', storage_id: null },
	])
	expect(oauthFailureRows.users).toEqual([
		expect.objectContaining({
			id: 1,
			email: 'a@example.com',
			deleting_at: expect.any(String),
		}),
	])

	const { db: kvFailureDb, rows: kvFailureRows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
		published_bundle_artifacts: [
			{ id: 'pba-1', user_id: 'user-aaa', kv_key: 'bundle-artifact:v1:src-1' },
		],
		archived_job_artifacts: [
			{ id: 'aja-1', user_id: 'user-aaa', kv_key: 'archived:src-1' },
		],
		email_messages: [
			{
				id: 'em-1',
				user_id: 'user-aaa',
				raw_mime_key: 'email-raw:v1:user-aaa/em-1',
			},
		],
	})
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(kvFailureDb, {
				BUNDLE_ARTIFACTS_KV: {
					delete: vi.fn(async () => undefined),
					list: vi.fn(async () => ({
						keys: [],
						list_complete: true,
						cursor: undefined,
					})),
				},
				EMAIL_BLOBS: {
					list: vi.fn(async () => ({
						objects: [{ key: 'email-raw:v1:user-aaa/em-1' }],
						delimitedPrefixes: [],
						truncated: false,
					})),
					delete: vi.fn(async () => {
						throw new Error('simulated R2 outage')
					}),
				},
			}),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toMatchObject({
		cleanupErrors: expect.arrayContaining([
			expect.stringContaining('Email raw MIME prefix delete failed'),
		]),
	})
	expect(kvFailureRows.published_bundle_artifacts).toHaveLength(1)
	expect(kvFailureRows.archived_job_artifacts).toHaveLength(1)
	expect(kvFailureRows.email_messages).toHaveLength(1)
	expect(kvFailureRows.users).toEqual([
		expect.objectContaining({
			id: 1,
			email: 'a@example.com',
			deleting_at: expect.any(String),
		}),
	])
})

test('account deletion reports a missing email blob binding and remains retryable', async () => {
	const { db, rows } = createTestDb({
		users: [
			{
				id: 1,
				email: 'a@example.com',
				stable_user_id: 'user-aaa',
			},
		],
		email_messages: [{ id: 'message-a', user_id: 'user-aaa' }],
	})
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(db, {
				EMAIL_BLOBS: undefined,
			}),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toMatchObject({
		cleanupErrors: expect.arrayContaining([
			'EMAIL_BLOBS binding was unavailable; email objects were not removed.',
		]),
	})
	expect(rows.email_messages).toEqual([
		{ id: 'message-a', user_id: 'user-aaa' },
	])
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			deleting_at: expect.any(String),
		}),
	])
})

test('account deletion is disabled until legacy MCP sessions are backfilled', async () => {
	const { db, rows } = createTestDb({
		users: [{ id: 1, stable_user_id: 'user-aaa' }],
		deployment_backfill_markers: [],
	})
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toThrow('MCP agent session backfill is incomplete')
	expect(rows.users).toEqual([{ id: 1, stable_user_id: 'user-aaa' }])
})

test('deleteUserAccount fails closed when preflight inventory cannot be read', async () => {
	const { db, rows } = createTestDb(
		{
			users: [{ id: 1, email: 'a@example.com' }],
			mcp_memories: [{ id: 'memory-a', user_id: 'user-aaa' }],
			jobs: [{ id: 'job-a', user_id: 'user-aaa', storage_id: 'job:job-a' }],
		},
		{ failSelectContaining: 'select id from mcp_memories where user_id = ?' },
	)
	const deleteVectors = vi.fn(async () => undefined)
	const clearStorage = vi.fn(async () => undefined)
	await expect(
		deleteUserAccount({
			env: {
				APP_DB: db,
				CAPABILITY_VECTOR_INDEX: { deleteByIds: deleteVectors },
				STORAGE_RUNNER: {
					idFromName: (name: string) => name as unknown as DurableObjectId,
					get: () => ({ clearStorage }),
				},
			} as unknown as Parameters<typeof deleteUserAccount>[0]['env'],
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toBeInstanceOf(AccountDeletionInventoryError)
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			email: 'a@example.com',
			deleting_at: expect.any(String),
		}),
	])
	expect(rows.mcp_memories).toEqual([{ id: 'memory-a', user_id: 'user-aaa' }])
	expect(rows.jobs).toEqual([
		{ id: 'job-a', user_id: 'user-aaa', storage_id: 'job:job-a' },
	])
	expect(deleteVectors).not.toHaveBeenCalled()
	expect(clearStorage).not.toHaveBeenCalled()
})

test('account deletion removes deterministic legacy retriever keys when KV listing fails', async () => {
	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
		saved_packages: [
			{
				id: 'package-a',
				user_id: 'user-aaa',
				kody_id: 'package-a',
				source_id: 'source-a',
				has_app: 0,
			},
		],
	})
	const deletedKeys: Array<string> = []
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(db, {
				BUNDLE_ARTIFACTS_KV: {
					get: vi.fn(async () => '{}'),
					delete: vi.fn(async (key: string) => {
						deletedKeys.push(key)
					}),
					list: vi.fn(async () => {
						throw new Error('KV list unavailable')
					}),
				},
			}),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toBeInstanceOf(AccountDeletionCleanupError)
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			email: 'a@example.com',
			deleting_at: expect.any(String),
		}),
	])
	expect(deletedKeys).toEqual(
		expect.arrayContaining([
			'package-retriever-index:v1:user-aaa:search',
			'package-retriever-index:v1:user-aaa:context',
		]),
	)
})

test('atomic D1 deletion rolls back every row when one statement fails', async () => {
	const { db, rows } = createTestDb(
		{
			users: [{ id: 1, email: 'a@example.com' }],
			jobs: [{ id: 'job-a', user_id: 'user-aaa', storage_id: null }],
			mcp_memories: [{ id: 'memory-a', user_id: 'user-aaa' }],
		},
		{ failRunContaining: 'delete from jobs where user_id = ?' },
	)
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toMatchObject({
		cleanupErrors: [
			expect.stringContaining('Atomic D1 account deletion failed'),
		],
	})
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			email: 'a@example.com',
			deleting_at: expect.any(String),
		}),
	])
	expect(rows.jobs).toEqual([
		{ id: 'job-a', user_id: 'user-aaa', storage_id: null },
	])
	expect(rows.mcp_memories).toEqual([{ id: 'memory-a', user_id: 'user-aaa' }])
})

test('account deletion quiesces a concurrent user write before inventory', async () => {
	let env: Parameters<typeof deleteUserAccount>[0]['env']
	let raceAttempted = false
	let writeCommitted = false
	let writeError: unknown
	const { db } = createTestDb(
		{
			users: [
				{
					id: 1,
					email: 'a@example.com',
					stable_user_id: 'user-aaa',
					updated_at: '2026-07-22',
				},
			],
		},
		{
			async onSelect(query) {
				if (
					raceAttempted ||
					!query.includes('select id from mcp_memories where user_id = ?')
				) {
					return
				}
				raceAttempted = true
				try {
					await assertAccountWritable(env, 'user-aaa')
					writeCommitted = true
				} catch (error) {
					writeError = error
				}
			},
		},
	)
	env = createSuccessfulDeletionEnv(db)
	await deleteUserAccount({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(raceAttempted).toBe(true)
	expect(writeCommitted).toBe(false)
	expect(writeError).toBeInstanceOf(AccountDeletionInProgressError)
})

test('account deletion waits for an active writer and resumes on retry', async () => {
	const { db, rows } = createTestDb({
		users: [
			{
				id: 1,
				email: 'a@example.com',
				stable_user_id: 'user-aaa',
				active_write_count: 1,
				updated_at: '2026-07-22',
			},
		],
		account_write_leases: [
			{
				token: 'crashed-token',
				user_id: 'user-aaa',
				holder: 'test',
				acquired_at: '2000-01-01 00:00:00',
				released_at: null,
			},
		],
	})
	const env = createSuccessfulDeletionEnv(db)
	await expect(
		deleteUserAccount({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toBeInstanceOf(AccountDeletionWritersActiveError)
	expect(rows.users?.[0]).toEqual(
		expect.objectContaining({
			deleting_at: expect.any(String),
			active_write_count: 1,
		}),
	)
	rows.account_write_leases![0]!['released_at'] = '2026-07-23 00:00:00'
	rows.users![0]!['active_write_count'] = 0
	await expect(
		deleteUserAccount({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).resolves.toEqual(expect.objectContaining({ warnings: [] }))
	expect(rows.users).toEqual([])
})

test('account deletion empties the user RunLog DO and leaves other users untouched', async () => {
	const userAaa = 'user-aaa'
	const userBbb = 'user-bbb'
	const runLogByUser = new Map<
		string,
		{
			runs: Array<{ id: string; storageId: string | null }>
			logs: Array<{ runId: string; message: string }>
		}
	>([
		[
			userAaa,
			{
				runs: [{ id: 'run-a', storageId: 'run-only-bucket' }],
				logs: [{ runId: 'run-a', message: 'aaa console output' }],
			},
		],
		[
			userBbb,
			{
				runs: [{ id: 'run-b', storageId: 'bbb-bucket' }],
				logs: [{ runId: 'run-b', message: 'bbb console output' }],
			},
		],
	])
	const clearedStorageIds: Array<string> = []
	const { db } = createTestDb({
		users: [
			{ id: 1, email: 'a@example.com', stable_user_id: userAaa },
			{ id: 2, email: 'b@example.com', stable_user_id: userBbb },
		],
	})
	const env = createSuccessfulDeletionEnv(db, {
		STORAGE_RUNNER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: (id: DurableObjectId) => ({
				clearStorage: async () => {
					clearedStorageIds.push(String(id))
					return { ok: true as const }
				},
			}),
		},
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: (id: DurableObjectId) => {
				const userId = String(id)
				return {
					listStorageIds: async () => {
						const state = runLogByUser.get(userId)
						return (state?.runs ?? [])
							.map((run) => run.storageId)
							.filter((value): value is string => value != null)
					},
					clearAll: async () => {
						const state = runLogByUser.get(userId)
						if (state) {
							state.runs = []
							state.logs = []
						}
						return { ok: true as const }
					},
					exportRuns: async () => {
						const state = runLogByUser.get(userId) ?? {
							runs: [],
							logs: [],
						}
						return {
							runs: state.runs,
							logs: state.logs,
							nextStartAfter: null,
							truncated: false,
						}
					},
				}
			},
		},
	})

	const result = await deleteUserAccount({
		env,
		dbUserId: 1,
		mcpUserId: userAaa,
	})

	expect(result.clearedDurableObjects.runLogs).toBe(1)
	expect(runLogByUser.get(userAaa)).toEqual({ runs: [], logs: [] })
	expect(runLogByUser.get(userBbb)).toEqual({
		runs: [{ id: 'run-b', storageId: 'bbb-bucket' }],
		logs: [{ runId: 'run-b', message: 'bbb console output' }],
	})
	expect(clearedStorageIds.some((id) => id.includes('run-only-bucket'))).toBe(
		true,
	)
	expect(clearedStorageIds.some((id) => id.includes('bbb-bucket'))).toBe(false)
})

test('account deletion purges a StorageRunner known only via user_storage_buckets', async () => {
	const userId = 'user-bucket-only'
	const clearStorage = vi.fn(async () => ({ ok: true as const }))
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const { db } = createTestDb({
		users: [{ id: 1, email: 'bucket@example.com', stable_user_id: userId }],
		user_storage_buckets: [
			{
				user_id: userId,
				storage_id: 'exec:adhoc-only',
				kind: 'execute',
			},
		],
	})

	const result = await deleteUserAccount({
		env: createSuccessfulDeletionEnv(db, {
			STORAGE_RUNNER: {
				idFromName,
				get: () => ({ clearStorage }),
			},
		}),
		dbUserId: 1,
		mcpUserId: userId,
	})

	expect(result.clearedDurableObjects.storageRunners).toBe(1)
	expect(clearStorage).toHaveBeenCalledTimes(1)
	expect(idFromName).toHaveBeenCalledWith(
		JSON.stringify([userId, 'exec:adhoc-only']),
	)
})

test('account deletion purges a PackageServiceInstance known only via package_service_states', async () => {
	const userId = 'user-states-only'
	const serviceFetch = vi.fn(async () => Response.json({ ok: true }))
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const { db } = createTestDb({
		users: [{ id: 1, email: 'states@example.com', stable_user_id: userId }],
		saved_packages: [
			{
				id: 'pkg-states',
				user_id: userId,
				kody_id: 'states-pkg',
				source_id: 'src-states',
				has_app: 0,
			},
		],
		package_service_states: [
			{
				user_id: userId,
				package_id: 'pkg-states',
				service_name: 'only-in-states',
				status: 'running',
				started_at: '2026-07-05T00:00:00.000Z',
				updated_at: '2026-07-05T00:00:00.000Z',
			},
		],
	})

	const result = await deleteUserAccount({
		env: createSuccessfulDeletionEnv(db, {
			BUNDLE_ARTIFACTS_KV: {
				get: async () => null,
				async list() {
					return { keys: [], list_complete: true as const }
				},
				delete: async () => undefined,
			},
			PACKAGE_SERVICE_INSTANCE: {
				idFromName,
				get: () => ({ fetch: serviceFetch }),
			},
		}),
		dbUserId: 1,
		mcpUserId: userId,
	})

	expect(result.clearedDurableObjects.packageServiceInstances).toBe(1)
	expect(serviceFetch).toHaveBeenCalledTimes(1)
	const request = serviceFetch.mock.calls[0]?.[0] as Request
	expect(new URL(request.url).pathname).toContain('/purge')
	const body = (await request.clone().json()) as {
		binding: { packageId: string; serviceName: string }
	}
	expect(body.binding).toMatchObject({
		packageId: 'pkg-states',
		serviceName: 'only-in-states',
	})
	expect(idFromName).toHaveBeenCalledWith(
		JSON.stringify([userId, 'pkg-states', 'only-in-states']),
	)
})

test('account deletion purges a service declared only in the package manifest', async () => {
	const userId = 'user-manifest-only'
	const serviceFetch = vi.fn(async () => Response.json({ ok: true }))
	const { db } = createTestDb({
		users: [{ id: 1, email: 'manifest@example.com', stable_user_id: userId }],
		saved_packages: [
			{
				id: 'pkg-manifest',
				user_id: userId,
				kody_id: 'manifest-pkg',
				source_id: 'src-manifest',
				has_app: 0,
				name: 'Manifest Package',
				description: '',
				tags_json: '[]',
				search_text: null,
				hidden: 0,
				is_private: 1,
				created_at: '2026-07-05T00:00:00.000Z',
				updated_at: '2026-07-05T00:00:00.000Z',
			},
		],
	})

	const loadManifest = vi.spyOn(
		await import('#worker/package-registry/source.ts'),
		'loadPackageManifestBySourceId',
	)
	loadManifest.mockResolvedValue({
		source: {
			id: 'src-manifest',
			userId,
			entityKind: 'package',
			entityId: 'pkg-manifest',
			repoId: 'repo-1',
			manifestPath: 'package.json',
			sourceRoot: '.',
			publishedCommit: null,
		},
		manifest: {
			name: 'manifest-pkg',
			kody: {
				services: {
					'only-in-manifest': {
						entry: './services/only-in-manifest.ts',
					},
				},
			},
		},
	} as never)

	const listSaved = vi.spyOn(
		await import('#worker/package-registry/repo.ts'),
		'listSavedPackagesByUserId',
	)
	listSaved.mockResolvedValue([
		{
			id: 'pkg-manifest',
			userId,
			name: 'Manifest Package',
			kodyId: 'manifest-pkg',
			description: '',
			tags: [],
			searchText: null,
			sourceId: 'src-manifest',
			hasApp: false,
			hidden: false,
			isPrivate: true,
			createdAt: '2026-07-05T00:00:00.000Z',
			updatedAt: '2026-07-05T00:00:00.000Z',
		},
	])

	try {
		const result = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(db, {
				BUNDLE_ARTIFACTS_KV: {
					get: async () => null,
					async list() {
						return { keys: [], list_complete: true as const }
					},
					delete: async () => undefined,
				},
				PACKAGE_SERVICE_INSTANCE: {
					idFromName: (name: string) => name as unknown as DurableObjectId,
					get: () => ({ fetch: serviceFetch }),
				},
			}),
			dbUserId: 1,
			mcpUserId: userId,
		})

		expect(result.clearedDurableObjects.packageServiceInstances).toBe(1)
		const request = serviceFetch.mock.calls[0]?.[0] as Request
		const body = (await request.clone().json()) as {
			binding: { packageId: string; serviceName: string; kodyId: string }
		}
		expect(body.binding).toMatchObject({
			packageId: 'pkg-manifest',
			serviceName: 'only-in-manifest',
			kodyId: 'manifest-pkg',
		})
	} finally {
		loadManifest.mockRestore()
		listSaved.mockRestore()
	}
})

test('account deletion continues when manifest load fails and still purges state-table services', async () => {
	const userId = 'user-manifest-fail'
	const serviceFetch = vi.fn(async () => Response.json({ ok: true }))
	consoleWarn.mockImplementation(() => {})
	const { db } = createTestDb({
		users: [{ id: 1, email: 'fail@example.com', stable_user_id: userId }],
		saved_packages: [
			{
				id: 'pkg-fail',
				user_id: userId,
				kody_id: 'fail-pkg',
				source_id: 'src-fail',
				has_app: 0,
			},
		],
		package_service_states: [
			{
				user_id: userId,
				package_id: 'pkg-fail',
				service_name: 'known-in-states',
				status: 'idle',
				started_at: null,
				updated_at: '2026-07-05T00:00:00.000Z',
			},
		],
	})

	const listSaved = vi.spyOn(
		await import('#worker/package-registry/repo.ts'),
		'listSavedPackagesByUserId',
	)
	listSaved.mockResolvedValue([
		{
			id: 'pkg-fail',
			userId,
			name: 'Fail Package',
			kodyId: 'fail-pkg',
			description: '',
			tags: [],
			searchText: null,
			sourceId: 'src-fail',
			hasApp: false,
			hidden: false,
			isPrivate: true,
			createdAt: '2026-07-05T00:00:00.000Z',
			updatedAt: '2026-07-05T00:00:00.000Z',
		},
	])
	const loadManifest = vi.spyOn(
		await import('#worker/package-registry/source.ts'),
		'loadPackageManifestBySourceId',
	)
	loadManifest.mockRejectedValue(new Error('manifest unavailable'))

	try {
		let result
		try {
			result = await deleteUserAccount({
				env: createSuccessfulDeletionEnv(db, {
					BUNDLE_ARTIFACTS_KV: {
						get: async () => null,
						async list() {
							return { keys: [], list_complete: true as const }
						},
						delete: async () => undefined,
					},
					PACKAGE_SERVICE_INSTANCE: {
						idFromName: (name: string) => name as unknown as DurableObjectId,
						get: () => ({ fetch: serviceFetch }),
					},
				}),
				dbUserId: 1,
				mcpUserId: userId,
			})
		} catch (error) {
			expect(error).toBeInstanceOf(AccountDeletionCleanupError)
			const cleanupError = error as AccountDeletionCleanupError
			expect(
				cleanupError.cleanupErrors.some((warning) =>
					warning.includes('Failed to load package manifest'),
				),
			).toBe(true)
			result = cleanupError.partialResult
		}

		expect(result.clearedDurableObjects.packageServiceInstances).toBe(1)
		const request = serviceFetch.mock.calls[0]?.[0] as Request
		const body = (await request.clone().json()) as {
			binding: { packageId: string; serviceName: string }
		}
		expect(body.binding).toMatchObject({
			packageId: 'pkg-fail',
			serviceName: 'known-in-states',
		})
		expect(consoleWarn).toHaveBeenCalledWith(
			expect.stringContaining('Failed to load package manifest'),
		)
	} finally {
		loadManifest.mockRestore()
		listSaved.mockRestore()
		consoleWarn.mockReset()
	}
})
