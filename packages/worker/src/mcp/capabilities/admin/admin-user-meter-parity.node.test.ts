import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'

const mockModule = vi.hoisted(() => ({
	logAuditEvent: vi.fn(async () => undefined),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Array<unknown>) =>
			mockModule.logAuditEvent(...args),
	}
})

const { adminUserMeterParityCapability } =
	await import('./admin-user-meter-parity.ts')

const stableUserId = testStableUserIdFromEmail('parity-cap@example.com')

function createCapabilityTestDb() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE NOT NULL,
			username TEXT NOT NULL,
			email TEXT NOT NULL,
			deleting_at TEXT,
			created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
			updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
		);
		INSERT INTO users (stable_user_id, username, email)
		VALUES ('${stableUserId}', 'parity-cap', 'parity-cap@example.com');
	`)
	return createD1FromSqlite(sqlite)
}

test('admin_user_meter_parity returns null for missing users and omits lease secrets', async () => {
	const db = createCapabilityTestDb()
	const meter = createInMemoryUserMeterEnv()
	const meterStub = userMeterRpc({ env: meter.env, userId: stableUserId })
	// Seed one active authoritative write lease.
	await meterStub.acquireWriteLease({
		token: 'active-lease-xyz789',
		holder: 'some-holder-value',
		acquiredAt: '2026-08-01T09:00:00.000Z',
	})
	const ctx = {
		env: { APP_DB: db, ...meter.env } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: testStableUserIdFromEmail('admin@example.com'),
				email: 'admin@example.com',
				displayName: 'Admin',
				roles: ['admin'],
			},
		}),
	}

	const missing = await adminUserMeterParityCapability.handler(
		{
			stable_user_id: testStableUserIdFromEmail('missing@example.com'),
		},
		ctx,
	)
	expect(missing).toEqual({ report: null })
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_user_meter_parity',
			result: 'success',
			reason: `target_stable_user_id=${testStableUserIdFromEmail('missing@example.com')}`,
		}),
	)

	const present = await adminUserMeterParityCapability.handler(
		{ stable_user_id: stableUserId },
		ctx,
	)
	expect(present.report?.stableUserId).toBe(stableUserId)
	expect(
		present.report?.daily.resources.every((row) => row.needsBootstrap),
	).toBe(true)
	expect(present.report?.deletion.deletingAtParity).toBe(true)
	expect(present.report?.deletion.activeLeaseCount).toBe(1)
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_user_meter_parity',
			result: 'success',
			reason: `target_stable_user_id=${stableUserId}`,
		}),
	)
	const serialized = JSON.stringify(present)
	expect(serialized).not.toContain('active-lease-xyz789')
	expect(serialized).not.toContain('some-holder-value')
	expect(serialized).not.toContain('"token"')
	expect(serialized).not.toContain('"holder"')
})
