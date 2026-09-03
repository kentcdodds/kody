import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAccountExport,
	createAccountExportManifest,
	getAccountExportD1UserColumnCoverage,
	readAccountExportSection,
} from './export.ts'
import {
	createMigratedDb,
	createMailboxBinding,
} from '#worker/test-support/account-export.ts'
import { createMemoryKvNamespace } from '#worker/test-support/memory-kv.ts'

test('account export D1 coverage includes every live user-owned schema column', () => {
	const db = new DatabaseSync(':memory:')
	// Coverage tracks APP_DB only; jobs tables live in the jobs worker's
	// database and are exported through the JOBS service (ADR 0016).
	applyAllMigrations(db, new URL('../../migrations/', import.meta.url))
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
	const coveredColumns = getAccountExportD1UserColumnCoverage()
	const missing = [...liveUserColumns].filter(
		(column) => !coveredColumns.has(column),
	)
	const stale = [...coveredColumns].filter(
		(column) => !liveUserColumns.has(column),
	)
	expect(missing, 'user-owned D1 columns missing from account export').toEqual(
		[],
	)
	expect(stale, 'account export references stale D1 columns').toEqual([])
})

test('account export documents and excludes operator-owned system email rows', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		)
		VALUES (
			1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
			'2026-07-05', '2026-07-05', 'user-aaa'
		);
	`)

	const accountExport = await createAccountExport({
		env: {
			APP_DB: db,
			MAILBOX: createMailboxBinding({
				blobReferences: () => [
					{
						kind: 'raw_mime',
						key: 'email-raw:v1:user-aaa/user-message',
						messageId: 'user-message',
						attachmentId: null,
					},
				],
			}),
		} as Env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		generatedAt: '2026-07-05T00:00:00.000Z',
	})

	expect(accountExport.d1).not.toHaveProperty('email_messages')
	expect(accountExport.d1).not.toHaveProperty('email_threads')
	expect(accountExport.d1).not.toHaveProperty('email_attachments')
	expect(accountExport.d1).not.toHaveProperty('email_delivery_events')
	expect(accountExport.manifest.sections.r2_object?.count).toBe(1)
	expect(accountExport.manifest.excludedD1Surfaces).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				name: 'system_email_inboxes',
				reason: expect.stringContaining('Operator-owned inbound mail'),
			}),
			expect.objectContaining({
				name: 'system_email_messages',
				reason: expect.stringContaining('operator-owned system email'),
			}),
		]),
	)
	expect(accountExport.d1).not.toHaveProperty('entitlement_daily_counters')
})

test('account export includes submitted feedback but excludes reviewer-only relationships', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO platform_feedback (
			id, submitter_user_id, submitter_username, submitter_email,
			category, summary, details, status, reviewed_by_user_id,
			reviewed_at, admin_note, created_at, updated_at
		) VALUES
			(
				'feedback-submitted-by-a',
				'user-aaa',
				'user-a',
				'a@example.com',
				'friction',
				'Setup is confusing',
				'The setup flow needs clearer guidance.',
				'triaged',
				'admin-other',
				'2026-07-05',
				'Needs setup review.',
				'2026-07-04',
				'2026-07-05'
			),
			(
				'feedback-reviewed-by-a',
				'user-bbb',
				'user-b',
				'b@example.com',
				'bug',
				'Private feedback from B',
				'This record belongs only in user B exports.',
				'triaged',
				'user-aaa',
				'2026-07-05',
				'Reviewer-only relationship.',
				'2026-07-04',
				'2026-07-05'
			);
	`)

	const accountExport = await createAccountExport({
		env: { APP_DB: db } as Env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		generatedAt: '2026-07-05T00:00:00.000Z',
	})

	const feedbackRows = accountExport.d1.platform_feedback.rows
	expect(feedbackRows).toEqual([
		expect.objectContaining({
			id: 'feedback-submitted-by-a',
			submitter_user_id: 'user-aaa',
			submitter_username: 'user-a',
			submitter_email: 'a@example.com',
			category: 'friction',
			summary: 'Setup is confusing',
			details: 'The setup flow needs clearer guidance.',
			status: 'triaged',
			created_at: '2026-07-04',
			updated_at: '2026-07-05',
		}),
	])
	expect(feedbackRows[0]).not.toHaveProperty('reviewed_by_user_id')
	expect(feedbackRows[0]).not.toHaveProperty('reviewed_at')
	expect(feedbackRows[0]).not.toHaveProperty('admin_note')
	expect(feedbackRows.some((row) => row.id === 'feedback-reviewed-by-a')).toBe(
		false,
	)
	expect(accountExport.d1.platform_feedback.redactedColumns).toEqual([
		'admin_note',
		'reviewed_at',
		'reviewed_by_user_id',
	])
	expect(
		accountExport.manifest.sections['d1.platform_feedback']?.redactedColumns,
	).toEqual(['admin_note', 'reviewed_at', 'reviewed_by_user_id'])
})

