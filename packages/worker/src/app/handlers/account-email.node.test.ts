import { expect, test, vi } from 'vitest'
import { utcDayKey } from '@kody-internal/shared/date-keys.ts'
import type * as EmailPlatformAddress from '#worker/email/platform-address.ts'
import type * as EntitlementPlans from '#worker/entitlements/plans.ts'
import type * as EntitlementService from '#worker/entitlements/service.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { userMeterRpc } from '#worker/entitlements/user-meter-client.ts'

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

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: vi.fn(async () => ({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		emailVerified: true,
		displayName: 'user',
		roles: ['user'],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	})),
	isAccountEmailVerified: vi.fn(async () => true),
	getUserPlan: vi.fn(async () => 'free' as const),
	readEntitlementResourceUsage: vi.fn(async () => 2),
	resolveEmailResourceLimit: vi.fn((_plan: string, resource: string) => {
		switch (resource) {
			case 'stored_email_messages':
				return 100
			case 'email_sends_per_day':
				return 20
			case 'email_receives_per_day':
				return 50
			case 'email_message_bytes':
				return 1_000_000
			default:
				return 0
		}
	}),
	getPlatformEmailDomain: vi.fn(() => 'inbox.example.com'),
	listEmailInboxesForUser: vi.fn(async () => [
		{
			id: 'inbox-1',
			userId: 'stable-user-1',
			packageId: null,
			name: 'default',
			description: '',
			enabled: true,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	]),
	listEmailInboxAddressesForUser: vi.fn(async () => [
		{
			id: 'addr-1',
			inboxId: 'inbox-1',
			userId: 'stable-user-1',
			address: 'test-user@inbox.example.com',
			localPart: 'test-user',
			domain: 'inbox.example.com',
			enabled: true,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	]),
	listOwnerEmailMessagesPage: vi.fn(async () => ({
		total: 1,
		messages: [messageRecord],
	})),
	getOwnerEmailMessageById: vi.fn(async () => messageRecord),
	listOwnerEmailAttachmentsForMessage: vi.fn(async () => [
		{
			id: 'att-1',
			messageId: 'msg-1',
			filename: 'note.txt',
			contentType: 'text/plain',
			contentId: null,
			disposition: 'attachment',
			size: 12,
			storageKind: 'inline',
			storageKey: null,
			createdAt: new Date(0).toISOString(),
		},
	]),
	listOwnerEmailDeliveryEvents: vi.fn(async () => [
		{
			id: 'evt-1',
			messageId: 'msg-1',
			userId: 'stable-user-1',
			inboxId: 'inbox-1',
			eventType: 'received' as const,
			provider: 'cloudflare',
			providerMessageId: null,
			providerEventId: null,
			detailJson: '{}',
			createdAt: new Date(0).toISOString(),
		},
	]),
	setEmailMessageClassification: vi.fn(async () => true),
	prepare: vi.fn(),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
	redirectToLoginWhenUnauthenticated: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async () => new Response('ok'),
}))

vi.mock('#app/email-verification.ts', () => ({
	emailVerificationRequiredMessage:
		'Account email is not verified. Open the verification link sent to your account email, or resend it from /pending-verification or /account.',
	isAccountEmailVerified: (...args: Array<unknown>) =>
		mockModule.isAccountEmailVerified(...args),
}))

vi.mock('#worker/entitlements/service.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementService>()
	return {
		...actual,
		getUserPlan: (...args: Array<unknown>) => mockModule.getUserPlan(...args),
		readEntitlementResourceUsage: (...args: Array<unknown>) =>
			mockModule.readEntitlementResourceUsage(...args),
	}
})

vi.mock('#worker/entitlements/plans.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EntitlementPlans>()
	return {
		...actual,
		resolveEmailResourceLimit: (...args: Array<unknown>) =>
			mockModule.resolveEmailResourceLimit(...(args as [string, string])),
	}
})

vi.mock('#worker/email/platform-address.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof EmailPlatformAddress>()
	return {
		...actual,
		getPlatformEmailDomain: (...args: Array<unknown>) =>
			mockModule.getPlatformEmailDomain(...args),
	}
})

vi.mock('#worker/email/repo.ts', () => ({
	listEmailInboxesForUser: (...args: Array<unknown>) =>
		mockModule.listEmailInboxesForUser(...args),
	listEmailInboxAddressesForUser: (...args: Array<unknown>) =>
		mockModule.listEmailInboxAddressesForUser(...args),
}))

