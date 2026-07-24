import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	listWebhooksForUser: vi.fn(),
	mintWebhookUrlForUser: vi.fn(),
	rotateWebhookUrlForUser: vi.fn(),
	setWebhookEnabledForUser: vi.fn(),
	listWebhookDeliveriesForUser: vi.fn(),
}))

vi.mock('#worker/webhooks/service.ts', () => ({
	listWebhooksForUser: (...args: Array<unknown>) =>
		mockModule.listWebhooksForUser(...args),
	mintWebhookUrlForUser: (...args: Array<unknown>) =>
		mockModule.mintWebhookUrlForUser(...args),
	rotateWebhookUrlForUser: (...args: Array<unknown>) =>
		mockModule.rotateWebhookUrlForUser(...args),
	setWebhookEnabledForUser: (...args: Array<unknown>) =>
		mockModule.setWebhookEnabledForUser(...args),
	listWebhookDeliveriesForUser: (...args: Array<unknown>) =>
		mockModule.listWebhookDeliveriesForUser(...args),
}))

const { webhookListCapability } = await import('./webhook-list.ts')
const { webhookUrlMintCapability } = await import('./webhook-url-mint.ts')
const { webhookUrlRotateCapability } = await import('./webhook-url-rotate.ts')
const { webhookEnableCapability } = await import('./webhook-enable.ts')
const { webhookDisableCapability } = await import('./webhook-disable.ts')
const { webhookDeliveryListCapability } =
	await import('./webhook-delivery-list.ts')

function createCapabilityContext() {
	return {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
				username: 'user',
			},
		}),
	}
}

test('webhook capabilities expose mint once and never leak secrets on list', async () => {
	mockModule.listWebhooksForUser.mockResolvedValue([
		{
			packageId: 'pkg-1',
			packageKodyId: 'sentry-bridge',
			packageName: '@user/sentry-bridge',
			name: 'sentry',
			exportName: './handle-sentry-webhook',
			description: null,
			responseMode: 'ack',
			verification: {
				type: 'hmac-sha256',
				header: 'sentry-hook-signature',
				secretName: 'sentryWebhookSecret',
				encoding: 'hex',
			},
			minted: true,
			enabled: true,
			createdAt: '2026-07-24T00:00:00.000Z',
			rotatedAt: '2026-07-24T00:00:00.000Z',
		},
	])
	mockModule.mintWebhookUrlForUser.mockResolvedValue({
		packageId: 'pkg-1',
		packageKodyId: 'sentry-bridge',
		name: 'sentry',
		url: 'https://heykody.dev/@user/webhooks/sentry-bridge/sentry/secret-once',
		urlSecret: 'secret-once',
		enabled: true,
		createdAt: '2026-07-24T00:00:00.000Z',
		rotatedAt: '2026-07-24T00:00:00.000Z',
	})
	mockModule.rotateWebhookUrlForUser.mockResolvedValue({
		packageId: 'pkg-1',
		packageKodyId: 'sentry-bridge',
		name: 'sentry',
		url: 'https://heykody.dev/@user/webhooks/sentry-bridge/sentry/new-secret',
		urlSecret: 'new-secret',
		enabled: true,
		createdAt: '2026-07-24T00:00:00.000Z',
		rotatedAt: '2026-07-24T01:00:00.000Z',
	})
	mockModule.setWebhookEnabledForUser.mockImplementation(
		async (input: { enabled: boolean }) => ({
			id: 'ep-1',
			userId: 'user-1',
			packageId: 'pkg-1',
			webhookName: 'sentry',
			urlSecretHash: 'hash',
			enabled: input.enabled,
			createdAt: '2026-07-24T00:00:00.000Z',
			rotatedAt: '2026-07-24T00:00:00.000Z',
		}),
	)
	mockModule.listWebhookDeliveriesForUser.mockResolvedValue([
		{
			id: 'del-1',
			endpointId: 'ep-1',
			userId: 'user-1',
			packageId: 'pkg-1',
			webhookName: 'sentry',
			receivedAt: '2026-07-24T01:00:00.000Z',
			outcome: 'delivered',
			httpStatus: 202,
			error: null,
			payloadBytes: 10,
		},
	])

	const ctx = createCapabilityContext()
	const listed = await webhookListCapability.handler({}, ctx)
	expect(listed.webhooks[0]?.minted).toBe(true)
	expect(JSON.stringify(listed)).not.toContain('secret-once')

	const minted = await webhookUrlMintCapability.handler(
		{ kodyId: 'sentry-bridge', webhookName: 'sentry' },
		ctx,
	)
	expect(minted.webhook.url_secret).toBe('secret-once')

	const rotated = await webhookUrlRotateCapability.handler(
		{ kodyId: 'sentry-bridge', webhookName: 'sentry' },
		ctx,
	)
	expect(rotated.webhook.url_secret).toBe('new-secret')

	await expect(
		webhookDisableCapability.handler(
			{ kodyId: 'sentry-bridge', webhookName: 'sentry' },
			ctx,
		),
	).resolves.toEqual({
		package_id: 'pkg-1',
		webhook_name: 'sentry',
		enabled: false,
	})
	await expect(
		webhookEnableCapability.handler(
			{ kodyId: 'sentry-bridge', webhookName: 'sentry' },
			ctx,
		),
	).resolves.toEqual({
		package_id: 'pkg-1',
		webhook_name: 'sentry',
		enabled: true,
	})

	const deliveries = await webhookDeliveryListCapability.handler(
		{ kodyId: 'sentry-bridge', webhookName: 'sentry' },
		ctx,
	)
	expect(deliveries.deliveries[0]?.webhook_name).toBe('sentry')
})
