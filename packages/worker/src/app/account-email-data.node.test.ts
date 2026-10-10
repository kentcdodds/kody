import {
	ownerIdFromStored,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { type AuthenticatedAppUser } from '#app/authenticated-user.ts'
import type * as EntitlementPlans from '#universal/plans.ts'
import type * as EntitlementService from '#worker/entitlements/service.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { sessionRequestContext } from '#worker/test-support/request-context.ts'

const messageRecord = {
	id: 'msg-1',
	direction: 'inbound' as const,
	userId: ownerIdFromStored('stable-user-1'),
	inboxId: 'inbox-1',
	threadId: null,
	senderIdentityId: null,
	fromAddress: 'sender@example.com',
	envelopeFrom: 'sender@example.com',
	toAddresses: ['user@inbox.example.com'],
	ccAddresses: [],
	bccAddresses: [],
	replyToAddresses: [],
	subject: 'Hello from sender',
	messageIdHeader: '<msg-1@example.com>',
	inReplyToHeader: null,
	references: [],
	headers: { subject: ['Hello from sender'] },
	authResults: null,
	textBody: 'Plain text body',
	htmlBody: '<p>HTML body</p>',
	rawMimeKey: null,
	rawSize: 128,
	processingStatus: 'stored' as const,
	classification: 'accepted' as const,
	classificationReason: null,
	providerMessageId: null,
	deliveryStatus: null,
	deliveryStatusAt: null,
	error: null,
	receivedAt: new Date(0).toISOString(),
	sentAt: null,
	createdAt: new Date(0).toISOString(),
	updatedAt: new Date(0).toISOString(),
}

const mocks = vi.hoisted(() => ({
	listOwnerEmailMessagesPage: vi.fn(),
	getOwnerEmailMessageById: vi.fn(),
	listOwnerEmailAttachmentsForMessage: vi.fn(),
	listOwnerEmailDeliveryEvents: vi.fn(),
}))

vi.mock('#app/email-verification.ts', () => ({
	emailVerificationRequiredMessage: 'verify',
	isAccountEmailVerified: vi.fn(async () => true),
}))

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementService>()
	return {
		...actual,
		getUserPlan: vi.fn(async () => 'free' as const),
		getUserEntitlement: vi.fn(async () => ({
			plan: 'free' as const,
			ladder: 'public' as const,
		})),
		readCurrentEntitlementResourceUsage: vi.fn(async () => 1),
		readDailyEntitlementResourceUsage: vi.fn(async () => 0),
	}
})

vi.mock('#universal/plans.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementPlans>()
	return {
		...actual,
		resolvePlanLimit: vi.fn(() => 100),
	}
})

vi.mock('#worker/email/platform-address.ts', () => ({
	getPlatformEmailDomain: vi.fn(() => null),
	buildPlatformEmailAddress: vi.fn(() => null),
}))

vi.mock('#worker/email/repo.ts', () => ({
	listEmailInboxesForUser: vi.fn(async () => []),
	listEmailInboxAddressesForUser: vi.fn(async () => []),
}))

vi.mock('#worker/email/owner-email-reader.ts', () => ({
	listOwnerEmailMessagesPage: mocks.listOwnerEmailMessagesPage,
	getOwnerEmailMessageById: mocks.getOwnerEmailMessageById,
	listOwnerEmailAttachmentsForMessage:
		mocks.listOwnerEmailAttachmentsForMessage,
	listOwnerEmailDeliveryEvents: mocks.listOwnerEmailDeliveryEvents,
}))

const { loadAccountEmailData } = await import('./account-email-data.ts')

const authenticatedUser: AuthenticatedAppUser = {
	sessionUserId: '42',
	userId: 42,
	username: 'test-user',
	email: 'user@example.com',
	emailVerified: true,
	emailVerificationDelivery: null,
	displayName: 'user',
	roles: ['user'],
	permissions: [],
	artifactOwnerIds: [],
	mcpUser: {
		userId: personIdFromStored('stable-user-1'),
		email: 'user@example.com',
		username: 'test-user',
		displayName: 'user',
	},
	request: sessionRequestContext('stable-user-1'),
}

test('loadAccountEmailData reads USER message graph only through owner Mailbox readers', async () => {
	mocks.listOwnerEmailMessagesPage.mockResolvedValueOnce({
		total: 1,
		messages: [messageRecord],
	})
	mocks.getOwnerEmailMessageById.mockResolvedValueOnce(messageRecord)
	mocks.listOwnerEmailAttachmentsForMessage.mockResolvedValueOnce([])
	mocks.listOwnerEmailDeliveryEvents.mockResolvedValueOnce([])
	const prepare = vi.fn()
	const meter = createInMemoryUserMeterEnv()
	const env = {
		APP_DB: { prepare } as unknown as D1Database,
		APP_BASE_URL: 'https://example.com',
		COOKIE_SECRET: 'secret',
		...meter.env,
	} as Env

	const result = await loadAccountEmailData({
		env,
		request: new Request(
			'https://example.com/account/email.json?selected=msg-1',
		),
		user: authenticatedUser,
	})

	expect(result.messages).toEqual([
		expect.objectContaining({
			id: 'msg-1',
			subject: 'Hello from sender',
			classification: 'accepted',
		}),
	])
	expect(result.selectedMessage?.id).toBe('msg-1')
	expect(mocks.listOwnerEmailMessagesPage).toHaveBeenCalledWith(
		expect.objectContaining({
			env,
			ownerId: ownerIdFromStored('stable-user-1'),
		}),
	)
	expect(mocks.getOwnerEmailMessageById).toHaveBeenCalledWith({
		env,
		ownerId: ownerIdFromStored('stable-user-1'),
		messageId: 'msg-1',
	})
	expect(prepare).not.toHaveBeenCalled()
})