vi.mock('#worker/email/mailbox-read-cutover.ts', () => ({
	listOwnerEmailMessagesPage: (...args: Array<unknown>) =>
		mockModule.listOwnerEmailMessagesPage(...args),
	getOwnerEmailMessageById: (...args: Array<unknown>) =>
		mockModule.getOwnerEmailMessageById(...args),
	listOwnerEmailAttachmentsForMessage: (...args: Array<unknown>) =>
		mockModule.listOwnerEmailAttachmentsForMessage(...args),
	listOwnerEmailDeliveryEvents: (...args: Array<unknown>) =>
		mockModule.listOwnerEmailDeliveryEvents(...args),
}))

vi.mock('#worker/email/service.ts', () => ({
	setEmailMessageClassification: (...args: Array<unknown>) =>
		mockModule.setEmailMessageClassification(...args),
}))

const { createAccountEmailApiHandler } = await import('./account-email.ts')

function createEnv(input?: {
	meter?: ReturnType<typeof createInMemoryUserMeterEnv>
	messages?: Array<typeof messageRecord>
	messageTotal?: number
}) {
	const meter = input?.meter ?? createInMemoryUserMeterEnv()
	const messages = input?.messages ?? [messageRecord]
	const messageTotal = input?.messageTotal ?? messages.length
	mockModule.listOwnerEmailMessagesPage.mockImplementation(async () => ({
		total: messageTotal,
		messages,
	}))
	return {
		APP_DB: {
			prepare: (...args: Array<unknown>) => mockModule.prepare(...args),
		} as unknown as D1Database,
		APP_BASE_URL: 'https://example.com',
		COOKIE_SECRET: 'secret',
		...meter.env,
	} as Env
}

function useFrozenUtcTime(iso: string) {
	vi.useFakeTimers({ toFake: ['Date'] })
	vi.setSystemTime(new Date(iso))
	return {
		[Symbol.dispose]() {
			vi.useRealTimers()
		},
	}
}

