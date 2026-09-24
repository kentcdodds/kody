import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'

const mocks = vi.hoisted(() => ({
	resolveSavedPackage: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	listPackageWebhooks: vi.fn(),
	getWebhookEndpointByKey: vi.fn(),
	dispatchWebhookInvocation: vi.fn(),
	readWebhookInvocationResult: vi.fn((body: unknown) =>
		body && typeof body === 'object'
			? (body as Record<string, unknown>)['result']
			: undefined,
	),
	recordWebhookDelivery: vi.fn(),
	readPreExecutionPackageInvocationInfrastructureCode: vi.fn(() => null),
	collectSafeWebhookHeaders: vi.fn(() => ({
		'content-type': 'application/json',
	})),
	buildWebhookExportParams: vi.fn(
		(input: {
			packageKodyId: string
			webhookName: string
			bodyText: string
			receivedAt: string
		}) => ({
			webhook: {
				packageKodyId: input.packageKodyId,
				name: input.webhookName,
				receivedAt: input.receivedAt,
			},
			request: {
				method: 'POST',
				contentType: 'application/json',
				headers: { 'content-type': 'application/json' },
				body: input.bodyText,
				json: input.bodyText ? JSON.parse(input.bodyText) : null,
			},
		}),
	),
	resolveWebhookParamsModeFirstArg: vi.fn((json: unknown) => {
		if (!json || typeof json !== 'object' || Array.isArray(json)) {
			return { ok: false as const, code: 'invalid_params' as const }
		}
		return { ok: true as const, params: json as Record<string, unknown> }
	}),
}))

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mocks.resolveSavedPackage(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mocks.loadPackageManifestBySourceId(...args),
}))

vi.mock('#worker/package-registry/manifest.ts', () => ({
	listPackageWebhooks: (...args: Array<unknown>) =>
		mocks.listPackageWebhooks(...args),
}))

vi.mock('./repo.ts', () => ({
	getWebhookEndpointByKey: (...args: Array<unknown>) =>
		mocks.getWebhookEndpointByKey(...args),
	getWebhookEndpointByIdForUser: vi.fn(),
	listWebhookEndpointsForUser: vi.fn(),
	setWebhookEndpointEnabled: vi.fn(),
	upsertWebhookEndpointSecret: vi.fn(),
}))

vi.mock('./delivery.ts', () => ({
	dispatchWebhookInvocation: (...args: Array<unknown>) =>
		mocks.dispatchWebhookInvocation(...args),
	readWebhookInvocationResult: (...args: Array<unknown>) =>
		mocks.readWebhookInvocationResult(...args),
	recordWebhookDelivery: (...args: Array<unknown>) =>
		mocks.recordWebhookDelivery(...args),
}))

vi.mock('#worker/package-invocations/infrastructure-codes.ts', () => ({
	readPreExecutionPackageInvocationInfrastructureCode: (
		...args: Array<unknown>
	) => mocks.readPreExecutionPackageInvocationInfrastructureCode(...args),
}))

vi.mock('./headers.ts', () => ({
	collectSafeWebhookHeaders: (...args: Array<unknown>) =>
		mocks.collectSafeWebhookHeaders(...args),
}))

vi.mock('./params.ts', () => ({
	buildWebhookExportParams: (...args: Array<unknown>) =>
		mocks.buildWebhookExportParams(...args),
	resolveWebhookParamsModeFirstArg: (...args: Array<unknown>) =>
		mocks.resolveWebhookParamsModeFirstArg(...args),
}))

const { dispatchSyntheticWebhookForUser } = await import('./service.ts')

