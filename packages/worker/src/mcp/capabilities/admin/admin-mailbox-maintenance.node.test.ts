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
	runAdminMailboxMaintenanceReconcile: vi.fn(),
	runAdminMailboxMaintenanceSystemEmailGraphReconcile: vi.fn(),
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
		runAdminMailboxMaintenanceReconcile:
			mockModule.runAdminMailboxMaintenanceReconcile,
		runAdminMailboxMaintenanceSystemEmailGraphReconcile:
			mockModule.runAdminMailboxMaintenanceSystemEmailGraphReconcile,
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
	outboundProviderIndex: {
		linkedMessageCount: 0,
		indexCount: 0,
		missingFromIndexCount: 0,
		missingFromMessagesCount: 0,
		mismatchedCount: 0,
		parity: true,
	},
	systemEmailGraph: {
		threads: {
			legacyCount: 0,
			dedicatedCount: 0,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		messages: {
			legacyCount: 0,
			dedicatedCount: 0,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		attachments: {
			legacyCount: 0,
			dedicatedCount: 0,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		deliveryEvents: {
			legacyCount: 0,
			dedicatedCount: 0,
			missingFromDedicatedCount: 0,
			missingFromLegacyCount: 0,
			ownershipMismatchCount: 0,
			referencedOwnerMismatchCount: 0,
			relationshipMismatchCount: 0,
			keyFieldMismatchCount: 0,
			parity: true,
		},
		outboundProviderIndex: {
			legacyProviderLinkedMessageCount: 0,
			dedicatedProviderLinkedMessageCount: 0,
			legacyAuthorityIndexCount: 0,
			missingFromLegacyAuthorityIndexCount: 0,
			missingFromLegacyMessagesCount: 0,
			mismatchedLegacyAuthorityIndexCount: 0,
			classification: 'no-system-provider-links',
			authorityDisposition: 'legacy-email-messages-until-4b-routing',
			parity: true,
		},
		parity: true,
	},
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

const emptySystemEmailGraphReconcileResult = {
	metrics: {
		upserted: {
			threads: 0,
			messages: 0,
			attachments: 0,
			deliveryEvents: 0,
		},
		deleted: {
			threads: 0,
			messages: 0,
			attachments: 0,
			deliveryEvents: 0,
		},
		referencedOwnerMismatchCount: 0,
	},
	postReport: emptyStatus.systemEmailGraph,
}

const emptyDeleteResult = {
	d1MessageAbsent: true,
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

test('admin_mailbox_maintenance routes status, reconcile, retention, and delete with audits', async () => {
	mockModule.loadAdminMailboxMaintenanceStatus.mockResolvedValue(emptyStatus)
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
	mockModule.runAdminMailboxMaintenanceSystemEmailGraphReconcile.mockResolvedValue(
		emptySystemEmailGraphReconcileResult,
	)
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
	expect(status).toEqual({ action: 'status', status: emptyStatus })
	expect(status.status.systemEmailGraph).toEqual(emptyStatus.systemEmailGraph)
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_mailbox_maintenance',
			result: 'success',
		}),
	)

	const reconcile = await adminMailboxMaintenanceCapability.handler(
		{ action: 'reconcile', batch_size: 16 },
		ctx,
	)
	expect(reconcile.action).toBe('reconcile')
	expect(mockModule.runAdminMailboxMaintenanceReconcile).toHaveBeenCalledWith({
		env: ctx.env,
		batchSize: 16,
	})

	const systemGraphReconcile = await adminMailboxMaintenanceCapability.handler(
		{ action: 'system_email_graph_reconcile', force: true },
		ctx,
	)
	expect(systemGraphReconcile).toEqual({
		action: 'system_email_graph_reconcile',
		...emptySystemEmailGraphReconcileResult,
	})
	expect(
		mockModule.runAdminMailboxMaintenanceSystemEmailGraphReconcile,
	).toHaveBeenCalledWith({ db: ctx.env.APP_DB })
	expect(mockModule.logAuditEvent).toHaveBeenCalledWith(
		expect.objectContaining({
			action: 'admin_mailbox_maintenance',
			result: 'success',
			reason: expect.stringContaining('action=system_email_graph_reconcile'),
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
			{ action: 'system_email_graph_reconcile' },
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
