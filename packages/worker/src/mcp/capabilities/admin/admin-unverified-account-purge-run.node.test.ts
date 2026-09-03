import { DatabaseSync } from 'node:sqlite'
import { expect, test } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { createSuccessfulDeletionEnv } from '#worker/test-support/account-deletion.ts'
import { applyAllMigrations } from '#worker/test-support/apply-all-migrations.ts'
import {
	auditEventSummaries,
	logAuditEventSpy,
} from '#worker/test-support/audit-log-spy.ts'
import { consoleWarn } from '#worker/test-support/console-spies.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { adminUnverifiedAccountPurgeRunCapability } from './admin-unverified-account-purge-run.ts'

const millisecondsPerDay = 24 * 60 * 60 * 1000

function daysAgo(days: number) {
	return new Date(Date.now() - days * millisecondsPerDay).toISOString()
}

function createAppDb() {
	const sqlite = new DatabaseSync(':memory:')
	applyAllMigrations(
		sqlite,
		new URL('../../../../migrations/', import.meta.url),
	)
	applyAllMigrations(
		sqlite,
		new URL('../../../../../jobs-worker/migrations/', import.meta.url),
	)
	return { sqlite, db: createD1FromSqlite(sqlite) }
}

function seedUnverifiedUser(
	sqlite: DatabaseSync,
	input: { username: string; email: string; createdAt: string },
) {
	const stableUserId = testStableUserIdFromEmail(input.email)
	sqlite
		.prepare(
			`INSERT INTO users (
				username, email, password_hash, stable_user_id, account_type, created_at
			) VALUES (?, ?, 'hash', ?, 'person', ?)`,
		)
		.run(input.username, input.email, stableUserId, input.createdAt)
	return { stableUserId, ...input }
}

function userRow(sqlite: DatabaseSync, username: string) {
	return sqlite
		.prepare(`SELECT deleting_at FROM users WHERE username = ?`)
		.get(username) as { deleting_at: string | null } | undefined
}

/**
 * Fails the memory inventory select so `deleteUserAccount` throws an
 * `AccountDeletionInventoryError` after the purge has claimed the row.
 */
function withFailingMemoryInventory(db: D1Database): D1Database {
	const originalPrepare = db.prepare.bind(db)
	return {
		...db,
		prepare(query: string) {
			if (/from\s+mcp_memories/i.test(query)) {
				throw new Error('simulated inventory outage')
			}
			return originalPrepare(query)
		},
	} as D1Database
}

function createContext(roles: Array<string>, env: Env) {
	return {
		env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: testStableUserIdFromEmail('admin@example.com'),
				email: 'admin@example.com',
				displayName: 'admin',
				roles,
			},
		}),
	}
}

test('adminUnverifiedAccountPurgeRun is admin-only and validates batchSize', async () => {
	const { db } = createAppDb()
	const env = createSuccessfulDeletionEnv(db) as Env
	await expect(
		adminUnverifiedAccountPurgeRunCapability.handler(
			{ dryRun: true },
			createContext(['user'], env),
		),
	).rejects.toThrow('lacks required role "admin"')
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'auth',
			action: 'mcp_capability_denied',
			result: 'failure',
			reason: 'role',
		}),
	)

	await expect(
		adminUnverifiedAccountPurgeRunCapability.handler(
			{ batchSize: 0 },
			createContext(['admin'], env),
		),
	).rejects.toThrow(/batchSize/)
	await expect(
		adminUnverifiedAccountPurgeRunCapability.handler(
			{ batchSize: 21 },
			createContext(['admin'], env),
		),
	).rejects.toThrow(/batchSize/)
})

