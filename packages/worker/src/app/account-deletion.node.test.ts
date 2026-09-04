import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import * as stripeClient from '#worker/billing/stripe-client.ts'
import {
	AccountDeletionBillingError,
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
	deleteUserAccount,
	getAccountDeletionD1UserColumnCoverage,
} from './account-deletion.ts'
import { AccountDeletionWritersActiveError } from '#worker/account/deletion-state.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'
import { accountUserDataExcludedOwnerIds } from '#worker/account/data-targets.ts'
import { jobVectorId } from '#mcp/jobs-vectorize.ts'
import { consoleError } from '#worker/test-support/console-spies.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'
import {
	insertRepoSession,
	listRepoSessionsByUser,
} from '#worker/repo/repo-sessions.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { accountUserOwnedVectorizeSurfaces } from '#worker/account/user-owned-surfaces.ts'
import {
	createTestDb,
	createJobsBindingStub,
	createSuccessfulDeletionEnv,
} from '#worker/test-support/account-deletion.ts'

const appMigrationsDir = new URL('../../migrations/', import.meta.url)

function listSqliteTables(db: DatabaseSync) {
	return (
		db
			.prepare(
				`SELECT name
				FROM sqlite_schema
				WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
				ORDER BY name`,
			)
			.all() as Array<{ name: string }>
	).map((row) => row.name)
}

test('vectorize surface sources match the migrated APP_DB schema', () => {
	const db = new DatabaseSync(':memory:')
	applyAllMigrations(db, appMigrationsDir)
	const tables = new Set(listSqliteTables(db))

	// Jobs moved to the jobs worker's D1 (migration 0010 dropped the APP_DB
	// copies), so the job surface must be sourced over the JOBS binding rather
	// than an APP_DB table scan.
	expect(tables.has('jobs')).toBe(false)
	for (const surface of accountUserOwnedVectorizeSurfaces) {
		switch (surface.source.kind) {
			case 'app_db': {
				expect(
					tables.has(surface.source.table),
					`vectorize surface ${surface.id} reads APP_DB table ${surface.source.table}, which the migrated schema does not define`,
				).toBe(true)
				break
			}
			case 'jobs_rpc': {
				expect(surface.id).toBe('job')
				break
			}
			default: {
				const unknownSource: never = surface.source
				throw new Error(
					`Unknown vectorize source: ${JSON.stringify(unknownSource)}`,
				)
			}
		}
	}
})

