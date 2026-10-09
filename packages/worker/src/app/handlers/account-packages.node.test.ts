import {
	personalOrgId,
	personIdFromStored,
} from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import type * as authenticatedUserModule from '#app/authenticated-user.ts'
import type * as packageRepo from '#worker/package-registry/repo.ts'
import type * as packageSource from '#worker/package-registry/source.ts'
import type * as entitySources from '#worker/repo/entity-sources.ts'
import type * as invocationRepo from '#worker/package-invocations/repo.ts'
import type * as communityRepo from '#worker/community/repo.ts'

const mockModule = vi.hoisted(() => {
	const savedPackage = {
		id: 'pkg-1',
		userId: 'stable-user-1',
		name: '@test/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Dispatch Discord gateway events.',
		tags: ['discord', 'events'],
		searchText: 'discord gateway websocket',
		sourceId: 'source-1',
		hasApp: true,
		hasSkills: false,
		hidden: false,
		isPrivate: false,
		lockedAt: null,
		createdAt: new Date(0).toISOString(),
		updatedAt: new Date(0).toISOString(),
	}
	const tokenRecord = {
		id: 'token-1',
		user_id: 'stable-user-1',
		package_id: 'pkg-1',
		token_hash: 'stored-hash',
		name: 'Personal client',
		export_names_json: '["*"]',
		created_at: new Date(0).toISOString(),
		updated_at: new Date(0).toISOString(),
		last_used_at: null,
		revoked_at: null,
		exportNames: ['*'],
	}
	return {
		savedPackage,
		readAuthenticatedAppUser: vi.fn<
			typeof authenticatedUserModule.readAuthenticatedAppUser
		>(async () => ({
			sessionUserId: '42',
			userId: 42,
			username: 'test-user',
			email: 'user@example.com',
			emailVerified: true,
			emailVerificationDelivery: null,
			displayName: 'user',
			roles: ['user'],
			permissions: [],
			artifactOwnerIds: [],
			mcpUser: {
				userId: personIdFromStored('stable-user-1'),
				email: 'user@example.com',
				username: 'test-user',
				displayName: 'user',
			},
			actor: personIdFromStored('stable-user-1'),
			owner: personalOrgId(personIdFromStored('stable-user-1')),
		})),
		searchSavedPackagesByUserId: vi.fn<
			typeof packageRepo.searchSavedPackagesByUserId
		>(async () => ({
			items: [savedPackage],
			total: 1,
		})),
		getSavedPackageById: vi.fn<typeof packageRepo.getSavedPackageById>(
			async () => savedPackage,
		),
		getSavedPackageWithCommunityProvenanceById: vi.fn<
			typeof packageRepo.getSavedPackageWithCommunityProvenanceById
		>(async () => ({
			...savedPackage,
			sourceListingId: null,
			listingCurrent: null,
			listingKodyId: null,
			listingName: null,
			originCommit: null,
			listingPinnedCommit: null,
			listingPublishedAt: null,
			listingAhead: null,
			forkListingRelation: null,
		})),
		listSavedPackageCommunityProvenanceByIds: vi.fn<
			typeof packageRepo.listSavedPackageCommunityProvenanceByIds
		>(async () => []),
		getEntitySourceById: vi.fn<typeof entitySources.getEntitySourceById>(
			async () => null,
		),
		listPackageInvocationTokensByPackageId: vi.fn<
			typeof invocationRepo.listPackageInvocationTokensByPackageId
		>(async () => [tokenRecord]),
		hashPackageInvocationBearerToken: vi.fn<
			typeof invocationRepo.hashPackageInvocationBearerToken
		>(async () => 'hashed-raw-token'),
		insertPackageInvocationToken: vi.fn<
			typeof invocationRepo.insertPackageInvocationToken
		>(async () => undefined),
		updatePackageInvocationToken: vi.fn<
			typeof invocationRepo.updatePackageInvocationToken
		>(async () => true),
		revokePackageInvocationToken: vi.fn<
			typeof invocationRepo.revokePackageInvocationToken
		>(async () => true),
		reinstatePackageInvocationToken: vi.fn<
			typeof invocationRepo.reinstatePackageInvocationToken
		>(async () => true),
		deletePackageInvocationToken: vi.fn<
			typeof invocationRepo.deletePackageInvocationToken
		>(async () => true),
		getAppBaseUrl: () => 'https://example.com',
		loadPackageManifestBySourceId: vi.fn<
			typeof packageSource.loadPackageManifestBySourceId
		>(async () => ({
			source: {
				id: 'source-1',
				user_id: 'stable-user-1',
				entity_kind: 'package',
				entity_id: 'pkg-1',
				repo_id: 'repo-1',
				published_commit: 'commit-1',
				indexed_commit: 'commit-1',
				manifest_path: 'package.json',
				source_root: '/',
				last_external_check_at: null,
				external_check_until: null,
				created_at: new Date(0).toISOString(),
				updated_at: new Date(0).toISOString(),
			},
			manifest: {
				name: '@test/discord-gateway',
				exports: {
					'./dispatch-message-created': { import: './src/index.ts' },
				},
				kody: {
					id: 'discord-gateway',
					description: 'Dispatch Discord gateway events.',
				},
			},
		})),
		getCommunityListingByOwnerAndPackage: vi.fn<
			typeof communityRepo.getCommunityListingByOwnerAndPackage
		>(async () => null),
		requireAuthenticatedPageUser: vi.fn(),
	}
})

