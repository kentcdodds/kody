import { expect, test, vi } from 'vitest'
import type * as EmailPlatformAddress from '#worker/email/platform-address.ts'
import type * as EntitlementPlans from '#worker/entitlements/plans.ts'

const messageRow = {
	id: 'msg-1',
	direction: 'inbound',
	inbox_id: 'inbox-1',
	thread_id: null,
	from_address: 'sender@example.com',
	envelope_from: 'sender@example.com',
	to_addresses_json: '["user@inbox.example.com"]',
	subject: 'Hello from sender',
	message_id_header: '<msg-1@example.com>',
	processing_status: 'stored',
	classification: 'accepted',
	classification_reason: null,
	provider_message_id: null,
	delivery_status: null,
	delivery_status_at: null,
	error: null,
	received_at: new Date(0).toISOString(),
	sent_at: null,
	created_at: new Date(0).toISOString(),
	updated_at: new Date(0).toISOString(),
}

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
	getEmailMessageById: vi.fn(async () => messageRecord),
	listEmailAttachmentsForMessage: vi.fn(async () => [
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
	listEmailDeliveryEvents: vi.fn(async () => [
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

vi.mock('#worker/entitlements/service.ts', () => ({
	getUserPlan: (...args: Array<unknown>) => mockModule.getUserPlan(...args),
	readEntitlementResourceUsage: (...args: Array<unknown>) =>
		mockModule.readEntitlementResourceUsage(...args),
}))

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
	getEmailMessageById: (...args: Array<unknown>) =>
		mockModule.getEmailMessageById(...args),
	listEmailAttachmentsForMessage: (...args: Array<unknown>) =>
		mockModule.listEmailAttachmentsForMessage(...args),
	listEmailDeliveryEvents: (...args: Array<unknown>) =>
		mockModule.listEmailDeliveryEvents(...args),
	setEmailMessageClassification: (...args: Array<unknown>) =>
		mockModule.setEmailMessageClassification(...args),
}))

const { createAccountEmailApiHandler } = await import('./account-email.ts')

function createCountResult(total: number) {
	return {
		bind: vi.fn().mockReturnValue({
			first: vi.fn(async () => ({ total })),
			all: vi.fn(async () => ({ results: [] })),
		}),
	}
}

function createListResult(rows: Array<Record<string, unknown>>) {
	return {
		bind: vi.fn().mockReturnValue({
			first: vi.fn(async () => null),
			all: vi.fn(async () => ({ results: rows })),
		}),
	}
}

function createEnv() {
	let prepareCall = 0
	mockModule.prepare.mockImplementation(() => {
		prepareCall += 1
		// countAndListMessages issues COUNT then SELECT in Promise.all order.
		if (prepareCall % 2 === 1) return createCountResult(1)
		return createListResult([messageRow])
	})
	return {
		APP_DB: {
			prepare: (...args: Array<unknown>) => mockModule.prepare(...args),
		} as unknown as D1Database,
		APP_BASE_URL: 'https://example.com',
		COOKIE_SECRET: 'secret',
	} as Env
}

test('email API lists messages with pagination, usage, and selected detail', async () => {
	mockModule.prepare.mockClear()
	mockModule.getEmailMessageById.mockClear()
	mockModule.listEmailDeliveryEvents.mockClear()
	const env = createEnv()
	const handler = createAccountEmailApiHandler(env)

	const listResponse = await handler.handler({
		request: new Request('https://example.com/account/email.json'),
	})
	expect(listResponse.status).toBe(200)
	expect(listResponse.headers.get('Cache-Control')).toBe('no-store')
	expect(mockModule.getEmailMessageById).not.toHaveBeenCalled()
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

	mockModule.prepare.mockClear()
	mockModule.getEmailMessageById.mockClear()
	const envWithSelection = createEnv()
	const selectedResponse = await createAccountEmailApiHandler(
		envWithSelection,
	).handler({
		request: new Request(
			'https://example.com/account/email.json?q=Hello&page=2&pageSize=10&selected=msg-1',
		),
	})
	expect(selectedResponse.status).toBe(200)
	expect(mockModule.getEmailMessageById).toHaveBeenCalledWith({
		db: envWithSelection.APP_DB,
		userId: 'stable-user-1',
		messageId: 'msg-1',
	})
	expect(mockModule.listEmailDeliveryEvents).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
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

test('email API filters quarantined messages and surfaces classification', async () => {
	const quarantinedRow = {
		...messageRow,
		id: 'msg-quarantined',
		classification: 'quarantined',
		classification_reason: 'DMARC failed.',
	}
	let prepareCall = 0
	mockModule.prepare.mockImplementation((sql: string) => {
		prepareCall += 1
		expect(sql).toContain('(? IS NULL OR classification = ?)')
		if (prepareCall % 2 === 1) return createCountResult(1)
		return createListResult([quarantinedRow])
	})
	mockModule.getEmailMessageById.mockResolvedValueOnce({
		...messageRecord,
		id: 'msg-quarantined',
		classification: 'quarantined',
		classificationReason: 'DMARC failed.',
	})

	const env = {
		APP_DB: {
			prepare: (...args: Array<unknown>) =>
				mockModule.prepare(...(args as [string])),
		} as unknown as D1Database,
		APP_BASE_URL: 'https://example.com',
		COOKIE_SECRET: 'secret',
	} as Env
	const response = await createAccountEmailApiHandler(env).handler({
		request: new Request(
			'https://example.com/account/email.json?classification=quarantined&selected=msg-quarantined',
		),
	})
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
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
})

test('email API classifies inbound messages as spam or not spam', async () => {
	mockModule.setEmailMessageClassification.mockClear()
	mockModule.prepare.mockClear()
	const env = createEnv()
	const handler = createAccountEmailApiHandler(env)

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
	mockModule.prepare.mockClear()
	mockModule.listEmailInboxesForUser.mockClear()
	mockModule.getUserPlan.mockClear()

	const handler = createAccountEmailApiHandler(createEnv())
	const response = await handler.handler({
		request: new Request('https://example.com/account/email.json'),
	})
	expect(response.status).toBe(200)
	expect(mockModule.listEmailInboxesForUser).not.toHaveBeenCalled()
	expect(mockModule.getUserPlan).not.toHaveBeenCalled()
	expect(mockModule.prepare).not.toHaveBeenCalled()
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
	mockModule.getEmailMessageById.mockResolvedValueOnce(null)
	const env = createEnv()
	const handler = createAccountEmailApiHandler(env)
	const response = await handler.handler({
		request: new Request(
			'https://example.com/account/email.json?selected=missing-msg',
		),
	})
	expect(response.status).toBe(200)
	expect(mockModule.getEmailMessageById).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'stable-user-1',
		messageId: 'missing-msg',
	})
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		selectedMessage: null,
	})
})
