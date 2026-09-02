import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { getStaticRegistry } from '#mcp/capabilities/registry.ts'
import {
	createRemovedValueWriteError,
	removedValueWriteMessage,
} from './shared.ts'

const mockModule = vi.hoisted(() => ({
	listValues: vi.fn(),
}))

vi.mock('#mcp/values/service.ts', () => ({
	listValues: (...args: Array<unknown>) => mockModule.listValues(...args),
}))

const { valueListCapability } = await import('./value-list.ts')

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

test('value list treats underscore-prefixed names as ordinary leftovers', async () => {
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
})

test('values domain is unadvertised while read and delete stay on the map', async () => {
	const registry = await getStaticRegistry()
	expect(
		registry.capabilityDomains.some((domain) => domain.name === 'values'),
	).toBe(false)
	expect(registry.capabilitySpecs.valueGet).toBeUndefined()
	expect(registry.capabilitySpecs.valueList).toBeUndefined()
	expect(registry.capabilitySpecs.valueDelete).toBeUndefined()
	expect(registry.capabilityMap.valueGet).toBeTruthy()
	expect(registry.capabilityMap.valueList).toBeTruthy()
	expect(registry.capabilityMap.valueDelete).toBeTruthy()
	expect(createRemovedValueWriteError().message).toBe(removedValueWriteMessage)
	expect(removedValueWriteMessage).toMatch(/memories/)
	expect(removedValueWriteMessage).toMatch(/packageStorage/)
	expect(removedValueWriteMessage).toMatch(/repo/)
	expect(removedValueWriteMessage).toMatch(/secrets/)
})
