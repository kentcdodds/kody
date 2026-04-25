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

const { servicesDomain } = await import('./domain.ts')
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

test('services domain exposes package service lifecycle capabilities', () => {
	expect(servicesDomain.capabilities.map((capability) => capability.name)).toEqual(
		expect.arrayContaining([
			'service_list',
			'service_get',
			'service_start',
			'service_stop',
		]),
	)
})

test('service_list returns declared package services with live status', async () => {
	resetMocks()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-123',
		userId: 'user-123',
		name: '@scope/example',
		kodyId: 'example',
		description: 'Example package',
		tags: [],
		searchText: null,
		sourceId: 'source-123',
		hasApp: true,
		createdAt: '2026-04-24T00:00:00.000Z',
		updatedAt: '2026-04-24T00:00:00.000Z',
	})
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
	const result = await serviceListCapability.handler(
		{},
		{
			env: {
				APP_DB: {} as D1Database,
			} as Env,
			callerContext: createCallerContext(),
		},
	)

	expect(result).toEqual({
		package_id: 'package-123',
		kody_id: 'example',
		services: [
			{
				name: 'realtime-supervisor',
				entry: 'services/realtime-supervisor.ts',
				auto_start: true,
				status: 'stopped',
				timeout_ms: 300000,
			},
		],
	})
})

test('service_list marks status as unknown when a service status lookup fails', async () => {
	resetMocks()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-123',
		userId: 'user-123',
		name: '@scope/example',
		kodyId: 'example',
		description: 'Example package',
		tags: [],
		searchText: null,
		sourceId: 'source-123',
		hasApp: true,
		createdAt: '2026-04-24T00:00:00.000Z',
		updatedAt: '2026-04-24T00:00:00.000Z',
	})
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
				timeoutMs: null,
			},
		],
		rpc: () => ({
			status: async () => {
				throw new Error('worker unavailable')
			},
		}),
	})

	const result = await serviceListCapability.handler(
		{},
		{
			env: {
				APP_DB: {} as D1Database,
			} as Env,
			callerContext: createCallerContext(),
		},
	)

	expect(result).toEqual({
		package_id: 'package-123',
		kody_id: 'example',
		services: [
			{
				name: 'realtime-supervisor',
				entry: 'services/realtime-supervisor.ts',
				auto_start: false,
				status: 'unknown',
				timeout_ms: null,
			},
		],
	})
})

test('service_get, service_start, and service_stop delegate to package service RPC', async () => {
	resetMocks()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-123',
		userId: 'user-123',
		name: '@scope/example',
		kodyId: 'example',
		description: 'Example package',
		tags: [],
		searchText: null,
		sourceId: 'source-123',
		hasApp: true,
		createdAt: '2026-04-24T00:00:00.000Z',
		updatedAt: '2026-04-24T00:00:00.000Z',
	})
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

	const env = {
		APP_DB: {} as D1Database,
	} as Env
	const callerContext = createCallerContext()

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
