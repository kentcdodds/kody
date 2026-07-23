import { expect, test, vi } from 'vitest'

const emailDeliveryUpdatedTopic = 'email.message.delivery.updated'

const mocks = vi.hoisted(() => ({
	invokePackageSubscription: vi.fn(async () => ({ status: 200, body: {} })),
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
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

const { dispatchEmailDeliverySubscriptionEvents } =
	await import('./package-subscriptions.ts')

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