vi.mock('#app/authenticated-user.ts', () => ({
	readAuthenticatedAppUser: (
		...args: Parameters<typeof authenticatedUserModule.readAuthenticatedAppUser>
	) => mockModule.readAuthenticatedAppUser(...args),
}))

vi.mock('#app/auth-session.ts', () => ({
	readAuthSessionResult: async () => ({ session: null, setCookie: null }),
}))

vi.mock('#app/auth-redirect.ts', () => ({
	redirectToLogin: () => new Response(null, { status: 302 }),
	redirectToLoginWhenUnauthenticated: () => new Response(null, { status: 302 }),
}))

vi.mock('#app/page-auth.ts', () => ({
	requireAuthenticatedPageUser: (...args: Array<unknown>) =>
		mockModule.requireAuthenticatedPageUser(...args),
}))

vi.mock('#worker/community/repo.ts', () => ({
	getCommunityListingByOwnerAndPackage: (
		...args: Parameters<
			typeof communityRepo.getCommunityListingByOwnerAndPackage
		>
	) => mockModule.getCommunityListingByOwnerAndPackage(...args),
}))

vi.mock('#app/ssr-render.tsx', () => ({
	renderAppPage: async (input: { status?: number }) =>
		new Response('ok', { status: input.status ?? 200 }),
}))

vi.mock('#worker/app-base-url.ts', () => ({
	getAppBaseUrl: () => mockModule.getAppBaseUrl(),
}))

