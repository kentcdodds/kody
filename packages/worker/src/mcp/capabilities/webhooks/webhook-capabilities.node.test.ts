import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	listWebhooksForUser: vi.fn(),
	mintWebhookUrlForUser: vi.fn(),
	rotateWebhookUrlForUser: vi.fn(),
	setWebhookEnabledForUser: vi.fn(),
	resolveSavedPackage: vi.fn(),
	getWebhookEndpointByKey: vi.fn(),
	listRunRecords: vi.fn(),
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
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackage(...args),
}))

vi.mock('#worker/webhooks/repo.ts', () => ({
	getWebhookEndpointByKey: (...args: Array<unknown>) =>
		mockModule.getWebhookEndpointByKey(...args),
}))

vi.mock('#worker/run-records/service.ts', () => ({
	listRunRecords: (...args: Array<unknown>) =>
		mockModule.listRunRecords(...args),
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
	mockModule.resolveSavedPackage.mockResolvedValue({
		id: 'pkg-1',
		kodyId: 'sentry-bridge',
		name: '@user/sentry-bridge',
		userId: 'user-1',
		sourceId: 'src-1',
	})
	mockModule.getWebhookEndpointByKey.mockResolvedValue({
		id: 'ep-1',
		userId: 'user-1',
		packageId: 'pkg-1',
		webhookName: 'sentry',
		urlSecretHash: 'hash',
		enabled: true,
		createdAt: '2026-07-24T00:00:00.000Z',
		rotatedAt: '2026-07-24T00:00:00.000Z',
	})
	mockModule.listRunRecords.mockResolvedValue({
		runs: [
			{
				id: 'del-1',
				surface: 'webhook',
				status: 'success',
				name: 'sentry',
				packageId: 'pkg-1',
				kodyId: 'sentry-bridge',
				sourceId: null,
				publishedCommit: null,
				storageId: null,
				jobId: null,
				workflowId: null,
				invocationId: null,
				sessionId: null,
				idempotencyKey: null,
				parentRunId: null,
				startedAt: '2026-07-24T01:00:00.000Z',
				finishedAt: '2026-07-24T01:00:01.000Z',
				durationMs: 1000,
				errorName: null,
				errorMessage: null,
				metadata: {
					outcome: 'delivered',
					http_status: 202,
					payload_bytes: 10,
				},
				logCount: 0,
			},
			{
				id: 'del-other',
				surface: 'webhook',
				status: 'error',
				name: 'other-hook',
				packageId: 'pkg-1',
				kodyId: 'sentry-bridge',
				sourceId: null,
				publishedCommit: null,
				storageId: null,
				jobId: null,
				workflowId: null,
				invocationId: null,
				sessionId: null,
				idempotencyKey: null,
				parentRunId: null,
				startedAt: '2026-07-24T00:30:00.000Z',
				finishedAt: '2026-07-24T00:30:01.000Z',
				durationMs: 1000,
				errorName: 'Error',
				errorMessage: 'nope',
				metadata: {
					outcome: 'failed',
					http_status: 502,
					payload_bytes: 4,
				},
				logCount: 0,
			},
		],
		nextCursor: null,
	})

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
	expect(deliveries.deliveries).toEqual([
		{
			id: 'del-1',
			package_id: 'pkg-1',
			webhook_name: 'sentry',
			received_at: '2026-07-24T01:00:00.000Z',
			outcome: 'delivered',
			http_status: 202,
			error: null,
			payload_bytes: 10,
		},
	])
	expect(mockModule.listRunRecords).toHaveBeenCalledWith({
		env: ctx.env,
		userId: 'user-1',
		filter: {
			surface: 'webhook',
			packageId: 'pkg-1',
		},
		limit: 100,
	})
})