test('account export includes profile fields and social graph edges for either side', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id, display_name, bio, profile_visibility
		) VALUES
			(
				1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
				'2026-07-05', '2026-07-05', 'user-aaa', 'User A', 'Builds packages',
				'public'
			),
			(
				2, 'user-b', 'b@example.com', 'password-hash-b', '2026-07-05',
				'2026-07-05', '2026-07-05', 'user-bbb', 'User B', NULL, 'private'
			);

		INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, description,
			tags_json, license, pinned_commit, status, published_at
		) VALUES
			(
				'listing-a', 'user-aaa', 'pkg-a', 'src-a', 'demo', '@user-a/demo',
				'Demo listing', '[]', 'MIT', 'commit-a', 'active', '2026-07-05'
			),
			(
				'listing-b', 'user-bbb', 'pkg-b', 'src-b', 'other', '@user-b/other',
				'Other listing', '[]', 'MIT', 'commit-b', 'active', '2026-07-05'
			);

		INSERT INTO community_activity_events (
			id, actor_user_id, event_type, listing_id, created_at
		) VALUES
			(
				'evt-a', 'user-aaa', 'listing_published', 'listing-b', '2026-07-05'
			),
			(
				'evt-b', 'user-bbb', 'listing_updated', 'listing-a', '2026-07-05'
			),
			(
				'evt-c', 'user-bbb', 'listing_published', 'listing-b', '2026-07-05'
			);
	`)

	const accountExport = await createAccountExport({
		env: { APP_DB: db } as Env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		generatedAt: '2026-07-05T00:00:00.000Z',
	})

	expect(accountExport.d1.users.rows).toEqual([
		expect.objectContaining({
			id: 1,
			username: 'user-a',
			email: 'a@example.com',
			display_name: 'User A',
			bio: 'Builds packages',
			profile_visibility: 'public',
		}),
	])
	expect(accountExport.d1.users.rows[0]).not.toHaveProperty('password_hash')

	expect(accountExport.d1.community_activity_events.rows).toEqual([
		expect.objectContaining({
			id: 'evt-a',
			actor_user_id: 'user-aaa',
			event_type: 'listing_published',
		}),
	])
	expect(
		accountExport.d1.community_activity_events.rows.some(
			(row) => row.id === 'evt-c' || row.actor_user_id === 'user-bbb',
		),
	).toBe(false)

	expect(
		accountExport.manifest.sections['d1.community_activity_events']?.count,
	).toBe(1)
})

test('account export separates listing-owner deletion cascades from participant ownership', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		) VALUES
			(1, 'owner', 'owner@example.com', 'hash', '2026-07-05', '2026-07-05', '2026-07-05', 'user-owner'),
			(2, 'participant', 'participant@example.com', 'hash', '2026-07-05', '2026-07-05', '2026-07-05', 'user-participant');
		INSERT INTO community_listings (
			id, owner_user_id, package_id, source_id, kody_id, name, description,
			tags_json, license, pinned_commit, status, published_at
		) VALUES (
			'listing-owner', 'user-owner', 'pkg-owner', 'src-owner', 'owned',
			'@owner/owned', 'Owned listing', '[]', 'MIT', 'commit-owner', 'active',
			'2026-07-05'
		);
		INSERT INTO community_ratings (
			id, listing_id, user_id, stars, adaptation_effort, note
		) VALUES (
			'rating-private', 'listing-owner', 'user-participant', 4, 3,
			'private rating note'
		);
		INSERT INTO community_forks (
			id, listing_id, forker_user_id, origin_commit, forked_package_id,
			forked_source_id, target_kody_id, adoption_note
		) VALUES (
			'fork-private', 'listing-owner', 'user-participant', 'commit-owner',
			'pkg-fork', 'src-fork', 'forked', 'private adoption note'
		);
		INSERT INTO community_reports (
			id, listing_id, listing_name, listing_owner_user_id, reporter_user_id,
			reason, resolved_by_user_id
		) VALUES (
			'report-private', 'listing-owner', '@owner/owned', 'user-owner',
			'user-participant', 'private report reason', 'user-moderator'
		);
	`)
	const ownerExport = await createAccountExport({
		env: { APP_DB: db } as Env,
		dbUserId: 1,
		mcpUserId: 'user-owner',
	})
	expect(ownerExport.d1.community_ratings.rows).toEqual([])
	expect(ownerExport.d1.community_forks.rows).toEqual([])
	expect(ownerExport.d1.community_reports.rows).toEqual([])

	const participantExport = await createAccountExport({
		env: { APP_DB: db } as Env,
		dbUserId: 2,
		mcpUserId: 'user-participant',
	})
	expect(participantExport.d1.community_ratings.rows).toEqual([
		expect.objectContaining({
			id: 'rating-private',
			note: 'private rating note',
		}),
	])
	expect(participantExport.d1.community_forks.rows).toEqual([
		expect.objectContaining({
			id: 'fork-private',
			adoption_note: 'private adoption note',
		}),
	])
	expect(participantExport.d1.community_reports.rows).toEqual([
		expect.objectContaining({
			id: 'report-private',
			reason: 'private report reason',
			reporter_user_id: 'user-participant',
			listing_owner_user_id: '[redacted]',
			resolved_by_user_id: '[redacted]',
		}),
	])
})

