import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	lockIntegrationToPackage: vi.fn(),
}))

vi.mock('#worker/integrations/service.ts', () => ({
	lockIntegrationToPackage: (...args: Array<unknown>) =>
		mockModule.lockIntegrationToPackage(...args),
}))

const { integrationLockCapability } = await import('./integration-lock.ts')

test('integrationLock grants a package and rejects missing packages', async () => {
	mockModule.lockIntegrationToPackage.mockResolvedValue({
		name: 'google',
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
		integrationLockCapability.handler(
			{ name: 'google', package_id: 'pkg-drafts' },
			ctx,
		),
	).resolves.toEqual({
		name: 'google',
		usage_mode: 'packages',
		allowed_package_ids: ['pkg-drafts'],
		usage_url: 'https://kody.codes/account/integrations/google',
	})
	expect(mockModule.lockIntegrationToPackage).toHaveBeenCalledWith({
		env: ctx.env,
		userId: 'user-1',
		name: 'google',
		packageId: 'pkg-drafts',
	})

	mockModule.lockIntegrationToPackage.mockRejectedValueOnce(
		new Error('Saved package not found for this user.'),
	)
	const missing = await integrationLockCapability
		.handler({ name: 'google', package_id: 'missing' }, ctx)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missing).toBeInstanceOf(McpCallerError)
	expect((missing as Error).message).toContain('Saved package not found')
})
