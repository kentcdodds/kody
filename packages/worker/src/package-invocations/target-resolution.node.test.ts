import { expect, test, vi } from 'vitest'
import { resolvePackageInvokeTarget } from './target-resolution.ts'

const mockModule = vi.hoisted(() => ({
	resolveSavedPackage: vi.fn(),
	resolveSavedPackageImport: vi.fn(),
}))

vi.mock('./module-artifacts.ts', () => ({
	resolveSavedPackage: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackage(...args),
}))

vi.mock('#worker/package-runtime/package-import-resolution.ts', () => ({
	resolveSavedPackageImport: (...args: Array<unknown>) =>
		mockModule.resolveSavedPackageImport(...args),
}))

test('resolves scoped specifiers by owner while keeping bare ids user-scoped', async () => {
	const env = { APP_DB: {} } as Env
	const platformPackage = { id: 'platform-google', kodyId: 'google' }
	mockModule.resolveSavedPackageImport.mockResolvedValueOnce({
		row: platformPackage,
		sourceOwnerUserId: 'platform-user',
		platformScope: 'kody',
	})
	await expect(
		resolvePackageInvokeTarget({
			env,
			userId: 'person-user',
			packageIdentifier: {
				kind: 'specifier',
				value: 'kody:@kody/google',
				packageName: '@kody/google',
			},
		}),
	).resolves.toEqual({
		savedPackage: platformPackage,
		sourceOwnerUserId: 'platform-user',
	})
	expect(mockModule.resolveSavedPackageImport).toHaveBeenLastCalledWith({
		db: env.APP_DB,
		userId: 'person-user',
		specifier: 'kody:@kody/google',
	})

	const personPackage = { id: 'person-google', kodyId: 'google' }
	mockModule.resolveSavedPackageImport.mockResolvedValueOnce({
		row: personPackage,
		sourceOwnerUserId: 'person-user',
		platformScope: null,
	})
	await expect(
		resolvePackageInvokeTarget({
			env,
			userId: 'person-user',
			packageIdentifier: {
				kind: 'specifier',
				value: 'kody:@kentcdodds/google',
				packageName: '@kentcdodds/google',
			},
		}),
	).resolves.toEqual({
		savedPackage: personPackage,
		sourceOwnerUserId: 'person-user',
	})

	mockModule.resolveSavedPackage.mockResolvedValueOnce(personPackage)
	await expect(
		resolvePackageInvokeTarget({
			env,
			userId: 'person-user',
			packageIdentifier: { kind: 'kodyId', value: 'google' },
		}),
	).resolves.toEqual({
		savedPackage: personPackage,
		sourceOwnerUserId: 'person-user',
	})
	expect(mockModule.resolveSavedPackage).toHaveBeenLastCalledWith({
		db: env.APP_DB,
		userId: 'person-user',
		packageIdOrKodyId: 'google',
	})
})