test('account write lease repair export redacts the foreign party for both perspectives', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		) VALUES
			(1, 'target', 'target@example.com', 'hash', '2026-07-05', '2026-07-05', '2026-07-05', 'user-target'),
			(2, 'admin', 'admin@example.com', 'hash', '2026-07-05', '2026-07-05', '2026-07-05', 'user-admin');
		INSERT INTO account_write_lease_repairs (
			id, target_user_id, lease_token, lease_holder, lease_acquired_at,
			repaired_by_user_id, reason, created_at
		) VALUES (
			'repair-a', 'user-target', 'token-a', 'job:run', '2026-07-05',
			'user-admin', 'Confirmed crashed worker', '2026-07-05'
		);
	`)
	const targetExport = await createAccountExport({
		env: { APP_DB: db } as Env,
		dbUserId: 1,
		mcpUserId: 'user-target',
	})
	expect(targetExport.d1.account_write_lease_repairs.rows).toEqual([
		expect.objectContaining({
			target_user_id: 'user-target',
			repaired_by_user_id: '[redacted]',
		}),
	])
	const adminExport = await createAccountExport({
		env: { APP_DB: db } as Env,
		dbUserId: 2,
		mcpUserId: 'user-admin',
	})
	expect(adminExport.d1.account_write_lease_repairs.rows).toEqual([
		expect.objectContaining({
			target_user_id: '[redacted]',
			repaired_by_user_id: 'user-admin',
		}),
	])
})

test('createAccountExport redacts secrets and credential-equivalent hashes', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		)
		VALUES
			(
				1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
				'2026-07-05', '2026-07-05', 'user-aaa'
			),
			(
				2, 'user-b', 'b@example.com', 'password-hash-b', '2026-07-05',
				'2026-07-05', '2026-07-05', 'user-bbb'
			);

		INSERT INTO secret_buckets (id, user_id, scope, binding_key, created_at, updated_at)
		VALUES ('secret-bucket-a', 'user-aaa', 'user', 'global', '2026-07-05', '2026-07-05');
		INSERT INTO secret_entries (
			bucket_id,
			name,
			description,
			encrypted_value,
			allowed_hosts,
			allowed_packages,
			lookup_hash,
			created_at,
			updated_at
		)
		VALUES (
			'secret-bucket-a',
			'api-key',
			'API key',
			'encrypted-secret-value',
			'["api.example.com"]',
			'["@user/pkg"]',
			'lookup-hash',
			'2026-07-05',
			'2026-07-05'
		);

		INSERT INTO value_buckets (id, user_id, scope, binding_key, created_at, updated_at)
		VALUES ('value-bucket-a', 'user-aaa', 'user', 'global', '2026-07-05', '2026-07-05');
		INSERT INTO value_entries (bucket_id, name, description, value, created_at, updated_at)
		VALUES ('value-bucket-a', 'timezone', 'Preferred timezone', 'America/Denver', '2026-07-05', '2026-07-05');

		INSERT INTO package_invocation_tokens (
			id,
			user_id,
			package_id,
			name,
			token_hash,
			created_at,
			updated_at
		)
		VALUES (
			'token-a',
			'user-aaa',
			'pkg-a',
			'Migration token',
			'token-hash-a',
			'2026-07-05',
			'2026-07-05'
		);

		INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
		VALUES (1, 1, 'reset-token-hash-a', 2000000000, '2026-07-05');


		INSERT INTO mcp_memories (id, user_id, subject, summary, details)
		VALUES
			('memory-a', 'user-aaa', 'Favorite color', 'Blue', 'Likes navy.'),
			('memory-b', 'user-bbb', 'Favorite color', 'Green', 'Likes moss.');
	`)
	const accountExport = await createAccountExport({
		env: {
			APP_DB: db,
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({
					exportStorage: async () => ({
						entries: [],
						estimatedBytes: 0,
						truncated: false,
						nextStartAfter: null,
						pageSize: 500,
					}),
				}),
			},
		} as unknown as Env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		generatedAt: '2026-07-05T00:00:00.000Z',
	})

	expect(accountExport.manifest.security.secretValuesExported).toBe(false)
	expect(accountExport.d1.users.rows).toEqual([
		expect.not.objectContaining({ password_hash: expect.anything() }),
	])
	expect(accountExport.d1.secret_entries.rows).toEqual([
		expect.objectContaining({
			bucket_id: 'secret-bucket-a',
			name: 'api-key',
			allowed_hosts: '["api.example.com"]',
			allowed_packages: '["@user/pkg"]',
		}),
	])
	expect(accountExport.d1.secret_entries.rows[0]).not.toHaveProperty(
		'encrypted_value',
	)
	expect(accountExport.d1.secret_entries.rows[0]).not.toHaveProperty(
		'lookup_hash',
	)
	expect(accountExport.d1.package_invocation_tokens.rows[0]).not.toHaveProperty(
		'token_hash',
	)
	expect(accountExport.d1.password_resets.rows[0]).not.toHaveProperty(
		'token_hash',
	)
	expect(accountExport.d1.value_entries.rows).toEqual([
		expect.objectContaining({ value: 'America/Denver' }),
	])
	expect(accountExport.d1.mcp_memories.rows).toEqual([
		expect.objectContaining({ id: 'memory-a', summary: 'Blue' }),
	])
	expect(
		accountExport.d1.mcp_memories.rows.some((row) => row.id === 'memory-b'),
	).toBe(false)
	expect(
		accountExport.manifest.sections['d1.secret_entries']?.redactedColumns,
	).toEqual(['encrypted_value', 'lookup_hash'])
})