vi.mock('#worker/community/fork-listing-relation.ts', () => ({
	applySavedPackageForkListingAncestry: async ({
		records,
	}: {
		records: Array<unknown>
	}) => records,
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	searchSavedPackagesByUserId: (
		...args: Parameters<typeof packageRepo.searchSavedPackagesByUserId>
	) => mockModule.searchSavedPackagesByUserId(...args),
	getSavedPackageById: (
		...args: Parameters<typeof packageRepo.getSavedPackageById>
	) => mockModule.getSavedPackageById(...args),
	getSavedPackageWithCommunityProvenanceById: (
		...args: Parameters<
			typeof packageRepo.getSavedPackageWithCommunityProvenanceById
		>
	) => mockModule.getSavedPackageWithCommunityProvenanceById(...args),
	listSavedPackageCommunityProvenanceByIds: (
		...args: Parameters<
			typeof packageRepo.listSavedPackageCommunityProvenanceByIds
		>
	) => mockModule.listSavedPackageCommunityProvenanceByIds(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (
		...args: Parameters<typeof packageSource.loadPackageManifestBySourceId>
	) => mockModule.loadPackageManifestBySourceId(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceById: (
		...args: Parameters<typeof entitySources.getEntitySourceById>
	) => mockModule.getEntitySourceById(...args),
}))

vi.mock('#worker/package-invocations/repo.ts', () => ({
	listPackageInvocationTokensByPackageId: (
		...args: Parameters<
			typeof invocationRepo.listPackageInvocationTokensByPackageId
		>
	) => mockModule.listPackageInvocationTokensByPackageId(...args),
	hashPackageInvocationBearerToken: (
		...args: Parameters<typeof invocationRepo.hashPackageInvocationBearerToken>
	) => mockModule.hashPackageInvocationBearerToken(...args),
	insertPackageInvocationToken: (
		...args: Parameters<typeof invocationRepo.insertPackageInvocationToken>
	) => mockModule.insertPackageInvocationToken(...args),
	updatePackageInvocationToken: (
		...args: Parameters<typeof invocationRepo.updatePackageInvocationToken>
	) => mockModule.updatePackageInvocationToken(...args),
	revokePackageInvocationToken: (
		...args: Parameters<typeof invocationRepo.revokePackageInvocationToken>
	) => mockModule.revokePackageInvocationToken(...args),
	reinstatePackageInvocationToken: (
		...args: Parameters<typeof invocationRepo.reinstatePackageInvocationToken>
	) => mockModule.reinstatePackageInvocationToken(...args),
	deletePackageInvocationToken: (
		...args: Parameters<typeof invocationRepo.deletePackageInvocationToken>
	) => mockModule.deletePackageInvocationToken(...args),
}))

const { createAccountPackagesApiHandler, createAccountPackagesHandler } =
	await import('./account-packages.ts')

function createEnv() {
	return {
		APP_DB: {} as D1Database,
		COOKIE_SECRET: 'secret',
	} as Env
}

function createPackagesClient() {
	const env = createEnv()
	const { handler } = createAccountPackagesApiHandler(env)
	return {
		env,
		get: (search = '') =>
			handler({
				request: new Request(
					`https://example.com/account/packages.json${search}`,
				),
				params: {},
			} as never),
		post: (body: Record<string, unknown>) =>
			handler({
				request: new Request('https://example.com/account/packages.json', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
				params: {},
			} as never),
	}
}

test('packages API lists with filters, ignores invalid values, and rejects unknown actions', async () => {
	const { env, get, post } = createPackagesClient()
	const searchCall = (input: Record<string, unknown>) =>
		expect(mockModule.searchSavedPackagesByUserId).toHaveBeenLastCalledWith(
			env.APP_DB,
			{ userId: 'stable-user-1', ...input },
		)

	const defaults = await get()
	expect(defaults.status).toBe(200)
	expect(defaults.headers.get('Cache-Control')).toBe('no-store')
	searchCall({
		query: '',
		hasApp: null,
		sort: 'updated',
		limit: 20,
		offset: 0,
	})
	expect(mockModule.getSavedPackageById).not.toHaveBeenCalled()
	await expect(defaults.json()).resolves.toMatchObject({
		ok: true,
		email: 'user@example.com',
		username: 'test-user',
		invocationUrlOrigin: 'https://example.com',
		packages: [
			expect.objectContaining({
				id: 'pkg-1',
				kodyId: 'discord-gateway',
				hasApp: true,
			}),
		],
		selectedPackage: null,
		page: 1,
		pageSize: 20,
		total: 1,
		query: '',
		appFilter: 'all',
		sort: 'updated',
	})

	const filtered = await get(
		'?q=discord&app=with&sort=name&page=3&pageSize=10&selected=pkg-1',
	)
	expect(filtered.status).toBe(200)
	searchCall({
		query: 'discord',
		hasApp: true,
		sort: 'name',
		limit: 10,
		offset: 20,
	})
	expect(
		mockModule.getSavedPackageWithCommunityProvenanceById,
	).toHaveBeenCalledWith(env.APP_DB, {
		userId: 'stable-user-1',
		packageId: 'pkg-1',
	})
	expect(
		mockModule.listPackageInvocationTokensByPackageId,
	).toHaveBeenCalledWith({
		db: env.APP_DB,
		userId: 'stable-user-1',
		packageId: 'pkg-1',
	})
	const filteredPayload = await filtered.json()
	expect(filteredPayload).toMatchObject({
		ok: true,
		page: 3,
		pageSize: 10,
		query: 'discord',
		appFilter: 'with',
		sort: 'name',
		selectedPackage: {
			id: 'pkg-1',
			searchText: 'discord gateway websocket',
			exports: ['./dispatch-message-created'],
			tokens: [{ id: 'token-1', name: 'Personal client', exportNames: ['*'] }],
		},
	})
	expect(JSON.stringify(filteredPayload)).not.toContain('stored-hash')
	expect(mockModule.loadPackageManifestBySourceId).toHaveBeenCalledWith({
		env,
		baseUrl: 'https://example.com',
		userId: 'stable-user-1',
		sourceId: 'source-1',
	})

	mockModule.loadPackageManifestBySourceId.mockRejectedValueOnce(
		new Error('Saved package source bindings are not available.'),
	)
	await expect((await get('?selected=pkg-1')).json()).resolves.toMatchObject({
		ok: true,
		selectedPackage: { id: 'pkg-1', exports: null },
	})

	mockModule.getSavedPackageWithCommunityProvenanceById.mockResolvedValue(
		null as never,
	)
	const invalid = await get('?app=bogus&sort=bogus&selected=missing-package')
	expect(invalid.status).toBe(200)
	expect(mockModule.searchSavedPackagesByUserId).toHaveBeenLastCalledWith(
		env.APP_DB,
		expect.objectContaining({ hasApp: null, sort: 'updated' }),
	)
	await expect(invalid.json()).resolves.toMatchObject({
		ok: true,
		selectedPackage: null,
		appFilter: 'all',
		sort: 'updated',
	})

	expect((await post({ action: 'anything' })).status).toBe(400)

	mockModule.readAuthenticatedAppUser.mockResolvedValueOnce(null as never)
	expect((await get()).status).toBe(401)
})

test('packages API creates, updates, revokes, reinstates, and deletes package tokens', async () => {
	const { env, post } = createPackagesClient()
	const tokenAction = (action: string, extra: Record<string, unknown> = {}) =>
		post({ action, packageId: 'pkg-1', ...extra })
	const tokenScope = {
		db: env.APP_DB,
		userId: 'stable-user-1',
		packageId: 'pkg-1',
		id: 'token-1',
	}

	const createResponse = await tokenAction('create-token', {
		name: 'Personal automation',
		rawToken: 'raw-personal-client-token',
		exportNames: ['*'],
	})
	expect(createResponse.status).toBe(200)
	expect(mockModule.hashPackageInvocationBearerToken).toHaveBeenCalledWith(
		'raw-personal-client-token',
	)
	expect(mockModule.insertPackageInvocationToken).toHaveBeenCalledWith({
		db: env.APP_DB,
		row: expect.objectContaining({
			userId: 'stable-user-1',
			packageId: 'pkg-1',
			name: 'Personal automation',
			tokenHash: 'hashed-raw-token',
			exportNames: ['*'],
		}),
	})
	const createText = await createResponse.text()
	expect(createText).not.toContain('raw-personal-client-token')
	expect(JSON.parse(createText)).toMatchObject({
		ok: true,
		selectedTokenId: expect.any(String),
	})

	const missingExportResponse = await tokenAction('create-token', {
		name: 'Bad scope',
		rawToken: 'raw-token',
	})
	expect(missingExportResponse.status).toBe(400)
	await expect(missingExportResponse.json()).resolves.toEqual({
		ok: false,
		error: 'Choose at least one export scope.',
	})

	const updateResponse = await tokenAction('update-token', {
		id: 'token-1',
		name: 'Updated personal client',
		exportNames: ['dispatch-message-created'],
		tokenHash: 'should-not-be-read',
	})
	expect(updateResponse.status).toBe(200)
	expect(mockModule.hashPackageInvocationBearerToken).toHaveBeenCalledTimes(1)
	expect(mockModule.updatePackageInvocationToken).toHaveBeenNthCalledWith(1, {
		...tokenScope,
		name: 'Updated personal client',
		tokenHash: undefined,
		exportNames: ['./dispatch-message-created'],
	})
	const updateText = await updateResponse.text()
	expect(updateText).not.toContain('should-not-be-read')
	expect(updateText).not.toContain('stored-hash')
	expect(JSON.parse(updateText)).toMatchObject({
		ok: true,
		selectedTokenId: 'token-1',
	})

	const replaceTokenResponse = await tokenAction('update-token', {
		id: 'token-1',
		name: 'Rotated personal client',
		rawToken: 'replacement-raw-token',
		exportNames: ['dispatch-message-created'],
	})
	expect(replaceTokenResponse.status).toBe(200)
	expect(mockModule.hashPackageInvocationBearerToken).toHaveBeenCalledTimes(2)
	expect(mockModule.hashPackageInvocationBearerToken).toHaveBeenLastCalledWith(
		'replacement-raw-token',
	)
	expect(mockModule.updatePackageInvocationToken).toHaveBeenNthCalledWith(2, {
		...tokenScope,
		name: 'Rotated personal client',
		tokenHash: 'hashed-raw-token',
		exportNames: ['./dispatch-message-created'],
	})

	expect((await tokenAction('revoke-token', { id: 'token-1' })).status).toBe(
		200,
	)
	expect(mockModule.revokePackageInvocationToken).toHaveBeenCalledWith(
		tokenScope,
	)

	const reinstateResponse = await tokenAction('reinstate-token', {
		id: 'token-1',
	})
	expect(reinstateResponse.status).toBe(200)
	expect(mockModule.reinstatePackageInvocationToken).toHaveBeenCalledWith(
		tokenScope,
	)
	await expect(reinstateResponse.json()).resolves.toMatchObject({
		ok: true,
		selectedTokenId: 'token-1',
	})

	const deleteResponse = await tokenAction('delete-token', { id: 'token-1' })
	expect(deleteResponse.status).toBe(200)
	expect(mockModule.deletePackageInvocationToken).toHaveBeenCalledWith(
		tokenScope,
	)
	const deletePayload = await deleteResponse.json()
	expect(deletePayload).toMatchObject({ ok: true })
	expect(deletePayload).not.toHaveProperty('selectedTokenId')
})

test('account package detail redirects the owner to the canonical package URL', async () => {
	mockModule.requireAuthenticatedPageUser.mockResolvedValue({
		username: 'test-user',
		email: 'user@example.com',
		mcpUser: {
			userId: personIdFromStored('stable-user-1'),
			email: 'user@example.com',
			username: 'test-user',
			displayName: 'user',
		},
	})
	const { handler } = createAccountPackagesHandler(createEnv())
	const visit = (path: string, params: Record<string, string> = {}) =>
		handler({
			request: new Request(`https://example.com/account/packages${path}`),
			params,
		} as never)

	const indexRedirect = await visit('?q=discord')
	expect(indexRedirect.status).toBe(302)
	expect(indexRedirect.headers.get('location')).toBe(
		'https://example.com/@test-user?q=discord',
	)

	const redirect = await visit('/pkg-1?newToken=1&exportNames=.', {
		packageId: 'pkg-1',
	})
	expect(redirect.status).toBe(302)
	expect(redirect.headers.get('location')).toBe(
		'https://example.com/@test-user/discord-gateway?newToken=1&exportNames=.',
	)

	mockModule.getSavedPackageById.mockResolvedValue(null as never)
	expect((await visit('/missing', { packageId: 'missing' })).status).toBe(404)
})

test('packages API loads the selected package detail while list provenance is still loading', async () => {
	let releaseProvenance!: () => void
	const provenanceGate = new Promise<void>((resolve) => {
		releaseProvenance = resolve
	})
	mockModule.listSavedPackageCommunityProvenanceByIds.mockImplementation(
		async () => {
			await provenanceGate
			return []
		},
	)

	const responding = createPackagesClient().get('?selected=pkg-1')
	await vi.waitFor(() => {
		expect(mockModule.listPackageInvocationTokensByPackageId).toHaveBeenCalled()
	})
	releaseProvenance()
	const response = await responding
	expect(response.status).toBe(200)
	await expect(response.json()).resolves.toMatchObject({
		selectedPackage: expect.objectContaining({ id: 'pkg-1' }),
	})
})
