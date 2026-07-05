import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const mockModule = vi.hoisted(() => ({
	listSavedPackageServices: vi.fn(),
	packageServiceRpc: vi.fn(),
	getSavedPackageById: vi.fn(),
}))

vi.mock('#worker/package-runtime/package-service.ts', () => ({
	listSavedPackageServices: (...args: Array<unknown>) =>
		mockModule.listSavedPackageServices(...args),
	packageServiceRpc: (...args: Array<unknown>) =>
		mockModule.packageServiceRpc(...args),
	normalizePackageServiceStatus: vi.fn((input: unknown) => input),
	packageServiceStatusSchema: {
		parse: vi.fn((input: unknown) => input),
		safeParse: vi.fn((input: unknown) => ({
			success: true,
			data: input,
		})),
	},
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

const { serviceStartCapability } = await import('./service-start.ts')

function createEntitlementsTestDb(input: {
	users?: Array<{ email: string; plan: string | null }>
	packageServiceCount?: number
}) {
	const users = input.users ?? []
	const packageServiceCount = input.packageServiceCount ?? 0

	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (query.includes('SELECT plan FROM users')) {
								const user = users.find((row) => row.email === params[0])
								return (user ? { plan: user.plan } : null) as T | null
							}
							if (query.includes('FROM package_runtime_runs')) {
								return { count: packageServiceCount } as T
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async run() {
							throw new Error(`Unsupported run query: ${query}`)
						},
					}
				},
			}
		},
	} as unknown as D1Database
}

function createSavedPackage(input: { userId: string }) {
	return {
		id: 'package-123',
		userId: input.userId,
		name: '@scope/example',
		kodyId: 'example',
		description: 'Example package',
		tags: [],
		searchText: null,
		sourceId: 'source-123',
		hasApp: true,
		createdAt: '2026-04-24T00:00:00.000Z',
		updatedAt: '2026-04-24T00:00:00.000Z',
	}
}

function createPlanUserCallerContext(input: { userId: string; email: string }) {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: input.userId,
			email: input.email,
			displayName: 'Plan User',
		},
		storageContext: {
			sessionId: null,
			appId: 'package-123',
			storageId: 'package-123',
		},
	})
}

function mockDeclaredServices(
	mode: 'bounded' | 'persistent',
	serviceName = 'realtime-supervisor',
) {
	mockModule.listSavedPackageServices.mockResolvedValue({
		savedPackage: {
			id: 'package-123',
			kodyId: 'example',
		},
		services: [
			{
				name: serviceName,
				entry: 'services/realtime-supervisor.ts',
				autoStart: false,
				mode,
				timeoutMs: null,
			},
		],
	})
}

function mockServiceRpc(input: {
	status: 'running' | 'stopped'
	startResult?: Record<string, unknown>
}) {
	const startResult = input.startResult ?? {
		ok: true,
		run_id: 'run-123',
		started_at: '2026-04-24T00:00:00.000Z',
		status: 'running',
	}
	mockModule.packageServiceRpc.mockImplementation(() => ({
		status: async () => ({
			package_id: 'package-123',
			kody_id: 'example',
			service_name: 'realtime-supervisor',
			status: input.status,
			auto_start: false,
			timeout_ms: null,
			stop_requested: false,
			active_run_id: input.status === 'running' ? 'run-123' : null,
			next_alarm_at: null,
			last_error: null,
			last_started_at: null,
			last_stopped_at: null,
			last_run_finished_at: null,
			last_result: null,
		}),
		start: async () => startResult,
	}))
}

test('service_start denies persistent services for personal plan users', async () => {
	const email = 'planned@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const env = {
		APP_DB: createEntitlementsTestDb({
			users: [{ email, plan: 'personal' }],
		}),
	} as Env
	const callerContext = createPlanUserCallerContext({ userId, email })

	mockModule.getSavedPackageById.mockResolvedValue(
		createSavedPackage({ userId }),
	)
	mockDeclaredServices('persistent')
	mockServiceRpc({ status: 'stopped' })

	const error = await serviceStartCapability
		.handler({ service_name: 'realtime-supervisor' }, { env, callerContext })
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)
	if (!isEntitlementLimitError(error)) {
		throw new Error('Expected an EntitlementLimitError from service_start.')
	}
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'persistent_package_services',
		plan: 'personal',
		limit: 0,
		current: 0,
	})
})

test('service_start denies bounded starts at the package_services limit', async () => {
	const email = 'bounded-limit@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.personal.maxPackageServices
	if (limit === null) {
		throw new Error('Expected a numeric personal package service limit.')
	}
	const env = {
		APP_DB: createEntitlementsTestDb({
			users: [{ email, plan: 'personal' }],
			packageServiceCount: limit,
		}),
	} as Env
	const callerContext = createPlanUserCallerContext({ userId, email })

	mockModule.getSavedPackageById.mockResolvedValue(
		createSavedPackage({ userId }),
	)
	mockDeclaredServices('bounded')
	mockServiceRpc({ status: 'stopped' })

	const error = await serviceStartCapability
		.handler({ service_name: 'realtime-supervisor' }, { env, callerContext })
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)
	if (!isEntitlementLimitError(error)) {
		throw new Error('Expected an EntitlementLimitError from service_start.')
	}
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'package_services',
		plan: 'personal',
		limit,
		current: limit,
	})
})

test('service_start skips enforcement when the service is already running', async () => {
	const email = 'running@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.personal.maxPackageServices
	if (limit === null) {
		throw new Error('Expected a numeric personal package service limit.')
	}
	const env = {
		APP_DB: createEntitlementsTestDb({
			users: [{ email, plan: 'personal' }],
			packageServiceCount: limit,
		}),
	} as Env
	const callerContext = createPlanUserCallerContext({ userId, email })

	mockModule.getSavedPackageById.mockResolvedValue(
		createSavedPackage({ userId }),
	)
	mockServiceRpc({
		status: 'running',
		startResult: {
			ok: true,
			run_id: 'run-123',
			started_at: '2026-04-24T00:00:00.000Z',
			status: 'running',
			already_running: true,
		},
	})

	await expect(
		serviceStartCapability.handler(
			{ service_name: 'realtime-supervisor' },
			{ env, callerContext },
		),
	).resolves.toMatchObject({
		ok: true,
		run_id: 'run-123',
		already_running: true,
	})
	expect(mockModule.listSavedPackageServices).not.toHaveBeenCalled()
})

test('service_start stays unlimited for users without a plan', async () => {
	const email = 'legacy@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.personal.maxPackageServices
	if (limit === null) {
		throw new Error('Expected a numeric personal package service limit.')
	}
	const env = {
		APP_DB: createEntitlementsTestDb({
			users: [{ email, plan: null }],
			packageServiceCount: limit + 1,
		}),
	} as Env
	const callerContext = createPlanUserCallerContext({ userId, email })

	mockModule.getSavedPackageById.mockResolvedValue(
		createSavedPackage({ userId }),
	)
	mockDeclaredServices('persistent')
	mockServiceRpc({ status: 'stopped' })

	await expect(
		serviceStartCapability.handler(
			{ service_name: 'realtime-supervisor' },
			{ env, callerContext },
		),
	).resolves.toMatchObject({
		ok: true,
		run_id: 'run-123',
	})
})
