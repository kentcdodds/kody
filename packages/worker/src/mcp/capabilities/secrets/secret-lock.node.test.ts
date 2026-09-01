import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

const mockModule = vi.hoisted(() => ({
	lockSecretToPackage: vi.fn(),
}))

vi.mock('#mcp/secrets/service.ts', () => ({
	lockSecretToPackage: (...args: Array<unknown>) =>
		mockModule.lockSecretToPackage(...args),
}))

const { secretLockCapability } = await import('./secret-lock.ts')

test('secretLock grants a package and rejects missing packages', async () => {
	mockModule.lockSecretToPackage.mockResolvedValue({
		name: 'openai-api-key',
		allowedPackages: ['pkg-drafts'],
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
		secretLockCapability.handler(
			{ name: 'openai-api-key', package_id: 'pkg-drafts' },
			ctx,
		),
	).resolves.toEqual({
		name: 'openai-api-key',
		scope: 'user',
		allowed_packages: ['pkg-drafts'],
		usage_url: 'https://kody.codes/account/secrets/user/openai-api-key',
	})
	expect(mockModule.lockSecretToPackage).toHaveBeenCalledWith({
		env: ctx.env,
		userId: 'user-1',
		name: 'openai-api-key',
		packageId: 'pkg-drafts',
	})

	mockModule.lockSecretToPackage.mockRejectedValueOnce(
		new Error('Saved package not found for this user.'),
	)
	const missing = await secretLockCapability
		.handler({ name: 'openai-api-key', package_id: 'missing' }, ctx)
		.then(
			() => null,
			(error: unknown) => error,
		)
	expect(missing).toBeInstanceOf(McpCallerError)
	expect((missing as Error).message).toContain('Saved package not found')
})
