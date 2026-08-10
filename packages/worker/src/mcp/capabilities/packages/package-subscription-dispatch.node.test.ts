import { expect, test, vi } from 'vitest'

const inboundEmailReceiptTopic = 'email.message.received'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(async () => ({
		status: 200,
		body: { result: { ok: true } },
	})),
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	getInternalEmailMessageById: vi.fn(),
	listInternalEmailAttachmentsForMessage: vi.fn(),
}))

vi.mock('#worker/email/package-subscriptions.ts', () => ({
	buildEmailReceiptSubscriptionEnvelope: vi.fn(
		(input: {
			event: string
			message: { id: string }
			attachments: Array<unknown>
		}) => ({
			event: input.event,
			message: { id: input.message.id },
			attachments: input.attachments,
		}),
	),
	inboundEmailReceiptTopic: 'email.message.received',
	inboundEmailQuarantinedTopic: 'email.message.quarantined',
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: mocks.getSavedPackageById,
	getSavedPackageByKodyId: mocks.getSavedPackageByKodyId,
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	packageScopeInputDescription: 'package scope',
	resolvePackageOwnerContext: mocks.resolvePackageOwnerContext,
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

vi.mock('#worker/email/mailbox-internal-read.ts', () => ({
	getInternalEmailMessageById: mocks.getInternalEmailMessageById,
	listInternalEmailAttachmentsForMessage:
		mocks.listInternalEmailAttachmentsForMessage,
}))

const { packageSubscriptionDispatchCapability } =
	await import('./package-subscription-dispatch.ts')

function createSavedPackage() {
	return {
		id: 'pkg-1',
		userId: 'user-1',
		sourceId: 'source-1',
		kodyId: 'demo',
		name: '@user/demo',
		description: 'Demo package',
		tags: [],
		searchText: null,
		hasApp: false,
		hidden: false,
		isPrivate: false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
	}
}

function createCtx(
	overrides?: Partial<{
		executionOrigin: 'interactive' | 'background'
		storageContext: {
			packageId?: string | null
			appId?: string | null
			storageId?: string | null
		} | null
	}>,
) {
	mocks.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId: 'user-1',
		ownerScope: 'user',
		ownerEmail: 'user@example.com',
		actorUserId: 'user-1',
		delegated: false,
	})
	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			executionOrigin: overrides?.executionOrigin ?? 'interactive',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
			},
			remoteConnectors: null,
			storageContext: overrides?.storageContext ?? null,
			repoContext: null,
		},
	}
}

function mockDeclaredSubscription(topic = inboundEmailReceiptTopic) {
	mocks.getSavedPackageByKodyId.mockResolvedValue(createSavedPackage())
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: {
			name: '@user/demo',
			kody: {
				id: 'demo',
				description: 'Demo',
				subscriptions: {
					[topic]: {
						handler: './src/on-email.ts',
					},
				},
			},
		},
	})
}

test('package_subscription_dispatch sends synthetic params envelopes to one package', async () => {
	mockDeclaredSubscription('repo.pushed')
	const ctx = createCtx()

	const result = await packageSubscriptionDispatchCapability.handler(
		{
			kody_id: 'demo',
			topic: 'repo.pushed',
			params: {
				event: 'repo.pushed',
				synthetic: true,
				replay_of: 'forged',
			},
		},
		ctx as never,
	)

	expect(result).toMatchObject({
		package_id: 'pkg-1',
		kody_id: 'demo',
		topic: 'repo.pushed',
		source: 'synthetic',
		synthetic: true,
		replay_of: null,
		status: 200,
	})
	expect(result.idempotency_key).toMatch(/^synthetic:[0-9a-f-]{36}$/)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage: createSavedPackage(),
			topic: 'repo.pushed',
			trustedSyntheticDispatch: expect.any(Object),
			actorTokenId: 'internal:synthetic-subscriptions',
			params: {
				event: 'repo.pushed',
				synthetic: true,
			},
			idempotencyKey: result.idempotency_key,
		}),
	)

	const second = await packageSubscriptionDispatchCapability.handler(
		{
			kody_id: 'demo',
			topic: 'repo.pushed',
			params: { event: 'repo.pushed' },
		},
		ctx as never,
	)
	expect(second.idempotency_key).toMatch(/^synthetic:[0-9a-f-]{36}$/)
	expect(second.idempotency_key).not.toBe(result.idempotency_key)
})

test('package_subscription_dispatch bounds oversized handler results', async () => {
	mockDeclaredSubscription('repo.pushed')
	mocks.invokePackageSubscription.mockResolvedValue({
		status: 200,
		body: { result: { blob: 'x'.repeat(102_400) } },
	})

	const result = await packageSubscriptionDispatchCapability.handler(
		{
			kody_id: 'demo',
			topic: 'repo.pushed',
			params: { event: 'repo.pushed' },
		},
		createCtx() as never,
	)

	expect(result.result).toEqual({
		truncated: true,
		message:
			'Subscription result exceeded 102400 bytes and was omitted. Inspect the subscription run for details.',
	})
})

