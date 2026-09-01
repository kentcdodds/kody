import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import * as stripeClient from '#worker/billing/stripe-client.ts'
import {
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
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import {
	insertRepoSession,
	listRepoSessionsByUser,
} from '#worker/repo/repo-sessions.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createTestDb,
	createJobsBindingStub,
	createSuccessfulDeletionEnv,
} from '#worker/test-support/account-deletion.ts'

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

test('account deletion cancels Stripe billing and remains non-blocking on Stripe failures', async () => {
	const listSubscriptions = vi.spyOn(stripeClient, 'listSubscriptions')
	const cancelSubscription = vi.spyOn(stripeClient, 'cancelSubscription')
	const deleteCustomer = vi.spyOn(stripeClient, 'deleteCustomer')
	try {
		listSubscriptions.mockResolvedValue([
			{
				id: 'sub_active',
				status: 'active',
				cancel_at: null,
				items: { data: [{ price: { id: 'price_pro' } }] },
			},
			{
				id: 'sub_trialing',
				status: 'trialing',
				cancel_at: null,
				items: { data: [{ price: { id: 'price_pro' } }] },
			},
			{
				id: 'sub_canceled',
				status: 'canceled',
				cancel_at: null,
				items: { data: [{ price: { id: 'price_pro' } }] },
			},
		])
		cancelSubscription.mockResolvedValue(undefined)
		deleteCustomer.mockResolvedValue(undefined)
		const { db, rows } = createTestDb({
			users: [
				{
					id: 1,
					email: 'pro@example.com',
					stable_user_id: 'user-pro',
					stripe_customer_id: 'cus_pro',
				},
			],
		})

		const result = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(db),
			dbUserId: 1,
			mcpUserId: 'user-pro',
		})

		expect(listSubscriptions).toHaveBeenCalledWith(
			expect.any(Object),
			'cus_pro',
		)
		expect(cancelSubscription).toHaveBeenCalledTimes(2)
		expect(cancelSubscription).toHaveBeenCalledWith(
			expect.any(Object),
			'sub_active',
		)
		expect(cancelSubscription).toHaveBeenCalledWith(
			expect.any(Object),
			'sub_trialing',
		)
		expect(deleteCustomer).toHaveBeenCalledWith(expect.any(Object), 'cus_pro')
		expect(rows.users).toEqual([])
		expect(result.warnings).toEqual([])

		listSubscriptions.mockRejectedValue(
			new Error('Stripe subscriptions unavailable'),
		)
		deleteCustomer.mockRejectedValue(new Error('Stripe customer unavailable'))
		cancelSubscription.mockClear()
		consoleError.mockImplementation(() => {})
		const { db: failureDb, rows: failureRows } = createTestDb({
			users: [
				{
					id: 2,
					email: 'failure@example.com',
					stable_user_id: 'user-stripe-failure',
					stripe_customer_id: 'cus_failure',
				},
			],
		})

		const failureResult = await deleteUserAccount({
			env: createSuccessfulDeletionEnv(failureDb),
			dbUserId: 2,
			mcpUserId: 'user-stripe-failure',
		})

		expect(deleteCustomer).toHaveBeenLastCalledWith(
			expect.any(Object),
			'cus_failure',
		)
		expect(cancelSubscription).not.toHaveBeenCalled()
		expect(failureRows.users).toEqual([])
		expect(failureResult.warnings).toEqual([
			expect.stringContaining('Stripe customer cleanup failed'),
		])
		expect(consoleError).toHaveBeenCalledOnce()
		expect(consoleError).toHaveBeenCalledWith(
			'account_deletion_stripe_cleanup_failed',
			expect.objectContaining({
				userId: 'user-stripe-failure',
				error: expect.any(AggregateError),
			}),
		)

		listSubscriptions.mockClear()
		deleteCustomer.mockClear()
		const { db: freeDb, rows: freeRows } = createTestDb({
			users: [
				{
					id: 3,
					email: 'free@example.com',
					stable_user_id: 'user-free',
					stripe_customer_id: null,
				},
			],
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
		consoleError.mockReset()
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
