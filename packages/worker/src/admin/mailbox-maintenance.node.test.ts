import { expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
	mailboxRpc: vi.fn(),
	deleteOutboundProviderIndexByMessageId: vi.fn(),
	isOutboundProviderIndexForeignKeyDetached: vi.fn(async () => true),
	loadOutboundProviderIndexHealthReport: vi.fn(async () => ({
		indexCount: 2,
		distinctOwnerCount: 2,
		malformedCount: 0,
		healthy: true,
	})),
	loadUserEmailGraphAuthorityMarker: vi.fn(async () => ({
		ownerCount: 2,
		frozenAt: '2026-08-01T00:00:00.000Z',
		maxParityAgeHours: 6,
	})),
	assertUserEmailGraphAuthority: vi.fn(async () => undefined),
	loadProviderIndexRepairHealth: vi.fn(async () => ({
		pendingOwners: 0,
		pendingCount: 0,
		oldestPendingAt: null,
	})),
	loadInboundDueOwnersHealth: vi.fn(async () => ({
		pendingOwners: 0,
		dueOwners: 0,
		oldestDueAt: null,
	})),
	loadDeliveryAlertEventsHealth: vi.fn(async () => ({
		retainedEvents: 0,
		lastHourEvents: 0,
		oldestEventAt: null,
	})),
	loadSystemEmailGraphParityReport: vi.fn(async () => ({
		threads: {},
		messages: {},
		attachments: {},
		deliveryEvents: {},
		outboundProviderIndex: {},
		parity: true,
	})),
}))

vi.mock('#worker/email/mailbox-client.ts', () => ({
	mailboxRpc: mocks.mailboxRpc,
}))

vi.mock('#worker/email/outbound-provider-index.ts', () => ({
	deleteOutboundProviderIndexByMessageId:
		mocks.deleteOutboundProviderIndexByMessageId,
	isOutboundProviderIndexForeignKeyDetached:
		mocks.isOutboundProviderIndexForeignKeyDetached,
	loadOutboundProviderIndexHealthReport:
		mocks.loadOutboundProviderIndexHealthReport,
}))

vi.mock('#worker/email/system-email-graph-repo.ts', () => ({
	loadSystemEmailGraphParityReport: mocks.loadSystemEmailGraphParityReport,
	reconcileLegacySystemEmailGraphFromDedicated: vi.fn(),
}))

vi.mock('#worker/email/user-email-graph-authority.ts', () => ({
	assertUserEmailGraphAuthority: mocks.assertUserEmailGraphAuthority,
	loadUserEmailGraphAuthorityMarker: mocks.loadUserEmailGraphAuthorityMarker,
}))

vi.mock('#worker/email/provider-index-repair-health.ts', () => ({
	loadProviderIndexRepairHealth: mocks.loadProviderIndexRepairHealth,
}))

vi.mock('#worker/email/inbound-due-owners.ts', () => ({
	loadInboundDueOwnersHealth: mocks.loadInboundDueOwnersHealth,
}))

vi.mock('#worker/email/delivery-alert-events.ts', () => ({
	loadDeliveryAlertEventsHealth: mocks.loadDeliveryAlertEventsHealth,
}))

const {
	loadAdminMailboxMaintenanceStatus,
	runAdminMailboxMaintenanceDeleteMessage,
	runAdminMailboxMaintenanceRetention,
} = await import('./mailbox-maintenance.ts')

function createUsersDb(userIds: ReadonlyArray<string>) {
	const prepare = vi.fn((sql: string) => ({
		bind: (...params: Array<unknown>) => ({
			async first() {
				if (sql.includes('COUNT(*) AS trackedOwners')) {
					return { trackedOwners: userIds.length }
				}
				throw new Error(`Unexpected first query: ${sql}`)
			},
			async all() {
				if (!sql.includes('FROM users u')) {
					throw new Error(`Unexpected all query: ${sql}`)
				}
				const startAfter =
					params.length === 3 && typeof params[1] === 'string'
						? params[1]
						: null
				const limit = Number(params.at(-1))
				return {
					results: userIds
						.filter((userId) => startAfter == null || userId > startAfter)
						.slice(0, limit)
						.map((userId) => ({ userId })),
				}
			},
		}),
	}))
	return { prepare } as unknown as D1Database
}

