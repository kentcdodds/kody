import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { readdirSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	deleteUserAccount,
	getAccountDeletionD1UserColumnCoverage,
} from './account-deletion.ts'
import { accountUserDataExcludedOwnerIds } from './account-data-targets.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'

type RowMap = Record<string, Array<Record<string, unknown>>>

function createTestDb(initial: RowMap): {
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
							let results: Array<unknown> = []
							const userId = params[0] as string
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
								"select distinct package_id, name from package_runtime_runs where user_id = ? and surface = 'service' and name is not null"
							) {
								const seen = new Set<string>()
								results = []
								for (const row of rows.package_runtime_runs ?? []) {
									if (
										row['user_id'] !== userId ||
										row['surface'] !== 'service' ||
										row['name'] == null
									) {
										continue
									}
									const key = `${String(row['package_id'])}:${String(row['name'])}`
									if (seen.has(key)) continue
									seen.add(key)
									results.push({
										package_id: row['package_id'],
										name: row['name'],
									})
								}
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (lower.startsWith('select distinct r.package_id,')) {
								const seen = new Set<string>()
								results = []
								for (const row of rows.package_runtime_runs ?? []) {
									if (
										row['user_id'] !== userId ||
										row['surface'] !== 'service' ||
										row['name'] == null
									) {
										continue
									}
									const savedPackage = (rows.saved_packages ?? []).find(
										(pkg) =>
											pkg['id'] === row['package_id'] &&
											pkg['user_id'] === row['user_id'],
									)
									const sourceId =
										savedPackage?.['source_id'] ?? row['source_id']
									const key = `${String(row['package_id'])}:${String(row['name'])}`
									if (seen.has(key)) continue
									seen.add(key)
									results.push({
										package_id: row['package_id'],
										kody_id:
											savedPackage?.['kody_id'] ?? row['package_kody_id'],
										source_id: sourceId,
										name: row['name'],
									})
								}
								return { results: results as Array<T>, meta: { changes: 0 } }
							}
							if (
								lower.startsWith(
									'select community_listings.id, community_listings.pinned_commit',
								)
							) {
								results = (rows.community_listings ?? [])
									.filter((row) => row['owner_user_id'] === userId)
									.map((row) => {
										const source = (rows.entity_sources ?? []).find(
											(sourceRow) =>
												sourceRow['id'] === row['source_id'] &&
												sourceRow['user_id'] === row['owner_user_id'],
										)
										return {
											id: row['id'],
											pinned_commit: row['pinned_commit'],
											source_published_commit:
												source?.['published_commit'] ?? null,
										}
									})
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
							if (
								lower ===
								'select raw_mime_key from email_messages where user_id = ? and raw_mime_key is not null'
							) {
								results = (rows.email_messages ?? [])
									.filter(
										(row) =>
											row['user_id'] === userId && row['raw_mime_key'] != null,
									)
									.map((row) => ({ raw_mime_key: row['raw_mime_key'] }))
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
							return { results: [] as Array<T>, meta: { changes: 0 } }
						},
						async first<T>() {
							const result = await this.all<T>()
							return (result.results[0] ?? null) as T | null
						},
						async run() {
							const userId = params[0] as string | number
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
	} as unknown as D1Database

	return { db, rows }
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
		env: { APP_DB: db } as unknown as Parameters<
			typeof deleteUserAccount
		>[0]['env'],
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
			{ id: 1, email: 'a@example.com' },
			{ id: 2, email: 'b@example.com' },
		],
		jobs: [
			{ id: 'job-1', user_id: userAaa, storage_id: 'job:job-1' },
			{ id: 'job-2', user_id: userAaa, storage_id: null },
			{ id: packageJobId, user_id: userAaa, storage_id: null },
			{ id: 'job-3', user_id: userBbb, storage_id: 'job:job-3' },
		],
		package_runtime_runs: [
			{
				id: 'run-1',
				user_id: userAaa,
				package_id: 'pkg-1',
				package_kody_id: 'demo',
				source_id: 'src-1',
				surface: 'service',
				name: 'sync',
				storage_id: 'service:pkg-1:sync',
			},
			{
				id: 'run-2',
				user_id: userAaa,
				package_id: 'pkg-1',
				package_kody_id: 'demo',
				source_id: 'src-1',
				surface: 'app_fetch',
				name: null,
				storage_id: 'exec:run-2',
			},
			{
				id: 'run-orphan-service',
				user_id: userAaa,
				package_id: 'pkg-orphan',
				package_kody_id: 'legacy',
				source_id: null,
				surface: 'service',
				name: 'legacy-sync',
				storage_id: null,
			},
			{
				id: 'run-3',
				user_id: userBbb,
				package_id: 'pkg-2',
				package_kody_id: 'other',
				source_id: 'src-2',
				surface: 'service',
				name: 'sync',
				storage_id: 'service:pkg-2:sync',
			},
		],
		package_runtime_logs: [
			{ id: 'log-1', run_id: 'run-1', user_id: userAaa, package_id: 'pkg-1' },
			{ id: 'log-2', run_id: 'run-3', user_id: userBbb, package_id: 'pkg-2' },
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
		package_invocations: [{ id: 'pi-1', user_id: userAaa }],
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
				reviewed_by_user_id: userBbb,
				reviewed_at: '2026-07-05',
				admin_note: 'Reviewed by B.',
			},
			{
				id: 'feedback-reviewed-by-a',
				submitter_user_id: userBbb,
				reviewed_by_user_id: userAaa,
				reviewed_at: '2026-07-05',
				admin_note: 'Private admin note from A.',
			},
			{
				id: 'feedback-unrelated',
				submitter_user_id: userBbb,
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
	})

	const deletedKvKeys: Array<string> = []
	const kv = {
		async delete(key: string) {
			deletedKvKeys.push(key)
		},
		async list(options?: { prefix?: string; cursor?: string }) {
			const allKeys = [
				'source-snapshot:v1:src-1:abc123',
				'source-manifest-snapshot:v1:src-1:abc123',
				'source-snapshot:v1:src-1:old456',
				'source-manifest-snapshot:v1:src-1:old456',
				'source-snapshot:v1:src-2:def456',
				'package-retriever-manifest:v1:user-aaa:pkg-1:abc123',
				'package-retriever-index-entry:v1:user-aaa:search:pkg-1:notes',
				'package-retriever-index-entry:v1:user-aaa:context:pkg-1:notes',
				'package-retriever-index-entry:v1:user-bbb:search:pkg-2:notes',
			]
			const keys = allKeys
				.filter((key) => key.startsWith(options?.prefix ?? ''))
				.map((name) => ({ name }))
			return {
				keys,
				list_complete: true,
				cursor: undefined,
			}
		},
	} as unknown as KVNamespace

	const deletedEmailBlobKeys: Array<string> = []
	const emailBlobs = {
		async delete(key: string) {
			deletedEmailBlobKeys.push(key)
		},
	} as unknown as R2Bucket
	const deletedCommunityAssetKeys: Array<string> = []
	const communityAssets = {
		async delete(key: string) {
			deletedCommunityAssetKeys.push(key)
		},
	} as unknown as R2Bucket

	const clearStorageMock = vi.fn(async () => ({ ok: true as const }))
	const purgeJobManagerMock = vi.fn(async () => ({ ok: true as const }))
	const purgeRepoSessionMock = vi.fn(async () => ({ ok: true as const }))
	const purgeRemoteConnectorMock = vi.fn(async () => ({ ok: true as const }))
	const purgeMcpClientHubMock = vi.fn(async () => undefined)
	const doFetchMock = vi.fn(async () => Response.json({ ok: true }))
	const deleteVectorsMock = vi.fn(async () => undefined)
	const env = {
		APP_DB: db,
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
		PACKAGE_REALTIME_SESSION: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ fetch: doFetchMock }),
		},
		PACKAGE_SERVICE_INSTANCE: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ fetch: doFetchMock }),
		},
	} as unknown as Env

	// password_resets.user_id is the database integer id; the deletion
	// service must use the dbUserId (1) to clear the deleted user's reset
	// tokens while leaving the other user's tokens in place.
	const result = await deleteUserAccount({
		env: env as Env & { OAUTH_PROVIDER: undefined },
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
	expect(deletedEmailBlobKeys).toEqual(['email-raw:v1:user-aaa/em-1'])
	expect(rows.entitlement_daily_counters).toEqual([
		{ user_id: userBbb, resource: 'email_sends_per_day', day: '2026-07-05' },
	])
	expect(rows.platform_feedback).toEqual([
		{
			id: 'feedback-reviewed-by-a',
			submitter_user_id: userBbb,
			reviewed_by_user_id: null,
			reviewed_at: null,
			admin_note: null,
		},
		{
			id: 'feedback-unrelated',
			submitter_user_id: userBbb,
			reviewed_by_user_id: userBbb,
			reviewed_at: '2026-07-05',
			admin_note: 'Reviewed by B.',
		},
	])
	expect(rows.package_runtime_runs).toEqual([
		{
			id: 'run-3',
			user_id: userBbb,
			package_id: 'pkg-2',
			package_kody_id: 'other',
			source_id: 'src-2',
			surface: 'service',
			name: 'sync',
			storage_id: 'service:pkg-2:sync',
		},
	])
	expect(rows.package_runtime_logs).toEqual([
		{ id: 'log-2', run_id: 'run-3', user_id: userBbb, package_id: 'pkg-2' },
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
	expect(clearStorageMock).toHaveBeenCalledTimes(6)
	expect(purgeJobManagerMock).toHaveBeenCalledTimes(1)
	expect(purgeRepoSessionMock).toHaveBeenCalledWith({
		sessionId: 'rs-1',
		userId: userAaa,
	})
	expect(purgeRemoteConnectorMock).toHaveBeenCalledWith({
		userId: userAaa,

		instanceId: 'home',
	})
	expect(doFetchMock).toHaveBeenCalledTimes(3)

	// Bundle KV keys for the deleted user were removed; the other user's keys
	// remain in storage.
	expect(deletedKvKeys.sort()).toEqual([
		'bundle-artifact:v1:src-1',
		'community-snapshot:v1:listing-1',
		'derived-cache:v1:community-icon:v1:listing-1:abc123',
		'derived-cache:v1:community-icon:v1:listing-1:commit-1',
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

	// Result accounting captures the per-table counts.
	expect(result.deletedRowCounts.jobs).toBe(3)
	expect(result.deletedRowCounts.users).toBe(1)
	expect(result.deletedRowCounts.email_attachments).toBe(1)
	expect(result.deletedRowCounts.package_runtime_runs).toBe(3)
	expect(result.deletedRowCounts.package_runtime_logs).toBe(1)
	expect(result.deletedRowCounts.community_listings).toBe(1)
	expect(result.deletedRowCounts.community_forks).toBe(2)
	expect(result.deletedRowCounts.community_ratings).toBe(2)
	expect(result.deletedRowCounts.community_reports).toBe(2)
	expect(result.updatedRowCounts.community_reports).toBe(1)
	expect(result.deletedRowCounts.community_bans).toBe(1)
	expect(result.updatedRowCounts.community_bans).toBe(1)
	expect(result.deletedRowCounts.platform_feedback).toBe(1)
	expect(result.updatedRowCounts.platform_feedback).toBe(1)
	expect(result.deletedKvKeys).toBe(13)
	expect(result.deletedCommunityAssets).toBe(2)
	expect(result.deletedEmailBlobs).toBe(1)
	// Both the pinned snapshot revision and the current icon commit revision
	// (the source's published commit) are removed.
	expect(deletedCommunityAssetKeys.sort()).toEqual([
		'community-icon:v1/listing-1/abc123/asset',
		'community-icon:v1/listing-1/commit-1/asset',
	])
	expect(result.deletedVectors).toBe(5)
	expect(result.clearedDurableObjects).toMatchObject({
		storageRunners: 6,
		jobManagers: 1,
		repoSessions: 1,
		remoteConnectorSessions: 1,
		// The MCP client hub is purged even when the user has no
		// mcp_server_settings rows, since the hub DO can still hold OAuth
		// tokens from failed or removed registrations.
		mcpClientHubs: 1,
		packageRealtimeSessions: 1,
		packageServiceInstances: 2,
	})
	expect(purgeMcpClientHubMock).toHaveBeenCalledTimes(1)
	expect(result.warnings.length).toBeGreaterThan(0)
})

test('deleteUserAccount handles OAuth grant revocation and warning-only edge cases', async () => {
	const revokeGrant = vi.fn(async () => undefined)
	const { db: revokeDb } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
	})
	const revokeResult = await deleteUserAccount({
		env: {
			APP_DB: revokeDb,
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
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ clearStorage: async () => ({ ok: true as const }) }),
			},
		} as unknown as Parameters<typeof deleteUserAccount>[0]['env'],
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(revokeGrant).toHaveBeenCalledTimes(2)
	expect(revokeResult.revokedOAuthGrants).toBe(2)
	expect(revokeResult.warnings).toContain(
		'JOB_MANAGER binding was unavailable; the user scheduler Durable Object was not purged.',
	)

	const { db: oauthFailureDb, rows: oauthFailureRows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
		jobs: [{ id: 'job-1', user_id: 'user-aaa', storage_id: null }],
	})
	const oauthFailureResult = await deleteUserAccount({
		env: {
			APP_DB: oauthFailureDb,
			OAUTH_PROVIDER: {
				async listUserGrants() {
					throw new Error('OAuth provider is temporarily unavailable')
				},
				revokeGrant: vi.fn(async () => undefined),
			},
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ clearStorage: async () => ({ ok: true as const }) }),
			},
		} as unknown as Parameters<typeof deleteUserAccount>[0]['env'],
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(oauthFailureRows.jobs).toEqual([])
	expect(oauthFailureRows.users).toEqual([])
	expect(oauthFailureResult.revokedOAuthGrants).toBe(0)
	expect(oauthFailureResult.warnings.length).toBeGreaterThan(0)

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
	const kvFailureResult = await deleteUserAccount({
		env: {
			APP_DB: kvFailureDb,
			EMAIL_BLOBS: {
				delete: vi.fn(async () => {
					throw new Error('simulated R2 outage')
				}),
			},
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ clearStorage: async () => ({ ok: true as const }) }),
			},
		} as unknown as Parameters<typeof deleteUserAccount>[0]['env'],
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(kvFailureRows.published_bundle_artifacts).toEqual([])
	expect(kvFailureRows.archived_job_artifacts).toEqual([])
	expect(kvFailureRows.email_messages).toEqual([])
	expect(kvFailureResult.deletedKvKeys).toBe(0)
	// The D1 rows are still removed when the blob delete fails; the
	// stranded blob is reported as a warning instead of aborting.
	expect(kvFailureResult.deletedEmailBlobs).toBe(0)
	expect(kvFailureResult.warnings).toContain(
		'Email blob delete failed for email-raw:v1:user-aaa/em-1: simulated R2 outage',
	)
	expect(kvFailureResult.warnings.length).toBeGreaterThan(0)
})
