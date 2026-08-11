import { quoteSqlIdentifier } from '@kody-internal/shared/sql-literals.ts'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import {
	mailboxBlobRefAttachmentCursorPrefix,
	mailboxBlobRefRawMimeCursorPrefix,
	parseMailboxBlobRefCursor,
} from '#worker/email/mailbox-types.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	createAccountExport,
	createAccountExportManifest,
	getAccountExportD1UserColumnCoverage,
	readAccountExportSection,
} from './export.ts'

function applyMigrations(db: DatabaseSync) {
	const migrationsDir = new URL('../../migrations/', import.meta.url)
	applyAllMigrations(db, migrationsDir)
	// The APP_DB fallback jobs store serves the jobs-worker schema (ADR 0016)
	// from the same test database handle.
	applyAllMigrations(
		db,
		new URL('../../../jobs-worker/migrations/', import.meta.url),
	)
}

function createD1FromSqlite(
	db: DatabaseSync,
	options?: {
		onQueryRows?: (rowCount: number) => void
		onQuery?: (query: string) => void
	},
) {
	return {
		prepare(query: string) {
			options?.onQuery?.(query.replace(/\s+/g, ' ').trim())
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							const statement = db.prepare(query)
							const rows = statement.all(...params) as Array<T>
							options?.onQueryRows?.(rows.length)
							return { results: rows, meta: { changes: 0 } }
						},
						async first<T>() {
							const statement = db.prepare(query)
							return (statement.get(...params) ?? null) as T | null
						},
						async run() {
							const statement = db.prepare(query)
							const result = statement.run(...params)
							return { meta: { changes: result.changes } }
						},
					}
				},
				async all<T>() {
					const statement = db.prepare(query)
					const rows = statement.all() as Array<T>
					options?.onQueryRows?.(rows.length)
					return { results: rows, meta: { changes: 0 } }
				},
				async first<T>() {
					const statement = db.prepare(query)
					return (statement.get() ?? null) as T | null
				},
				async run() {
					const statement = db.prepare(query)
					const result = statement.run()
					return { meta: { changes: result.changes } }
				},
			}
		},
		async exec(query: string) {
			db.exec(query)
		},
	} as unknown as D1Database
}

function createMigratedDb(options?: {
	onQueryRows?: (rowCount: number) => void
	onQuery?: (query: string) => void
}) {
	const sqlite = new DatabaseSync(':memory:')
	applyMigrations(sqlite)
	return {
		sqlite,
		db: createD1FromSqlite(sqlite, options),
	}
}

type TestMailboxBlobReference = {
	kind: 'raw_mime' | 'attachment'
	key: string
	messageId: string
	attachmentId: string | null
}

function createMailboxBinding(input?: {
	blobReferences?: () => Array<TestMailboxBlobReference>
}) {
	const cursorAfter = (reference: TestMailboxBlobReference) =>
		reference.kind === 'raw_mime'
			? `${mailboxBlobRefRawMimeCursorPrefix}${reference.messageId}`
			: `${mailboxBlobRefAttachmentCursorPrefix}${reference.attachmentId}`
	const listBlobReferences = async ({
		pageSize = 100,
		startAfter,
	}: {
		pageSize?: number
		startAfter?: string | null
	}) => {
		const cursor = parseMailboxBlobRefCursor(startAfter ?? null)
		const references = (input?.blobReferences?.() ?? [])
			.filter((reference) => {
				if (cursor.phase === 'raw_mime') {
					return (
						reference.kind === 'attachment' ||
						reference.messageId > cursor.startAfterId
					)
				}
				return (
					reference.kind === 'attachment' &&
					(reference.attachmentId ?? '') > cursor.startAfterId
				)
			})
			.sort((left, right) => {
				if (left.kind !== right.kind) return left.kind === 'raw_mime' ? -1 : 1
				return cursorAfter(left).localeCompare(cursorAfter(right))
			})
		const page = references.slice(0, pageSize)
		const truncated = references.length > page.length
		return {
			references: page,
			nextStartAfter: truncated ? cursorAfter(page.at(-1)!) : null,
			truncated,
		}
	}
	return {
		idFromName: (name: string) => name as unknown as DurableObjectId,
		get: () => ({
			countMailbox: async () => ({
				threads: 0,
				messages: 0,
				attachments: 0,
				deliveryEvents: 0,
			}),
			exportMailbox: async () => ({
				rows: [],
				nextStartAfter: null,
				truncated: false,
			}),
			listBlobReferences,
		}),
	} as unknown as DurableObjectNamespace
}

function encodeTestBase64Url(bytes: Uint8Array) {
	let binary = ''
	for (const byte of bytes) binary += String.fromCharCode(byte)
	return btoa(binary)
		.replaceAll('+', '-')
		.replaceAll('/', '_')
		.replace(/=+$/u, '')
}

