import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'
import { type McpRegistrationAgent } from '#mcp/mcp-registration-agent.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
	getValue: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	collectIntegrationPackageSuggestions: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#mcp/values/service.ts', () => ({
	getValue: (...args: Array<unknown>) => mockModule.getValue(...args),
}))

vi.mock('./integration-package-suggestions.ts', () => ({
	collectIntegrationPackageSuggestions: (...args: Array<unknown>) =>
		mockModule.collectIntegrationPackageSuggestions(...args),
}))

const { resolveEntityDetail } = await import('./search-detail.ts')

function createAgent() {
	const callerContext = createMcpCallerContext({
		baseUrl: 'https://example.com',
		user: {
			userId: 'user-1',
			email: 'user@example.com',
			displayName: 'user',
		},
	})
	return {
		getEnv: () => ({ APP_DB: {} }) as Env,
		getCallerContext: () => callerContext,
	} as unknown as McpRegistrationAgent
}

function emptySearchRows() {
	return {
		userValueRows: [],
		userSecretRows: [],
		packageRows: [],
		registry: { capabilitySpecs: {} },
	}
}

test('resolveEntityDetail reports unresolvable entity refs as caller errors', async () => {
	mockModule.getValue.mockReset()
	mockModule.getValue.mockResolvedValue(null)

	const agent = createAgent()
	const callerContext = agent.getCallerContext()
	const searchRows = emptySearchRows() as never
	const resolve = (entity: string) =>
		resolveEntityDetail({
			agent,
			callerContext,
			userId: 'user-1',
			username: 'user',
			entity,
			searchRows,
		})

	const expected = [
		['nope:capability', 'Capability not found.'],
		['user:missing-value:value', 'Persisted value not found for this user.'],
		['notion:integration', 'Saved integration not found for this user.'],
		['API_KEY:secret', 'Secret not found for this user.'],
		[
			'not-a-ref',
			'Entity must use the format "{id}:{type}" where type is capability, package, secret, value, or integration.',
		],
		[
			'thing:widget',
			'Entity type must be one of: capability, package, secret, value, or integration.',
		],
		[
			'workspace:preferred_repo:value',
			'Value entity scope must be one of: session, app, or user.',
		],
	] as const

	for (const [entity, message] of expected) {
		const detail = resolve(entity)
		await expect(detail).rejects.toThrow(McpCallerError)
		await expect(detail).rejects.toThrow(message)
	}
})