function mockPackage(input?: {
	inputMode?: 'request' | 'params'
	minted?: boolean
}) {
	mocks.resolveSavedPackage.mockResolvedValue({
		id: 'pkg-1',
		userId: 'user-1',
		sourceId: 'source-1',
		kodyId: 'demo',
		name: '@user/demo',
	})
	mocks.loadPackageManifestBySourceId.mockResolvedValue({
		manifest: { name: '@user/demo' },
	})
	mocks.listPackageWebhooks.mockReturnValue([
		{
			name: 'hook',
			exportName: './handle-hook',
			description: null,
			responseMode: 'ack',
			inputMode: input?.inputMode ?? 'request',
			rateLimitPerMinute: 60,
			verification: null,
			replay: null,
		},
	])
	mocks.getWebhookEndpointByKey.mockResolvedValue(
		input?.minted === false
			? null
			: {
					id: 'endpoint-1',
					userId: 'user-1',
					packageId: 'pkg-1',
					webhookName: 'hook',
					enabled: true,
				},
	)
	mocks.dispatchWebhookInvocation.mockResolvedValue({
		status: 200,
		body: { result: { ok: true } },
	})
	mocks.recordWebhookDelivery.mockResolvedValue({ id: 'run-1' })
}

test('dispatchSyntheticWebhookForUser builds request-mode export params with synthetic: true', async () => {
	mockPackage({ inputMode: 'request' })

	const result = await dispatchSyntheticWebhookForUser({
		env: { APP_DB: {} } as Env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		kodyId: 'demo',
		webhookName: 'hook',
		request: {
			json: { hello: 'world' },
			headers: { 'x-test': '1' },
		},
	})

	expect(result).toMatchObject({
		packageId: 'pkg-1',
		packageKodyId: 'demo',
		webhookName: 'hook',
		inputMode: 'request',
		synthetic: true,
		status: 200,
		runId: 'run-1',
		result: { ok: true },
	})
	expect(result.idempotencyKey).toMatch(/^synthetic:/)
	expect(mocks.dispatchWebhookInvocation).toHaveBeenCalledWith(
		expect.objectContaining({
			exportName: './handle-hook',
			endpoint: expect.objectContaining({ id: 'endpoint-1' }),
			params: expect.objectContaining({
				synthetic: true,
				webhook: expect.objectContaining({
					packageKodyId: 'demo',
					name: 'hook',
				}),
				request: expect.objectContaining({
					json: { hello: 'world' },
				}),
			}),
		}),
	)
	expect(mocks.recordWebhookDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			synthetic: true,
			outcome: 'delivered',
			kodyId: 'demo',
		}),
	)
})