async function createSignedR2Cursor(input: {
	secret: string
	userId: string
	cursor: unknown
}) {
	const payload = encodeTestBase64Url(
		new TextEncoder().encode(
			JSON.stringify({ userId: input.userId, cursor: input.cursor }),
		),
	)
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(input.secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	)
	const signature = await crypto.subtle.sign(
		'HMAC',
		key,
		new TextEncoder().encode(payload),
	)
	return `${payload}.${encodeTestBase64Url(new Uint8Array(signature))}`
}

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
	expect(accountExport.manifest.excludedD1Surfaces).not.toEqual(
		expect.arrayContaining([
			expect.objectContaining({ name: 'entitlement_daily_counters' }),
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

		INSERT INTO user_follows (follower_user_id, followee_user_id, created_at)
		VALUES
			('user-aaa', 'user-bbb', '2026-07-05'),
			('user-bbb', 'user-aaa', '2026-07-05'),
			('user-bbb', 'user-ccc', '2026-07-05');

		INSERT INTO community_stars (listing_id, user_id, created_at)
		VALUES
			('listing-a', 'user-bbb', '2026-07-05'),
			('listing-b', 'user-aaa', '2026-07-05'),
			('listing-b', 'user-bbb', '2026-07-05');

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

	expect(accountExport.d1.user_follows.rows).toEqual([
		expect.objectContaining({
			follower_user_id: '[redacted]',
			followee_user_id: 'user-aaa',
		}),
		expect.objectContaining({
			follower_user_id: 'user-aaa',
			followee_user_id: '[redacted]',
		}),
	])
	expect(
		accountExport.d1.user_follows.rows.some(
			(row) =>
				row.follower_user_id === 'user-bbb' ||
				row.followee_user_id === 'user-bbb' ||
				row.followee_user_id === 'user-ccc',
		),
	).toBe(false)

	expect(accountExport.d1.community_stars.rows).toEqual([
		expect.objectContaining({ listing_id: 'listing-b', user_id: 'user-aaa' }),
	])
	expect(
		accountExport.d1.community_stars.rows.some(
			(row) => row.user_id === 'user-bbb',
		),
	).toBe(false)

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

	expect(accountExport.manifest.sections['d1.user_follows']?.count).toBe(2)
	expect(accountExport.manifest.sections['d1.community_stars']?.count).toBe(1)
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

test('R2 export pages owned payloads in bounded chunks and reports missing objects', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id, avatar_key
		) VALUES
			(1, 'user-a', 'a@example.com', 'hash', '2026-07-05', '2026-07-05', '2026-07-05', 'user-aaa', 'user-avatars/user-aaa/avatar.png'),
			(2, 'user-b', 'b@example.com', 'hash', '2026-07-05', '2026-07-05', '2026-07-05', 'user-bbb', 'user-avatars/user-bbb/avatar.png');
	`)
	const mimeBytes = new TextEncoder().encode('Subject: A\r\n\r\nbody')
	const getEmailBlob = vi.fn(async (key: string) => {
		if (key === 'email-raw:v1:user-aaa/mail-z') {
			throw new Error('temporary R2 outage')
		}
		if (key !== 'email-raw:v1:user-aaa/mail-a') return null
		return {
			size: mimeBytes.byteLength,
			httpEtag: '"etag-a"',
			httpMetadata: { contentType: 'message/rfc822' },
			arrayBuffer: async () => mimeBytes.buffer,
		}
	})
	const env = {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		EMAIL_BLOBS: { get: getEmailBlob },
		COMMUNITY_ASSETS: { get: vi.fn(async () => null) },
		MAILBOX: createMailboxBinding({
			blobReferences: () => [
				{
					kind: 'raw_mime',
					key: 'email-raw:v1:user-aaa/mail-a',
					messageId: 'mail-a',
					attachmentId: null,
				},
				{
					kind: 'raw_mime',
					key: 'email-raw:v1:user-aaa/mail-z',
					messageId: 'mail-z',
					attachmentId: null,
				},
			],
		}),
	} as unknown as Env

	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
	})
	expect(first.items).toEqual([
		expect.objectContaining({
			surfaceId: 'user_avatar',
			key: 'user-avatars/user-aaa/avatar.png',
			missing: true,
		}),
	])
	const firstCursor = first.nextStartAfter!
	const tamperedCursor = `${firstCursor.slice(0, -1)}${firstCursor.endsWith('a') ? 'b' : 'a'}`
	await expect(
		readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			section: 'r2_object',
			startAfter: tamperedCursor,
		}),
	).rejects.toThrow('Invalid or unsupported r2_object cursor')
	const legacyCursor = await createSignedR2Cursor({
		secret: 'test-cookie-secret',
		userId: 'user-aaa',
		cursor: {
			v: 1,
			state: { stage: 'email_raw_mime', afterRowid: 1 },
		},
	})
	await expect(
		readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			section: 'r2_object',
			startAfter: legacyCursor,
		}),
	).rejects.toThrow('restart without startAfter')
	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual([
		expect.objectContaining({
			surfaceId: 'email_raw_mime',
			key: 'email-raw:v1:user-aaa/mail-a',
			contentBase64: btoa('Subject: A\r\n\r\nbody'),
			objectComplete: true,
		}),
	])
	expect(second.truncated).toBe(true)
	const third = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
		startAfter: second.nextStartAfter ?? undefined,
	})
	expect(third.items).toEqual([
		expect.objectContaining({
			key: 'email-raw:v1:user-aaa/mail-z',
			unavailable: true,
		}),
	])
	expect(third.truncated).toBe(true)
	expect(third.warnings).toEqual([
		expect.stringContaining('R2 object export failed'),
	])
	const done = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
		startAfter: third.nextStartAfter ?? undefined,
	})
	expect(done.items).toEqual([])
	expect(done.truncated).toBe(false)
	expect(getEmailBlob).not.toHaveBeenCalledWith(
		'email-raw:v1:user-bbb/mail-b',
		expect.anything(),
	)
})

test('R2 export performs bounded keyset work independent of mailbox size', async () => {
	const queries: Array<string> = []
	const { sqlite, db } = createMigratedDb({
		onQuery: (query) => queries.push(query),
	})
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		) VALUES (
			1, 'user-a', 'a@example.com', 'hash', '2026-07-05', '2026-07-05',
			'2026-07-05', 'user-aaa'
		);
	`)
	const page = await readAccountExportSection({
		env: {
			APP_DB: db,
			COOKIE_SECRET: 'test-cookie-secret',
			EMAIL_BLOBS: { get: vi.fn(async () => null) },
			COMMUNITY_ASSETS: { get: vi.fn(async () => null) },
			MAILBOX: createMailboxBinding({
				blobReferences: () =>
					Array.from({ length: 502 }, (_, index) => {
						const messageId = `mail-${String(index).padStart(4, '0')}`
						return {
							kind: 'raw_mime' as const,
							key: `email-raw:v1:user-aaa/${messageId}`,
							messageId,
							attachmentId: null,
						}
					}),
			}),
		} as unknown as Env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
	})
	expect(page.items).toEqual([
		expect.objectContaining({
			key: 'email-raw:v1:user-aaa/mail-0000',
			missing: true,
		}),
	])
	expect(queries.length).toBeLessThanOrEqual(4)
	expect(
		queries.some(
			(query) => query === 'SELECT id FROM email_messages WHERE user_id = ?',
		),
	).toBe(false)
})

