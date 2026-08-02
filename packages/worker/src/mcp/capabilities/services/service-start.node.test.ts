import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { isEntitlementLimitError } from '#worker/entitlements/errors.ts'
import { planLimits } from '#worker/entitlements/plans.ts'
import { createInMemoryUserMeterEnv } from '#worker/test-support/user-meter.ts'
import { type UserMeterRpc } from '#worker/entitlements/user-meter-client.ts'
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
}) {
	const users = input.users ?? []

	return {
		prepare(query: string) {
			return {
				bind(...params: Array<unknown>) {
					return {
						async first<T>() {
							if (query.includes('SELECT plan, stripe_plan FROM users')) {
								const user = users.find((row) => row.email === params[0])
								return (user ? { plan: user.plan } : null) as T | null
							}
							throw new Error(`Unsupported first query: ${query}`)
						},
						async all<T>(): Promise<{ results: Array<T> }> {
							throw new Error(`Unsupported all() query: ${query}`)
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
		hidden: false,
		isPrivate: false,
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

function buildRunningServices(count: number) {
	return Array.from({ length: count }, (_, index) => ({
		packageId: `other-package-${index}`,
		serviceName: `service-${index}`,
	}))
}

async function seedRunningServicesInMeter(
	meterEnv: { USER_METER?: DurableObjectNamespace },
	userId: string,
	services: ReadonlyArray<{ packageId: string; serviceName: string }>,
) {
	const freshAt = new Date().toISOString()
	const meter = meterEnv.USER_METER!.get(
		meterEnv.USER_METER!.idFromName(userId),
	) as unknown as UserMeterRpc
	for (const service of services) {
		await meter.upsertPackageServiceState({
			packageId: service.packageId,
			serviceName: service.serviceName,
			status: 'running',
			startedAt: freshAt,
			sourceUpdatedAt: freshAt,
		})
	}
}

test('service_start denies persistent services for free plan users', async () => {
	const email = 'planned@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const env = {
		APP_DB: createEntitlementsTestDb({
			users: [{ email, plan: 'free' }],
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
		plan: 'free',
		limit: 0,
		current: 0,
	})
})

test('service_start denies bounded starts at the package_services limit', async () => {
	const email = 'bounded-limit@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxPackageServices
	if (limit === null) {
		throw new Error('Expected a numeric pro package service limit.')
	}
	const { env: meterEnv } = createInMemoryUserMeterEnv()
	await seedRunningServicesInMeter(
		meterEnv,
		userId,
		buildRunningServices(limit),
	)
	const env = {
		APP_DB: createEntitlementsTestDb({ users: [{ email, plan: 'pro' }] }),
		...meterEnv,
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
		plan: 'pro',
		limit,
		current: limit,
	})
})

test('service_start skips enforcement when the service is already running', async () => {
	const email = 'running@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxPackageServices
	if (limit === null) {
		throw new Error('Expected a numeric pro package service limit.')
	}
	// Enforcement is skipped entirely when the service is already running;
	// USER_METER and running service count are not consulted.
	const env = {
		APP_DB: createEntitlementsTestDb({ users: [{ email, plan: 'pro' }] }),
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

test('service_start lets a stale running row for the same service restart at the limit', async () => {
	const email = 'stale-restart@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const limit = planLimits.pro.maxPackageServices
	if (limit === null) {
		throw new Error('Expected a numeric pro package service limit.')
	}
	// The target service itself holds one of the 'running' telemetry rows
	// (stale after a hard eviction); excluding it keeps the restart under
	// the limit.
	const { env: meterEnv } = createInMemoryUserMeterEnv()
	await seedRunningServicesInMeter(meterEnv, userId, [
		...buildRunningServices(limit - 1),
		{ packageId: 'package-123', serviceName: 'realtime-supervisor' },
	])
	const env = {
		APP_DB: createEntitlementsTestDb({ users: [{ email, plan: 'pro' }] }),
		...meterEnv,
	} as Env
	const callerContext = createPlanUserCallerContext({ userId, email })

	mockModule.getSavedPackageById.mockResolvedValue(
		createSavedPackage({ userId }),
	)
	mockDeclaredServices('bounded')
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

test('service_start allows below-max usage and denies at the max plan ceiling', async () => {
	const email = 'max@example.com'
	const userId = await createStableUserIdFromEmail(email)
	const maxLimit = planLimits.max.maxPackageServices
	const { env: belowMaxMeterEnv } = createInMemoryUserMeterEnv()
	await seedRunningServicesInMeter(
		belowMaxMeterEnv,
		userId,
		buildRunningServices(planLimits.pro.maxPackageServices + 1),
	)
	const belowMaxEnv = {
		APP_DB: createEntitlementsTestDb({ users: [{ email, plan: 'max' }] }),
		...belowMaxMeterEnv,
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
			{ env: belowMaxEnv, callerContext },
		),
	).resolves.toMatchObject({
		ok: true,
		run_id: 'run-123',
	})

	const { env: atCeilingMeterEnv } = createInMemoryUserMeterEnv()
	await seedRunningServicesInMeter(
		atCeilingMeterEnv,
		userId,
		buildRunningServices(maxLimit),
	)
	const atCeilingEnv = {
		APP_DB: createEntitlementsTestDb({ users: [{ email, plan: 'max' }] }),
		...atCeilingMeterEnv,
	} as Env
	mockModule.getSavedPackageById.mockResolvedValue(
		createSavedPackage({ userId }),
	)
	mockDeclaredServices('persistent')
	mockServiceRpc({ status: 'stopped' })

	const error = await serviceStartCapability
		.handler(
			{ service_name: 'realtime-supervisor' },
			{ env: atCeilingEnv, callerContext },
		)
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)
	if (!isEntitlementLimitError(error)) {
		throw new Error(
			'Expected an EntitlementLimitError at the max package service ceiling.',
		)
	}
	expect(error.details).toMatchObject({
		code: 'entitlement_limit_exceeded',
		resource: 'package_services',
		plan: 'max',
		limit: maxLimit,
		current: maxLimit,
	})
})