test('createAccountExport records partial-failure warnings and section pagination works', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		)
		VALUES (
			1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
			'2026-07-05', '2026-07-05', 'user-aaa'
		);
		INSERT INTO archived_job_artifacts (
			id,
			job_id,
			user_id,
			source_id,
			published_commit,
			storage_id,
			retain_until,
			created_at,
			updated_at
		)
		VALUES (
			'archive-a',
			'job-a',
			'user-aaa',
			'source-a',
			'commit-a',
			'job:archive-a',
			'2026-08-05',
			'2026-07-05',
			'2026-07-05'
		);
		INSERT INTO value_buckets (id, user_id, scope, binding_key, created_at, updated_at)
		VALUES ('value-bucket-a', 'user-aaa', 'user', 'global', '2026-07-05', '2026-07-05');
		INSERT INTO value_entries (bucket_id, name, description, value, created_at, updated_at)
		VALUES
			('value-bucket-a', 'first', '', '1', '2026-07-05', '2026-07-05'),
			('value-bucket-a', 'second', '', '2', '2026-07-05', '2026-07-05');
	`)
	const exportStorage = vi.fn(async () => {
		throw new Error('storage unavailable')
	})
	const env = {
		APP_DB: db,
		STORAGE_RUNNER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ exportStorage }),
		},
		OAUTH_PROVIDER: {
			async listUserGrants() {
				throw new Error('oauth unavailable')
			},
		},
	} as unknown as Env & {
		OAUTH_PROVIDER: {
			listUserGrants: () => Promise<never>
		}
	}

	const accountExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		generatedAt: '2026-07-05T00:00:00.000Z',
	})
	expect(accountExport.manifest.warnings).toEqual(
		expect.arrayContaining([
			expect.stringContaining('Storage runner export failed for job:archive-a'),
			expect.stringContaining('OAuth grant listing failed'),
		]),
	)

	const page = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'd1_table',
		table: 'value_entries',
		pageSize: 1,
	})
	expect(page.items).toEqual([expect.objectContaining({ name: 'first' })])
	expect(page.truncated).toBe(true)
	expect(page.nextStartAfter).not.toBeNull()
	const nextPage = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'd1_table',
		table: 'value_entries',
		pageSize: 1,
		startAfter: page.nextStartAfter ?? undefined,
	})
	expect(nextPage.items).toEqual([expect.objectContaining({ name: 'second' })])
	expect(nextPage.truncated).toBe(false)
	expect(nextPage.nextStartAfter).toBeNull()
})

test('D1 export reads large tables in bounded keyset pages', async () => {
	const rowCounts: Array<number> = []
	const queries: Array<string> = []
	const { sqlite, db } = createMigratedDb({
		onQueryRows: (rowCount) => rowCounts.push(rowCount),
		onQuery: (query) => queries.push(query),
	})
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		)
		VALUES (
			1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
			'2026-07-05', '2026-07-05', 'user-aaa'
		);
	`)
	const totalRows = 502
	const insert = sqlite.prepare(
		`INSERT INTO mcp_memories (
			id, user_id, subject, summary, details, created_at, updated_at
		) VALUES (?, 'user-aaa', ?, 'Summary', '', '2026-07-05', '2026-07-05')`,
	)
	for (let index = 0; index < totalRows; index += 1) {
		insert.run(`memory-${String(index).padStart(4, '0')}`, `Memory ${index}`)
	}
	sqlite.exec(`
		INSERT INTO user_storage_buckets (
			user_id, storage_id, kind, created_at, last_seen_at
		) VALUES (
			'user-aaa', 'package:pkg%3A1', 'package',
			'2026-07-05', '2026-07-05'
		);
	`)

	const env = {
		APP_DB: db,
		MAILBOX: createMailboxBinding(),
	} as Env
	const accountExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		generatedAt: '2026-07-05T00:00:00.000Z',
	})
	expect(accountExport.d1.mcp_memories.rows).toHaveLength(totalRows)
	expect(accountExport.manifest.sections['d1.mcp_memories']?.count).toBe(
		totalRows,
	)
	// The keyset page size is 500 (+1 lookahead row), so no single query may
	// return the whole table.
	expect(Math.max(...rowCounts)).toBeLessThanOrEqual(501)

	rowCounts.length = 0
	const seenIds = new Set<string>()
	let startAfter: string | undefined
	let pages = 0
	while (true) {
		const page = await readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			section: 'd1_table',
			table: 'mcp_memories',
			pageSize: 500,
			startAfter,
		})
		pages += 1
		for (const item of page.items as Array<{ id: string }>) {
			seenIds.add(item.id)
		}
		if (!page.truncated) break
		startAfter = page.nextStartAfter ?? undefined
	}
	expect(pages).toBe(2)
	expect(seenIds.size).toBe(totalRows)
	expect(Math.max(...rowCounts)).toBeLessThanOrEqual(501)

	rowCounts.length = 0
	queries.length = 0
	let oauthPage = 0
	const manifest = await createAccountExportManifest({
		env: {
			APP_DB: db,
			MAILBOX: createMailboxBinding(),
			OAUTH_PROVIDER: {
				async listUserGrants() {
					oauthPage += 1
					return {
						items: [{ id: `grant-${oauthPage}`, clientId: 'client' }],
						cursor: oauthPage < 100 ? String(oauthPage) : undefined,
					}
				},
			},
		} as unknown as Env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(manifest.sections['d1.mcp_memories']?.count).toBe(totalRows)
	expect(manifest.sections).not.toHaveProperty('d1.email_messages')
	expect(manifest.sections.oauth_grants?.count).toBe(100)
	expect(manifest.sections.storage_runners?.count).toBe(1)
	expect(Math.max(...rowCounts)).toBeLessThanOrEqual(1)
	expect(
		queries.some((query) => query.includes('__account_export_rowid')),
	).toBe(false)
})