test('R2 export cursor detects object overwrite before continuing bytes', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id, avatar_key
		) VALUES (
			1, 'user-a', 'a@example.com', 'hash', '2026-07-05', '2026-07-05',
			'2026-07-05', 'user-aaa', 'user-avatars/user-aaa/avatar.png'
		);
	`)
	const bytes = new Uint8Array(300 * 1024).fill(1)
	let etag = '"v1"'
	const get = vi.fn(
		async (
			_key: string,
			options?: { range?: { offset: number; length: number } },
		) => {
			const offset = options?.range?.offset ?? 0
			const length = options?.range?.length ?? bytes.byteLength
			const chunk = bytes.slice(offset, offset + length)
			return {
				size: bytes.byteLength,
				httpEtag: etag,
				httpMetadata: { contentType: 'image/png' },
				arrayBuffer: async () => chunk.buffer,
			}
		},
	)
	const head = vi.fn(async () => ({
		size: bytes.byteLength,
		httpEtag: etag,
	}))
	const env = {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		COMMUNITY_ASSETS: { get, head },
		EMAIL_BLOBS: { get: vi.fn(async () => null), head },
	} as unknown as Env
	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
	})
	expect(first.items).toEqual([
		expect.objectContaining({
			offset: 0,
			etag: '"v1"',
			objectComplete: false,
		}),
	])
	etag = '"v2"'
	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual([
		expect.objectContaining({
			changed: true,
			change: 'object_overwritten',
			expectedEtag: '"v1"',
			actualEtag: '"v2"',
		}),
	])
	expect(get).toHaveBeenCalledTimes(1)
})

test('R2 export cursor keeps stable row identity when inventory mutates', async () => {
	const { sqlite, db } = createMigratedDb()
	sqlite.exec(`
		INSERT INTO users (
			id, username, email, password_hash, created_at, updated_at,
			email_verified_at, stable_user_id
		) VALUES (
			1, 'user-a', 'a@example.com', 'hash', '2026-07-05', '2026-07-05',
			'2026-07-05', 'user-aaa'
		);
	`)
	const requestedKeys: Array<string> = []
	const get = vi.fn(async (key: string) => {
		requestedKeys.push(key)
		const bytes = new TextEncoder().encode(key)
		return {
			size: bytes.byteLength,
			httpEtag: `"${key}"`,
			arrayBuffer: async () => bytes.buffer,
		}
	})
	const blobReferences = [
		{
			kind: 'raw_mime' as const,
			key: 'email-raw:v1:user-aaa/mail-a',
			messageId: 'mail-a',
			attachmentId: null,
		},
		{
			kind: 'raw_mime' as const,
			key: 'email-raw:v1:user-aaa/mail-b',
			messageId: 'mail-b',
			attachmentId: null,
		},
	]
	const env = {
		APP_DB: db,
		COOKIE_SECRET: 'test-cookie-secret',
		EMAIL_BLOBS: { get },
		COMMUNITY_ASSETS: { get: vi.fn(async () => null) },
		MAILBOX: createMailboxBinding({
			blobReferences: () => blobReferences,
		}),
	} as unknown as Env
	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
	})
	blobReferences.unshift({
		kind: 'raw_mime',
		key: 'email-raw:v1:user-aaa/mail-00',
		messageId: 'mail-00',
		attachmentId: null,
	})
	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'r2_object',
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual([
		expect.objectContaining({ key: 'email-raw:v1:user-aaa/mail-b' }),
	])
	expect(requestedKeys).toEqual([
		'email-raw:v1:user-aaa/mail-a',
		'email-raw:v1:user-aaa/mail-b',
	])
})

test('DO export sections expose bounded job manager and owned connector state', async () => {
	const db = {
		prepare(query: string) {
			return {
				bind() {
					return {
						async first<T>() {
							if (query.includes('FROM remote_connector_settings')) {
								return { owned: 1 } as T
							}
							return null
						},
					}
				},
			}
		},
	} as unknown as D1Database
	const env = {
		APP_DB: db,
		JOBS: {
			exportUser: async () => ({
				userId: 'user-aaa',
				alarm: null,
				status: 'idle',
			}),
		},
		REMOTE_CONNECTOR_SESSION: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				rpcExportUserSessionPage: async () => ({
					persisted: { instanceId: 'home' },
					tools: [],
					connected: false,
					truncated: false,
					nextStartAfter: null,
					pageSize: 100,
				}),
			}),
		},
	} as unknown as Env
	const jobManager = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'job_manager',
	})
	expect(jobManager.items).toEqual([
		expect.objectContaining({ userId: 'user-aaa' }),
	])
	expect(jobManager.truncated).toBe(false)

	const connector = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'remote_connector_session',
		instanceId: 'home',
	})
	expect(connector.items).toEqual([
		expect.objectContaining({
			instanceId: 'home',
			connected: false,
		}),
	])
})

test('durable object discovery pages high-cardinality storage ids without nested arrays', async () => {
	const ids = Array.from(
		{ length: 502 },
		(_, index) => `storage-${String(index).padStart(4, '0')}`,
	)
	let maxRows = 0
	const db = {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async all<T>() {
							if (query.includes('FROM user_storage_buckets')) {
								if (!query.includes('storage_id > ?')) {
									return { results: [] as Array<T> }
								}
								const afterId = String(params[1])
								const limit = Number(params[2])
								const rows = ids
									.filter((id) => id > afterId)
									.slice(0, limit)
									.map((id) => ({ id }))
								maxRows = Math.max(maxRows, rows.length)
								return { results: rows as Array<T> }
							}
							if (query.includes('FROM package_service_states')) {
								return { results: [] as Array<T> }
							}
							throw new Error(`Unexpected query: ${query}`)
						},
						async first<T>() {
							return null as T | null
						},
					}
				},
			}
		},
	} as unknown as D1Database
	const seen = new Set<string>()
	let startAfter: string | undefined
	for (;;) {
		const page = await readAccountExportSection({
			env: {
				APP_DB: db,
				JOBS: { listJobStorageIdsForUser: async () => [] },
			} as unknown as Env,
			dbUserId: 1,
			mcpUserId: 'user-a',
			section: 'durable_object_summaries',
			kind: 'storage_runner',
			pageSize: 100,
			startAfter,
		})
		for (const item of page.items as Array<{ storageId: string }>) {
			expect(Array.isArray(item.storageId)).toBe(false)
			seen.add(item.storageId)
		}
		if (!page.truncated) break
		startAfter = page.nextStartAfter ?? undefined
	}
	expect(seen.size).toBe(502)
	expect(maxRows).toBeLessThanOrEqual(101)
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
			allowed_capabilities,
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
			'["fetch"]',
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
			name,
			token_hash,
			email,
			display_name,
			created_at,
			updated_at
		)
		VALUES (
			'token-a',
			'user-aaa',
			'Migration token',
			'token-hash-a',
			'a@example.com',
			'User A',
			'2026-07-05',
			'2026-07-05'
		);

		INSERT INTO password_resets (id, user_id, token_hash, expires_at, created_at)
		VALUES (1, 1, 'reset-token-hash-a', 2000000000, '2026-07-05');

		INSERT INTO remote_connector_settings (
			id,
			user_id,
			instance_id,
			encrypted_shared_secret,
			created_at,
			updated_at
		)
		VALUES (
			'connector-a',
			'user-aaa',
			'home',
			'encrypted-connector-secret',
			'2026-07-05',
			'2026-07-05'
		);

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
			allowed_capabilities: '["fetch"]',
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
	expect(accountExport.d1.remote_connector_settings.rows[0]).toEqual(
		expect.objectContaining({
			id: 'connector-a',
			instance_id: 'home',
		}),
	)
	expect(accountExport.d1.remote_connector_settings.rows[0]).not.toHaveProperty(
		'encrypted_shared_secret',
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
	expect(
		accountExport.manifest.sections['d1.remote_connector_settings']
			?.redactedColumns,
	).toEqual(['encrypted_shared_secret'])
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
			'user-aaa', 'service:pkg%3A1:svc%20x', 'service',
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

test('account export includes run_records section with runs, ledger, and dedicated state', async () => {
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
	const run = {
		id: 'run-export-1',
		surface: 'job' as const,
		status: 'success' as const,
		name: 'nightly',
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: 'job:nightly',
		jobId: 'job-1',
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: '2026-07-26T00:00:00.000Z',
		finishedAt: '2026-07-26T00:00:01.000Z',
		durationMs: 1000,
		errorName: null,
		errorMessage: null,
		metadata: {},
		logCount: 2,
	}
	const logs = [
		{
			runId: 'run-export-1',
			sequence: 0,
			level: 'log' as const,
			message: 'starting',
			fields: null,
		},
		{
			runId: 'run-export-1',
			sequence: 1,
			level: 'info' as const,
			message: 'done',
			fields: { ok: true },
		},
	]
	// Keyed package-invocation idempotency ledger row stored in the same
	// RunLog DO; exported through the same run_records section.
	const packageInvocation = {
		id: 'invocation-export-1',
		tokenId: 'token-1',
		packageId: 'pkg-1',
		packageKodyId: 'pkg-one',
		exportName: './send-message',
		idempotencyKey: 'evt-1',
		requestHash: 'hash-1',
		source: 'webhook',
		topic: null,
		status: 'completed' as const,
		responseJson: '{"status":200,"body":{"ok":true}}',
		createdAt: '2026-07-26T00:00:00.000Z',
		updatedAt: '2026-07-26T00:00:01.000Z',
	}
	const workflowProjection = {
		id: 'wf-export-1',
		bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
		sourceType: 'inline' as const,
		packageId: null,
		kodyId: null,
		sourceId: null,
		workflowName: 'export-wf',
		exportName: null,
		idempotencyKey: 'idem-export',
		runAt: '2026-07-31T00:00:00.000Z',
		planDate: null,
		status: 'complete',
		createdAt: '2026-07-31T00:00:00.000Z',
		updatedAt: '2026-07-31T00:00:01.000Z',
		completedAt: '2026-07-31T00:00:01.000Z',
		lastError: null,
	}
	const jobRunObservability = {
		jobId: 'job-export-1',
		lastRunAt: '2026-07-31T00:00:00.000Z',
		lastRunStatus: 'success' as const,
		lastRunError: null,
		lastDurationMs: 12,
		runCount: 1,
		successCount: 1,
		errorCount: 0,
		updatedAt: '2026-07-31T00:00:01.000Z',
	}
	const packageRunSuccess = {
		packageId: 'pkg-1',
		successCount: 2,
		updatedAt: '2026-07-31T00:00:01.000Z',
	}
	const activationMilestone = {
		milestone: 'package_activated' as const,
		reachedAt: '2026-07-31T00:00:01.000Z',
		packageId: 'pkg-1',
	}
	const env = {
		APP_DB: db,
		STORAGE_RUNNER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				exportStorage: async () => ({
					entries: [],
					truncated: false,
					nextStartAfter: null,
					pageSize: 100,
				}),
			}),
		},
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				exportRuns: async () => ({
					runs: [run],
					logs,
					packageInvocations: [packageInvocation],
					workflowProjections: [workflowProjection],
					jobRunObservability: [jobRunObservability],
					packageRunSuccesses: [packageRunSuccess],
					activationMilestones: [activationMilestone],
					nextStartAfter: null,
					truncated: false,
				}),
				listStorageIds: async () => ['job:nightly'],
				summarize: async () => ({
					since: '1970-01-01T00:00:00.000Z',
					total: 1,
					errors: 0,
					ignored: 0,
					resolved: 0,
					running: 0,
					bySurface: [],
				}),
			}),
		},
		JOBS: {
			exportUser: async () => ({ userId: 'user-aaa' }),
		},
	} as unknown as Env

	const accountExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	// One run plus one row from each RunLog export phase.
	expect(accountExport.manifest.sections.run_records?.count).toBe(6)
	expect(accountExport.durableObjects.runRecords).toEqual({
		runs: [run],
		logs,
		packageInvocations: [packageInvocation],
		workflowProjections: [workflowProjection],
		jobRunObservability: [jobRunObservability],
		packageRunSuccesses: [packageRunSuccess],
		activationMilestones: [activationMilestone],
		nextStartAfter: null,
		truncated: false,
	})

	const section = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'run_records',
	})
	expect(section.truncated).toBe(false)
	expect(section.items).toEqual([
		{
			run,
			logs,
		},
		{
			packageInvocation,
		},
		{
			workflowProjection,
		},
		{
			jobRunObservability,
		},
		{
			packageRunSuccess,
		},
		{
			activationMilestone,
		},
	])
})

test('account export includes user_meter counters, pages them, and warns on truncation', async () => {
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
	const counters = [
		{
			resource: 'email_sends_per_day' as const,
			day: '2026-07-30',
			count: 2,
			revision: 2,
			updatedAt: '2026-07-30T01:00:00.000Z',
			mirrorUpdatedAt: 'r/00000000000000000002',
		},
		{
			resource: 'execute_calls_per_day' as const,
			day: '2026-07-30',
			count: 5,
			revision: 5,
			updatedAt: '2026-07-30T02:00:00.000Z',
			mirrorUpdatedAt: 'r/00000000000000000005',
		},
		{
			resource: 'outbound_fetches_per_day' as const,
			day: '2026-07-31',
			count: 1,
			revision: 1,
			updatedAt: '2026-07-31T00:00:00.000Z',
			mirrorUpdatedAt: 'r/00000000000000000001',
		},
	]
	const storageBytesState = {
		bytes: 4_096,
		revision: 3,
		updatedAt: '2026-07-31T03:00:00.000Z',
		mirrorUpdatedAt: 'r/00000000000000000003',
	}
	const packageServiceStates = [
		{
			packageId: 'pkg-1',
			serviceName: 'worker',
			status: 'running' as const,
			startedAt: '2026-07-31T03:00:00.000Z',
			sourceUpdatedAt: '2026-07-31T03:05:00.000Z',
			revision: 2,
			updatedAt: '2026-07-31T03:05:00.000Z',
			mirrorUpdatedAt: 'r/00000000000000000002',
		},
	]
	const deletionState = {
		deletingAt: '2026-07-31 03:10:00' as string | null,
		activeWriteLeaseCount: 1,
		writeLeases: [
			{
				acquiredAt: '2026-07-31 03:00:00',
			},
		],
	}
	const exportCounters = vi.fn(
		async (input: { pageSize?: number; startAfter?: string | null }) => {
			const pageSize = input.pageSize ?? 100
			const startIndex = input.startAfter
				? counters.findIndex(
						(row) => `${row.day}:${row.resource}` === input.startAfter,
					) + 1
				: 0
			const page = counters.slice(startIndex, startIndex + pageSize)
			const truncated = startIndex + pageSize < counters.length
			const isFirstPage =
				typeof input.startAfter !== 'string' || input.startAfter.length === 0
			return {
				counters: page,
				storageBytesState: isFirstPage ? storageBytesState : null,
				packageServiceStates: isFirstPage ? packageServiceStates : null,
				deletionState: isFirstPage ? deletionState : null,
				nextStartAfter: truncated
					? `${page.at(-1)!.day}:${page.at(-1)!.resource}`
					: null,
				truncated,
			}
		},
	)
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const env = {
		APP_DB: db,
		USER_METER: {
			idFromName,
			get: () => ({ exportCounters }),
		},
	} as unknown as Env

	const accountExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(idFromName).toHaveBeenCalledWith('user-aaa')
	// 3 counters + storage state + 1 package service + deletingAt + 1 lease
	expect(accountExport.manifest.sections.user_meter?.count).toBe(7)
	expect(accountExport.durableObjects.userMeter).toEqual({
		counters,
		storageBytesState,
		packageServiceStates,
		deletionState,
		nextStartAfter: null,
		truncated: false,
	})
	expect(accountExport.manifest.warnings).not.toEqual(
		expect.arrayContaining([
			expect.stringContaining('entitlement_daily_counters'),
		]),
	)

	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'user_meter',
		pageSize: 2,
	})
	expect(first.items).toEqual(counters.slice(0, 2))
	expect(first.storageBytesState).toEqual(storageBytesState)
	expect(first.packageServiceStates).toEqual(packageServiceStates)
	expect(first.deletionState).toEqual(deletionState)
	expect(first.truncated).toBe(true)
	expect(first.nextStartAfter).toBe('2026-07-30:execute_calls_per_day')

	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'user_meter',
		pageSize: 2,
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual(counters.slice(2))
	expect(second.storageBytesState).toBeNull()
	expect(second.packageServiceStates).toBeNull()
	expect(second.deletionState).toBeNull()
	expect(second.truncated).toBe(false)
	expect(second.nextStartAfter).toBeNull()
	expect(exportCounters).toHaveBeenCalledWith(
		expect.objectContaining({
			pageSize: 2,
			startAfter: first.nextStartAfter,
		}),
	)

	exportCounters.mockImplementation(async () => ({
		counters: [counters[0]!],
		storageBytesState: null,
		packageServiceStates: null,
		deletionState: null,
		nextStartAfter: 'cursor-more',
		truncated: true,
	}))
	const truncatedExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(truncatedExport.durableObjects.userMeter?.truncated).toBe(true)
	expect(truncatedExport.manifest.sections.user_meter?.count).toBe(1)
	expect(truncatedExport.manifest.warnings).toContain(
		'User meter counters were truncated in the full export; use account_export_section with section "user_meter" to retrieve additional pages.',
	)
})

test('account export includes mailbox rows, pages them, and warns on truncation', async () => {
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
	const rows = [
		{
			kind: 'thread' as const,
			row: {
				id: 'thread-1',
				inboxId: 'inbox-1',
				subjectNormalized: 'hello',
				rootMessageIdHeader: null,
				lastMessageAt: '2026-07-30T00:00:00.000Z',
				createdAt: '2026-07-30T00:00:00.000Z',
				updatedAt: '2026-07-30T00:00:00.000Z',
			},
		},
		{
			kind: 'message' as const,
			row: {
				id: 'message-1',
				threadId: 'thread-1',
				inboxId: 'inbox-1',
				direction: 'inbound' as const,
				processingStatus: 'received' as const,
				deliveryStatus: 'delivered' as const,
				classification: 'personal' as const,
				subject: 'hello',
				fromAddress: 'a@example.com',
				toAddresses: ['b@example.com'],
				ccAddresses: [],
				bccAddresses: [],
				replyToAddresses: [],
				messageIdHeader: null,
				inReplyToHeader: null,
				referencesHeader: null,
				sentAt: '2026-07-30T00:00:00.000Z',
				receivedAt: '2026-07-30T00:00:00.000Z',
				rawMimeKey: null,
				rawMimeStorageKind: 'unavailable' as const,
				bodyText: 'hi',
				bodyHtml: null,
				snippet: 'hi',
				hasAttachments: false,
				createdAt: '2026-07-30T00:00:00.000Z',
				updatedAt: '2026-07-30T00:00:00.000Z',
			},
		},
		{
			kind: 'attachment' as const,
			row: {
				id: 'attachment-1',
				messageId: 'message-1',
				filename: 'file.txt',
				contentType: 'text/plain',
				sizeBytes: 3,
				storageKey: null,
				storageKind: 'unavailable' as const,
				contentId: null,
				isInline: false,
				createdAt: '2026-07-30T00:00:00.000Z',
			},
		},
	]
	const exportMailbox = vi.fn(
		async (input: { pageSize?: number; startAfter?: string | null }) => {
			const pageSize = input.pageSize ?? 100
			const startIndex = input.startAfter
				? rows.findIndex((row) => row.row.id === input.startAfter) + 1
				: 0
			const page = rows.slice(startIndex, startIndex + pageSize)
			const truncated = startIndex + pageSize < rows.length
			return {
				rows: page,
				nextStartAfter: truncated ? page.at(-1)!.row.id : null,
				truncated,
			}
		},
	)
	const countMailbox = vi.fn(async () => ({
		threads: 1,
		messages: 1,
		attachments: 1,
		deliveryEvents: 0,
	}))
	const idFromName = vi.fn((name: string) => name as unknown as DurableObjectId)
	const env = {
		APP_DB: db,
		MAILBOX: {
			idFromName,
			get: () => ({ exportMailbox, countMailbox }),
		},
	} as unknown as Env

	const accountExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(idFromName).toHaveBeenCalledWith('user-aaa')
	expect(accountExport.manifest.sections.mailbox?.count).toBe(3)
	expect(accountExport.durableObjects.mailbox).toEqual({
		rows,
		nextStartAfter: null,
		truncated: false,
	})
	for (const table of [
		'email_threads',
		'email_messages',
		'email_attachments',
		'email_delivery_events',
	]) {
		expect(accountExport.d1).not.toHaveProperty(table)
		expect(accountExport.manifest.sections).not.toHaveProperty(`d1.${table}`)
	}

	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'mailbox',
		pageSize: 2,
	})
	expect(first.items).toEqual(rows.slice(0, 2))
	expect(first.truncated).toBe(true)
	expect(first.nextStartAfter).toBe('message-1')

	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'mailbox',
		pageSize: 2,
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual(rows.slice(2))
	expect(second.truncated).toBe(false)
	expect(second.nextStartAfter).toBeNull()
	expect(exportMailbox).toHaveBeenCalled()

	exportMailbox.mockImplementation(async () => ({
		rows: [rows[0]!],
		nextStartAfter: 'cursor-more',
		truncated: true,
	}))
	const truncatedExport = await createAccountExport({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(truncatedExport.durableObjects.mailbox?.truncated).toBe(true)
	expect(truncatedExport.manifest.warnings).toContain(
		'Mailbox rows were truncated in the full export; use account_export_section with section "mailbox" to retrieve additional pages.',
	)
})

test('run_records section paging preserves exportRuns cursor across dedicated phases', async () => {
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
	const run = {
		id: 'run-page-1',
		surface: 'job' as const,
		status: 'success' as const,
		name: 'page',
		packageId: null,
		kodyId: null,
		sourceId: null,
		publishedCommit: null,
		storageId: null,
		jobId: 'job-page',
		workflowId: null,
		invocationId: null,
		sessionId: null,
		idempotencyKey: null,
		parentRunId: null,
		startedAt: '2026-07-26T00:00:00.000Z',
		finishedAt: '2026-07-26T00:00:01.000Z',
		durationMs: 1000,
		errorName: null,
		errorMessage: null,
		metadata: {},
		logCount: 0,
	}
	const workflowProjection = {
		id: 'wf-page-1',
		bindingName: 'DYNAMIC_CALLABLE_WORKFLOWS',
		sourceType: 'inline' as const,
		packageId: null,
		kodyId: null,
		sourceId: null,
		workflowName: 'page-wf',
		exportName: null,
		idempotencyKey: 'idem-page',
		runAt: '2026-07-31T00:00:00.000Z',
		planDate: null,
		status: 'complete',
		createdAt: '2026-07-31T00:00:00.000Z',
		updatedAt: '2026-07-31T00:00:01.000Z',
		completedAt: '2026-07-31T00:00:01.000Z',
		lastError: null,
	}
	const exportRuns = vi
		.fn()
		.mockResolvedValueOnce({
			runs: [run],
			logs: [],
			packageInvocations: [],
			workflowProjections: [],
			jobRunObservability: [],
			packageRunSuccesses: [],
			activationMilestones: [],
			nextStartAfter: 'invocation-ledger:',
			truncated: true,
		})
		.mockResolvedValueOnce({
			runs: [],
			logs: [],
			packageInvocations: [],
			workflowProjections: [workflowProjection],
			jobRunObservability: [],
			packageRunSuccesses: [],
			activationMilestones: [],
			nextStartAfter: null,
			truncated: false,
		})
	const env = {
		APP_DB: db,
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ exportRuns }),
		},
	} as unknown as Env

	const first = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'run_records',
		pageSize: 1,
	})
	expect(first.items).toEqual([{ run, logs: [] }])
	expect(first.truncated).toBe(true)
	expect(first.nextStartAfter).toBe('invocation-ledger:')

	const second = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'run_records',
		pageSize: 1,
		startAfter: first.nextStartAfter ?? undefined,
	})
	expect(second.items).toEqual([{ workflowProjection }])
	expect(second.truncated).toBe(false)
	expect(exportRuns).toHaveBeenNthCalledWith(
		2,
		expect.objectContaining({
			pageSize: 1,
			startAfter: 'invocation-ledger:',
		}),
	)
})

test('account export includes a package service known only via package_service_states', async () => {
	consoleWarn.mockImplementation(() => {})
	try {
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
		INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, source_id,
			has_app, hidden, is_private, created_at, updated_at
		) VALUES (
			'pkg-states', 'user-aaa', 'States Package', 'states-pkg', '', '[]',
			'src-states', 0, 0, 1, '2026-07-05', '2026-07-05'
		);
		INSERT INTO package_service_states (
			user_id, package_id, service_name, status, started_at, updated_at
		) VALUES (
			'user-aaa', 'pkg-states', 'only-in-states', 'running',
			'2026-07-05T00:00:00.000Z', '2026-07-05T00:00:00.000Z'
		);
	`)

		const statusMock = vi.fn(async () =>
			Response.json({
				package_id: 'pkg-states',
				kody_id: 'states-pkg',
				service_name: 'only-in-states',
				status: 'running',
				auto_start: false,
				mode: 'bounded',
				timeout_ms: 30_000,
				stop_requested: false,
				active_run_id: null,
				next_alarm_at: null,
				last_error: null,
				last_started_at: '2026-07-05T00:00:00.000Z',
				last_stopped_at: null,
				last_run_finished_at: null,
				last_result: null,
			}),
		)

		const accountExport = await createAccountExport({
			env: {
				APP_DB: db,
				PACKAGE_SERVICE_INSTANCE: {
					idFromName: (name: string) => name as unknown as DurableObjectId,
					get: () => ({ fetch: statusMock }),
				},
			} as unknown as Env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			generatedAt: '2026-07-05T00:00:00.000Z',
		})

		expect(accountExport.manifest.sections.package_services?.count).toBe(1)
		expect(accountExport.durableObjects.packageServices).toEqual([
			expect.objectContaining({
				packageId: 'pkg-states',
				serviceName: 'only-in-states',
				status: expect.objectContaining({
					service_name: 'only-in-states',
					status: 'running',
				}),
			}),
		])
		expect(statusMock).toHaveBeenCalledTimes(1)
	} finally {
		consoleWarn.mockReset()
	}
})

