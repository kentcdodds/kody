import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	readAuthenticatedAppUser: async () => ({
		sessionUserId: '42',
		userId: 42,
		email: 'user@example.com',
		displayName: 'user',
		artifactOwnerIds: [],
		mcpUser: {
			userId: 'stable-user-1',
			email: 'user@example.com',
			displayName: 'user',
		},
	}),
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
	listEmailInboxesForUser: vi.fn(async () => []),
	listEmailInboxAddressesForUser: vi.fn(async () => []),
	listEmailSenderPolicies: vi.fn(async () => []),
	listEmailMessages: vi.fn(async () => []),
	upsertEmailSenderPolicy: vi.fn(async () => ({
		id: 'policy-1',
		userId: 'stable-user-1',
		inboxId: 'inbox-1',
		packageId: null,
		kind: 'sender',
		value: 'agent@trusted.example',
		effect: 'allow',
		enabled: true,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	})),
	disableEmailSenderPolicy: vi.fn(async () => true),
	getEmailMessageById: vi.fn(async () => null),
	listEmailAttachmentsForMessage: vi.fn(async () => []),
	getLatestEmailAgentRunForMessage: vi.fn(async () => null),
	listEmailAgentRunsForThread: vi.fn(async () => []),
}))

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (...args: Array<unknown>) =>
		mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: (...args: Array<unknown>) =>
		mockModule.readAuthSessionResult(...args),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/layout.ts', () => ({
	Layout: () => null,
}))

vi.mock('#app/render.ts', () => ({
	render: () => new Response('ok'),
}))

vi.mock('#worker/email/repo.ts', () => ({
	listEmailInboxesForUser: (...args: Array<unknown>) =>
		mockModule.listEmailInboxesForUser(...args),
	listEmailInboxAddressesForUser: (...args: Array<unknown>) =>
		mockModule.listEmailInboxAddressesForUser(...args),
	listEmailSenderPolicies: (...args: Array<unknown>) =>
		mockModule.listEmailSenderPolicies(...args),
	listEmailMessages: (...args: Array<unknown>) =>
		mockModule.listEmailMessages(...args),
	upsertEmailSenderPolicy: (...args: Array<unknown>) =>
		mockModule.upsertEmailSenderPolicy(...args),
	disableEmailSenderPolicy: (...args: Array<unknown>) =>
		mockModule.disableEmailSenderPolicy(...args),
	getEmailMessageById: (...args: Array<unknown>) =>
		mockModule.getEmailMessageById(...args),
	listEmailAttachmentsForMessage: (...args: Array<unknown>) =>
		mockModule.listEmailAttachmentsForMessage(...args),
	getLatestEmailAgentRunForMessage: (...args: Array<unknown>) =>
		mockModule.getLatestEmailAgentRunForMessage(...args),
	listEmailAgentRunsForThread: (...args: Array<unknown>) =>
		mockModule.listEmailAgentRunsForThread(...args),
}))

const { createAccountEmailApiHandler } = await import('./account-email.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env
}

