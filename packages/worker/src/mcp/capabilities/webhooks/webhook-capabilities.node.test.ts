import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	createWebhookEndpointForUser: vi.fn(),
	listWebhookEndpointsForUserService: vi.fn(),
	getWebhookEndpointForUser: vi.fn(),
	updateWebhookEndpointForUser: vi.fn(),
	rotateWebhookEndpointSecretForUser: vi.fn(),
	deleteWebhookEndpointForUser: vi.fn(),
	listWebhookDeliveriesForUser: vi.fn(),
}))

vi.mock('#worker/webhooks/service.ts', () => ({
	createWebhookEndpointForUser: (...args: Array<unknown>) =>
		mockModule.createWebhookEndpointForUser(...args),
	listWebhookEndpointsForUserService: (...args: Array<unknown>) =>
		mockModule.listWebhookEndpointsForUserService(...args),
	getWebhookEndpointForUser: (...args: Array<unknown>) =>
		mockModule.getWebhookEndpointForUser(...args),
	updateWebhookEndpointForUser: (...args: Array<unknown>) =>
		mockModule.updateWebhookEndpointForUser(...args),
	rotateWebhookEndpointSecretForUser: (...args: Array<unknown>) =>
		mockModule.rotateWebhookEndpointSecretForUser(...args),
	deleteWebhookEndpointForUser: (...args: Array<unknown>) =>
		mockModule.deleteWebhookEndpointForUser(...args),
	listWebhookDeliveriesForUser: (...args: Array<unknown>) =>
		mockModule.listWebhookDeliveriesForUser(...args),
}))

const { webhookEndpointCreateCapability } =
	await import('./webhook-endpoint-create.ts')
const { webhookEndpointListCapability } =
	await import('./webhook-endpoint-list.ts')
const { webhookEndpointGetCapability } =
	await import('./webhook-endpoint-get.ts')
const { webhookEndpointUpdateCapability } =
	await import('./webhook-endpoint-update.ts')
const { webhookEndpointRotateSecretCapability } =
	await import('./webhook-endpoint-rotate-secret.ts')
const { webhookEndpointDeleteCapability } =
	await import('./webhook-endpoint-delete.ts')
const { webhookDeliveryListCapability } =
	await import('./webhook-delivery-list.ts')

function createCapabilityContext() {
	return {
		env: {
			APP_DB: {} as D1Database,
			APP_BASE_URL: 'https://heykody.dev',
		} as Env,
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

const publicEndpoint = {
	id: 'ep-1',
	name: 'sentry',
	packageId: 'pkg-1',
	exportName: './handle-webhook',
	responseMode: 'ack' as const,
	enabled: true,
	verification: {
		type: 'hmac-sha256' as const,
		header: 'sentry-hook-signature',
		encoding: 'hex' as const,
	},
	createdAt: '2026-07-24T00:00:00.000Z',
	updatedAt: '2026-07-24T00:00:00.000Z',
}

test('webhook capabilities map CRUD/delivery results without leaking secrets on list/get', async () => {
	mockModule.createWebhookEndpointForUser.mockResolvedValue({
		...publicEndpoint,
		url: 'https://heykody.dev/@user/webhooks/ep-1/secret-once',
		urlSecret: 'secret-once',
	})
	mockModule.listWebhookEndpointsForUserService.mockResolvedValue([
		publicEndpoint,
	])
	mockModule.getWebhookEndpointForUser.mockResolvedValue(publicEndpoint)
	mockModule.updateWebhookEndpointForUser.mockResolvedValue({
		...publicEndpoint,
		enabled: false,
	})
	mockModule.rotateWebhookEndpointSecretForUser.mockResolvedValue({
		...publicEndpoint,
		url: 'https://heykody.dev/@user/webhooks/ep-1/new-secret',
		urlSecret: 'new-secret',
	})
	mockModule.deleteWebhookEndpointForUser.mockResolvedValue(true)
	mockModule.listWebhookDeliveriesForUser.mockResolvedValue([
		{
			id: 'del-1',
			endpointId: 'ep-1',
			userId: 'user-1',
			receivedAt: '2026-07-24T01:00:00.000Z',
			outcome: 'delivered',
			httpStatus: 202,
			error: null,
			payloadBytes: 10,
		},
	])

	const ctx = createCapabilityContext()

	const created = await webhookEndpointCreateCapability.handler(
		{
			name: 'sentry',
			packageId: 'pkg-1',
			exportName: 'handle-webhook',
		},
		ctx,
	)
	expect(created.endpoint.url_secret).toBe('secret-once')
	expect(mockModule.createWebhookEndpointForUser).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'user-1', username: 'user' }),
	)

	const listed = await webhookEndpointListCapability.handler({}, ctx)
	expect(listed.endpoints).toHaveLength(1)
	expect(JSON.stringify(listed)).not.toContain('secret-once')
	expect(listed.endpoints[0]).not.toHaveProperty('url')

	const got = await webhookEndpointGetCapability.handler({ id: 'ep-1' }, ctx)
	expect(got.endpoint.id).toBe('ep-1')
	expect(got.endpoint).not.toHaveProperty('url_secret')

	const updated = await webhookEndpointUpdateCapability.handler(
		{ id: 'ep-1', enabled: false },
		ctx,
	)
	expect(updated.endpoint.enabled).toBe(false)

	const rotated = await webhookEndpointRotateSecretCapability.handler(
		{ id: 'ep-1' },
		ctx,
	)
	expect(rotated.endpoint.url_secret).toBe('new-secret')

	const deliveries = await webhookDeliveryListCapability.handler(
		{ endpointId: 'ep-1' },
		ctx,
	)
	expect(deliveries.deliveries[0]).toEqual({
		id: 'del-1',
		endpoint_id: 'ep-1',
		received_at: '2026-07-24T01:00:00.000Z',
		outcome: 'delivered',
		http_status: 202,
		error: null,
		payload_bytes: 10,
	})

	const deleted = await webhookEndpointDeleteCapability.handler(
		{ id: 'ep-1' },
		ctx,
	)
	expect(deleted).toEqual({ id: 'ep-1', deleted: true })
})