test('storage_runners count matches ids enumerable by discovery paging', async () => {
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
		INSERT INTO jobs (
			id, user_id, name, source_id, storage_id, schedule_json, timezone,
			caller_context_json, created_at, updated_at, next_run_at
		) VALUES (
			'job-1', 'user-aaa', 'Job', 'src-job-1', 'job:job-1', '{}', 'UTC',
			'{}', '2026-07-05', '2026-07-05', '2026-07-05'
		);
		INSERT INTO user_storage_buckets (
			user_id, storage_id, kind, created_at, last_seen_at
		) VALUES (
			'user-aaa', 'exec:adhoc', 'execute', '2026-07-05', '2026-07-05'
		);
		INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, source_id,
			has_app, hidden, is_private, created_at, updated_at
		) VALUES (
			'pkg-1', 'user-aaa', 'Pkg', 'pkg', '', '[]',
			'src-1', 1, 0, 1, '2026-07-05', '2026-07-05'
		);
		INSERT INTO package_service_states (
			user_id, package_id, service_name, status, started_at, updated_at
		) VALUES (
			'user-aaa', 'pkg-1', 'worker', 'idle',
			null, '2026-07-05T00:00:00.000Z'
		);
	`)

	const env = {
		APP_DB: db,
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				listStorageIds: async () => [
					'exec:adhoc',
					'exec:runlog-only',
					'job:job-1',
				],
			}),
		},
	} as unknown as Env
	const manifest = await createAccountExportManifest({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	const expectedCount = manifest.sections.storage_runners?.count
	expect(expectedCount).toBeGreaterThan(0)

	const seen = new Set<string>()
	let startAfter: string | undefined
	for (;;) {
		const page = await readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			section: 'durable_object_summaries',
			kind: 'storage_runner',
			pageSize: 2,
			startAfter,
		})
		for (const item of page.items as Array<{ storageId: string }>) {
			seen.add(item.storageId)
		}
		if (!page.truncated) break
		startAfter = page.nextStartAfter ?? undefined
	}
	expect(seen.size).toBe(expectedCount)
	expect(seen.has('exec:runlog-only')).toBe(true)
})

test('storage_runner section exports a RunLog-only storage id', async () => {
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

	const exportStorage = vi.fn(async () => ({
		entries: [{ key: 'runlog', value: { ok: true } }],
		truncated: false,
		nextStartAfter: null,
		pageSize: 100,
		estimatedBytes: 8,
	}))
	const env = {
		APP_DB: db,
		STORAGE_RUNNER: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({ exportStorage }),
		},
		RUN_LOG: {
			idFromName: (name: string) => name as unknown as DurableObjectId,
			get: () => ({
				listStorageIds: async () => ['exec:runlog-export-only'],
			}),
		},
	} as unknown as Env

	const manifest = await createAccountExportManifest({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
	})
	expect(manifest.sections.storage_runners?.count).toBe(1)

	const section = await readAccountExportSection({
		env,
		dbUserId: 1,
		mcpUserId: 'user-aaa',
		section: 'storage_runner',
		storageId: 'exec:runlog-export-only',
	})
	expect(section.items).toEqual([{ key: 'runlog', value: { ok: true } }])
	expect(exportStorage).toHaveBeenCalledTimes(1)
})

test('storage_runner and package_service section reads do not load manifests for D1-known rows', async () => {
	const loadManifest = vi.spyOn(
		await import('#worker/package-registry/source.ts'),
		'loadPackageManifestBySourceId',
	)
	loadManifest.mockRejectedValue(new Error('manifest should not be loaded'))
	try {
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
			INSERT INTO user_storage_buckets (
				user_id, storage_id, kind, created_at, last_seen_at
			) VALUES (
				'user-aaa', 'exec:section-only', 'execute',
				'2026-07-05', '2026-07-05'
			);
			INSERT INTO saved_packages (
				id, user_id, name, kody_id, description, tags_json, source_id,
				has_app, hidden, is_private, created_at, updated_at
			) VALUES (
				'pkg-1', 'user-aaa', 'Pkg', 'pkg', '', '[]',
				'src-1', 0, 0, 1, '2026-07-05', '2026-07-05'
			);
			INSERT INTO package_service_states (
				user_id, package_id, service_name, status, started_at, updated_at
			) VALUES (
				'user-aaa', 'pkg-1', 'worker', 'idle',
				null, '2026-07-05T00:00:00.000Z'
			);
		`)

		const exportStorage = vi.fn(async () => ({
			entries: [],
			truncated: false,
			nextStartAfter: null,
			pageSize: 100,
			estimatedBytes: 0,
		}))
		const statusMock = vi.fn(async () =>
			Response.json({
				package_id: 'pkg-1',
				kody_id: 'pkg',
				service_name: 'worker',
				status: 'idle',
			}),
		)
		const env = {
			APP_DB: db,
			STORAGE_RUNNER: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ exportStorage }),
			},
			PACKAGE_SERVICE_INSTANCE: {
				idFromName: (name: string) => name as unknown as DurableObjectId,
				get: () => ({ fetch: statusMock }),
			},
		} as unknown as Env

		await readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			section: 'storage_runner',
			storageId: 'exec:section-only',
		})
		await readAccountExportSection({
			env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			section: 'package_service',
			packageId: 'pkg-1',
			serviceName: 'worker',
		})
		expect(loadManifest).not.toHaveBeenCalled()
	} finally {
		loadManifest.mockRestore()
	}
})

test('storage_runner section treats malformed service storage ids as not found', async () => {
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
		INSERT INTO saved_packages (
			id, user_id, name, kody_id, description, tags_json, source_id,
			has_app, hidden, is_private, created_at, updated_at
		) VALUES (
			'pkg%', 'user-aaa', 'Malformed', 'malformed', '', '[]',
			'src-malformed', 0, 0, 1, '2026-07-05', '2026-07-05'
		);
		INSERT INTO package_service_states (
			user_id, package_id, service_name, status, started_at, updated_at
		) VALUES (
			'user-aaa', 'pkg%', 'worker%', 'idle',
			null, '2026-07-05T00:00:00.000Z'
		);
	`)

	await expect(
		readAccountExportSection({
			env: { APP_DB: db } as Env,
			dbUserId: 1,
			mcpUserId: 'user-aaa',
			section: 'storage_runner',
			storageId: 'service:pkg%:worker%',
		}),
	).rejects.toThrow('Storage runner was not found for account export.')
})
