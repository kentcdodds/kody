vi.unmock('#worker/audit-log.ts')

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import * as AuditLog from '#worker/audit-log.ts'
import * as AccountDeletion from '#app/account-deletion.ts'
import * as DeletionState from '#worker/account/deletion-state.ts'
import { AccountDeletionWritersActiveError } from '#worker/account/deletion-state.ts'
import {
	AccountDeletionCleanupError,
	AccountDeletionInventoryError,
	type AccountDeletionResult,
} from '#app/account-deletion.ts'
import {
	listUnverifiedAccountPurgeCandidates,
	pruneUnverifiedAccounts,
	unverifiedAccountPurgeFailureReasonMaxLength,
} from './unverified-account-purge.ts'

const now = new Date('2026-09-02T12:00:00.000Z')
const millisecondsPerDay = 24 * 60 * 60 * 1000

function daysAgo(days: number) {
	return new Date(now.getTime() - days * millisecondsPerDay).toISOString()
}

function minutesAgo(minutes: number) {
	return new Date(now.getTime() - minutes * 60 * 1000).toISOString()
}

function deletingAt(sqlite: DatabaseSync, username: string) {
	const row = sqlite
		.prepare(`SELECT deleting_at FROM users WHERE username = ?`)
		.get(username) as { deleting_at: string | null } | undefined
	return row?.deleting_at ?? null
}

function withVerifyAfterUnverifiedAccountSelect(
	db: D1Database,
	verifiedAt: string,
): D1Database {
	const originalPrepare = db.prepare.bind(db)
	return {
		...db,
		prepare(query: string) {
			const statement = originalPrepare(query)
			if (!query.includes('SELECT id, stable_user_id, email, created_at')) {
				return statement
			}
			return {
				bind(...params: Array<unknown>) {
					const bound = statement.bind(...params)
					return {
						...bound,
						async all<T extends { id: number }>() {
							const result = await bound.all<T>()
							for (const row of result.results ?? []) {
								await originalPrepare(
									`UPDATE users SET email_verified_at = ? WHERE id = ?`,
								)
									.bind(verifiedAt, row.id)
									.run()
							}
							return result
						},
					}
				},
			}
		},
	} as D1Database
}

function emptyDeletionResult(): AccountDeletionResult {
	return {
		deletedRowCounts: {},
		updatedRowCounts: {},
		deletedKvKeys: 0,
		deletedCommunityAssets: 0,
		deletedEmailBlobs: 0,
		deletedArtifactRepos: 0,
		revokedOAuthGrants: 0,
		clearedDurableObjects: {},
		deletedVectors: 0,
		warnings: ['simulated cleanup'],
	}
}

function emailHash(email: string) {
	return createHash('sha256').update(email.trim().toLowerCase()).digest('hex')
}

function createAppDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(sqlite, new URL('../../migrations/', import.meta.url))
	applyAllMigrations(
		sqlite,
		new URL('../../../jobs-worker/migrations/', import.meta.url),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createAuditDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(
		readFileSync(
			new URL('../../audit-migrations/0001-audit-events.sql', import.meta.url),
			'utf8',
		),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function createPurgeEnv(appDb: D1Database, auditDb: D1Database) {
	return {
		...createSuccessfulDeletionEnv(appDb),
		AUDIT_DB: auditDb,
	} as Env
}

async function seedUser(
	db: D1Database,
	input: {
		username: string
		email: string
		createdAt: string
		emailVerifiedAt?: string | null
		accountType?: 'person' | 'platform'
		deletingAt?: string | null
		oauthProvider?: string
	},
) {
	const stableUserId = await createStableUserIdFromEmail(input.email)
	const inserted = await db
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id,
				email_verified_at, account_type, deleting_at, created_at
			) VALUES (?, ?, 'hash', ?, ?, ?, ?, ?)`,
		)
		.bind(
			input.username,
			input.email,
			stableUserId,
			input.emailVerifiedAt ?? null,
			input.accountType ?? 'person',
			input.deletingAt ?? null,
			input.createdAt,
		)
		.run()
	const id = Number(inserted.meta.last_row_id)
	if (input.oauthProvider) {
		await db
			.prepare(
				`INSERT INTO oauth_connections (provider_name, provider_id, user_id)
				VALUES (?, ?, ?)`,
			)
			.bind(input.oauthProvider, `${input.oauthProvider}-${id}`, id)
			.run()
	}
	return { id, stableUserId, email: input.email, username: input.username }
}

function usernames(sqlite: DatabaseSync) {
	return (
		sqlite
			.prepare(`SELECT username FROM users ORDER BY username ASC`)
			.all() as Array<{ username: string }>
	).map((row) => row.username)
}

function auditActions(sqlite: DatabaseSync) {
	return sqlite
		.prepare(
			`SELECT category, action, result, email_hash, reason
			FROM audit_events
			ORDER BY id ASC`,
		)
		.all() as Array<{
		category: string
		action: string
		result: string
		email_hash: string | null
		reason: string | null
	}>
}

test('purge deletes only aged unverified person accounts through full account deletion and writes an audit row', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const eligible = await seedUser(db, {
		username: 'stale-unverified',
		email: 'stale@example.com',
		createdAt: daysAgo(8),
	})
	await seedUser(db, {
		username: 'verified-old',
		email: 'verified@example.com',
		createdAt: daysAgo(30),
		emailVerifiedAt: daysAgo(29),
	})
	await seedUser(db, {
		username: 'young-unverified',
		email: 'young@example.com',
		createdAt: daysAgo(1),
	})
	await seedUser(db, {
		username: 'platform-unverified',
		email: 'platform@example.com',
		createdAt: daysAgo(30),
		accountType: 'platform',
	})
	await seedUser(db, {
		username: 'fenced-unverified',
		email: 'fenced@example.com',
		createdAt: daysAgo(30),
		deletingAt: minutesAgo(5),
	})
	await seedUser(db, {
		username: 'social-unverified',
		email: 'social@example.com',
		createdAt: daysAgo(30),
		oauthProvider: 'github',
	})

	const result = await pruneUnverifiedAccounts({
		env: createPurgeEnv(db, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 1,
		purged: 1,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: eligible.stableUserId, ageDays: 8, outcome: 'purged' },
		],
	})
	expect(deleteUserAccount).toHaveBeenCalledTimes(1)
	expect(deleteUserAccount).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_DB: db }),
		dbUserId: eligible.id,
		mcpUserId: eligible.stableUserId,
	})
	expect(usernames(sqlite)).toEqual([
		'fenced-unverified',
		'platform-unverified',
		'social-unverified',
		'verified-old',
		'young-unverified',
	])
	expect(auditActions(audit.sqlite)).toEqual([
		{
			category: 'account',
			action: 'unverified_account_purged',
			result: 'success',
			email_hash: emailHash(eligible.email),
			reason: 'unverified_for_8_days',
		},
	])
})

test('purge walks oldest-first keyset pages and stops at the bounded batch size', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const oldest = await seedUser(db, {
		username: 'oldest',
		email: 'oldest@example.com',
		createdAt: daysAgo(11),
	})
	const second = await seedUser(db, {
		username: 'second',
		email: 'second@example.com',
		createdAt: daysAgo(10),
	})
	const third = await seedUser(db, {
		username: 'third',
		email: 'third@example.com',
		createdAt: daysAgo(9),
	})
	const fourth = await seedUser(db, {
		username: 'fourth',
		email: 'fourth@example.com',
		createdAt: daysAgo(8),
	})
	const env = createPurgeEnv(db, audit.db)

	const firstRun = await pruneUnverifiedAccounts({
		env,
		now,
		batchSize: 2,
	})
	expect(firstRun).toEqual({
		scanned: 2,
		purged: 2,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: oldest.stableUserId, ageDays: 11, outcome: 'purged' },
			{ stableUserId: second.stableUserId, ageDays: 10, outcome: 'purged' },
		],
	})
	expect(deleteUserAccount.mock.calls.map((call) => call[0].mcpUserId)).toEqual(
		[oldest.stableUserId, second.stableUserId],
	)
	expect(usernames(sqlite)).toEqual(['fourth', 'third'])

	deleteUserAccount.mockClear()
	const secondRun = await pruneUnverifiedAccounts({
		env,
		now,
		batchSize: 2,
	})
	expect(secondRun.purged).toBe(2)
	expect(deleteUserAccount.mock.calls.map((call) => call[0].mcpUserId)).toEqual(
		[third.stableUserId, fourth.stableUserId],
	)
	expect(usernames(sqlite)).toEqual([])
	expect(auditActions(audit.sqlite)).toHaveLength(4)
})

test('a failed deletion is audited with a bounded reason, reported per account, and does not stop the rest of the batch', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const failing = await seedUser(db, {
		username: 'failing',
		email: 'failing@example.com',
		createdAt: daysAgo(12),
	})
	const surviving = await seedUser(db, {
		username: 'purged-after-failure',
		email: 'after@example.com',
		createdAt: daysAgo(11),
	})
	const last = await seedUser(db, {
		username: 'purged-last',
		email: 'last@example.com',
		createdAt: daysAgo(10),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionInventoryError([
			'simulated inventory',
			'second inventory warning',
		])
	})

	const result = await pruneUnverifiedAccounts({
		env: createPurgeEnv(db, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 3,
		purged: 2,
		failed: 1,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: failing.stableUserId,
				ageDays: 12,
				outcome: 'failed',
				error: 'AccountDeletionInventoryError: simulated inventory',
				warnings: ['simulated inventory', 'second inventory warning'],
			},
			{ stableUserId: surviving.stableUserId, ageDays: 11, outcome: 'purged' },
			{ stableUserId: last.stableUserId, ageDays: 10, outcome: 'purged' },
		],
	})
	expect(JSON.stringify(result)).not.toContain('@example.com')
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(consoleWarn).toHaveBeenCalledWith('unverified_account_purge_failed', {
		userId: failing.stableUserId,
		warnings: ['simulated inventory', 'second inventory warning'],
		error: expect.any(AccountDeletionInventoryError),
	})
	expect(usernames(sqlite)).toEqual(['failing'])
	expect(auditActions(audit.sqlite)).toEqual([
		{
			category: 'account',
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email_hash: emailHash(failing.email),
			reason: 'AccountDeletionInventoryError: simulated inventory',
		},
		expect.objectContaining({
			action: 'unverified_account_purged',
			email_hash: emailHash(surviving.email),
		}),
		expect.objectContaining({
			action: 'unverified_account_purged',
			reason: 'unverified_for_10_days',
		}),
	])
	expect(deletingAt(sqlite, 'failing')).toBeNull()

	deleteUserAccount.mockClear()
	const retry = await pruneUnverifiedAccounts({
		env: createPurgeEnv(db, audit.db),
		now,
	})
	expect(retry).toEqual({
		scanned: 1,
		purged: 1,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: failing.stableUserId, ageDays: 12, outcome: 'purged' },
		],
	})
	expect(usernames(sqlite)).toEqual([])
})

test('the failure audit reason falls back to the error message and is truncated', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const failing = await seedUser(db, {
		username: 'long-failure',
		email: 'long-failure@example.com',
		createdAt: daysAgo(9),
	})
	const other = await seedUser(db, {
		username: 'writers-active',
		email: 'writers-active@example.com',
		createdAt: daysAgo(8),
	})
	deleteUserAccount
		.mockImplementationOnce(async () => {
			throw new Error(`d1 timeout\n${'x'.repeat(400)}`)
		})
		.mockImplementationOnce(async () => {
			throw new AccountDeletionWritersActiveError(2)
		})

	const result = await pruneUnverifiedAccounts({
		env: createPurgeEnv(db, audit.db),
		now,
	})

	const [truncated, writersActive] = result.outcomes
	expect(truncated).toMatchObject({
		stableUserId: failing.stableUserId,
		outcome: 'failed',
		warnings: [],
	})
	expect(truncated?.error).toHaveLength(
		unverifiedAccountPurgeFailureReasonMaxLength,
	)
	expect(truncated?.error).toMatch(/^Error: d1 timeout x+$/)
	expect(writersActive).toEqual({
		stableUserId: other.stableUserId,
		ageDays: 8,
		outcome: 'failed',
		error:
			'AccountDeletionWritersActiveError: Account deletion is waiting for 2 active user write(s) to finish.',
		warnings: [],
	})
	expect(auditActions(audit.sqlite)).toEqual([
		expect.objectContaining({
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email_hash: emailHash(failing.email),
			reason: truncated?.error,
		}),
		expect.objectContaining({
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email_hash: emailHash(other.email),
			reason: writersActive?.error,
		}),
	])
	expect(deletingAt(sqlite, 'writers-active')).toBeNull()
})

test('a failed failure-audit write is logged and does not stop the rest of the batch', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const logAuditEvent = vi.spyOn(AuditLog, 'logAuditEvent')
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const failing = await seedUser(db, {
		username: 'failing-audit-down',
		email: 'failing-audit-down@example.com',
		createdAt: daysAgo(12),
	})
	const purged = await seedUser(db, {
		username: 'purged-after-audit-down',
		email: 'purged-after-audit-down@example.com',
		createdAt: daysAgo(11),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionInventoryError(['simulated inventory'])
	})
	logAuditEvent.mockRejectedValueOnce(new Error('audit db down'))

	const result = await pruneUnverifiedAccounts({
		env: createPurgeEnv(db, audit.db),
		now,
	})

	expect(result).toMatchObject({ scanned: 2, purged: 1, failed: 1 })
	expect(consoleWarn).toHaveBeenCalledWith(
		'unverified_account_purge_audit_failed',
		{ userId: failing.stableUserId, error: expect.any(Error) },
	)
	expect(usernames(sqlite)).toEqual(['failing-audit-down'])
	expect(auditActions(audit.sqlite)).toEqual([
		expect.objectContaining({
			action: 'unverified_account_purged',
			email_hash: emailHash(purged.email),
		}),
	])
})

test('a failed fence release is logged and does not stop the rest of the batch', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const abortAccountDeleting = vi.spyOn(DeletionState, 'abortAccountDeleting')
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const stuck = await seedUser(db, {
		username: 'stuck-fence',
		email: 'stuck@example.com',
		createdAt: daysAgo(12),
	})
	const afterStuck = await seedUser(db, {
		username: 'purged-after-stuck',
		email: 'after-stuck@example.com',
		createdAt: daysAgo(11),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionInventoryError(['simulated inventory'])
	})
	abortAccountDeleting.mockImplementationOnce(async () => {
		throw new Error('simulated release failure')
	})

	const result = await pruneUnverifiedAccounts({
		env: createPurgeEnv(db, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 2,
		purged: 1,
		failed: 1,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: stuck.stableUserId,
				ageDays: 12,
				outcome: 'failed',
				error: 'AccountDeletionInventoryError: simulated inventory',
				warnings: ['simulated inventory'],
			},
			{ stableUserId: afterStuck.stableUserId, ageDays: 11, outcome: 'purged' },
		],
	})
	expect(consoleWarn).toHaveBeenCalledWith(
		'unverified_account_purge_release_failed',
		{ userId: stuck.stableUserId, error: expect.any(Error) },
	)
	expect(usernames(sqlite)).toEqual(['stuck-fence'])
	expect(deletingAt(sqlite, 'stuck-fence')).not.toBeNull()
})

test('a pre-existing fence is left in place when a restamped deletion fails', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const fenced = await seedUser(db, {
		username: 'restamp-fail',
		email: 'restamp-fail@example.com',
		createdAt: daysAgo(12),
		deletingAt: daysAgo(1),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new Error('simulated restamped deletion failure')
	})

	const result = await pruneUnverifiedAccounts({
		env: createPurgeEnv(db, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 1,
		purged: 0,
		failed: 1,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: fenced.stableUserId,
				ageDays: 12,
				outcome: 'failed',
				error: 'Error: simulated restamped deletion failure',
				warnings: [],
			},
		],
	})
	expect(consoleWarn).toHaveBeenCalledWith('unverified_account_purge_failed', {
		userId: fenced.stableUserId,
		warnings: [],
		error: expect.any(Error),
	})
	expect(usernames(sqlite)).toEqual(['restamp-fail'])
	expect(deletingAt(sqlite, 'restamp-fail')).not.toBeNull()
	expect(auditActions(audit.sqlite)).toEqual([
		expect.objectContaining({
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email_hash: emailHash(fenced.email),
			reason: 'Error: simulated restamped deletion failure',
		}),
	])
})

test('a cleanup error keeps a claim-created fence so the damaged account retries', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const damaged = await seedUser(db, {
		username: 'cleanup-fail',
		email: 'cleanup-fail@example.com',
		createdAt: daysAgo(8),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new AccountDeletionCleanupError(
			['simulated cleanup'],
			emptyDeletionResult(),
		)
	})

	const result = await pruneUnverifiedAccounts({
		env: createPurgeEnv(db, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 1,
		purged: 0,
		failed: 1,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: damaged.stableUserId,
				ageDays: 8,
				outcome: 'failed',
				error: 'AccountDeletionCleanupError: simulated cleanup',
				warnings: ['simulated cleanup'],
			},
		],
	})
	expect(consoleWarn).toHaveBeenCalledWith('unverified_account_purge_failed', {
		userId: damaged.stableUserId,
		warnings: ['simulated cleanup'],
		error: expect.any(AccountDeletionCleanupError),
	})
	expect(usernames(sqlite)).toEqual(['cleanup-fail'])
	expect(deletingAt(sqlite, 'cleanup-fail')).not.toBeNull()
	expect(auditActions(audit.sqlite)).toEqual([
		expect.objectContaining({
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email_hash: emailHash(damaged.email),
			reason: 'AccountDeletionCleanupError: simulated cleanup',
		}),
	])

	deleteUserAccount.mockClear()
	const retry = await pruneUnverifiedAccounts({
		env: createPurgeEnv(db, audit.db),
		now,
	})
	expect(retry).toEqual({
		scanned: 0,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [],
	})
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(usernames(sqlite)).toEqual(['cleanup-fail'])
})

test('an audit failure after a successful delete does not stop the batch or release a fence', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const logAuditEvent = vi.spyOn(AuditLog, 'logAuditEvent')
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const first = await seedUser(db, {
		username: 'audit-fail',
		email: 'audit-fail@example.com',
		createdAt: daysAgo(10),
	})
	const second = await seedUser(db, {
		username: 'audit-ok',
		email: 'audit-ok@example.com',
		createdAt: daysAgo(9),
	})
	logAuditEvent.mockRejectedValueOnce(new Error('audit db down'))

	const result = await pruneUnverifiedAccounts({
		env: createPurgeEnv(db, audit.db),
		now,
	})

	expect(result).toEqual({
		scanned: 2,
		purged: 2,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: first.stableUserId, ageDays: 10, outcome: 'purged' },
			{ stableUserId: second.stableUserId, ageDays: 9, outcome: 'purged' },
		],
	})
	expect(deleteUserAccount).toHaveBeenCalledTimes(2)
	expect(consoleWarn).toHaveBeenCalledWith(
		'unverified_account_purge_audit_failed',
		{
			userId: first.stableUserId,
			error: expect.any(Error),
		},
	)
	expect(usernames(sqlite)).toEqual([])
	expect(auditActions(audit.sqlite)).toEqual([
		expect.objectContaining({
			action: 'unverified_account_purged',
			email_hash: emailHash(second.email),
		}),
	])
})

test('a claim that loses the race to verification keeps the account and writes no audit', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const raced = await seedUser(db, {
		username: 'verified-during-select',
		email: 'raced@example.com',
		createdAt: daysAgo(8),
	})
	const env = createPurgeEnv(
		withVerifyAfterUnverifiedAccountSelect(db, now.toISOString()),
		audit.db,
	)

	const result = await pruneUnverifiedAccounts({ env, now })

	expect(result).toEqual({
		scanned: 1,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: raced.stableUserId,
				ageDays: 8,
				outcome: 'skipped_claim',
			},
		],
	})
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(usernames(sqlite)).toEqual(['verified-during-select'])
	expect(auditActions(audit.sqlite)).toEqual([])
	const row = sqlite
		.prepare(`SELECT email_verified_at, deleting_at FROM users WHERE id = ?`)
		.get(raced.id) as {
		email_verified_at: string | null
		deleting_at: string | null
	}
	expect(row.email_verified_at).not.toBeNull()
	expect(row.deleting_at).toBeNull()
})

test('never-attempted accounts are purged before stale fences; in-backoff fences are skipped', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const staleFence = await seedUser(db, {
		username: 'stale-fence',
		email: 'stale-fence@example.com',
		createdAt: daysAgo(30),
		deletingAt: daysAgo(1),
	})
	const fresh = await seedUser(db, {
		username: 'fresh-unverified',
		email: 'fresh@example.com',
		createdAt: daysAgo(8),
	})
	await seedUser(db, {
		username: 'recent-fence',
		email: 'recent-fence@example.com',
		createdAt: daysAgo(20),
		deletingAt: minutesAgo(5),
	})
	const env = createPurgeEnv(db, audit.db)

	const firstRun = await pruneUnverifiedAccounts({
		env,
		now,
		batchSize: 1,
	})
	expect(firstRun).toEqual({
		scanned: 1,
		purged: 1,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: fresh.stableUserId, ageDays: 8, outcome: 'purged' },
		],
	})
	expect(deleteUserAccount.mock.calls.map((call) => call[0].mcpUserId)).toEqual(
		[fresh.stableUserId],
	)
	expect(usernames(sqlite)).toEqual(['recent-fence', 'stale-fence'])

	deleteUserAccount.mockClear()
	const secondRun = await pruneUnverifiedAccounts({
		env,
		now,
		batchSize: 2,
	})
	expect(secondRun).toEqual({
		scanned: 1,
		purged: 1,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: staleFence.stableUserId, ageDays: 30, outcome: 'purged' },
		],
	})
	expect(deleteUserAccount.mock.calls.map((call) => call[0].mcpUserId)).toEqual(
		[staleFence.stableUserId],
	)
	expect(usernames(sqlite)).toEqual(['recent-fence'])
	expect(deletingAt(sqlite, 'recent-fence')).not.toBeNull()
	expect(auditActions(audit.sqlite)).toHaveLength(2)
})

test('a zero time budget deletes nothing', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	await seedUser(db, {
		username: 'would-purge',
		email: 'budget@example.com',
		createdAt: daysAgo(8),
	})

	const result = await pruneUnverifiedAccounts({
		env: createPurgeEnv(db, audit.db),
		now,
		timeBudgetMs: 0,
	})

	expect(result).toEqual({
		scanned: 1,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: true,
		outcomes: [],
	})
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(usernames(sqlite)).toEqual(['would-purge'])
	expect(deletingAt(sqlite, 'would-purge')).toBeNull()
	expect(auditActions(audit.sqlite)).toEqual([])
})

test('listUnverifiedAccountPurgeCandidates previews the claim page without claiming, deleting, or auditing', async () => {
	const deleteUserAccount = vi.spyOn(AccountDeletion, 'deleteUserAccount')
	const { sqlite, db } = createAppDb()
	const audit = createAuditDb()
	const staleFence = await seedUser(db, {
		username: 'preview-stale-fence',
		email: 'preview-stale-fence@example.com',
		createdAt: daysAgo(30),
		deletingAt: daysAgo(1),
	})
	const fresh = await seedUser(db, {
		username: 'preview-fresh',
		email: 'preview-fresh@example.com',
		createdAt: daysAgo(9),
	})
	await seedUser(db, {
		username: 'preview-young',
		email: 'preview-young@example.com',
		createdAt: daysAgo(2),
	})
	await seedUser(db, {
		username: 'preview-recent-fence',
		email: 'preview-recent-fence@example.com',
		createdAt: daysAgo(20),
		deletingAt: minutesAgo(5),
	})

	const preview = await listUnverifiedAccountPurgeCandidates({
		env: createPurgeEnv(db, audit.db),
		now,
	})

	expect(preview).toEqual({
		scanned: 2,
		candidates: [
			{ stableUserId: fresh.stableUserId, ageDays: 9 },
			{ stableUserId: staleFence.stableUserId, ageDays: 30 },
		],
	})
	expect(JSON.stringify(preview)).not.toContain('@example.com')
	expect(deleteUserAccount).not.toHaveBeenCalled()
	expect(deletingAt(sqlite, 'preview-fresh')).toBeNull()
	expect(deletingAt(sqlite, 'preview-stale-fence')).toBe(daysAgo(1))
	expect(auditActions(audit.sqlite)).toEqual([])
	expect(
		await listUnverifiedAccountPurgeCandidates({
			env: createPurgeEnv(db, audit.db),
			now,
			batchSize: 1,
		}),
	).toEqual({
		scanned: 1,
		candidates: [{ stableUserId: fresh.stableUserId, ageDays: 9 }],
	})
})
