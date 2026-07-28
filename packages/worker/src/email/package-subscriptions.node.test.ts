import { expect, test, vi } from 'vitest'

const emailDeliveryUpdatedTopic = 'email.message.delivery.updated'
const inboundEmailReceiptTopic = 'email.message.received'
const inboundEmailQuarantinedTopic = 'email.message.quarantined'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(async () => ({ status: 200, body: {} })),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	listEmailAttachmentsForMessage: vi.fn(async () => []),
}))

vi.mock('#worker/package-invocations/service.ts', () => ({
	invokePackageSubscription: mocks.invokePackageSubscription,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: mocks.listSavedPackagesByUserId,
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: mocks.loadPackageManifestBySourceId,
}))

vi.mock('./repo.ts', () => ({
	listEmailAttachmentsForMessage: mocks.listEmailAttachmentsForMessage,
}))

const {
	dispatchEmailDeliverySubscriptionEvents,
	dispatchInboundEmailSubscriptionEvents,
	inboundEmailQuarantinedTopic: exportedQuarantinedTopic,
} = await import('./package-subscriptions.ts')

test('delivery updates fan out only through the stored message owner', async () => {
	const savedPackage = {
		id: 'package-1',
		userId: 'user-1',
		sourceId: 'source-1',
		kodyId: 'delivery-notifier',
		name: '@user/delivery-notifier',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([savedPackage])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce({
		manifest: {
			name: '@user/delivery-notifier',
			kody: {
				id: 'delivery-notifier',
				description: 'Delivery notifier',
				subscriptions: {
					[emailDeliveryUpdatedTopic]: {
						handler: './src/on-delivery.ts',
					},
				},
			},
		},
	})
	const message = {
		id: 'message-1',
		userId: 'user-1',
		inboxId: 'inbox-1',
		threadId: 'thread-1',
		fromAddress: 'user@inbox.example.com',
		toAddresses: ['recipient@example.net'],
		subject: 'Hello',
		processingStatus: 'sent',
		providerMessageId: 'provider-1',
		deliveryStatus: 'bounced',
		deliveryStatusAt: '2026-07-17T20:00:00.000Z',
		sentAt: '2026-07-17T19:59:00.000Z',
		createdAt: '2026-07-17T19:59:00.000Z',
	}
	const providerEvent = {
		type: 'cf.email.sending.message.bounced',
		source: {
			type: 'email.sending',
			zoneId: 'zone-1',
			domain: 'inbox.example.com',
		},
		payload: {
			eventId: 'event-1',
			messageId: 'provider-1',
			sender: 'user@inbox.example.com',
			recipient: 'recipient@example.net',
			terminal: true,
			delivery: { status: 'bounced' },
			bounce: { type: 'hard' },
		},
		metadata: {
			accountId: 'account-1',
			eventSubscriptionId: 'subscription-1',
			eventSchemaVersion: 1,
			eventTimestamp: '2026-07-17T20:00:00.000Z',
		},
	}
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
	} as Env

	await dispatchEmailDeliverySubscriptionEvents({
		env,
		message: message as never,
		providerEvent: providerEvent as never,
	})

	expect(mocks.listSavedPackagesByUserId).toHaveBeenCalledWith(env.APP_DB, {
		userId: 'user-1',
	})
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: emailDeliveryUpdatedTopic,
			idempotencyKey: 'email-delivery:event-1:package-1',
			source: 'email',
			params: expect.objectContaining({
				event: emailDeliveryUpdatedTopic,
				message: expect.objectContaining({
					id: 'message-1',
					delivery_status: 'bounced',
				}),
				delivery: expect.objectContaining({
					event_id: 'event-1',
					status: 'bounced',
					terminal: true,
				}),
			}),
		}),
	)

	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([savedPackage])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce({
		manifest: {
			name: '@user/delivery-notifier',
			kody: {
				id: 'delivery-notifier',
				description: 'Delivery notifier',
				subscriptions: {
					[emailDeliveryUpdatedTopic]: {
						handler: './src/on-delivery.ts',
					},
				},
			},
		},
	})
	mocks.invokePackageSubscription.mockResolvedValueOnce({
		status: 503,
		body: { error: { code: 'artifact_preparation_failed' } },
	})
	await expect(
		dispatchEmailDeliverySubscriptionEvents({
			env,
			message: message as never,
			providerEvent: providerEvent as never,
		}),
	).rejects.toThrow('dispatch was incomplete')
})