test('email API lists messages with pagination, usage, and selected detail', async () => {
	mockModule.listOwnerEmailMessagesPage.mockClear()
	mockModule.getOwnerEmailMessageById.mockClear()
	mockModule.listOwnerEmailDeliveryEvents.mockClear()
	using _frozenTime = useFrozenUtcTime('2026-07-31T15:00:00.000Z')
	const day = utcDayKey()
	const userId = 'stable-user-1'
	const bootstrapMeter = createInMemoryUserMeterEnv()
	const env = createEnv({
		meter: bootstrapMeter,
	})
	const meterStub = userMeterRpc({ env: bootstrapMeter.env, userId })
	await meterStub.initialize({
		resource: 'email_sends_per_day',
		day,
		count: 2,
		updatedAt: new Date().toISOString(),
	})
	await meterStub.initialize({
		resource: 'email_receives_per_day',
		day,
		count: 2,
		updatedAt: new Date().toISOString(),
	})
	const handler = createAccountEmailApiHandler(env)

	const listResponse = await handler.handler({
		request: new Request('https://example.com/account/email.json'),
	})
	expect(listResponse.status).toBe(200)
	expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(mockModule.getOwnerEmailMessageById).not.toHaveBeenCalled()
	await expect(listResponse.json()).resolves.toMatchObject({
		ok: true,
		emailVerified: true,
		email: 'user@example.com',
		username: 'test-user',
		inboxAddress: 'test-user@inbox.example.com',
		verificationMessage: null,
		inboxes: [
			expect.objectContaining({
				id: 'inbox-1',
				addresses: [
					expect.objectContaining({
						address: 'test-user@inbox.example.com',
					}),
				],
			}),
		],
		messages: [
			expect.objectContaining({
				id: 'msg-1',
				subject: 'Hello from sender',
				direction: 'inbound',
				from_address: 'sender@example.com',
				classification: 'accepted',
				classification_reason: null,
			}),
		],
		selectedMessage: null,
		usage: expect.objectContaining({
			plan: 'free',
			day,
			stored_messages: { count: 2, limit: 100 },
			sends_today: { count: 2, limit: 20 },
			receives_today: { count: 2, limit: 50 },
			max_message_bytes: 1_000_000,
		}),
		page: 1,
		pageSize: 25,
		total: 1,
		query: '',
		classification: null,
	})

	mockModule.getOwnerEmailMessageById.mockClear()
	const selectionMeter = createInMemoryUserMeterEnv()
	const envWithSelection = createEnv({
		meter: selectionMeter,
	})
	const selectionStub = userMeterRpc({
		env: selectionMeter.env,
		userId,
	})
	await selectionStub.initialize({
		resource: 'email_sends_per_day',
		day,
		count: 2,
		updatedAt: new Date().toISOString(),
	})
	await selectionStub.initialize({
		resource: 'email_receives_per_day',
		day,
		count: 2,
		updatedAt: new Date().toISOString(),
	})
	const selectedResponse = await createAccountEmailApiHandler(
		envWithSelection,
	).handler({
		request: new Request(
			'https://example.com/account/email.json?q=Hello&page=2&pageSize=10&selected=msg-1',
		),
	})
	expect(selectedResponse.status).toBe(200)
	expect(mockModule.getOwnerEmailMessageById).toHaveBeenCalledWith(
		expect.objectContaining({
			dbUserId: 42,
			stableUserId: 'stable-user-1',
			messageId: 'msg-1',
		}),
	)
	expect(mockModule.listOwnerEmailDeliveryEvents).toHaveBeenCalledWith(
		expect.objectContaining({
			stableUserId: 'stable-user-1',
			messageId: 'msg-1',
		}),
	)
	await expect(selectedResponse.json()).resolves.toMatchObject({
		ok: true,
		page: 2,
		pageSize: 10,
		query: 'Hello',
		classification: null,
		selectedMessage: expect.objectContaining({
			id: 'msg-1',
			text_body: 'Plain text body',
			html_body: '<p>HTML body</p>',
			classification: 'accepted',
			classification_reason: null,
			attachments: [
				expect.objectContaining({
					id: 'att-1',
					filename: 'note.txt',
				}),
			],
			delivery_events: [
				expect.objectContaining({
					id: 'evt-1',
					event_type: 'received',
				}),
			],
		}),
	})

	const putResponse = await handler.handler({
		request: new Request('https://example.com/account/email.json', {
			method: 'PUT',
		}),
	})
	expect(putResponse.status).toBe(405)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null as never)
	const unauthorizedResponse = await handler.handler({
		request: new Request('https://example.com/account/email.json'),
	})
	expect(unauthorizedResponse.status).toBe(401)
})

test('email API usage reads initialized UserMeter daily counts', async () => {
	using _frozenTime = useFrozenUtcTime('2026-07-31T15:00:00.000Z')
	const day = utcDayKey()
	const userId = 'stable-user-1'
	const meter = createInMemoryUserMeterEnv()
	await meter.seed({
		userId,
		resource: 'email_sends_per_day',
		day,
		count: 13,
	})
	await meter.seed({
		userId,
		resource: 'email_receives_per_day',
		day,
		count: 15,
	})
	const env = createEnv({
		meter,
	})
	const response = await createAccountEmailApiHandler(env).handler({
		request: new Request('https://example.com/account/email.json'),
	})
	expect(response.status).toBe(200)
	const body = await response.json()
	expect(body).toMatchObject({
		ok: true,
		usage: expect.objectContaining({
			day,
			stored_messages: { count: 2, limit: 100 },
			sends_today: { count: 13, limit: 20 },
			receives_today: { count: 15, limit: 50 },
		}),
	})
	expect(body.usage.sends_today.count).toBe(13)
	expect(body.usage.receives_today.count).not.toBe(5)
})

