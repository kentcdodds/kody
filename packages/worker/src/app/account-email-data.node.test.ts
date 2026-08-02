import { expect, test, vi } from 'vitest'
import type * as EntitlementPlans from '#worker/entitlements/plans.ts'
import type * as EntitlementService from '#worker/entitlements/service.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { mailboxReadCutoverFlagKey } from '#worker/email/mailbox-read-cutover.ts'

const messageRecord = {
	id: 'msg-1',
	direction: 'inbound' as const,
	userId: 'stable-user-1',
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

const { recordFeatureFlagExposuresMock } = vi.hoisted(() => ({
	recordFeatureFlagExposuresMock: vi.fn(async () => {}),
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
		readEntitlementResourceUsage: vi.fn(async () => 0),
		readDailyEntitlementResourceUsage: vi.fn(async () => 0),
	}
})

vi.mock('#worker/entitlements/plans.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementPlans>()
	return {
		...actual,
		resolveEmailResourceLimit: vi.fn(() => 100),
	}
})

vi.mock('#worker/email/platform-address.ts', () => ({
	getPlatformEmailDomain: vi.fn(() => null),
	buildPlatformEmailAddress: vi.fn(() => null),
}))

vi.mock('#worker/email/repo.ts', () => ({
	listEmailInboxesForUser: vi.fn(async () => []),
	listEmailInboxAddressesForUser: vi.fn(async () => []),
	listEmailMessagesPageForUser: vi.fn(async () => ({
		total: 1,
		messages: [messageRecord],
	})),
	getEmailMessageById: vi.fn(async () => messageRecord),
	listEmailAttachmentsForUserMessage: vi.fn(async () => []),
	listEmailDeliveryEvents: vi.fn(async () => []),
}))

vi.mock('#worker/feature-flags/exposure.ts', () => ({
	recordFeatureFlagExposures: (...args: Array<unknown>) =>
		recordFeatureFlagExposuresMock(...args),
}))

const { loadAccountEmailData } = await import('./account-email-data.ts')

const authenticatedUser = {
	sessionUserId: '42',
	userId: 42,
	username: 'test-user',
	email: 'user@example.com',
	emailVerified: true,
	displayName: 'user',
	roles: ['user'] as const,
	permissions: [] as const,
	artifactOwnerIds: [],
	mcpUser: {
		userId: 'stable-user-1',
		email: 'user@example.com',
		username: 'test-user',
		displayName: 'user',
	},
}

function createEnv() {
	const meter = createInMemoryUserMeterEnv()
	return {
		APP_DB: createCutoverDb(true),
		APP_BASE_URL: 'https://example.com',
		COOKIE_SECRET: 'secret',
		...meter.env,
	} as Env
}

function createCutoverDb(enabled: boolean) {
	return {
		prepare(query: string) {
			const normalized = query.replace(/\s+/g, ' ').trim().toLowerCase()
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (
								normalized.includes('from feature_flag_user_overrides') &&
								normalized.includes('where flag_key = ? and user_id = ?')
							) {
								expect(params[0]).toBe(mailboxReadCutoverFlagKey)
								return { enabled: enabled ? 1 : 0 } as T
							}
							if (
								normalized.includes('from feature_flags') &&
								normalized.includes('where key = ?')
							) {
								return null
							}
							if (
								normalized.includes('from users') &&
								normalized.includes('mailbox_parity_matching_since')
							) {
								return null
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

test('loadAccountEmailData skips cutover exposure when SSR requests it', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-07-31T15:00:00.000Z'))
	recordFeatureFlagExposuresMock.mockClear()

	await loadAccountEmailData({
		env: createEnv(),
		request: new Request('https://example.com/account/email?selected=msg-1'),
		user: authenticatedUser,
		skipCutoverExposureRecording: true,
	})

	expect(recordFeatureFlagExposuresMock).not.toHaveBeenCalled()
	vi.useRealTimers()
})

test('loadAccountEmailData records cutover exposure once for JSON API loads', async () => {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date('2026-07-31T15:00:00.000Z'))
	recordFeatureFlagExposuresMock.mockClear()

	await loadAccountEmailData({
		env: createEnv(),
		request: new Request(
			'https://example.com/account/email.json?selected=msg-1',
		),
		user: authenticatedUser,
	})

	expect(recordFeatureFlagExposuresMock).toHaveBeenCalledTimes(1)
	expect(recordFeatureFlagExposuresMock).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			stableUserId: 'stable-user-1',
			evaluations: expect.objectContaining({
				[mailboxReadCutoverFlagKey]: expect.any(Object),
			}),
		}),
	)
	vi.useRealTimers()
})