function inboundMessageFixture(input: {
	id: string
	classification: 'accepted' | 'quarantined'
	classificationReason: string | null
}) {
	return {
		id: input.id,
		userId: 'user-1',
		inboxId: 'inbox-1',
		fromAddress: 'sender@example.net',
		envelopeFrom: 'sender@example.net',
		toAddresses: ['user@inbox.example.com'],
		ccAddresses: [],
		replyToAddresses: [],
		subject: 'Inbound',
		messageIdHeader: `<${input.id}@example.net>`,
		inReplyToHeader: null,
		references: [],
		processingStatus: 'stored',
		classification: input.classification,
		classificationReason: input.classificationReason,
		receivedAt: '2026-07-17T19:59:00.000Z',
		createdAt: '2026-07-17T19:59:00.000Z',
	}
}

async function seedInboundSubscription(topic: string) {
	const savedPackage = {
		id: 'package-inbound-1',
		userId: 'user-1',
		sourceId: 'source-inbound-1',
		kodyId: 'inbound-notifier',
		name: '@user/inbound-notifier',
	}
	mocks.listSavedPackagesByUserId.mockResolvedValueOnce([savedPackage])
	mocks.loadPackageManifestBySourceId.mockResolvedValueOnce({
		manifest: {
			name: '@user/inbound-notifier',
			kody: {
				id: 'inbound-notifier',
				description: 'Inbound notifier',
				subscriptions: {
					[topic]: {
						handler: './src/on-inbound.ts',
					},
				},
			},
		},
	})
	return savedPackage
}

test('accepted inbound messages dispatch email.message.received with classification fields', async () => {
	mocks.invokePackageSubscription.mockClear()
	const savedPackage = await seedInboundSubscription(inboundEmailReceiptTopic)
	const message = inboundMessageFixture({
		id: 'accepted-1',
		classification: 'accepted',
		classificationReason: null,
	})
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
	} as Env

	await dispatchInboundEmailSubscriptionEvents({
		env,
		userId: 'user-1',
		message: message as never,
	})

	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(1)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: inboundEmailReceiptTopic,
			idempotencyKey: `email:accepted-1:package-inbound-1:${inboundEmailReceiptTopic}`,
			params: expect.objectContaining({
				event: inboundEmailReceiptTopic,
				message: expect.objectContaining({
					id: 'accepted-1',
					classification: 'accepted',
					classification_reason: null,
				}),
			}),
		}),
	)
	expect(mocks.invokePackageSubscription.mock.calls[0]?.[0]?.topic).not.toBe(
		inboundEmailQuarantinedTopic,
	)
})

test('quarantined inbound messages dispatch email.message.quarantined and not received', async () => {
	expect(exportedQuarantinedTopic).toBe(inboundEmailQuarantinedTopic)
	mocks.invokePackageSubscription.mockClear()
	const savedPackage = await seedInboundSubscription(
		inboundEmailQuarantinedTopic,
	)
	const message = inboundMessageFixture({
		id: 'quarantined-1',
		classification: 'quarantined',
		classificationReason: 'Sender matched quarantine rule spam.example.',
	})
	const env = {
		APP_DB: {},
		BUNDLE_ARTIFACTS_KV: {},
		APP_BASE_URL: 'https://example.com',
	} as Env

	await dispatchInboundEmailSubscriptionEvents({
		env,
		userId: 'user-1',
		message: message as never,
	})

	expect(mocks.invokePackageSubscription).toHaveBeenCalledTimes(1)
	expect(mocks.invokePackageSubscription).toHaveBeenCalledWith(
		expect.objectContaining({
			savedPackage,
			topic: inboundEmailQuarantinedTopic,
			idempotencyKey: `email:quarantined-1:package-inbound-1:${inboundEmailQuarantinedTopic}`,
			params: expect.objectContaining({
				event: inboundEmailQuarantinedTopic,
				message: expect.objectContaining({
					id: 'quarantined-1',
					classification: 'quarantined',
					classification_reason: 'Sender matched quarantine rule spam.example.',
				}),
			}),
		}),
	)
	expect(mocks.invokePackageSubscription.mock.calls[0]?.[0]?.topic).not.toBe(
		inboundEmailReceiptTopic,
	)
})
