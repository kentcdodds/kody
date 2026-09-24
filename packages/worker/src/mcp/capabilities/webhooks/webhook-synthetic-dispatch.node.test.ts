import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	dispatchSyntheticWebhookForUser: vi.fn(),
}))

vi.mock('#worker/webhooks/service.ts', () => ({
	dispatchSyntheticWebhookForUser: (...args: Array<unknown>) =>
		mocks.dispatchSyntheticWebhookForUser(...args),
}))

const { webhookSyntheticDispatchCapability } =
	await import('./webhook-synthetic-dispatch.ts')

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
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			executionOrigin: overrides?.executionOrigin ?? 'interactive',
			user: {
				userId: 'user-1',
				email: 'user@example.com',
				displayName: 'User',
				username: 'user',
			},
			storageContext: overrides?.storageContext ?? null,
		}),
	}
}

test('webhookSyntheticDispatch invokes request-mode fixtures and returns synthetic run metadata', async () => {
	mocks.dispatchSyntheticWebhookForUser.mockResolvedValue({
		packageId: 'pkg-1',
		packageKodyId: 'sentry-bridge',
		webhookName: 'sentry',
		inputMode: 'request',
		synthetic: true,
		status: 200,
		runId: 'run-1',
		idempotencyKey: 'synthetic:00000000-0000-4000-8000-000000000001',
		result: { ok: true },
	})

	const result = await webhookSyntheticDispatchCapability.handler(
		{
			kodyId: 'sentry-bridge',
			webhookName: 'sentry',
			request: {
				json: { action: 'created' },
				headers: { 'content-type': 'application/json' },
			},
		},
		createCtx() as never,
	)

	expect(result).toEqual({
		package_id: 'pkg-1',
		package_kody_id: 'sentry-bridge',
		webhook_name: 'sentry',
		input_mode: 'request',
		synthetic: true,
		status: 200,
		run_id: 'run-1',
		idempotency_key: 'synthetic:00000000-0000-4000-8000-000000000001',
		result: { ok: true },
	})
	expect(JSON.stringify(result)).not.toMatch(/url_secret|"url"/)
	expect(mocks.dispatchSyntheticWebhookForUser).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			kodyId: 'sentry-bridge',
			webhookName: 'sentry',
			request: {
				json: { action: 'created' },
				headers: { 'content-type': 'application/json' },
			},
		}),
	)
})

test('webhookSyntheticDispatch preserves params-mode sibling fields through the service', async () => {
	mocks.dispatchSyntheticWebhookForUser.mockResolvedValue({
		packageId: 'pkg-1',
		packageKodyId: 'gateway',
		webhookName: 'message-created',
		inputMode: 'params',
		synthetic: true,
		status: 200,
		runId: 'run-2',
		idempotencyKey: 'synthetic:00000000-0000-4000-8000-000000000002',
		result: { routed: true },
	})

	const result = await webhookSyntheticDispatchCapability.handler(
		{
			packageId: 'pkg-1',
			webhookName: 'message-created',
			params: {
				route: 'discord',
				dryRun: true,
				params: { text: 'hi' },
				synthetic: true,
			},
		},
		createCtx() as never,
	)

	expect(result.input_mode).toBe('params')
	expect(result.synthetic).toBe(true)
	expect(result).not.toHaveProperty('url')
	expect(result).not.toHaveProperty('url_secret')
	expect(mocks.dispatchSyntheticWebhookForUser).toHaveBeenCalledWith(
		expect.objectContaining({
			params: {
				route: 'discord',
				dryRun: true,
				params: { text: 'hi' },
				synthetic: true,
			},
		}),
	)
})

test('webhookSyntheticDispatch rejects package runtime and background callers', async () => {
	await expect(
		webhookSyntheticDispatchCapability.handler(
			{
				kodyId: 'demo',
				webhookName: 'hook',
				params: { ok: true },
			},
			createCtx({
				storageContext: {
					packageId: 'pkg-1',
					appId: null,
					storageId: 'package:pkg-1',
				},
			}) as never,
		),
	).rejects.toThrow(McpCallerError)

	await expect(
		webhookSyntheticDispatchCapability.handler(
			{
				kodyId: 'demo',
				webhookName: 'hook',
				params: { ok: true },
			},
			createCtx({ executionOrigin: 'background' }) as never,
		),
	).rejects.toThrow(/unavailable from package runtime contexts/)

	expect(mocks.dispatchSyntheticWebhookForUser).not.toHaveBeenCalled()
})

test('webhookSyntheticDispatch requires a signed-in MCP user (owner path)', async () => {
	const ctx = {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://heykody.dev',
			executionOrigin: 'interactive',
			user: null,
			storageContext: null,
		}),
	}
	await expect(
		webhookSyntheticDispatchCapability.handler(
			{
				kodyId: 'demo',
				webhookName: 'hook',
				params: { ok: true },
			},
			ctx as never,
		),
	).rejects.toThrow()
	expect(mocks.dispatchSyntheticWebhookForUser).not.toHaveBeenCalled()
})