test('account email payload includes inboxes, policies, and selected message trace', async () => {
	mockModule.listEmailInboxesForUser.mockResolvedValueOnce([
		{
			id: 'inbox-1',
			userId: 'stable-user-1',
			packageId: null,
			ownerEmail: 'user@example.com',
			ownerDisplayName: 'User',
			name: 'Support',
			description: 'Support inbox',
			mode: 'quarantine',
			enabled: true,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	])
	mockModule.listEmailInboxAddressesForUser.mockResolvedValueOnce([
		{
			id: 'alias-1',
			inboxId: 'inbox-1',
			userId: 'stable-user-1',
			address: 'support@example.com',
			localPart: 'support',
			domain: 'example.com',
			replyTokenHash: null,
			enabled: true,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	])
	mockModule.listEmailSenderPolicies.mockResolvedValueOnce([
		{
			id: 'policy-1',
			userId: 'stable-user-1',
			inboxId: 'inbox-1',
			packageId: null,
			kind: 'sender',
			value: 'agent@trusted.example',
			effect: 'allow',
			enabled: true,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	])
	mockModule.getEmailMessageById.mockResolvedValueOnce({
		id: 'message-1',
		direction: 'inbound',
		userId: 'stable-user-1',
		inboxId: 'inbox-1',
		threadId: 'thread-1',
		senderIdentityId: null,
		fromAddress: 'agent@trusted.example',
		envelopeFrom: 'agent@trusted.example',
		toAddresses: ['support@example.com'],
		ccAddresses: [],
		bccAddresses: [],
		replyToAddresses: [],
		subject: 'Need help',
		messageIdHeader: '<message-1@example.com>',
		inReplyToHeader: null,
		references: [],
		headers: {},
		authResults: null,
		textBody: 'Need help',
		htmlBody: null,
		rawMime: null,
		rawSize: 0,
		policyDecision: 'accepted',
		processingStatus: 'stored',
		providerMessageId: null,
		error: null,
		receivedAt: new Date(0).toISOString(),
		sentAt: null,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	})
	mockModule.listEmailAttachmentsForMessage.mockResolvedValueOnce([])
	mockModule.getLatestEmailAgentRunForMessage.mockResolvedValueOnce({
		id: 'run-1',
		userId: 'stable-user-1',
		inboxId: 'inbox-1',
		threadId: 'thread-1',
		inboundMessageId: 'message-1',
		replyMessageId: 'reply-1',
		sessionId: 'email-thread-thread-1',
		conversationId: 'email-thread-1',
		status: 'completed',
		toolCallLimit: 20,
		toolCallsUsed: 2,
		traceUrl: 'https://example.com/account/email?selected=message-1&run=run-1',
		summary: 'Completed',
		assistantText: 'Completed',
		stopReason: 'completed',
		finishReason: 'stop',
		error: null,
		startedAt: new Date(0).toISOString(),
		completedAt: new Date(0).toISOString(),
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	})
	mockModule.listEmailAgentRunsForThread.mockResolvedValueOnce([
		{
			id: 'run-1',
			userId: 'stable-user-1',
			inboxId: 'inbox-1',
			threadId: 'thread-1',
			inboundMessageId: 'message-1',
			replyMessageId: 'reply-1',
			sessionId: 'email-thread-thread-1',
			conversationId: 'email-thread-1',
			status: 'completed',
			toolCallLimit: 20,
			toolCallsUsed: 2,
			traceUrl:
				'https://example.com/account/email?selected=message-1&run=run-1',
			summary: 'Completed',
			assistantText: 'Completed',
			stopReason: 'completed',
			finishReason: 'stop',
			error: null,
			startedAt: new Date(0).toISOString(),
			completedAt: new Date(0).toISOString(),
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	])

	const handler = createAccountEmailApiHandler(createEnv())
	const response = await handler.action({
		request: new Request(
			'https://example.com/account/email.json?selected=message-1',
			{ method: 'GET' },
		),
		params: {},
	} as never)

	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		ok: true,
		inboxes: [
			expect.objectContaining({
				id: 'inbox-1',
				name: 'Support',
				addresses: [
					expect.objectContaining({ address: 'support@example.com' }),
				],
				policies: [expect.objectContaining({ value: 'agent@trusted.example' })],
			}),
		],
		selected_message: expect.objectContaining({
			id: 'message-1',
			subject: 'Need help',
			agent_runs: [
				expect.objectContaining({
					id: 'run-1',
					trace_url:
						'https://example.com/account/email?selected=message-1&run=run-1',
				}),
			],
		}),
	})
})

test('account email approve and revoke actions update sender policies', async () => {
	mockModule.listEmailInboxesForUser.mockResolvedValue([
		{
			id: 'inbox-1',
			userId: 'stable-user-1',
			packageId: null,
			ownerEmail: 'user@example.com',
			ownerDisplayName: 'User',
			name: 'Support',
			description: 'Support inbox',
			mode: 'quarantine',
			enabled: true,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	])
	mockModule.listEmailInboxAddressesForUser.mockResolvedValue([
		{
			id: 'alias-1',
			inboxId: 'inbox-1',
			userId: 'stable-user-1',
			address: 'support@example.com',
			localPart: 'support',
			domain: 'example.com',
			replyTokenHash: null,
			enabled: true,
			createdAt: new Date(0).toISOString(),
			updatedAt: new Date(0).toISOString(),
		},
	])
	mockModule.listEmailSenderPolicies.mockResolvedValue([])

	const handler = createAccountEmailApiHandler(createEnv())
	const approveResponse = await handler.action({
		request: new Request('https://example.com/account/email.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'approve_sender',
				inboxId: 'inbox-1',
				value: 'agent@trusted.example',
			}),
		}),
		params: {},
	} as never)

	expect(approveResponse.status).toBe(200)
	expect(mockModule.upsertEmailSenderPolicy).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'stable-user-1',
			inboxId: 'inbox-1',
			kind: 'sender',
			value: 'agent@trusted.example',
			effect: 'allow',
		}),
	)

	const revokeResponse = await handler.action({
		request: new Request('https://example.com/account/email.json', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				action: 'revoke_policy',
				inboxId: 'inbox-1',
				kind: 'sender',
				value: 'agent@trusted.example',
			}),
		}),
		params: {},
	} as never)

	expect(revokeResponse.status).toBe(200)
	expect(mockModule.disableEmailSenderPolicy).toHaveBeenCalledWith(
		expect.objectContaining({
			db: expect.anything(),
			inboxId: 'inbox-1',
			kind: 'sender',
			value: 'agent@trusted.example',
			userId: 'stable-user-1',
		}),
	)
})
