import { DatabaseSync } from 'node:sqlite'
import { expect, test, vi } from 'vitest'
import type * as AuditLog from '#worker/audit-log.ts'
import { createD1FromSqlite } from '#worker/test-support/create-d1-from-sqlite.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { testStableUserIdFromEmail } from '#worker/test-support/stable-user-id.ts'
import type * as MailboxMaintenance from '#worker/admin/mailbox-maintenance.ts'
import {
	AdminMailboxMessageNotFoundError,
	adminMailboxMaintenanceRetentionMaxLimit,
} from '#worker/admin/mailbox-maintenance.ts'
import { McpCallerError } from '#mcp/caller-error.ts'

const mockModule = vi.hoisted(() => ({
	logAuditEvent: vi.fn(async () => undefined),
	loadAdminMailboxMaintenanceStatus: vi.fn(),
	runAdminMailboxMaintenanceRetention: vi.fn(),
	runAdminMailboxMaintenanceDeleteMessage: vi.fn(),
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
		runAdminMailboxMaintenanceRetention:
			mockModule.runAdminMailboxMaintenanceRetention,
		runAdminMailboxMaintenanceDeleteMessage:
			mockModule.runAdminMailboxMaintenanceDeleteMessage,
	}
})

const { adminMailboxMaintenanceCapability } =
	await import('./admin-mailbox-maintenance.ts')

const emptyStatus = {
	generatedAt: '2026-08-01T12:00:00.000Z',
	authority: {
		ownerCount: 2,
		frozenAt: '2026-08-01T00:00:00.000Z',
		droppedAt: '2026-08-03T00:00:00.000Z',
	},
	outboundProviderIndex: {
		indexCount: 0,
		distinctOwnerCount: 0,
		malformedCount: 0,
		healthy: true,
	},
	providerIndexRepair: {
		pendingOwners: 0,
		pendingCount: 0,
		oldestPendingAt: null,
	},
	inboundDueOwners: {
		pendingOwners: 0,
		dueOwners: 0,
		oldestDueAt: null,
	},
	deliveryAlerts: {
		retainedEvents: 0,
		lastHourEvents: 0,
		oldestEventAt: null,
	},
	systemEmail: {
		authority: {
			authority: 'dedicated' as const,
			cutoverAt: '2026-08-01T00:00:00.000Z',
		},
		counts: { threads: 0, messages: 0, attachments: 0, deliveryEvents: 0 },
		invalidReferenceCount: 0,
		providerLinkCount: 0,
		healthy: true,
	},
}

const emptyRetentionResult = {
	metrics: {
		mailbox: {
			ownersAttempted: 1,
			ownersSucceeded: 1,
			ownersFailed: 0,
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

const emptyDeleteResult = {
	authoritativeMessageAbsent: true,
	attachmentsSeen: 2,
	externalAttachmentsSeen: 1,
	rawMimeBlobAbsent: true,
	externalAttachmentBlobsAbsent: 1,
	allCapturedBlobsAbsent: true,
}

function createAdminCtx() {
	const appSqlite = new DatabaseSync(':memory:')
	appSqlite.exec(`
		CREATE TABLE users (
			id INTEGER PRIMARY KEY,
			stable_user_id TEXT UNIQUE NOT NULL,
			username TEXT NOT NULL,
			email TEXT NOT NULL
		);
	`)
	const auditSqlite = new DatabaseSync(':memory:')
	auditSqlite.exec(`
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
	return {
		env: {
			APP_DB: createD1FromSqlite(appSqlite),
			AUDIT_DB: createD1FromSqlite(auditSqlite),
		} as Env,
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

test('admin_mailbox_maintenance routes final status, retention, and delete with audits', async () => {
	mockModule.loadAdminMailboxMaintenanceStatus.mockResolvedValue(emptyStatus)
	mockModule.runAdminMailboxMaintenanceRetention.mockResolvedValue(
		emptyRetentionResult,
	)
	mockModule.runAdminMailboxMaintenanceDeleteMessage.mockResolvedValue(
		emptyDeleteResult,
	)
	const ctx = createAdminCtx()
	const stableUserId = testStableUserIdFromEmail('target@example.com')
	const messageId = 'canary-message-1'

	const status = await adminMailboxMaintenanceCapability.handler(
		{ action: 'status' },
		ctx,
	)
	expect(status).toMatchObject({ action: 'status', status: emptyStatus })
	expect(status.status.systemEmail).toEqual(emptyStatus.systemEmail)
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_mailbox_maintenance',
			result: 'success',
		}),
	)

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

	const deleted = await adminMailboxMaintenanceCapability.handler(
		{
			action: 'delete_message',
			stable_user_id: stableUserId,
			message_id: messageId,
		},
		ctx,
	)
	expect(deleted).toEqual({
		action: 'delete_message',
		result: emptyDeleteResult,
	})
	expect(
		mockModule.runAdminMailboxMaintenanceDeleteMessage,
	).toHaveBeenCalledWith({
		env: ctx.env,
		stableUserId,
		messageId,
	})
	expect(JSON.stringify(deleted)).not.toMatch(
		/@example|secret body|email-raw:|email-attachment:/,
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
				action: 'delete_message',
				stable_user_id: 'not-a-stable-id',
				message_id: messageId,
			},
			ctx,
		),
	).rejects.toThrow()

	const notFound = new AdminMailboxMessageNotFoundError({
		stableUserId,
		messageId: 'already-gone',
	})
	mockModule.runAdminMailboxMaintenanceDeleteMessage.mockRejectedValueOnce(
		notFound,
	)
	await expect(
		adminMailboxMaintenanceCapability.handler(
			{
				action: 'delete_message',
				stable_user_id: stableUserId,
				message_id: 'already-gone',
			},
			ctx,
		),
	).rejects.toSatisfy(
		(error: unknown) =>
			error instanceof McpCallerError &&
			error.message === notFound.message &&
			error.cause === notFound,
	)
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_mailbox_maintenance',
			result: 'failure',
			reason: notFound.message,
		}),
	)
})
