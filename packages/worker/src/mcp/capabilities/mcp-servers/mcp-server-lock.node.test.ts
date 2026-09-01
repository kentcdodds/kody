import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	resolveMcpServerSetting: vi.fn(),
	lockMcpServerToPackage: vi.fn(),
}))

vi.mock('./shared.ts', () => ({
	resolveMcpServerSetting: (...args: Array<unknown>) =>
		mockModule.resolveMcpServerSetting(...args),
}))

vi.mock('#worker/mcp-client/settings-service.ts', () => ({
	lockMcpServerToPackage: (...args: Array<unknown>) =>
		mockModule.lockMcpServerToPackage(...args),
}))

const { mcpServerLockCapability } = await import('./mcp-server-lock.ts')

test('mcpServerLock grants a package and rejects missing packages', async () => {
	mockModule.resolveMcpServerSetting.mockResolvedValue({
		id: 'server-1',
		name: 'linear',
	})
	mockModule.lockMcpServerToPackage.mockResolvedValue({
		id: 'server-1',
		name: 'linear',
		allowedPackageIds: ['pkg-drafts'],
	})

	const ctx = {
		env: {} as Env,
		callerContext: createMcpCallerContext({
			baseUrl: 'https://kody.codes',
			user: {
				userId: 'user-1',
				email: 'alice@example.com',
				displayName: 'Alice',
			},
		}),
	}

	await expect(
		mcpServerLockCapability.handler(
			{ server: 'linear', package_id: 'pkg-drafts' },
			ctx,
		),
	).resolves.toEqual({
		id: 'server-1',
		name: 'linear',
		usage_mode: 'packages',
		allowed_package_ids: ['pkg-drafts'],
		usage_url: 'https://kody.codes/account/mcp-servers/server-1',
	})
	expect(mockModule.lockMcpServerToPackage).toHaveBeenCalledWith({
		env: ctx.env,
		userId: 'user-1',
		id: 'server-1',
		packageId: 'pkg-drafts',
	})

	mockModule.lockMcpServerToPackage.mockRejectedValueOnce(
		new Error('Saved package not found for this user.'),
	)
	const missing = await mcpServerLockCapability
		.handler({ server: 'linear', package_id: 'missing' }, ctx)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missing).toBeInstanceOf(McpCallerError)
	expect((missing as Error).message).toContain('Saved package not found')
})
