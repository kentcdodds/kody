import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	listValues: vi.fn(),
	saveValue: vi.fn(),
}))

vi.mock('#mcp/values/service.ts', () => ({
	listValues: (...args: Array<unknown>) => mockModule.listValues(...args),
	saveValue: (...args: Array<unknown>) => mockModule.saveValue(...args),
}))

const { valueListCapability } = await import('./value-list.ts')
const { valueSetCapability } = await import('./value-set.ts')

function buildCallerContext() {
	return createMcpCallerContext({
		baseUrl: 'https://heykody.dev',
		user: {
			userId: 'user-1',
			email: 'user-1@example.com',
			displayName: 'user-1',
		},
	})
}

test('value_list omits platform-reserved integration and openapi values', async () => {
	mockModule.listValues.mockResolvedValue([
		{
			name: 'preferred_repo',
			scope: 'user',
			value: 'kentcdodds/kody',
			description: 'Preferred repo',
			appId: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			ttlMs: null,
		},
		{
			name: '_integration:github',
			scope: 'user',
			value: '{}',
			description: 'GitHub OAuth integration',
			appId: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			ttlMs: null,
		},
		{
			name: '_openapi:widgets',
			scope: 'user',
			value: '{}',
			description: 'Widgets OpenAPI binding',
			appId: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			ttlMs: null,
		},
	])

	const result = await valueListCapability.handler(
		{},
		{
			env: {} as Env,
			callerContext: buildCallerContext(),
		},
	)

	expect(result.values).toEqual([
		{
			name: 'preferred_repo',
			scope: 'user',
			value: 'kentcdodds/kody',
			description: 'Preferred repo',
			app_id: null,
			created_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-01-01T00:00:00.000Z',
			ttl_ms: null,
		},
	])
})

test('value_set rejects platform-reserved prefixes with actionable errors', async () => {
	const env = {} as Env
	const callerContext = buildCallerContext()

	await expect(
		valueSetCapability.handler(
			{
				name: '_integration:github',
				value: '{}',
				scope: 'user',
			},
			{ env, callerContext },
		),
	).rejects.toThrow('Use integration_save instead of value_set.')

	await expect(
		valueSetCapability.handler(
			{
				name: '_openapi:widgets',
				value: '{}',
				scope: 'user',
			},
			{ env, callerContext },
		),
	).rejects.toThrow('Use openapi_binding_save instead of value_set.')

	expect(mockModule.saveValue).not.toHaveBeenCalled()
})
