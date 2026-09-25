import { expect, test, vi } from 'vitest'
import { type PackageAppServeOwner } from './package-app-serve.ts'
import { packageAppRuntimeForwardUnavailableMessage } from '#worker/runtime-worker-service.ts'

const runtimeForwardMock = vi.hoisted(() => ({
	hasLocalPackageAppRuntimeBridge: vi.fn(() => true),
	getRuntimeWorkerService: vi.fn(() => null),
	servePackageApp: vi.fn(),
	buildPackageAppWorker: vi.fn(),
	resolveSavedPackage: vi.fn(),
	createPackageAppCallerContext: vi.fn(),
}))

vi.mock('#worker/runtime-worker-service.ts', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('#worker/runtime-worker-service.ts')>()
	return {
		...actual,
		hasLocalPackageAppRuntimeBridge: () =>
			runtimeForwardMock.hasLocalPackageAppRuntimeBridge(),
		getRuntimeWorkerService: (...args: Array<unknown>) =>
			runtimeForwardMock.getRuntimeWorkerService(...args),
	}
})

vi.mock('#worker/package-invocations/module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		runtimeForwardMock.resolveSavedPackage(...args),
	loadInvokeManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-runtime/package-app.ts', () => ({
	buildPackageAppWorker: (...args: Array<unknown>) =>
		runtimeForwardMock.buildPackageAppWorker(...args),
	createPackageAppCallerContext: (...args: Array<unknown>) =>
		runtimeForwardMock.createPackageAppCallerContext(...args),
}))

const { servePackageAppRequest } = await import('./package-app-serve.ts')

const owner: PackageAppServeOwner = {
	userId: 'user-1',
	username: 'demo',
	email: 'demo@example.com',
	displayName: 'Demo',
}

function createServeInput(env: Env = {} as Env) {
	return {
		request: new Request('https://example.com/@demo/packages/hello/'),
		env,
		owner,
		packagePath: {
			username: 'demo',
			kodyId: 'hello',
			restPath: '/',
			mount: 'username-path' as const,
		},
		dispatch: { synthetic: true } as const,
	}
}

test('servePackageAppRequest forwards to RUNTIME_WORKER when PackageAppRuntimeBridge is missing', async () => {
	runtimeForwardMock.hasLocalPackageAppRuntimeBridge.mockReturnValue(false)
	const forwarded = new Response('from-runtime', { status: 200 })
	runtimeForwardMock.servePackageApp.mockResolvedValue(forwarded)
	runtimeForwardMock.getRuntimeWorkerService.mockReturnValue({
		fetch: vi.fn(),
		servePackageApp: runtimeForwardMock.servePackageApp,
	})

	const input = createServeInput({ RUNTIME_WORKER: {} } as Env)
	const response = await servePackageAppRequest(input)

	expect(response).toBe(forwarded)
	expect(runtimeForwardMock.servePackageApp).toHaveBeenCalledWith({
		request: input.request,
		owner: input.owner,
		packagePath: input.packagePath,
		dispatch: input.dispatch,
	})
	expect(runtimeForwardMock.buildPackageAppWorker).not.toHaveBeenCalled()
	expect(runtimeForwardMock.resolveSavedPackage).not.toHaveBeenCalled()
})

test('servePackageAppRequest stays local when PackageAppRuntimeBridge is available', async () => {
	runtimeForwardMock.hasLocalPackageAppRuntimeBridge.mockReturnValue(true)
	runtimeForwardMock.getRuntimeWorkerService.mockReturnValue({
		fetch: vi.fn(),
		servePackageApp: runtimeForwardMock.servePackageApp,
	})
	runtimeForwardMock.resolveSavedPackage.mockResolvedValue(null)

	const response = await servePackageAppRequest(
		createServeInput({ RUNTIME_WORKER: {} } as Env),
	)

	expect(response.status).toBe(404)
	expect(runtimeForwardMock.servePackageApp).not.toHaveBeenCalled()
	expect(runtimeForwardMock.resolveSavedPackage).toHaveBeenCalled()
})

test('servePackageAppRequest fails closed when PackageAppRuntimeBridge and RUNTIME_WORKER are both missing', async () => {
	runtimeForwardMock.hasLocalPackageAppRuntimeBridge.mockReturnValue(false)
	runtimeForwardMock.getRuntimeWorkerService.mockReturnValue(null)

	const response = await servePackageAppRequest(createServeInput({} as Env))

	expect(response.status).toBe(500)
	const body = (await response.json()) as { cause?: string }
	expect(body.cause).toBe(packageAppRuntimeForwardUnavailableMessage)
	expect(runtimeForwardMock.servePackageApp).not.toHaveBeenCalled()
	expect(runtimeForwardMock.resolveSavedPackage).not.toHaveBeenCalled()
	expect(runtimeForwardMock.buildPackageAppWorker).not.toHaveBeenCalled()
})
