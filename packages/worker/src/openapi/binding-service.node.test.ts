import { expect, test, vi } from 'vitest'
import { type OpenApiBinding } from './binding-shared.ts'

const mockModule = vi.hoisted(() => ({
	listOpenApiBindingsForUser: vi.fn(),
	getOpenApiBindingByName: vi.fn(),
	upsertOpenApiBinding: vi.fn(),
	deleteOpenApiBindingByName: vi.fn(),
}))

vi.mock('#worker/openapi/repo.ts', () => ({
	listOpenApiBindingsForUser: (...args: Array<unknown>) =>
		mockModule.listOpenApiBindingsForUser(...args),
	getOpenApiBindingByName: (...args: Array<unknown>) =>
		mockModule.getOpenApiBindingByName(...args),
	upsertOpenApiBinding: (...args: Array<unknown>) =>
		mockModule.upsertOpenApiBinding(...args),
	deleteOpenApiBindingByName: (...args: Array<unknown>) =>
		mockModule.deleteOpenApiBindingByName(...args),
}))

const {
	clearOpenApiBindingsCacheForTests,
	deleteOpenApiBinding,
	listOpenApiBindingsCached,
	openApiBindingsCacheTtlMs,
	saveOpenApiBinding,
} = await import('./binding-service.ts')

function setupBindingFixture() {
	clearOpenApiBindingsCacheForTests()
	mockModule.listOpenApiBindingsForUser.mockResolvedValue([])
	mockModule.getOpenApiBindingByName.mockResolvedValue(null)
	mockModule.upsertOpenApiBinding.mockResolvedValue(undefined)
	mockModule.deleteOpenApiBindingByName.mockResolvedValue(true)
}

test('listOpenApiBindingsCached serves warm calls without a D1 read, per user', async () => {
	setupBindingFixture()
	const env = { APP_DB: {} } as Env

	const first = await listOpenApiBindingsCached({ env, userId: 'user-1' })
	const second = await listOpenApiBindingsCached({ env, userId: 'user-1' })

	expect(second).toBe(first)
	expect(mockModule.listOpenApiBindingsForUser).toHaveBeenCalledTimes(1)

	await listOpenApiBindingsCached({ env, userId: 'user-2' })
	// Another user's lookup must not reuse user-1's entry.
	expect(mockModule.listOpenApiBindingsForUser).toHaveBeenCalledTimes(2)
	expect(mockModule.listOpenApiBindingsForUser).toHaveBeenLastCalledWith(
		expect.objectContaining({ userId: 'user-2' }),
	)
})

test('listOpenApiBindingsCached expires after its TTL', async () => {
	setupBindingFixture()
	vi.useFakeTimers()
	try {
		const env = { APP_DB: {} } as Env
		await listOpenApiBindingsCached({ env, userId: 'user-1' })
		vi.setSystemTime(Date.now() + openApiBindingsCacheTtlMs + 1)
		await listOpenApiBindingsCached({ env, userId: 'user-1' })
		expect(mockModule.listOpenApiBindingsForUser).toHaveBeenCalledTimes(2)
	} finally {
		vi.useRealTimers()
	}
})

test('save and delete invalidate the bindings cache in the same isolate', async () => {
	setupBindingFixture()
	const env = { APP_DB: {} } as Env
	await listOpenApiBindingsCached({ env, userId: 'user-1' })
	expect(mockModule.listOpenApiBindingsForUser).toHaveBeenCalledTimes(1)

	await saveOpenApiBinding({
		env,
		userId: 'user-1',
		binding: { name: 'petstore' } as OpenApiBinding,
	})
	await listOpenApiBindingsCached({ env, userId: 'user-1' })
	expect(mockModule.listOpenApiBindingsForUser).toHaveBeenCalledTimes(2)

	await deleteOpenApiBinding({ env, userId: 'user-1', name: 'petstore' })
	await listOpenApiBindingsCached({ env, userId: 'user-1' })
	expect(mockModule.listOpenApiBindingsForUser).toHaveBeenCalledTimes(3)
})
