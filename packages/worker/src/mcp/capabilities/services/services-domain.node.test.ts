import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	listSavedPackageServices: vi.fn(),
	packageServiceRpc: vi.fn(),
	getSavedPackageById: vi.fn(),
	normalizePackageServiceStatus: vi.fn((input: unknown) => input),
	packageServiceStatusSchema: {
		parse: vi.fn((input: unknown) => input),
		safeParse: vi.fn((input: unknown) => ({
			success: true,
			data: input,
		})),
	},
}))

vi.mock('#worker/package-runtime/package-service.ts', () => ({
	listSavedPackageServices: (...args: Array<unknown>) =>
		mockModule.listSavedPackageServices(...args),
	packageServiceRpc: (...args: Array<unknown>) =>
		mockModule.packageServiceRpc(...args),
	normalizePackageServiceStatus: (...args: Array<unknown>) =>
		mockModule.normalizePackageServiceStatus(...args),
	packageServiceStatusSchema: mockModule.packageServiceStatusSchema,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

const { serviceListCapability } = await import('./service-list.ts')
const { serviceGetCapability } = await import('./service-get.ts')
const { serviceStartCapability } = await import('./service-start.ts')
const { serviceStopCapability } = await import('./service-stop.ts')

function resetMocks() {
	mockModule.listSavedPackageServices.mockReset()
	mockModule.packageServiceRpc.mockReset()
	mockModule.getSavedPackageById.mockReset()
	mockModule.normalizePackageServiceStatus.mockClear()
	mockModule.packageServiceStatusSchema.parse.mockClear()
	mockModule.packageServiceStatusSchema.safeParse.mockClear()
}

function createCallerContext() {
	return createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-123',
			email: 'user@example.com',
			displayName: 'User Example',
		},
		storageContext: {
			sessionId: null,
			appId: 'package-123',
			storageId: 'package-123',
		},
	})
}

function createSavedPackage() {
	return {
		id: 'package-123',
		userId: 'user-123',
		name: '@scope/example',
		kodyId: 'example',
		description: 'Example package',
		tags: [],
		searchText: null,
		sourceId: 'source-123',
		hasApp: true,
		hidden: false,
		createdAt: '2026-04-24T00:00:00.000Z',
		updatedAt: '2026-04-24T00:00:00.000Z',
	}
}

test('package service capabilities list, tolerate status failures, and delegate RPC actions', async () => {
	resetMocks()
	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage())
	mockModule.listSavedPackageServices.mockResolvedValue({
		savedPackage: {
			id: 'package-123',
			kodyId: 'example',
		},
		services: [
			{
				name: 'realtime-supervisor',
				entry: 'services/realtime-supervisor.ts',
				autoStart: true,
				mode: 'persistent',
				timeoutMs: 300000,
			},
		],
		rpc: () => ({
			status: async () => ({
				package_id: 'package-123',
				kody_id: 'example',
				service_name: 'realtime-supervisor',
				status: 'stopped',
				auto_start: true,
				timeout_ms: 300000,
				stop_requested: false,
				active_run_id: null,
				next_alarm_at: null,
				last_error: null,
				last_started_at: null,
				last_stopped_at: null,
				last_run_finished_at: null,
				last_result: null,
			}),
		}),
	})
	mockModule.packageServiceRpc.mockImplementation(() => ({
		status: async () => ({
			package_id: 'package-123',
			kody_id: 'example',
			service_name: 'realtime-supervisor',
			status: 'stopped',
			auto_start: true,
			timeout_ms: 300000,
			stop_requested: false,
			active_run_id: null,
			next_alarm_at: null,
			last_error: null,
			last_started_at: null,
			last_stopped_at: null,
			last_run_finished_at: null,
			last_result: null,
		}),
	}))

	const env = {
		APP_DB: {} as D1Database,
	} as Env
	const callerContext = createCallerContext()

	const listed = await serviceListCapability.handler({}, { env, callerContext })
	expect(listed).toEqual({
		package_id: 'package-123',
		kody_id: 'example',
		services: [
			{
				name: 'realtime-supervisor',
				entry: 'services/realtime-supervisor.ts',
				auto_start: true,
				mode: 'persistent',
				status: 'stopped',
				timeout_ms: 300000,
			},
		],
	})

	resetMocks()
	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage())
	mockModule.listSavedPackageServices.mockResolvedValue({
		savedPackage: {
			id: 'package-123',
			kodyId: 'example',
		},
		services: [
			{
				name: 'realtime-supervisor',
				entry: 'services/realtime-supervisor.ts',
				autoStart: false,
				mode: 'bounded',
				timeoutMs: null,
			},
		],
		rpc: () => ({
			status: async () => {
				throw new Error('worker unavailable')
			},
		}),
	})

	const unknownStatus = await serviceListCapability.handler(
		{},
		{ env, callerContext },
	)
	expect(unknownStatus.services[0]?.status).toBe('unknown')

	resetMocks()
	mockModule.getSavedPackageById.mockResolvedValue(createSavedPackage())
	mockModule.packageServiceRpc.mockImplementation(() => ({
		status: async () => ({
			package_id: 'package-123',
			kody_id: 'example',
			service_name: 'realtime-supervisor',
			status: 'running',
			auto_start: false,
			timeout_ms: 300000,
			stop_requested: false,
			active_run_id: 'run-123',
			next_alarm_at: null,
			last_error: null,
			last_started_at: null,
			last_stopped_at: null,
			last_run_finished_at: null,
			last_result: null,
		}),
		start: async () => ({
			ok: true,
			run_id: 'run-123',
			started_at: '2026-04-24T00:00:00.000Z',
			status: 'running',
		}),
		stop: async () => ({
			ok: true,
		}),
	}))

	await expect(
		serviceGetCapability.handler(
			{
				service_name: 'realtime-supervisor',
			},
			{
				env,
				callerContext,
			},
		),
	).resolves.toMatchObject({
		service_name: 'realtime-supervisor',
		status: 'running',
		active_run_id: 'run-123',
	})

	await expect(
		serviceStartCapability.handler(
			{
				service_name: 'realtime-supervisor',
			},
			{
				env,
				callerContext,
			},
		),
	).resolves.toEqual({
		ok: true,
		run_id: 'run-123',
		started_at: '2026-04-24T00:00:00.000Z',
		status: 'running',
	})

	await expect(
		serviceStopCapability.handler(
			{
				service_name: 'realtime-supervisor',
			},
			{
				env,
				callerContext,
			},
		),
	).resolves.toEqual({
		ok: true,
	})
})