test('deleteUserAccount enumerates job vectors through JOBS against the real post-0010 APP_DB schema', async () => {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, appMigrationsDir)
	const db = createD1FromSqlite(sqlite)
	const userId = 'user-post-0010'
	const inserted = await db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id,
				email_verified_at, account_type, created_at
			) VALUES ('post0010', 'post0010@example.com', 'hash', ?, ?, 'person', ?)`,
		)
		.bind(userId, '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
		.run()
	const dbUserId = Number(inserted.meta.last_row_id)
	await db
		.prepare(
			`INSERT INTO mcp_memories (id, user_id, subject, summary)
			VALUES ('mem-post-0010', ?, 'subject', 'summary')`,
		)
		.bind(userId)
		.run()

	const deleteVectorsMock = vi.fn(async () => undefined)
	const listJobIdsForUser = vi.fn(async (_input: { userId: string }) => [
		'job-live-1',
		'job-live-2',
	])
	const purgeJobsUser = vi.fn(async (input: { userId: string }) => ({
		ok: true as const,
		userId: input.userId,
		purged: true,
	}))
	const env = createSuccessfulDeletionEnv(db, {
		CAPABILITY_VECTOR_INDEX: { deleteByIds: deleteVectorsMock },
		JOBS: {
			listJobIdsForUser,
			listJobStorageIdsForUser: async () => [] as Array<string>,
			purgeUser: purgeJobsUser,
		},
	} as unknown as Partial<Env>)

	const result = await deleteUserAccount({ env, dbUserId, mcpUserId: userId })

	expect(listJobIdsForUser).toHaveBeenCalledWith({ userId })
	expect(deleteVectorsMock).toHaveBeenCalledWith([
		'memory_mem-post-0010',
		jobVectorId('job-live-1'),
		jobVectorId('job-live-2'),
	])
	expect(result.deletedVectors).toBe(3)
	expect(purgeJobsUser).toHaveBeenCalledWith({ userId })
	expect(result.warnings).toEqual([])
	expect(sqlite.prepare(`SELECT COUNT(*) AS count FROM users`).get()).toEqual({
		count: 0,
	})
	expect(
		sqlite.prepare(`SELECT COUNT(*) AS count FROM mcp_memories`).get(),
	).toEqual({ count: 0 })
})

test('deleteUserAccount fails inventory loudly when JOBS is unbound instead of scanning APP_DB for jobs', async () => {
	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
	})
	const env = createSuccessfulDeletionEnv(db, {
		JOBS: undefined,
	} as unknown as Partial<Env>)

	await expect(
		deleteUserAccount({ env, dbUserId: 1, mcpUserId: 'user-aaa' }),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof AccountDeletionInventoryError &&
			error.inventoryErrors.some((message) =>
				message.includes(
					'JOBS service binding is required to enumerate job vector ids',
				),
			),
	)
	expect(rows.users).toEqual([
		expect.objectContaining({ id: 1, deleting_at: null }),
	])
})

test('account deletion D1 coverage includes every live user-owned schema column', () => {
	const migrationsDir = new URL('../../migrations/', import.meta.url)
	const db = new DatabaseSync(':memory:')
	applyAllMigrations(db, migrationsDir)
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

test('account deletion preserves operator-owned system email configuration', async () => {
	expect(
		accountUserDataExcludedOwnerIds.some(
			(exclusion) => exclusion.ownerId === 'system:email',
		),
	).toBe(true)

	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'user@example.com' }],
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
		user_storage_buckets: [
			{
				user_id: userAaa,
				storage_id: 'exec:run-2',
				kind: 'execute',
			},
			{
				user_id: userAaa,
				storage_id: 'repo-session:rs-1',
				kind: 'repo_session',
			},
			{
				user_id: userBbb,
				storage_id: 'package:pkg-2',
				kind: 'package',
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
		mcp_memory_conversation_suppressions: [
			{ user_id: userAaa, conversation_id: 'c1', memory_id: 'mem-1' },
		],
		email_inboxes: [{ id: 'in-1', user_id: userAaa }],
		email_inbox_addresses: [{ id: 'ia-1', user_id: userAaa }],
		email_sender_identities: [{ id: 'ei-1', user_id: userAaa }],
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
		'derived-cache:v1:community-icon:v2:listing-1:commit-1',
		'derived-cache:v1:community-icon:v2:listing-1:abc123',
		'derived-cache:v1:community-icon:v3:listing-1:commit-1',
		'derived-cache:v1:community-icon:v3:listing-1:abc123',
		'source-snapshot:v1:src-2:def456',
		`package-codemod-revert:${userAaa}:item-1`,
		`package-codemod-revert:${userAaa}:item-2`,
		`package-codemod-revert:${userBbb}:item-other`,
		'package-retriever-manifest:v1:user-aaa:pkg-1:abc123',
		'package-retriever-index-entry:v1:user-aaa:search:pkg-1:notes',
		'package-retriever-index-entry:v1:user-aaa:context:pkg-1:notes',
		'package-retriever-index-entry:v1:user-bbb:search:pkg-2:notes',
		'platform-settings:v1:reserved-usernames',
		'platform-settings:v1:signup-mode',
		'public-code-runs:v2',
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
	const mailboxCleanupOrder: Array<string> = []
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
			mailboxCleanupOrder.push('delete-email-blob')
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
		'community-icon:v2/listing-1/abc123/asset',
		'community-icon:v2/listing-1/commit-1/asset',
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
	const purgeUserMeterMock = vi.fn(async () => ({ ok: true as const }))
	const purgeStripePlanRefreshMock = vi.fn(async () => ({ ok: true as const }))
	const stripePlanRefreshIdFromNameMock = vi.fn(
		(name: string) => name as unknown as DurableObjectId,
	)
	const purgeMailboxMock = vi.fn(async () => {
		mailboxCleanupOrder.push('purge-mailbox')
		return { ok: true as const }
	})
	const listBlobReferencesMock = vi.fn(
		async ({ startAfter }: { startAfter?: string | null }) => {
			mailboxCleanupOrder.push('list-blob-references')
			if (startAfter == null) {
				return {
					references: [
						{
							kind: 'raw_mime' as const,
							key: 'email-raw:v1:user-aaa/em-1',
							messageId: 'em-1',
							attachmentId: null,
						},
						{
							kind: 'raw_mime' as const,
							key: 'email-raw:v1:user-aaa/em-2',
							messageId: 'em-2',
							attachmentId: null,
						},
					],
					nextStartAfter: null,
					truncated: false as const,
				}
			}
			return {
				references: [],
				nextStartAfter: null,
				truncated: false as const,
			}
		},
	)
	const jobsBindingStub = createJobsBindingStub(db)
	const purgeJobManagerMock = vi.fn((input: { userId: string }) =>
		jobsBindingStub.purgeUser(input),
	)
	const purgeRepoSessionMock = vi.fn(async () => ({ ok: true as const }))
	const purgeMcpClientHubMock = vi.fn(async () => undefined)
	const purgeMcpAgentSessionMock = vi.fn(async () => undefined)
	const doFetchMock = vi.fn(async () => Response.json({ ok: true }))
	const deleteVectorsMock = vi.fn(async () => undefined)
	const userMeter = createInMemoryUserMeterEnv()
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
		USER_METER: {
			idFromName: (name: string) => userMeter.env.USER_METER!.idFromName(name),
			get: (id: DurableObjectId) => ({
				...userMeter.env.USER_METER!.get(id),
				purge: async () => purgeUserMeterMock(),
			}),
		},
		STRIPE_PLAN_REFRESH: {
			idFromName: stripePlanRefreshIdFromNameMock,
			get: () => ({ purgeUser: purgeStripePlanRefreshMock }),
		},
		MAILBOX: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				listBlobReferences: listBlobReferencesMock,
				purge: purgeMailboxMock,
			}),
		},
		JOBS: createJobsBindingStub(db, {
			purgeUser: purgeJobManagerMock as unknown,
		}),
		REPO_SESSION: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ purgeSession: purgeRepoSessionMock }),
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
	})
	await insertRepoSession(env, {
		id: 'rs-1',
		user_id: userAaa,
		source_id: 'src-1',
		source_repo_id: '',
		session_branch: 'sessions/rs-1',
		source_branch: 'main',
		base_commit: 'abc123',
		source_root: '/',
		conversation_id: null,
		status: 'active',
		expires_at: null,
		last_checkpoint_at: null,
		last_checkpoint_commit: null,
		last_check_run_id: null,
		last_check_tree_hash: null,
		created_at: '2026-07-05T00:00:00.000Z',
		updated_at: '2026-07-05T00:00:00.000Z',
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
	await expect(listRepoSessionsByUser(env, userAaa)).resolves.toEqual([])
	expect(deletedEmailBlobKeys.sort()).toEqual([
		'email-raw:v1:user-aaa/em-1',
		'email-raw:v1:user-aaa/em-2',
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
	expect(rows.user_storage_buckets).toEqual([
		{
			user_id: userBbb,
			storage_id: 'package:pkg-2',
			kind: 'package',
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
	expect(rows.community_activity_events).toEqual([
		{
			id: 'evt-3',
			actor_user_id: userBbb,
			event_type: 'listing_published',
			listing_id: 'listing-2',
		},
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
	expect(rows.users).toEqual([
		{ id: 2, email: 'b@example.com', stable_user_id: 'user-bbb' },
	])
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
	expect(clearStorageMock).toHaveBeenCalledTimes(3)
	expect(purgeJobManagerMock).toHaveBeenCalledTimes(1)
	expect(purgeRepoSessionMock).toHaveBeenCalledWith({
		sessionId: 'rs-1',
		userId: userAaa,
	})
	expect(doFetchMock).toHaveBeenCalledTimes(1)

	// Bundle KV keys for the deleted user were removed; the other user's keys
	// remain in storage.
	expect(deletedKvKeys.sort()).toEqual([
		'bundle-artifact:v1:src-1',
		'community-snapshot:v1:listing-1',
		'derived-cache:v1:community-icon:v1:listing-1:abc123',
		'derived-cache:v1:community-icon:v1:listing-1:commit-1',
		'derived-cache:v1:community-icon:v1:listing-1:historical',
		'derived-cache:v1:community-icon:v2:listing-1:abc123',
		'derived-cache:v1:community-icon:v2:listing-1:commit-1',
		'derived-cache:v1:community-icon:v3:listing-1:abc123',
		'derived-cache:v1:community-icon:v3:listing-1:commit-1',
		`package-codemod-revert:${userAaa}:item-1`,
		`package-codemod-revert:${userAaa}:item-2`,
		'package-retriever-index-entry:v1:user-aaa:context:pkg-1:notes',
		'package-retriever-index-entry:v1:user-aaa:search:pkg-1:notes',
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
		`package-codemod-revert:${userBbb}:item-other`,
	)
	expect(deletedKvKeys).not.toContain('platform-settings:v1:reserved-usernames')
	expect(deletedKvKeys).not.toContain('platform-settings:v1:signup-mode')
	expect(deletedKvKeys).not.toContain('public-code-runs:v2')

	// Result accounting captures the per-table counts. Job rows are purged
	// through the JOBS service (ADR 0016), so they are not counted here.
	expect(result.deletedRowCounts.jobs).toBeUndefined()
	expect(result.deletedRowCounts.users).toBe(1)
	expect(result.deletedRowCounts.user_storage_buckets).toBe(2)
	expect(result.deletedRowCounts.community_listings).toBe(1)
	expect(result.deletedRowCounts.community_forks).toBe(2)
	expect(result.deletedRowCounts.community_ratings).toBe(2)
	expect(result.deletedRowCounts.community_activity_events).toBe(2)
	expect(result.deletedRowCounts.community_reports).toBe(2)
	expect(result.updatedRowCounts.community_reports).toBe(1)
	expect(result.deletedRowCounts.community_bans).toBe(1)
	expect(result.updatedRowCounts.community_bans).toBe(1)
	expect(result.deletedRowCounts.platform_feedback).toBe(1)
	expect(result.updatedRowCounts.platform_feedback).toBe(1)
	expect(result.deletedKvKeys).toBe(18)
	expect(result.deletedCommunityAssets).toBe(7)
	expect(result.deletedEmailBlobs).toBe(2)
	// Prefix sweeps remove current and historical assets without crossing users.
	expect(deletedCommunityAssetKeys.sort()).toEqual([
		'community-icon:v1/listing-1/abc123/asset',
		'community-icon:v1/listing-1/commit-1/asset',
		'community-icon:v1/listing-1/historical/asset',
		'community-icon:v2/listing-1/abc123/asset',
		'community-icon:v2/listing-1/commit-1/asset',
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
		storageRunners: 3,
		runLogs: 1,
		userMeters: 1,
		stripePlanRefreshes: 1,
		mailboxes: 1,
		jobManagers: 1,
		repoSessions: 1,
		// The MCP client hub is purged even when the user has no
		// mcp_server_settings rows, since the hub DO can still hold OAuth
		// tokens from failed or removed registrations.
		mcpClientHubs: 1,
		mcpAgentSessions: 1,
		packageRealtimeSessions: 1,
	})
	expect(clearRunLogMock).toHaveBeenCalledTimes(1)
	expect(purgeUserMeterMock).toHaveBeenCalledTimes(1)
	expect(stripePlanRefreshIdFromNameMock).toHaveBeenCalledWith(userAaa)
	expect(purgeStripePlanRefreshMock).toHaveBeenCalledWith({ userId: userAaa })
	expect(listBlobReferencesMock).toHaveBeenCalledTimes(1)
	expect(purgeMailboxMock).toHaveBeenCalledTimes(1)
	expect(mailboxCleanupOrder[0]).toBe('list-blob-references')
	expect(mailboxCleanupOrder.indexOf('delete-email-blob')).toBeGreaterThan(
		mailboxCleanupOrder.indexOf('list-blob-references'),
	)
	expect(mailboxCleanupOrder.indexOf('purge-mailbox')).toBeGreaterThan(
		mailboxCleanupOrder.lastIndexOf('delete-email-blob'),
	)
	expect(purgeMcpClientHubMock).toHaveBeenCalledTimes(1)
	expect(purgeMcpAgentSessionMock).toHaveBeenCalledWith({
		userId: userAaa,
	})
	expect(result.warnings).toEqual([])
})

test('account deletion preserves Mailbox references and retry marker when R2 deletion fails', async () => {
	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com', stable_user_id: 'user-aaa' }],
	})
	const purgeMailbox = vi.fn(async () => ({ ok: true as const }))
	const deleteEmailBlob = vi.fn(async () => {
		throw new Error('email R2 delete unavailable')
	})
	const listBlobReferences = vi.fn(async () => ({
		references: [
			{
				kind: 'raw_mime' as const,
				key: 'email-raw:v1:user-aaa/message-1',
				messageId: 'message-1',
				attachmentId: null,
			},
		],
		nextStartAfter: null,
		truncated: false as const,
	}))
	const env = createSuccessfulDeletionEnv(db, {
		EMAIL_BLOBS: {
			async list() {
				return {
					objects: [{ key: 'email-raw:v1:user-aaa/message-1' }],
					delimitedPrefixes: [],
					truncated: false,
				}
			},
			delete: deleteEmailBlob,
		} as unknown as R2Bucket,
		MAILBOX: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				listBlobReferences,
				purge: purgeMailbox,
			}),
		} as unknown as DurableObjectNamespace,
	})

	await expect(
		deleteUserAccount({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof AccountDeletionCleanupError &&
			error.cleanupErrors.some((warning) =>
				warning.includes('email R2 delete unavailable'),
			),
	)
	expect(listBlobReferences).toHaveBeenCalledTimes(1)
	expect(deleteEmailBlob).toHaveBeenCalled()
	expect(purgeMailbox).not.toHaveBeenCalled()
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			stable_user_id: 'user-aaa',
			deleting_at: expect.any(String),
		}),
	])

	const { db: unrelatedDb } = createTestDb({
		users: [{ id: 1, email: 'b@example.com', stable_user_id: 'user-bbb' }],
	})
	const purgeAfterUnrelatedFailure = vi.fn(async () => ({ ok: true as const }))
	const unrelatedFailureEnv = createSuccessfulDeletionEnv(unrelatedDb, {
		OAUTH_PROVIDER: undefined,
		MAILBOX: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				listBlobReferences: async () => ({
					references: [],
					nextStartAfter: null,
					truncated: false as const,
				}),
				purge: purgeAfterUnrelatedFailure,
			}),
		} as unknown as DurableObjectNamespace,
	})
	await expect(
		deleteUserAccount({
			env: unrelatedFailureEnv,
			dbUserId: 1,
			mcpUserId: 'user-bbb',
		}),
	).rejects.toBeInstanceOf(AccountDeletionCleanupError)
	expect(purgeAfterUnrelatedFailure).not.toHaveBeenCalled()
})

function stripeSubscription(id: string, status: string) {
	return {
		id,
		status,
		cancel_at: null,
		items: { data: [{ price: { id: 'price_pro' } }] },
	}
}

/**
 * Spies the refund half of the Stripe client with "nothing paid yet" defaults
 * so cancel-focused tests do not accidentally issue credit notes.
 */
function spyOnStripeRefundClient() {
	const getLatestPaidInvoiceForSubscription = vi
		.spyOn(stripeClient, 'getLatestPaidInvoiceForSubscription')
		.mockResolvedValue(null)
	const listCreditNotesForInvoice = vi
		.spyOn(stripeClient, 'listCreditNotesForInvoice')
		.mockResolvedValue([])
	const createProratedRefundCreditNote = vi
		.spyOn(stripeClient, 'createProratedRefundCreditNote')
		.mockRejectedValue(new Error('unexpected credit note'))
	return {
		getLatestPaidInvoiceForSubscription,
		listCreditNotesForInvoice,
		createProratedRefundCreditNote,
		restore() {
			getLatestPaidInvoiceForSubscription.mockRestore()
			listCreditNotesForInvoice.mockRestore()
			createProratedRefundCreditNote.mockRestore()
		},
	}
}

const thirtyDaysSeconds = 30 * 24 * 60 * 60
const refundPeriodStart = Math.floor(
	new Date('2026-09-01T00:00:00.000Z').getTime() / 1000,
)
const refundPeriodEnd = refundPeriodStart + thirtyDaysSeconds

function paidInvoice(input: {
	id: string
	amountPaid: number
	lineAmount?: number
	lineId?: string
}) {
	return {
		id: input.id,
		amount_paid: input.amountPaid,
		currency: 'usd',
		lines: {
			data: [
				{
					id: input.lineId ?? `il_${input.id}`,
					amount: input.lineAmount ?? input.amountPaid,
					period: { start: refundPeriodStart, end: refundPeriodEnd },
				},
			],
		},
	}
}

function createStripeUserDb(input: {
	id: number
	stableUserId: string
	customerId: string | null
}) {
	return createTestDb({
		users: [
			{
				id: input.id,
				email: `${input.stableUserId}@example.com`,
				stable_user_id: input.stableUserId,
				stripe_customer_id: input.customerId,
			},
		],
		mcp_memories: [
			{ id: `mem-${input.stableUserId}`, user_id: input.stableUserId },
		],
	})
}

test('account deletion cancels Stripe billing before cleanup and keeps customer deletion best-effort', async () => {
	const listSubscriptions = vi.spyOn(stripeClient, 'listSubscriptions')
	const cancelSubscription = vi.spyOn(stripeClient, 'cancelSubscription')
	const deleteCustomer = vi.spyOn(stripeClient, 'deleteCustomer')
	const refundClient = spyOnStripeRefundClient()
	try {
		listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_active', 'active'),
			stripeSubscription('sub_trialing', 'trialing'),
			// Dunning and paused states can still invoice or resume, so they
			// must be canceled too; only terminal states are skipped.
			stripeSubscription('sub_past_due', 'past_due'),
			stripeSubscription('sub_unpaid', 'unpaid'),
			stripeSubscription('sub_paused', 'paused'),
			stripeSubscription('sub_incomplete', 'incomplete'),
			stripeSubscription('sub_canceled', 'canceled'),
			stripeSubscription('sub_expired', 'incomplete_expired'),
		])
		cancelSubscription.mockResolvedValue(undefined)
		deleteCustomer.mockResolvedValue(undefined)
		const { db, rows } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-pro',
			customerId: 'cus_pro',
		})

		const result = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-pro',
		})

		expect(listSubscriptions).toHaveBeenCalledTimes(1)
		expect(listSubscriptions).toHaveBeenCalledWith(
			expect.any(Object),
			'cus_pro',
		)
		expect(cancelSubscription).toHaveBeenCalledTimes(6)
		expect(
			cancelSubscription.mock.calls.map(([, subscriptionId]) => subscriptionId),
		).toEqual([
			'sub_active',
			'sub_trialing',
			'sub_past_due',
			'sub_unpaid',
			'sub_paused',
			'sub_incomplete',
		])
		expect(deleteCustomer).toHaveBeenCalledWith(expect.any(Object), 'cus_pro')
		expect(rows.users).toEqual([])
		expect(result.warnings).toEqual([])
		// Only subscriptions in good standing are even considered for a refund;
		// with no paid invoice there is nothing to credit.
		expect(
			refundClient.getLatestPaidInvoiceForSubscription.mock.calls.map(
				([, subscriptionId]) => subscriptionId,
			),
		).toEqual(['sub_active', 'sub_trialing'])
		expect(refundClient.createProratedRefundCreditNote).not.toHaveBeenCalled()
		expect(result.stripeRefunds).toEqual([])

		// Customer deletion after a successful cancel stays warning-only: nothing
		// bills a customer with no billable subscription.
		listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_active', 'active'),
		])
		deleteCustomer.mockRejectedValue(new Error('Stripe customer unavailable'))
		cancelSubscription.mockClear()
		consoleError.mockImplementation(() => {})
		const { db: customerFailureDb, rows: customerFailureRows } =
			createStripeUserDb({
				id: 2,
				stableUserId: 'user-customer-failure',
				customerId: 'cus_failure',
			})

		const customerFailureResult = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(customerFailureDb),
			dbUserId: 2,
			mcpUserId: 'user-customer-failure',
		})

		expect(cancelSubscription).toHaveBeenCalledWith(
			expect.any(Object),
			'sub_active',
		)
		expect(deleteCustomer).toHaveBeenLastCalledWith(
			expect.any(Object),
			'cus_failure',
		)
		expect(customerFailureRows.users).toEqual([])
		expect(customerFailureResult.warnings).toEqual([
			expect.stringContaining('Stripe customer cleanup failed'),
		])
		expect(consoleError).toHaveBeenCalledOnce()
		expect(consoleError).toHaveBeenCalledWith(
			'account_deletion_stripe_cleanup_failed',
			expect.objectContaining({
				userId: 'user-customer-failure',
				error: expect.any(Error),
			}),
		)

		listSubscriptions.mockClear()
		deleteCustomer.mockClear()
		const { db: freeDb, rows: freeRows } = createStripeUserDb({
			id: 3,
			stableUserId: 'user-free',
			customerId: null,
		})
		await deleteUserAccount({
			env: createSuccessfulDeletionEnv(freeDb),
			dbUserId: 3,
			mcpUserId: 'user-free',
		})
		expect(listSubscriptions).not.toHaveBeenCalled()
		expect(deleteCustomer).not.toHaveBeenCalled()
		expect(freeRows.users).toEqual([])
	} finally {
		listSubscriptions.mockRestore()
		cancelSubscription.mockRestore()
		deleteCustomer.mockRestore()
		refundClient.restore()
		consoleError.mockReset()
	}
})

test('a failed Stripe cancellation retains the account, releases the fence, and touches nothing else', async () => {
	const listSubscriptions = vi.spyOn(stripeClient, 'listSubscriptions')
	const cancelSubscription = vi.spyOn(stripeClient, 'cancelSubscription')
	const deleteCustomer = vi.spyOn(stripeClient, 'deleteCustomer')
	const refundClient = spyOnStripeRefundClient()
	consoleError.mockImplementation(() => {})
	try {
		const cases: Array<{
			name: string
			stableUserId: string
			arrange: () => void
			expectedBillingErrors: Array<string>
		}> = [
			{
				name: 'listing fails',
				stableUserId: 'user-list-fails',
				arrange: () => {
					listSubscriptions.mockRejectedValue(
						new Error('Stripe subscriptions unavailable'),
					)
				},
				expectedBillingErrors: [
					'Stripe subscriptions could not be listed: Stripe subscriptions unavailable',
				],
			},
			{
				name: 'cancel is rejected and the subscription stays active',
				stableUserId: 'user-cancel-fails',
				arrange: () => {
					listSubscriptions.mockResolvedValue([
						stripeSubscription('sub_active', 'active'),
					])
					cancelSubscription.mockRejectedValue(
						new Error('Stripe cancel rejected'),
					)
				},
				expectedBillingErrors: [
					'Stripe subscription sub_active could not be canceled: Stripe cancel rejected',
				],
			},
		]
		for (const testCase of cases) {
			listSubscriptions.mockReset()
			cancelSubscription.mockReset()
			deleteCustomer.mockReset()
			deleteCustomer.mockResolvedValue(undefined)
			testCase.arrange()
			const deleteVectorsMock = vi.fn(async () => undefined)
			const { db, rows } = createStripeUserDb({
				id: 1,
				stableUserId: testCase.stableUserId,
				customerId: 'cus_billing',
			})
			const env = createSuccessfulDeletionEnv(db, {
				CAPABILITY_VECTOR_INDEX: { deleteByIds: deleteVectorsMock },
			} as unknown as Partial<Env>)
			const meter = userMeterRpc({ env, userId: testCase.stableUserId })

			await expect(
				deleteUserAccount({
					env,
					dbUserId: 1,
					mcpUserId: testCase.stableUserId,
				}),
				testCase.name,
			).rejects.toSatisfy(
				(error: unknown) =>
					error instanceof AccountDeletionBillingError &&
					JSON.stringify(error.billingErrors) ===
						JSON.stringify(testCase.expectedBillingErrors),
			)

			// Nothing destructive ran and the account is usable again.
			expect(deleteVectorsMock, testCase.name).not.toHaveBeenCalled()
			expect(deleteCustomer, testCase.name).not.toHaveBeenCalled()
			expect(rows.users, testCase.name).toEqual([
				expect.objectContaining({
					id: 1,
					stable_user_id: testCase.stableUserId,
					stripe_customer_id: 'cus_billing',
					deleting_at: null,
				}),
			])
			expect(rows.mcp_memories, testCase.name).toEqual([
				{ id: `mem-${testCase.stableUserId}`, user_id: testCase.stableUserId },
			])
			expect(await meter.readDeletionState(), testCase.name).toEqual({
				deletingAt: null,
			})
			expect(consoleError).toHaveBeenCalledWith(
				'account_deletion_billing_cancel_failed',
				{
					userId: testCase.stableUserId,
					billingErrors: testCase.expectedBillingErrors,
				},
			)
		}
	} finally {
		listSubscriptions.mockRestore()
		cancelSubscription.mockRestore()
		deleteCustomer.mockRestore()
		refundClient.restore()
		consoleError.mockReset()
	}
})

test('a subscription that is already canceled counts as canceled so retried deletions proceed', async () => {
	const listSubscriptions = vi.spyOn(stripeClient, 'listSubscriptions')
	const cancelSubscription = vi.spyOn(stripeClient, 'cancelSubscription')
	const deleteCustomer = vi.spyOn(stripeClient, 'deleteCustomer')
	const refundClient = spyOnStripeRefundClient()
	try {
		deleteCustomer.mockResolvedValue(undefined)

		// Retry after an earlier attempt already canceled everything: Stripe
		// lists the subscription as canceled, so nothing is canceled again.
		listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_old', 'canceled'),
		])
		const { db: retryDb, rows: retryRows } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-retry',
			customerId: 'cus_retry',
		})
		const retryResult = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(retryDb),
			dbUserId: 1,
			mcpUserId: 'user-retry',
		})
		expect(cancelSubscription).not.toHaveBeenCalled()
		expect(retryRows.users).toEqual([])
		expect(retryResult.warnings).toEqual([])

		// The cancel call errors (for example Stripe raced the cancellation) but
		// a fresh listing shows the subscription is no longer billable.
		listSubscriptions
			.mockReset()
			.mockResolvedValueOnce([stripeSubscription('sub_racing', 'active')])
			.mockResolvedValueOnce([stripeSubscription('sub_racing', 'canceled')])
		cancelSubscription.mockRejectedValue(
			new Error('Stripe API request failed with HTTP 400.'),
		)
		const { db: raceDb, rows: raceRows } = createStripeUserDb({
			id: 2,
			stableUserId: 'user-race',
			customerId: 'cus_race',
		})
		const raceResult = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(raceDb),
			dbUserId: 2,
			mcpUserId: 'user-race',
		})
		expect(cancelSubscription).toHaveBeenCalledWith(
			expect.any(Object),
			'sub_racing',
		)
		expect(listSubscriptions).toHaveBeenCalledTimes(2)
		expect(raceRows.users).toEqual([])
		expect(raceResult.warnings).toEqual([])
		expect(deleteCustomer).toHaveBeenCalledWith(expect.any(Object), 'cus_race')
	} finally {
		listSubscriptions.mockRestore()
		cancelSubscription.mockRestore()
		deleteCustomer.mockRestore()
		refundClient.restore()
	}
})

test('account deletion refunds unused time with a credit note before canceling each paid subscription', async () => {
	const listSubscriptions = vi.spyOn(stripeClient, 'listSubscriptions')
	const cancelSubscription = vi.spyOn(stripeClient, 'cancelSubscription')
	const deleteCustomer = vi.spyOn(stripeClient, 'deleteCustomer')
	const refundClient = spyOnStripeRefundClient()
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		// Exactly half of a 30-day period has elapsed.
		vi.setSystemTime(new Date((refundPeriodStart + thirtyDaysSeconds / 2) * 1000))
		listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_active', 'active'),
			stripeSubscription('sub_trialing', 'trialing'),
			stripeSubscription('sub_past_due', 'past_due'),
		])
		cancelSubscription.mockResolvedValue(undefined)
		deleteCustomer.mockResolvedValue(undefined)
		refundClient.getLatestPaidInvoiceForSubscription.mockImplementation(
			async (_env, subscriptionId) => {
				if (subscriptionId === 'sub_active') {
					return paidInvoice({ id: 'in_active', amountPaid: 1201 })
				}
				// A trial that has not converted has a $0 paid invoice.
				return paidInvoice({ id: 'in_trial', amountPaid: 0 })
			},
		)
		refundClient.createProratedRefundCreditNote.mockResolvedValue({
			id: 'cn_active',
			total: 600,
			currency: 'usd',
		})
		const { db, rows } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-refund',
			customerId: 'cus_refund',
		})

		const result = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-refund',
		})

		// floor(1201 * 15d / 30d) = 600: the odd cent stays with Kody, never
		// rounds up against the invoice.
		expect(refundClient.createProratedRefundCreditNote).toHaveBeenCalledOnce()
		expect(refundClient.createProratedRefundCreditNote).toHaveBeenCalledWith(
			expect.any(Object),
			{
				invoiceId: 'in_active',
				invoiceLineItemId: 'il_in_active',
				amount: 600,
				reason: 'order_change',
			},
		)
		expect(refundClient.listCreditNotesForInvoice).toHaveBeenCalledWith(
			expect.any(Object),
			'in_active',
		)
		// Refund precedes the cancel of the same subscription so the invoice
		// line's service period is still intact when Stripe prorates tax.
		const creditNoteOrder =
			refundClient.createProratedRefundCreditNote.mock.invocationCallOrder[0]!
		const activeCancelIndex = cancelSubscription.mock.calls.findIndex(
			([, subscriptionId]) => subscriptionId === 'sub_active',
		)
		expect(
			cancelSubscription.mock.invocationCallOrder[activeCancelIndex]!,
		).toBeGreaterThan(creditNoteOrder)
		expect(
			refundClient.getLatestPaidInvoiceForSubscription.mock.calls.map(
				([, subscriptionId]) => subscriptionId,
			),
		).toEqual(['sub_active', 'sub_trialing'])
		expect(
			cancelSubscription.mock.calls.map(([, subscriptionId]) => subscriptionId),
		).toEqual(['sub_active', 'sub_trialing', 'sub_past_due'])
		expect(result.stripeRefunds).toEqual([
			{
				subscriptionId: 'sub_active',
				amountMinor: 600,
				currency: 'usd',
				invoiceId: 'in_active',
				creditNoteId: 'cn_active',
			},
		])
		expect(rows.users).toEqual([])
		expect(result.warnings).toEqual([])
		expect(logAuditEventSpy).toHaveBeenCalledWith({
			db: null,
			category: 'account',
			action: 'account_deletion_refund',
			result: 'success',
			email: 'user-refund@example.com',
			reason: 'usd:600',
		})
		expect(auditEventSummaries()).toEqual(['account_deletion_refund:success'])
	} finally {
		vi.useRealTimers()
		listSubscriptions.mockRestore()
		cancelSubscription.mockRestore()
		deleteCustomer.mockRestore()
		refundClient.restore()
	}
})

test('a failed credit note retains the account, releases the fence, and cancels nothing', async () => {
	const listSubscriptions = vi.spyOn(stripeClient, 'listSubscriptions')
	const cancelSubscription = vi.spyOn(stripeClient, 'cancelSubscription')
	const deleteCustomer = vi.spyOn(stripeClient, 'deleteCustomer')
	const refundClient = spyOnStripeRefundClient()
	consoleError.mockImplementation(() => {})
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		vi.setSystemTime(new Date((refundPeriodStart + thirtyDaysSeconds / 2) * 1000))
		listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_active', 'active'),
		])
		cancelSubscription.mockResolvedValue(undefined)
		deleteCustomer.mockResolvedValue(undefined)
		refundClient.getLatestPaidInvoiceForSubscription.mockResolvedValue(
			paidInvoice({ id: 'in_active', amountPaid: 1200 }),
		)
		refundClient.createProratedRefundCreditNote.mockRejectedValue(
			new Error('Stripe credit note rejected'),
		)
		const deleteVectorsMock = vi.fn(async () => undefined)
		const { db, rows } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-refund-fails',
			customerId: 'cus_refund_fails',
		})
		const env = createSuccessfulDeletionEnv(db, {
			CAPABILITY_VECTOR_INDEX: { deleteByIds: deleteVectorsMock },
		} as unknown as Partial<Env>)
		const meter = userMeterRpc({ env, userId: 'user-refund-fails' })

		await expect(
			deleteUserAccount({
				env,
				dbUserId: 1,
				mcpUserId: 'user-refund-fails',
			}),
		).rejects.toSatisfy(
			(error: unknown) =>
				error instanceof AccountDeletionBillingError &&
				JSON.stringify(error.billingErrors) ===
					JSON.stringify([
						'Stripe subscription sub_active unused time could not be refunded: Stripe credit note rejected',
					]),
		)

		// The subscription stays active so the retry can refund it, and nothing
		// destructive ran.
		expect(cancelSubscription).not.toHaveBeenCalled()
		expect(deleteVectorsMock).not.toHaveBeenCalled()
		expect(deleteCustomer).not.toHaveBeenCalled()
		expect(rows.users).toEqual([
			expect.objectContaining({
				id: 1,
				stable_user_id: 'user-refund-fails',
				stripe_customer_id: 'cus_refund_fails',
				deleting_at: null,
			}),
		])
		expect(rows.mcp_memories).toEqual([
			{ id: 'mem-user-refund-fails', user_id: 'user-refund-fails' },
		])
		expect(await meter.readDeletionState()).toEqual({ deletingAt: null })
		expect(auditEventSummaries()).toEqual([])
		expect(consoleError).toHaveBeenCalledWith(
			'account_deletion_billing_cancel_failed',
			{
				userId: 'user-refund-fails',
				billingErrors: [
					'Stripe subscription sub_active unused time could not be refunded: Stripe credit note rejected',
				],
			},
		)
	} finally {
		vi.useRealTimers()
		listSubscriptions.mockRestore()
		cancelSubscription.mockRestore()
		deleteCustomer.mockRestore()
		refundClient.restore()
		consoleError.mockReset()
	}
})

test('a retried deletion reuses the earlier Kody credit note and treats an exhausted invoice as nothing to refund', async () => {
	const listSubscriptions = vi.spyOn(stripeClient, 'listSubscriptions')
	const cancelSubscription = vi.spyOn(stripeClient, 'cancelSubscription')
	const deleteCustomer = vi.spyOn(stripeClient, 'deleteCustomer')
	const refundClient = spyOnStripeRefundClient()
	vi.useFakeTimers({ toFake: ['Date'] })
	try {
		vi.setSystemTime(new Date((refundPeriodStart + thirtyDaysSeconds / 2) * 1000))
		cancelSubscription.mockResolvedValue(undefined)
		deleteCustomer.mockResolvedValue(undefined)

		// Retry: the first attempt issued the credit note but failed later.
		listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_retry', 'active'),
		])
		refundClient.getLatestPaidInvoiceForSubscription.mockResolvedValue(
			paidInvoice({ id: 'in_retry', amountPaid: 1200 }),
		)
		refundClient.listCreditNotesForInvoice.mockResolvedValue([
			{
				id: 'cn_voided',
				total: 600,
				currency: 'usd',
				status: 'void',
				memo: stripeClient.accountDeletionCreditNoteMemo,
				metadata: { kody_account_deletion: '1' },
			},
			{
				id: 'cn_support',
				total: 100,
				currency: 'usd',
				status: 'issued',
				memo: 'Goodwill credit from support',
				metadata: {},
			},
			{
				id: 'cn_earlier',
				total: 600,
				currency: 'usd',
				status: 'issued',
				memo: null,
				metadata: { kody_account_deletion: '1' },
			},
		])
		const { db: retryDb, rows: retryRows } = createStripeUserDb({
			id: 1,
			stableUserId: 'user-refund-retry',
			customerId: 'cus_refund_retry',
		})
		const retryResult = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(retryDb),
			dbUserId: 1,
			mcpUserId: 'user-refund-retry',
		})
		expect(refundClient.createProratedRefundCreditNote).not.toHaveBeenCalled()
		expect(cancelSubscription).toHaveBeenCalledWith(
			expect.any(Object),
			'sub_retry',
		)
		expect(retryResult.stripeRefunds).toEqual([
			{
				subscriptionId: 'sub_retry',
				amountMinor: 600,
				currency: 'usd',
				invoiceId: 'in_retry',
				creditNoteId: 'cn_earlier',
			},
		])
		expect(retryRows.users).toEqual([])
		// The earlier attempt already audited this refund.
		expect(auditEventSummaries()).toEqual([])

		// Stripe says the invoice has nothing left to credit (for example
		// support already refunded it by hand): cancel proceeds without a refund.
		listSubscriptions.mockResolvedValue([
			stripeSubscription('sub_exhausted', 'active'),
		])
		refundClient.listCreditNotesForInvoice.mockResolvedValue([])
		refundClient.createProratedRefundCreditNote.mockRejectedValue(
			new stripeClient.StripeApiError(
				'Stripe API request failed with HTTP 400.',
				{
					status: 400,
					stripeMessage:
						'The credit note amount exceeds the maximum creditable amount for this invoice.',
				},
			),
		)
		cancelSubscription.mockClear()
		const { db: exhaustedDb, rows: exhaustedRows } = createStripeUserDb({
			id: 2,
			stableUserId: 'user-refund-exhausted',
			customerId: 'cus_refund_exhausted',
		})
		const exhaustedResult = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(exhaustedDb),
			dbUserId: 2,
			mcpUserId: 'user-refund-exhausted',
		})
		expect(refundClient.createProratedRefundCreditNote).toHaveBeenCalledOnce()
		expect(cancelSubscription).toHaveBeenCalledWith(
			expect.any(Object),
			'sub_exhausted',
		)
		expect(exhaustedResult.stripeRefunds).toEqual([])
		expect(exhaustedResult.warnings).toEqual([])
		expect(exhaustedRows.users).toEqual([])
	} finally {
		vi.useRealTimers()
		listSubscriptions.mockRestore()
		cancelSubscription.mockRestore()
		deleteCustomer.mockRestore()
		refundClient.restore()
	}
})

test('deleteUserAccount drops the UserMeter tombstone after the user row is gone', async () => {
	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
	})
	const env = createSuccessfulDeletionEnv(db)
	const meter = userMeterRpc({ env, userId: 'user-aaa' })
	await meter.markDeleting({ deletingAt: '2026-08-31 15:22:12' })

	await deleteUserAccount({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})

	expect(rows.users).toEqual([])
	expect(await meter.readDeletionState()).toEqual({ deletingAt: null })
})

test('deleteUserAccount clears the deletion fence when writers are still active', async () => {
	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com' }],
	})
	const env = createSuccessfulDeletionEnv(db)
	const meter = userMeterRpc({ env, userId: 'user-aaa' })
	await meter.acquireWriteLease({
		token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		holder: 'test:signup',
		acquiredAt: '2026-08-31 15:00:00',
	})

	await expect(
		deleteUserAccount({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toBeInstanceOf(AccountDeletionWritersActiveError)
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			stable_user_id: 'user-aaa',
			deleting_at: null,
		}),
	])
	expect(await meter.readDeletionState()).toEqual({ deletingAt: null })
})

test('deleteUserAccount clears the deletion fence when inventory cannot be collected', async () => {
	const { db, rows } = createTestDb(
		{
			users: [{ id: 1, email: 'a@example.com' }],
		},
		{ failSelectContaining: 'from mcp_memories' },
	)
	const env = createSuccessfulDeletionEnv(db)
	const meter = userMeterRpc({ env, userId: 'user-aaa' })

	await expect(
		deleteUserAccount({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toBeInstanceOf(AccountDeletionInventoryError)
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			stable_user_id: 'user-aaa',
			deleting_at: null,
		}),
	])
	expect(await meter.readDeletionState()).toEqual({ deletingAt: null })
})

test('deleteUserAccount keeps an existing fence when writers are still active', async () => {
	const { db, rows } = createTestDb({
		users: [
			{
				id: 1,
				email: 'a@example.com',
				deleting_at: '2026-08-31 15:22:12',
			},
		],
	})
	const env = createSuccessfulDeletionEnv(db)
	const meter = userMeterRpc({ env, userId: 'user-aaa' })
	await meter.acquireWriteLease({
		token: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		holder: 'test:cleanup-retry',
		acquiredAt: '2026-08-31 15:23:00',
	})
	await meter.markDeleting({ deletingAt: '2026-08-31 15:22:12' })

	await expect(
		deleteUserAccount({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toBeInstanceOf(AccountDeletionWritersActiveError)
	expect(rows.users).toEqual([
		expect.objectContaining({
			id: 1,
			stable_user_id: 'user-aaa',
			deleting_at: '2026-08-31 15:22:12',
		}),
	])
	expect(await meter.readDeletionState()).toEqual({
		deletingAt: '2026-08-31 15:22:12',
	})
})

test('deleteUserAccount revokes OAuth grants through OAUTH_KV when the provider helpers are absent', async () => {
	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com', stable_user_id: 'user-aaa' }],
		user_mcp_oauth_clients: [
			{
				id: 'row-1',
				user_id: 1,
				client_id: 'owned-client',
				revoked_at: null,
			},
		],
	})
	const providerGrant = (userId: string, grantId: string, clientId: string) =>
		JSON.stringify({ id: grantId, userId, clientId, scope: ['mcp'] })
	const providerToken = (userId: string, grantId: string, tokenId: string) =>
		JSON.stringify({ id: tokenId, userId, grantId })
	const { kv, store } = createMemoryKvNamespace({
		'client:owned-client': JSON.stringify({ clientId: 'owned-client' }),
		'client:host-client': JSON.stringify({ clientId: 'host-client' }),
		'grant:user-aaa:grant-1': providerGrant(
			'user-aaa',
			'grant-1',
			'host-client',
		),
		'grant:user-aaa:grant-2': providerGrant(
			'user-aaa',
			'grant-2',
			'host-client',
		),
		'token:user-aaa:grant-1:tok-1': providerToken(
			'user-aaa',
			'grant-1',
			'tok-1',
		),
		'token:user-aaa:grant-1:tok-2': providerToken(
			'user-aaa',
			'grant-1',
			'tok-2',
		),
		'token:user-aaa:grant-2:tok-3': providerToken(
			'user-aaa',
			'grant-2',
			'tok-3',
		),
		'grant:user-bbb:grant-9': providerGrant(
			'user-bbb',
			'grant-9',
			'host-client',
		),
		'token:user-bbb:grant-9:tok-9': providerToken(
			'user-bbb',
			'grant-9',
			'tok-9',
		),
	})
	const env = createSuccessfulDeletionEnv(db, {
		OAUTH_PROVIDER: undefined,
		OAUTH_KV: kv,
	})

	const result = await deleteUserAccount({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})

	expect(result.warnings).toEqual([])
	expect(result.revokedOAuthGrants).toBe(2)
	expect(rows.users).toEqual([])
	expect([...store.keys()].sort()).toEqual([
		'client:host-client',
		'grant:user-bbb:grant-9',
		'token:user-bbb:grant-9:tok-9',
	])
})

test('deleteUserAccount prefers the fetch-context provider helpers over OAUTH_KV', async () => {
	const { db } = createTestDb({
		users: [{ id: 1, email: 'a@example.com', stable_user_id: 'user-aaa' }],
	})
	const { kv, store } = createMemoryKvNamespace({
		'grant:user-aaa:grant-1': JSON.stringify({
			id: 'grant-1',
			userId: 'user-aaa',
			clientId: 'host-client',
		}),
	})
	const revokeGrant = vi.fn(async () => undefined)
	const result = await deleteUserAccount({
		env: createSuccessfulDeletionEnv(db, {
			OAUTH_KV: kv,
			OAUTH_PROVIDER: {
				async listUserGrants() {
					return {
						items: [{ id: 'provider-grant', clientId: 'host-client' }],
						cursor: undefined,
					}
				},
				revokeGrant,
			},
		}),
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})

	expect(result.warnings).toEqual([])
	expect(result.revokedOAuthGrants).toBe(1)
	expect(revokeGrant).toHaveBeenCalledWith('provider-grant', 'user-aaa')
	expect([...store.keys()]).toEqual(['grant:user-aaa:grant-1'])
})

test('deleteUserAccount reports the missing OAuth surfaces when neither provider helpers nor OAUTH_KV exist', async () => {
	const { db, rows } = createTestDb({
		users: [{ id: 1, email: 'a@example.com', stable_user_id: 'user-aaa' }],
	})
	await expect(
		deleteUserAccount({
			env: createSuccessfulDeletionEnv(db, { OAUTH_PROVIDER: undefined }),
			dbUserId: 1,
			mcpUserId: 'user-aaa',
		}),
	).rejects.toMatchObject({
		name: 'AccountDeletionCleanupError',
		cleanupErrors: [
			'OAuth provider binding and OAUTH_KV were unavailable; OAuth grants were not revoked.',
		],
	})
	expect(rows.users).toEqual([
		expect.objectContaining({ id: 1, deleting_at: expect.any(String) }),
	])
})