test('account export reads OAuth grant metadata from OAUTH_KV when the provider helpers are absent', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		)
		VALUES (
			1, 'user-a', 'a@example.com', 'password-hash-a', '2026-07-05',
			'2026-07-05', '2026-07-05', 'user-aaa'
		);
	`)
	const storedGrant = (userId: string, grantId: string) =>
		JSON.stringify({
			id: grantId,
			clientId: 'host-client',
			userId,
			scope: ['mcp'],
			metadata: { label: grantId },
			createdAt: 1_700_000_000,
			redirectUri: 'https://host.example/callback',
			encryptedProps: 'ciphertext',
			refreshTokenId: 'refresh-secret',
			refreshTokenWrappedKey: 'wrapped-key',
			previousRefreshTokenId: 'previous-refresh-secret',
			previousRefreshTokenWrappedKey: 'previous-wrapped-key',
			authCodeId: 'auth-code-secret',
			authCodeWrappedKey: 'auth-code-wrapped-key',
			codeChallenge: 'challenge',
			codeChallengeMethod: 'S256',
		})
	const { kv } = createMemoryKvNamespace({
		'grant:user-aaa:grant-1': storedGrant('user-aaa', 'grant-1'),
		'grant:user-aaa:grant-2': storedGrant('user-aaa', 'grant-2'),
		'grant:user-bbb:grant-9': storedGrant('user-bbb', 'grant-9'),
		'token:user-aaa:grant-1:tok-1': JSON.stringify({
			id: 'tok-1',
			grantId: 'grant-1',
			userId: 'user-aaa',
			wrappedEncryptionKey: 'token-wrapped-key',
		}),
	})
	const env = {
		APP_DB: db,
		MAILBOX: createMailboxBinding(),
		OAUTH_KV: kv,
	} as Env
	const expectedGrants = ['grant-1', 'grant-2'].map((id) => ({
		id,
		clientId: 'host-client',
		userId: 'user-aaa',
		scope: ['mcp'],
		metadata: { label: id },
		createdAt: 1_700_000_000,
		expiresAt: undefined,
		redirectUri: 'https://host.example/callback',
	}))

	const accountExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		generatedAt: '2026-07-05T00:00:00.000Z',
	})
	expect(accountExport.oauthGrants).toEqual(expectedGrants)
	expect(accountExport.manifest.sections.oauth_grants?.count).toBe(2)
	expect(accountExport.manifest.warnings).not.toEqual(
		expect.arrayContaining([
			expect.stringContaining('OAuth grant metadata was not exported'),
		]),
	)
	expect(JSON.stringify(accountExport.oauthGrants)).not.toMatch(
		/ciphertext|refresh-secret|wrapped-key|auth-code-secret|challenge/,
	)

	const manifest = await createAccountExportManifest({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(manifest.sections.oauth_grants?.count).toBe(2)
	expect(manifest.warnings).not.toEqual(
		expect.arrayContaining([
			expect.stringContaining('OAuth grant metadata was not exported'),
		]),
	)

	const section = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'oauth_grants',
	})
	expect(section.items).toEqual(expectedGrants)
	expect(section.warnings).not.toEqual(
		expect.arrayContaining([
			expect.stringContaining('OAuth grant metadata was not exported'),
		]),
	)

	const withoutOAuthSurface = await createAccountExport({
		env: { APP_DB: db, MAILBOX: createMailboxBinding() } as Env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		generatedAt: '2026-07-05T00:00:00.000Z',
	})
	expect(withoutOAuthSurface.oauthGrants).toEqual([])
	expect(withoutOAuthSurface.manifest.warnings).toContain(
		'OAuth provider binding and OAUTH_KV were unavailable; OAuth grant metadata was not exported.',
	)
})
