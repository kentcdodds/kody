import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	updateSavedPackage: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	updateSavedPackage: (...args: Array<unknown>) =>
		mockModule.updateSavedPackage(...args),
}))

const { setPackageHiddenCapability } = await import('./set-package-hidden.ts')

function createCtx(userId = 'user-1') {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user: {
				userId,
				email: 'user@example.com',
				displayName: 'User',
			},
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

test('package_set_hidden scopes updates to the authenticated user and rejects missing packages', async () => {
	mockModule.updateSavedPackage.mockResolvedValueOnce(true)

	await expect(
		setPackageHiddenCapability.handler(
			{ package_id: 'pkg-1', hidden: true },
			createCtx('user-1'),
		),
	).resolves.toEqual({
		ok: true,
		package_id: 'pkg-1',
		hidden: true,
	})

	expect(mockModule.updateSavedPackage).toHaveBeenCalledWith(
		{},
		{
			userId: 'user-1',
			packageId: 'pkg-1',
			hidden: true,
		},
	)

	mockModule.updateSavedPackage.mockResolvedValueOnce(false)
	await expect(
		setPackageHiddenCapability.handler(
			{ package_id: 'missing', hidden: false },
			createCtx('user-2'),
		),
	).rejects.toThrow('Saved package not found for this user.')

	expect(mockModule.updateSavedPackage).toHaveBeenLastCalledWith(
		{},
		{
			userId: 'user-2',
			packageId: 'missing',
			hidden: false,
		},
	)

	await expect(
		setPackageHiddenCapability.handler(
			{ package_id: 'pkg-1', hidden: true },
			{
				env: { APP_DB: {} } as Env,
				callerContext: {
					baseUrl: 'https://heykody.dev',
					user: null,
					remoteConnectors: null,
					storageContext: null,
					repoContext: null,
				},
			},
		),
	).rejects.toThrow()
})
