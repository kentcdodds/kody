vi.unmock('#worker/audit-log.ts')

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import { getScheduledLaneCadence } from '@kody-internal/shared/jobs/scheduled-lanes.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import * as AccountDeletion from './account-deletion.ts'
import {
	pruneUnverifiedAccounts,
	shouldRunUnverifiedAccountPurgeCron,
} from './unverified-account-purge.ts'

const now = new Date('2026-09-02T12:00:00.000Z')
const millisecondsPerDay = 24 * 60 * 60 * 1000

function daysAgo(days: number) {
	return new Date(now.getTime() - days * millisecondsPerDay).toISOString()
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

test('hourly cadence includes unverified account purge alongside retention', () => {
	expect(shouldRunUnverifiedAccountPurgeCron(now)).toBe(true)
	expect(
		shouldRunUnverifiedAccountPurgeCron(new Date('2026-09-02T12:05:00.000Z')),
	).toBe(false)
	const hourly = getScheduledLaneCadence(now)
	expect(hourly).toContain('retention')
	expect(hourly).toContain('unverified_account_purge')
	const offHour = getScheduledLaneCadence(new Date('2026-09-02T12:05:00.000Z'))
	expect(offHour.includes('retention')).toBe(false)
	expect(offHour.includes('unverified_account_purge')).toBe(false)
})

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
		deletingAt: daysAgo(1),
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

test('a failed deletion is recorded and does not stop the rest of the batch', async () => {
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
	await seedUser(db, {
		username: 'purged-last',
		email: 'last@example.com',
		createdAt: daysAgo(10),
	})
	deleteUserAccount.mockImplementationOnce(async () => {
		throw new Error('simulated deletion failure')
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
	})
	expect(consoleWarn).toHaveBeenCalledTimes(1)
	expect(consoleWarn).toHaveBeenCalledWith('unverified_account_purge_failed', {
		userId: failing.stableUserId,
		warnings: [],
		error: expect.any(Error),
	})
	expect(usernames(sqlite)).toEqual(['failing'])
	expect(auditActions(audit.sqlite)).toEqual([
		expect.objectContaining({
			action: 'unverified_account_purged',
			email_hash: emailHash(surviving.email),
		}),
		expect.objectContaining({
			action: 'unverified_account_purged',
			reason: 'unverified_for_10_days',
		}),
	])
})