test('package_subscription_dispatch replays stored inbound email envelopes', async () => {
	mockDeclaredSubscription()
	mocks.getInternalEmailMessageById.mockResolvedValue({
		id: 'message-1',
		inboxId: 'inbox-1',
		fromAddress: 'sender@example.com',
		envelopeFrom: 'sender@example.com',
		toAddresses: ['user@inbox.example.com'],
		ccAddresses: [],
		replyToAddresses: [],
		subject: 'Hello',
		messageIdHeader: '<msg@example.com>',
		inReplyToHeader: null,
		references: [],
		processingStatus: 'received',
		classification: 'accepted',
		classificationReason: null,
		receivedAt: '2026-01-01T00:00:00.000Z',
		createdAt: '2026-01-01T00:00:00.000Z',
	})
	mocks.listInternalEmailAttachmentsForMessage.mockResolvedValue([
		{
			id: 'attachment-1',
			filename: 'note.txt',
			contentType: 'text/plain',
			contentId: null,
			disposition: null,
			size: 4,
			storageKind: 'blob',
			storageKey: 'blob-1',
			createdAt: '2026-01-01T00:00:00.000Z',
		},
	])
	const ctx = createCtx()

	const result = await packageSubscriptionDispatchCapability.handler(
		{
			kody_id: 'demo',
			topic: inboundEmailReceiptTopic,
			email_message_id: 'message-1',
		},
		ctx as never,
	)

	expect(result).toMatchObject({
		source: 'synthetic',
		synthetic: true,
		replay_of: 'message-1',
	})
	expect(result.idempotency_key).toMatch(/^synthetic:[0-9a-f-]{36}$/)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			params: expect.objectContaining({
				event: inboundEmailReceiptTopic,
				synthetic: true,
				replay_of: 'message-1',
				message: expect.objectContaining({ id: 'message-1' }),
				attachments: [
					expect.objectContaining({ id: 'attachment-1', filename: 'note.txt' }),
				],
			}),
		}),
	)
})

test('package_subscription_dispatch rejects replay when the stored message topic differs', async () => {
	mockDeclaredSubscription()
	mocks.getInternalEmailMessageById.mockResolvedValue({
		id: 'message-quarantined',
		inboxId: 'inbox-1',
		fromAddress: 'sender@example.com',
		envelopeFrom: 'sender@example.com',
		toAddresses: ['user@inbox.example.com'],
		ccAddresses: [],
		replyToAddresses: [],
		subject: 'Quarantined',
		messageIdHeader: '<quarantined@example.com>',
		inReplyToHeader: null,
		references: [],
		processingStatus: 'received',
		classification: 'quarantined',
		classificationReason: 'test',
		receivedAt: '2026-01-01T00:00:00.000Z',
		createdAt: '2026-01-01T00:00:00.000Z',
	})

	await expect(
		packageSubscriptionDispatchCapability.handler(
			{
				kody_id: 'demo',
				topic: inboundEmailReceiptTopic,
				email_message_id: 'message-quarantined',
			},
			createCtx() as never,
		),
	).rejects.toThrow(
		'would dispatch on topic "email.message.quarantined", not "email.message.received"',
	)
	expect(mocks.invokePackageSubscription).not.toHaveBeenCalled()
})

test('package_subscription_dispatch rejects runtime callers and undeclared topics', async () => {
	mockDeclaredSubscription('repo.pushed')

	await expect(
		packageSubscriptionDispatchCapability.handler(
			{
				kody_id: 'demo',
				topic: 'repo.pushed',
				params: { event: 'repo.pushed' },
			},
			createCtx({
				storageContext: {
					packageId: 'pkg-1',
					appId: null,
					storageId: 'package:pkg-1',
				},
			}) as never,
		),
	).rejects.toThrow(
		'package_subscription_dispatch is unavailable from package runtime contexts.',
	)
	await expect(
		packageSubscriptionDispatchCapability.handler(
			{
				kody_id: 'demo',
				topic: 'repo.pushed',
				params: { event: 'repo.pushed' },
			},
			createCtx({ executionOrigin: 'background' }) as never,
		),
	).rejects.toThrow(
		'package_subscription_dispatch is unavailable from package runtime contexts.',
	)

	mockDeclaredSubscription()
	await expect(
		packageSubscriptionDispatchCapability.handler(
			{
				kody_id: 'demo',
				topic: 'repo.pushed',
				params: { event: 'repo.pushed' },
			},
			createCtx() as never,
		),
	).rejects.toThrow(/package_subscription_dispatch/)
})

test('package_subscription_dispatch resolves delegated package scope like package_get', async () => {
	mockDeclaredSubscription('repo.pushed')
	const ctx = createCtx()
	mocks.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId: 'platform-user',
		ownerScope: 'kody',
		ownerEmail: 'kody@example.com',
		actorUserId: 'user-1',
		delegated: true,
	})

	await packageSubscriptionDispatchCapability.handler(
		{
			kody_id: 'demo',
			topic: 'repo.pushed',
			package_scope: 'kody',
			params: { event: 'repo.pushed' },
		},
		ctx as never,
	)

	expect(mocks.resolvePackageOwnerContext).toHaveBeenCalledWith(
		ctx.env,
		ctx.callerContext.user,
		'kody',
	)
	expect(mocks.getSavedPackageByKodyId).toHaveBeenCalledWith(ctx.env.APP_DB, {
		userId: 'platform-user',
		kodyId: 'demo',
	})
})