test('maintenance status reports authority and coordination health', async () => {
	const db = createUsersDb(['user-1', 'user-2'])
	const status = await loadAdminMailboxMaintenanceStatus({
		db,
		now: new Date('2026-08-03T00:00:00.000Z'),
	})

	expect(status).toMatchObject({
		authority: {
			ownerCount: 2,
			frozenAt: '2026-08-01T00:00:00.000Z',
			maxParityAgeHours: 6,
		},
		outboundProviderIndex: {
			indexCount: 2,
			distinctOwnerCount: 2,
			malformedCount: 0,
			foreignKeyDetached: true,
			healthy: true,
		},
		providerIndexRepair: { pendingOwners: 0, pendingCount: 0 },
		inboundDueOwners: { pendingOwners: 0, dueOwners: 0 },
		deliveryAlerts: { retainedEvents: 0, lastHourEvents: 0 },
		systemEmailGraph: { parity: true },
	})
})

test('maintenance retention fans out only to owner Mailbox RPCs', async () => {
	const db = createUsersDb(['user-1', 'user-2'])
	const runRetentionNow = vi.fn(async () => ({
		before: { threads: 2, messages: 3, attachments: 1, deliveryEvents: 4 },
		after: { threads: 1, messages: 2, attachments: 0, deliveryEvents: 3 },
		blobDeleteFailures: false,
		expiredRemaining: false,
	}))
	mocks.mailboxRpc.mockReturnValue({ runRetentionNow })
	const env = {
		APP_DB: db,
		EMAIL_BLOBS: {},
	} as unknown as Parameters<
		typeof runAdminMailboxMaintenanceRetention
	>[0]['env']

	const result = await runAdminMailboxMaintenanceRetention({
		env,
		limit: 2,
		now: new Date('2026-08-03T00:00:00.000Z'),
	})

	expect(runRetentionNow).toHaveBeenCalledTimes(2)
	expect(result.metrics.mailbox).toMatchObject({
		ownersAttempted: 2,
		ownersSucceeded: 2,
		ownersFailed: 0,
		before: { threads: 4, messages: 6, attachments: 2, deliveryEvents: 8 },
		after: { threads: 2, messages: 4, attachments: 0, deliveryEvents: 6 },
	})
})

test('maintenance USER delete removes Mailbox/R2 data and only the thin provider index', async () => {
	const db = createUsersDb([])
	const deleteMessageWithBlobs = vi.fn(async () => ({
		status: 'deleted' as const,
		attachmentsSeen: 1,
		externalAttachmentsSeen: 1,
		blobReferences: [
			{
				kind: 'raw_mime' as const,
				key: 'email/raw/user-1/message-1.eml',
				messageId: 'message-1',
				attachmentId: null,
			},
			{
				kind: 'attachment' as const,
				key: 'email/attachments/user-1/message-1/attachment-1',
				messageId: 'message-1',
				attachmentId: 'attachment-1',
			},
		],
	}))
	mocks.mailboxRpc.mockReturnValue({ deleteMessageWithBlobs })
	mocks.deleteOutboundProviderIndexByMessageId.mockResolvedValueOnce(1)
	const head = vi.fn(async () => null)
	const env = {
		APP_DB: db,
		EMAIL_BLOBS: { head },
	} as unknown as Parameters<
		typeof runAdminMailboxMaintenanceDeleteMessage
	>[0]['env']

	const result = await runAdminMailboxMaintenanceDeleteMessage({
		env,
		stableUserId: 'user-1',
		messageId: 'message-1',
	})

	expect(deleteMessageWithBlobs).toHaveBeenCalledWith({
		ownerId: 'user-1',
		messageId: 'message-1',
	})
	expect(mocks.deleteOutboundProviderIndexByMessageId).toHaveBeenCalledWith({
		db,
		messageId: 'message-1',
	})
	expect(result).toEqual({
		authoritativeMessageAbsent: true,
		attachmentsSeen: 1,
		externalAttachmentsSeen: 1,
		rawMimeBlobAbsent: true,
		externalAttachmentBlobsAbsent: 1,
		allCapturedBlobsAbsent: true,
	})
})