test('email API lists classification filters and classifies inbound messages', async () => {
	const quarantinedMessage = {
		...messageRecord,
		id: 'msg-quarantined',
		classification: 'quarantined' as const,
		classificationReason: 'DMARC failed.',
	}
	const meter = createInMemoryUserMeterEnv()
	const env = createEnv({
		meter,
		messages: [quarantinedMessage],
	})
	mockModule.getOwnerEmailMessageById.mockResolvedValueOnce(quarantinedMessage)

	const handler = createAccountEmailApiHandler(env)
	const listResponse = await handler.handler({
		request: new Request(
			'https://example.com/account/email.json?classification=quarantined&selected=msg-quarantined',
		),
	})
	expect(listResponse.status).toBe(200)
	await expect(listResponse.json()).resolves.toMatchObject({
		ok: true,
		classification: 'quarantined',
		messages: [
			expect.objectContaining({
				id: 'msg-quarantined',
				classification: 'quarantined',
				classification_reason: 'DMARC failed.',
			}),
		],
		selectedMessage: expect.objectContaining({
			id: 'msg-quarantined',
			classification: 'quarantined',
			classification_reason: 'DMARC failed.',
		}),
	})

	mockModule.setEmailMessageClassification.mockClear()
	// Reload after classify uses the default message list again.
	createEnv({ meter, messages: [messageRecord] })
	mockModule.getOwnerEmailMessageById.mockResolvedValue(messageRecord)
	const quarantineResponse = await handler.handler({
		request: new Request('https://example.com/account/email.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'classify',
				message_id: 'msg-1',
				classification: 'quarantined',
			}),
		}),
	})
	expect(quarantineResponse.status).toBe(200)
	expect(mockModule.setEmailMessageClassification).toHaveBeenCalledWith({
		env,
		db: env.APP_DB,
		userId: 'stable-user-1',
		messageId: 'msg-1',
		classification: 'quarantined',
		classificationReason: 'Reclassified by user.',
	})
	await expect(quarantineResponse.json()).resolves.toMatchObject({
		ok: true,
		selectedMessage: expect.objectContaining({ id: 'msg-1' }),
	})

	mockModule.setEmailMessageClassification.mockClear()
	const acceptResponse = await handler.handler({
		request: new Request('https://example.com/account/email.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'classify',
				message_id: 'msg-1',
				classification: 'accepted',
			}),
		}),
	})
	expect(acceptResponse.status).toBe(200)
	expect(mockModule.setEmailMessageClassification).toHaveBeenCalledWith({
		env,
		db: env.APP_DB,
		userId: 'stable-user-1',
		messageId: 'msg-1',
		classification: 'accepted',
		classificationReason: null,
	})

	mockModule.setEmailMessageClassification.mockResolvedValueOnce(false)
	const missingResponse = await handler.handler({
		request: new Request('https://example.com/account/email.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'classify',
				message_id: 'missing',
				classification: 'quarantined',
			}),
		}),
	})
	expect(missingResponse.status).toBe(404)

	const invalidActionResponse = await handler.handler({
		request: new Request('https://example.com/account/email.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ action: 'delete' }),
		}),
	})
	expect(invalidActionResponse.status).toBe(400)
})

test('email API gates unverified accounts and skips mailbox queries', async () => {
	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce({
		sessionUserId: '42',
		userId: 42,
		username: 'test-user',
		email: 'user@example.com',
		emailVerified: false,
		displayName: 'user',
		roles: ['user'],
		permissions: [],
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	} as never)
	mockModule.isAccountEmailVerified.mockResolvedValueOnce(false)
	mockModule.listOwnerEmailMessagesPage.mockClear()
	mockModule.listEmailInboxesForUser.mockClear()
	mockModule.getUserPlan.mockClear()

	const handler = createAccountEmailApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/email.json'),
	})
	expect(response.status).toBe(200)
	expect(mockModule.listEmailInboxesForUser).not.toHaveBeenCalled()
	expect(mockModule.getUserPlan).not.toHaveBeenCalled()
	expect(mockModule.listOwnerEmailMessagesPage).not.toHaveBeenCalled()
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		emailVerified: false,
		inboxAddress: 'test-user@inbox.example.com',
		verificationMessage: expect.stringContaining('not verified'),
		messages: [],
		selectedMessage: null,
		usage: null,
		total: 0,
		classification: null,
	})
})

test('email API scopes message detail lookups to the signed-in userId', async () => {
	mockModule.getOwnerEmailMessageById.mockResolvedValueOnce(null)
	const env = createEnv()
	const handler = createAccountEmailApiHandler(env)
	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/email.json?selected=missing-msg',
		),
	})
	expect(response.status).toBe(200)
	expect(mockModule.getOwnerEmailMessageById).toHaveBeenCalledWith(
		expect.objectContaining({
			dbUserId: 42,
			stableUserId: 'stable-user-1',
			messageId: 'missing-msg',
		}),
	)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		selectedMessage: null,
	})
})