test('dispatchSyntheticWebhookForUser preserves params-mode siblings and forces synthetic: true', async () => {
	mockPackage({ inputMode: 'params' })

	await dispatchSyntheticWebhookForUser({
		env: { APP_DB: {} } as Env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		packageId: 'pkg-1',
		webhookName: 'hook',
		params: {
			route: 'discord',
			dryRun: true,
			params: { text: 'hi' },
			synthetic: false,
		},
	})

	expect(mocks.dispatchWebhookInvocation).toHaveBeenCalledWith(
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

test('dispatchSyntheticWebhookForUser requires minted webhook and matching fixture mode', async () => {
	mockPackage({ minted: false })
	await expect(
		dispatchSyntheticWebhookForUser({
			env: { APP_DB: {} } as Env,
			userId: 'user-1',
			baseUrl: 'https://heykody.dev',
			kodyId: 'demo',
			webhookName: 'hook',
			request: { json: {} },
		}),
	).rejects.toThrow(McpCallerError)

	mockPackage({ inputMode: 'request' })
	await expect(
		dispatchSyntheticWebhookForUser({
			env: { APP_DB: {} } as Env,
			userId: 'user-1',
			baseUrl: 'https://heykody.dev',
			kodyId: 'demo',
			webhookName: 'hook',
			params: { ok: true },
		}),
	).rejects.toThrow(/inputMode "request"/)
})

test('dispatchSyntheticWebhookForUser uses the normal webhook invocation helper that burns automation usage', async () => {
	mockPackage({ inputMode: 'params' })
	await dispatchSyntheticWebhookForUser({
		env: { APP_DB: {} } as Env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		kodyId: 'demo',
		webhookName: 'hook',
		params: { ok: true },
	})
	// Same helper as real ingress (`internal:webhook:<endpointId>` actor token).
	expect(mocks.dispatchWebhookInvocation).toHaveBeenCalledTimes(1)
	expect(mocks.dispatchWebhookInvocation).toHaveBeenCalledWith(
		expect.objectContaining({
			endpoint: expect.objectContaining({ id: 'endpoint-1', userId: 'user-1' }),
		}),
	)
})

test('dispatchSyntheticWebhookForUser is owner-scoped (missing package for user)', async () => {
	mocks.resolveSavedPackage.mockResolvedValue(null)
	await expect(
		dispatchSyntheticWebhookForUser({
			env: { APP_DB: {} } as Env,
			userId: 'other-user',
			baseUrl: 'https://heykody.dev',
			kodyId: 'demo',
			webhookName: 'hook',
			request: { json: {} },
		}),
	).rejects.toThrow(/not found for this user/)
	expect(mocks.dispatchWebhookInvocation).not.toHaveBeenCalled()
})

test('dispatchSyntheticWebhookForUser forwards declared verification headers like ingress', async () => {
	mockPackage({ inputMode: 'request' })
	mocks.listPackageWebhooks.mockReturnValue([
		{
			name: 'hook',
			exportName: './handle-hook',
			description: null,
			responseMode: 'ack',
			inputMode: 'request',
			rateLimitPerMinute: 60,
			verification: {
				type: 'hmac-sha256',
				header: 'x-acme-signature',
				secretName: 'acmeWebhookSecret',
				encoding: 'hex',
			},
			replay: {
				timestampHeader: 'x-acme-timestamp',
				deliveryIdHeader: 'x-acme-delivery',
			},
		},
	])

	await dispatchSyntheticWebhookForUser({
		env: { APP_DB: {} } as Env,
		userId: 'user-1',
		baseUrl: 'https://heykody.dev',
		kodyId: 'demo',
		webhookName: 'hook',
		request: {
			json: { ok: true },
			headers: {
				'x-acme-signature': 'sig',
				'x-acme-timestamp': '1',
				'x-acme-delivery': 'd1',
			},
		},
	})

	expect(mocks.collectSafeWebhookHeaders).toHaveBeenCalledWith(
		expect.any(Request),
		expect.arrayContaining([
			'x-acme-signature',
			'x-acme-timestamp',
			'x-acme-delivery',
			'Idempotency-Key',
		]),
	)
})

test('dispatchSyntheticWebhookForUser rejects fixtures over the ingress payload cap', async () => {
	mockPackage({ inputMode: 'request' })
	await expect(
		dispatchSyntheticWebhookForUser({
			env: { APP_DB: {} } as Env,
			userId: 'user-1',
			baseUrl: 'https://heykody.dev',
			kodyId: 'demo',
			webhookName: 'hook',
			request: {
				body: 'x'.repeat(1_048_577),
			},
		}),
	).rejects.toThrow(/payload limit/)
	expect(mocks.dispatchWebhookInvocation).not.toHaveBeenCalled()
})

test('dispatchSyntheticWebhookForUser does not re-finish a successful invoke as failed when persistence throws', async () => {
	mockPackage({ inputMode: 'params' })
	mocks.recordWebhookDelivery.mockRejectedValueOnce(
		new Error('Webhook synthetic delivery record was not persisted.'),
	)
	await expect(
		dispatchSyntheticWebhookForUser({
			env: { APP_DB: {} } as Env,
			userId: 'user-1',
			baseUrl: 'https://heykody.dev',
			kodyId: 'demo',
			webhookName: 'hook',
			params: { ok: true },
		}),
	).rejects.toThrow(/not persisted/)
	expect(mocks.recordWebhookDelivery).toHaveBeenCalledTimes(1)
	expect(mocks.recordWebhookDelivery).toHaveBeenCalledWith(
		expect.objectContaining({ outcome: 'delivered' }),
	)
})
