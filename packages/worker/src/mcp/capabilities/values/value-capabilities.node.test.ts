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

test('value list/set treat underscore-prefixed names as ordinary values', async () => {
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
			name: '_scratch:notes',
			scope: 'user',
			value: 'todo',
			description: 'Scratch notes',
			appId: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
			ttlMs: null,
		},
	])
	mockModule.saveValue.mockResolvedValue({
		name: '_scratch:notes',
		scope: 'user',
		value: 'updated',
		description: 'Scratch notes',
		appId: null,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		ttlMs: null,
	})

	const listed = await valueListCapability.handler(
		{},
		{
			env: {} as Env,
			callerContext: buildCallerContext(),
		},
	)
	expect(listed.values.map((entry) => entry.name)).toEqual([
		'preferred_repo',
		'_scratch:notes',
	])

	const env = {} as Env
	const callerContext = buildCallerContext()
	await expect(
		valueSetCapability.handler(
			{
				name: '_scratch:notes',
				value: 'updated',
				scope: 'user',
			},
			{ env, callerContext },
		),
	).resolves.toMatchObject({
		name: '_scratch:notes',
		value: 'updated',
	})
	expect(mockModule.saveValue).toHaveBeenCalledWith(
		expect.objectContaining({
			name: '_scratch:notes',
			value: 'updated',
			scope: 'user',
		}),
	)
})
