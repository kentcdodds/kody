import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mocks = vi.hoisted(() => ({
	getCommunityListingWithAggregates: vi.fn(),
}))

vi.mock('#worker/community/service.ts', () => ({
	getCommunityListingWithAggregates: (...args: Array<unknown>) =>
		mocks.getCommunityListingWithAggregates(...args),
}))

const { communityGetCapability } = await import('./get.ts')

function createContext() {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://example.com',
			user: {
				userId: 'user-alice',
				email: 'alice@example.com',
				displayName: 'Alice',
				username: 'alice',
			},
		}),
	}
}

test('community_get throws McpCallerError when the listing is missing', async () => {
	mocks.getCommunityListingWithAggregates.mockResolvedValue(null)

	const error = await communityGetCapability
		.handler({ listing_id: 'missing-listing' }, createContext())
		.then(
			() => null,
			(thrown: unknown) => thrown,
		)

	expect(error).toBeInstanceOf(McpCallerError)
	expect(error).toMatchObject({
		message: 'Community listing not found.',
	})
})