test('adminUnverifiedAccountPurgeRun dryRun lists the claim page without claiming or deleting', async () => {
	const { sqlite, db } = createAppDb()
	const stale = seedUnverifiedUser(sqlite, {
		username: 'stale',
		email: 'stale@example.com',
		createdAt: daysAgo(12),
	})
	const older = seedUnverifiedUser(sqlite, {
		username: 'older',
		email: 'older@example.com',
		createdAt: daysAgo(9),
	})
	seedUnverifiedUser(sqlite, {
		username: 'young',
		email: 'young@example.com',
		createdAt: daysAgo(2),
	})
	const ctx = createContext(['admin'], createSuccessfulDeletionEnv(db) as Env)

	const result = await adminUnverifiedAccountPurgeRunCapability.handler(
		{ dryRun: true },
		ctx,
	)

	expect(result).toEqual({
		dryRun: true,
		scanned: 2,
		purged: 0,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: stale.stableUserId, ageDays: 12, outcome: 'would_claim' },
			{ stableUserId: older.stableUserId, ageDays: 9, outcome: 'would_claim' },
		],
	})
	expect(JSON.stringify(result)).not.toMatch(/@example\.com|stale|older/)
	expect(userRow(sqlite, 'stale')).toEqual({ deleting_at: null })
	expect(userRow(sqlite, 'older')).toEqual({ deleting_at: null })
	expect(auditEventSummaries()).toEqual([
		'adminUnverifiedAccountPurgeRun:success',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'admin',
			action: 'adminUnverifiedAccountPurgeRun',
			result: 'success',
			reason: 'dry_run=true;scanned=2;purged=0;failed=0',
		}),
	)

	const limited = await adminUnverifiedAccountPurgeRunCapability.handler(
		{ dryRun: true, batchSize: 1 },
		ctx,
	)
	expect(limited.outcomes).toEqual([
		{ stableUserId: stale.stableUserId, ageDays: 12, outcome: 'would_claim' },
	])
})

test('adminUnverifiedAccountPurgeRun surfaces a failing delete per account and releases the claim', async () => {
	consoleWarn.mockImplementation(() => {})
	const { sqlite, db } = createAppDb()
	const failing = seedUnverifiedUser(sqlite, {
		username: 'failing',
		email: 'failing@example.com',
		createdAt: daysAgo(10),
	})
	const env = createSuccessfulDeletionEnv(withFailingMemoryInventory(db)) as Env
	const ctx = createContext(['admin'], env)

	const result = await adminUnverifiedAccountPurgeRunCapability.handler({}, ctx)

	expect(result).toEqual({
		dryRun: false,
		scanned: 1,
		purged: 0,
		failed: 1,
		timeBudgetExhausted: false,
		outcomes: [
			{
				stableUserId: failing.stableUserId,
				ageDays: 10,
				outcome: 'failed',
				error: expect.stringMatching(
					/^AccountDeletionInventoryError: Failed to enumerate .+simulated inventory outage$/,
				),
				warnings: [
					expect.stringMatching(
						/^Failed to enumerate .+simulated inventory outage$/,
					),
				],
			},
		],
	})
	expect(JSON.stringify(result)).not.toMatch(/@example\.com|failing/)
	expect(userRow(sqlite, 'failing')).toEqual({ deleting_at: null })
	expect(consoleWarn).toHaveBeenCalledWith(
		'unverified_account_purge_failed',
		expect.objectContaining({ userId: failing.stableUserId }),
	)
	expect(auditEventSummaries()).toEqual([
		'unverified_account_purge_failed:failure',
		'adminUnverifiedAccountPurgeRun:success',
	])
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			category: 'account',
			action: 'unverified_account_purge_failed',
			result: 'failure',
			email: failing.email,
			reason: result.outcomes[0]?.error,
		}),
	)
	expect(logAuditEventSpy).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'adminUnverifiedAccountPurgeRun',
			reason: 'dry_run=false;scanned=1;purged=0;failed=1',
		}),
	)
})

test('adminUnverifiedAccountPurgeRun purges eligible accounts and reports them by stable id', async () => {
	const { sqlite, db } = createAppDb()
	const stale = seedUnverifiedUser(sqlite, {
		username: 'stale',
		email: 'stale@example.com',
		createdAt: daysAgo(8),
	})
	seedUnverifiedUser(sqlite, {
		username: 'young',
		email: 'young@example.com',
		createdAt: daysAgo(1),
	})
	const ctx = createContext(['admin'], createSuccessfulDeletionEnv(db) as Env)

	const result = await adminUnverifiedAccountPurgeRunCapability.handler(
		{ batchSize: 5 },
		ctx,
	)

	expect(result).toEqual({
		dryRun: false,
		scanned: 1,
		purged: 1,
		failed: 0,
		timeBudgetExhausted: false,
		outcomes: [
			{ stableUserId: stale.stableUserId, ageDays: 8, outcome: 'purged' },
		],
	})
	expect(userRow(sqlite, 'stale')).toBeUndefined()
	expect(userRow(sqlite, 'young')).toEqual({ deleting_at: null })
	expect(auditEventSummaries()).toEqual([
		'unverified_account_purged:success',
		'adminUnverifiedAccountPurgeRun:success',
	])
})
