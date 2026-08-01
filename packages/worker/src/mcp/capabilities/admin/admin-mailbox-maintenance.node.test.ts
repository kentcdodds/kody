import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import type * as MailboxMaintenance from '#worker/admin/mailbox-maintenance.ts'
import { adminMailboxMaintenanceRetentionMaxLimit } from '#worker/admin/mailbox-maintenance.ts'

const mockModule = vi.hoisted(() => ({
	logAuditEvent: vi.fn(async () => undefined),
	loadAdminMailboxMaintenanceStatus: vi.fn(),
	runAdminMailboxMaintenanceReconcile: vi.fn(),
	runAdminMailboxMaintenanceRetention: vi.fn(),
}))

vi.mock('#worker/audit-log.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof AuditLog>()
	return {
		...actual,
		logAuditEvent: (...args: Array<unknown>) =>
			mockModule.logAuditEvent(...args),
	}
})

vi.mock('#worker/admin/mailbox-maintenance.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof MailboxMaintenance>()
	return {
		...actual,
		loadAdminMailboxMaintenanceStatus:
			mockModule.loadAdminMailboxMaintenanceStatus,
		runAdminMailboxMaintenanceReconcile:
			mockModule.runAdminMailboxMaintenanceReconcile,
		runAdminMailboxMaintenanceRetention:
			mockModule.runAdminMailboxMaintenanceRetention,
	}
})

const { adminDomain } = await import('./domain.ts')
const { adminMailboxMaintenanceCapability } =
	await import('./admin-mailbox-maintenance.ts')

const emptyStatus = {
	generatedAt: '2026-08-01T12:00:00.000Z',
	trackedOwners: 2,
	matching: 1,
	mismatch: 0,
	error: 0,
	incomplete: 1,
	eligible: 0,
	oldestMatchingSince: '2026-07-30T00:00:00.000Z',
	newestMatchingSince: '2026-07-30T00:00:00.000Z',
	oldestCheckedAt: '2026-07-31T00:00:00.000Z',
	newestCheckedAt: '2026-08-01T11:00:00.000Z',
	earliestCutoverAt: '2026-07-31T00:00:00.000Z',
}

const emptyRetentionResult = {
	metrics: {
		d1: {
			messagesDeleted: 1,
			attachmentsDeleted: 0,
			threadsDeleted: 0,
			deliveryEventsDeleted: 2,
			rawMimeBlobsDeleted: 1,
			attachmentBlobsDeleted: 0,
			blobDeleteErrors: 0,
		},
		mailbox: {
			ownersAttempted: 1,
			ownersSucceeded: 1,
			ownersFailed: 0,
			pendingD1Owners: 0,
			before: {
				threads: 1,
				messages: 1,
				attachments: 0,
				deliveryEvents: 1,
			},
			after: {
				threads: 0,
				messages: 0,
				attachments: 0,
				deliveryEvents: 0,
			},
			blobDeleteFailureOwners: 0,
			expiredRemainingOwners: 0,
		},
	},
	nextStartAfter: 'a'.repeat(64),
	truncated: true,
	status: emptyStatus,
}

function createAdminCtx() {
	const sqlite = new DatabaseSync(':memory:')
	sqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE NOT NULL,
			username TEXT NOT NULL,
			email TEXT NOT NULL
		);
		CREATE TABLE audit_events (
			id INTEGER PRIMARY KEY,
			category TEXT NOT NULL,
			action TEXT NOT NULL,
			result TEXT NOT NULL,
			email_hash TEXT,
			ip_hash TEXT,
			client_id TEXT,
			path TEXT,
			reason TEXT,
			timestamp TEXT NOT NULL
		);
	`)
	const db = createD1FromSqlite(sqlite)
	return {
		env: { APP_DB: db } as Env,
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
}

test('admin_mailbox_maintenance is registered admin-only destructive with keywords', () => {
	const capability = adminDomain.capabilities.find(
		(entry) => entry.name === 'admin_mailbox_maintenance',
	)
	expect(capability).toMatchObject({
		requiredRole: 'admin',
		readOnly: false,
		idempotent: false,
		destructive: true,
	})
	expect(adminDomain.keywords).toEqual(
		expect.arrayContaining(['mailbox', 'maintenance', 'retention']),
	)
	expect(adminMailboxMaintenanceCapability.name).toBe(
		'admin_mailbox_maintenance',
	)
})

test('admin_mailbox_maintenance status is audited and aggregate-only', async () => {
	mockModule.loadAdminMailboxMaintenanceStatus.mockResolvedValue(emptyStatus)
	const ctx = createAdminCtx()
	const result = await adminMailboxMaintenanceCapability.handler(
		{ action: 'status' },
		ctx,
	)
	expect(result).toEqual({ action: 'status', status: emptyStatus })
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_mailbox_maintenance',
			result: 'success',
			reason: 'action=status;tracked=2',
		}),
	)
})

test('admin_mailbox_maintenance reconcile and retention route with schema bounds', async () => {
	mockModule.runAdminMailboxMaintenanceReconcile.mockResolvedValue({
		metrics: {
			scanned: 1,
			backfilled: 0,
			compared: 1,
			matched: 1,
			mismatched: 0,
			failed: 0,
		},
		status: emptyStatus,
	})
	mockModule.runAdminMailboxMaintenanceRetention.mockResolvedValue(
		emptyRetentionResult,
	)
	const ctx = createAdminCtx()

	const reconcile = await adminMailboxMaintenanceCapability.handler(
		{ action: 'reconcile', batch_size: 16 },
		ctx,
	)
	expect(reconcile.action).toBe('reconcile')
	expect(mockModule.runAdminMailboxMaintenanceReconcile).toHaveBeenCalledWith({
		env: ctx.env,
		batchSize: 16,
	})

	const cursor = 'b'.repeat(64)
	const retention = await adminMailboxMaintenanceCapability.handler(
		{
			action: 'retention',
			limit: 8,
			start_after_user_id: cursor,
		},
		ctx,
	)
	expect(retention).toEqual({
		action: 'retention',
		...emptyRetentionResult,
	})
	expect(mockModule.runAdminMailboxMaintenanceRetention).toHaveBeenCalledWith({
		env: ctx.env,
		limit: 8,
		startAfterUserId: cursor,
	})
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_mailbox_maintenance',
			reason: 'action=retention;attempted=1;succeeded=1;truncated=1',
		}),
	)

	await expect(
		adminMailboxMaintenanceCapability.handler(
			{ action: 'reconcile', batch_size: 101 },
			ctx,
		),
	).rejects.toThrow()
	await expect(
		adminMailboxMaintenanceCapability.handler(
			{
				action: 'retention',
				limit: adminMailboxMaintenanceRetentionMaxLimit + 1,
			},
			ctx,
		),
	).rejects.toThrow()
	await expect(
		adminMailboxMaintenanceCapability.handler({ action: 'seed' }, ctx),
	).rejects.toThrow()
	await expect(
		adminMailboxMaintenanceCapability.handler(
			{
				action: 'retention',
				cutoff: '2000-01-01T00:00:00.000Z',
			},
			ctx,
		),
	).rejects.toThrow()
	await expect(
		adminMailboxMaintenanceCapability.handler(
			{
				action: 'retention',
				start_after_user_id: 'not-a-stable-id',
			},
			ctx,
		),
	).rejects.toThrow()
})
