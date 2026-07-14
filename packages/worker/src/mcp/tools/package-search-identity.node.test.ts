import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	getSavedPackageByKodyId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
	getSavedPackageByKodyId: (...args: Array<unknown>) =>
		mockModule.getSavedPackageByKodyId(...args),
}))

const { parsePackageSearchIdentity, resolvePackageIdentitySearch } =
	await import('./package-search-identity.ts')

const packageId = '550e8400-e29b-41d4-a716-446655440000'

function createSavedPackage(input?: { hidden?: boolean; userId?: string }) {
	return {
		id: packageId,
		userId: input?.userId ?? 'user-1',
		kodyId: 'daily-notes',
		name: '@user/daily-notes',
		description: 'Daily notes package',
		tags: ['notes'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hidden: input?.hidden ?? false,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-02T00:00:00.000Z',
	}
}

test('package identity parser accepts exact ids and current-origin package URLs', () => {
	const common = {
		baseUrl: 'https://heykody.dev',
		username: 'user',
	}
	expect(parsePackageSearchIdentity({ ...common, query: packageId })).toEqual({
		kind: 'package-id',
		value: packageId,
		authoritative: true,
	})
	expect(
		parsePackageSearchIdentity({ ...common, query: 'daily-notes' }),
	).toEqual({
		kind: 'kody-id',
		value: 'daily-notes',
		authoritative: false,
	})
	expect(
		parsePackageSearchIdentity({
			...common,
			query: `/account/packages/${packageId}`,
		}),
	).toEqual({
		kind: 'package-id',
		value: packageId,
		authoritative: true,
	})
	expect(
		parsePackageSearchIdentity({
			...common,
			query: `https://heykody.dev/account/packages/${packageId}?tab=source#top`,
		}),
	).toEqual({
		kind: 'package-id',
		value: packageId,
		authoritative: true,
	})
	expect(
		parsePackageSearchIdentity({
			...common,
			query: '/@user/packages/daily-notes',
		}),
	).toEqual({
		kind: 'kody-id',
		value: 'daily-notes',
		authoritative: true,
	})
	expect(
		parsePackageSearchIdentity({
			...common,
			query: 'https://heykody.dev/@user/packages/daily-notes',
		}),
	).toEqual({
		kind: 'kody-id',
		value: 'daily-notes',
		authoritative: true,
	})
})

test('package identity parser rejects malformed, wrong-origin, and wrong-owner URLs', () => {
	const common = {
		baseUrl: 'https://heykody.dev',
		username: 'user',
	}
	for (const query of [
		`https://attacker.example/account/packages/${packageId}`,
		`https://attacker.example/@user/packages/daily-notes`,
		'https://heykody.dev/account/packages/%E0%A4%A',
		'https://heykody.dev/@user/packages/%E0%A4%A',
		'https://heykody.dev/@other/packages/daily-notes',
		'/@INVALID/packages/daily-notes',
		'https://user:password@heykody.dev/account/packages/' + packageId,
	]) {
		expect(parsePackageSearchIdentity({ ...common, query }), query).toEqual({
			kind: 'invalid-package-identity',
		})
	}
	expect(
		parsePackageSearchIdentity({
			...common,
			query: 'find a package for daily notes',
		}),
	).toEqual({ kind: 'not-package-identity' })
})

test('package identity resolution is user-scoped and enforces hidden query semantics', async () => {
	const visible = createSavedPackage()
	const hidden = createSavedPackage({ hidden: true })
	mockModule.getSavedPackageById
		.mockResolvedValueOnce(visible)
		.mockResolvedValueOnce(hidden)
		.mockResolvedValueOnce(hidden)
		.mockResolvedValueOnce(null)

	const common = {
		db: {} as D1Database,
		userId: 'user-1',
		query: packageId,
		baseUrl: 'https://heykody.dev',
		username: 'user',
	}
	await expect(
		resolvePackageIdentitySearch({
			...common,
			includeHiddenPackages: false,
		}),
	).resolves.toMatchObject({
		recognized: true,
		match: {
			type: 'package',
			packageId,
			kodyId: 'daily-notes',
			hidden: false,
		},
	})
	await expect(
		resolvePackageIdentitySearch({
			...common,
			includeHiddenPackages: false,
		}),
	).resolves.toEqual({ recognized: true, match: null })
	await expect(
		resolvePackageIdentitySearch({
			...common,
			includeHiddenPackages: true,
		}),
	).resolves.toMatchObject({
		recognized: true,
		match: { packageId, hidden: true },
	})
	await expect(
		resolvePackageIdentitySearch({
			...common,
			userId: 'user-2',
			includeHiddenPackages: true,
		}),
	).resolves.toEqual({ recognized: true, match: null })

	expect(mockModule.getSavedPackageById).toHaveBeenNthCalledWith(
		4,
		{},
		{
			userId: 'user-2',
			packageId,
		},
	)
	expect(mockModule.getSavedPackageByKodyId).not.toHaveBeenCalled()
})

test('kody-id lookup resolves exact packages but preserves non-package single-word searches', async () => {
	mockModule.getSavedPackageByKodyId
		.mockResolvedValueOnce(createSavedPackage())
		.mockResolvedValueOnce(null)

	await expect(
		resolvePackageIdentitySearch({
			db: {} as D1Database,
			userId: 'user-1',
			query: 'daily-notes',
			baseUrl: 'https://heykody.dev',
			username: 'user',
			includeHiddenPackages: false,
		}),
	).resolves.toMatchObject({
		recognized: true,
		match: { kodyId: 'daily-notes' },
	})
	await expect(
		resolvePackageIdentitySearch({
			db: {} as D1Database,
			userId: 'user-1',
			query: 'email',
			baseUrl: 'https://heykody.dev',
			username: 'user',
			includeHiddenPackages: false,
		}),
	).resolves.toEqual({ recognized: false })
})

test('invalid and unauthenticated exact identities return no package without database access', async () => {
	for (const input of [
		{
			userId: 'user-1',
			query: `https://other.example/account/packages/${packageId}`,
			username: 'user',
		},
		{
			userId: 'user-1',
			query: 'https://heykody.dev/@other/packages/daily-notes',
			username: 'user',
		},
		{ userId: null, query: packageId, username: null },
	]) {
		await expect(
			resolvePackageIdentitySearch({
				db: {} as D1Database,
				...input,
				baseUrl: 'https://heykody.dev',
				includeHiddenPackages: true,
			}),
		).resolves.toEqual({ recognized: true, match: null })
	}
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
	expect(mockModule.getSavedPackageByKodyId).not.toHaveBeenCalled()
})
