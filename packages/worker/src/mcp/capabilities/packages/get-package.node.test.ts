import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageWithCommunityProvenanceById: vi.fn(),
	loadPackageSourceBySourceId: vi.fn(),
	resolvePackageOwnerContext: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageWithCommunityProvenanceById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageWithCommunityProvenanceById(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageSourceBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageSourceBySourceId(...args),
}))

vi.mock('#worker/package-registry/package-owner.ts', () => ({
	packageScopeInputDescription: 'package scope',
	resolvePackageOwnerContext: (...args: Array<unknown>) =>
		mockModule.resolvePackageOwnerContext(...args),
}))

const { getPackageCapability } = await import('./get-package.ts')

function createCallerContext(input?: {
	username?: string | null
	ownerUserId?: string
	ownerScope?: string
	ownerEmail?: string
	delegated?: boolean
}) {
	const userId = 'user-1'
	const ownerUserId = input?.ownerUserId ?? userId
	const ownerScope = input?.ownerScope ?? input?.username ?? 'kody'
	mockModule.resolvePackageOwnerContext.mockResolvedValue({
		ownerUserId,
		ownerScope,
		ownerEmail: input?.ownerEmail ?? 'kody@example.com',
		actorUserId: userId,
		delegated: input?.delegated ?? false,
	})

	const user: {
		userId: string
		email: string
		displayName: string
		username?: string
	} = {
		userId,
		email: 'kody@example.com',
		displayName: 'Kody',
	}
	if (input?.username !== null) {
		user.username = input?.username ?? 'kody'
	}

	return {
		env: { APP_DB: {} } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user,
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

function stubSavedPackage(input?: {
	userId?: string
	name?: string
	hasApp?: boolean
	sourceListingId?: string | null
	listingCurrent?: boolean | null
	listingKodyId?: string | null
}) {
	mockModule.getSavedPackageWithCommunityProvenanceById.mockResolvedValue({
		id: 'package-1',
		userId: input?.userId ?? 'user-1',
		name: input?.name ?? '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: input?.hasApp ?? true,
		hidden: false,
		isPrivate: false,
		sourceListingId: input?.sourceListingId ?? 'listing-1',
		listingCurrent: input?.listingCurrent ?? true,
		listingKodyId: input?.listingKodyId ?? 'upstream-discord-gateway',
		createdAt: '2026-04-25T00:00:00.000Z',
		updatedAt: '2026-04-26T00:00:00.000Z',
	})
}

test('getPackageCapability returns export metadata for owner and delegated package scopes', async () => {
	mockModule.getSavedPackageWithCommunityProvenanceById.mockReset()
	mockModule.loadPackageSourceBySourceId.mockReset()
	stubSavedPackage()
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: { id: 'source-1' },
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'.': './src/index.ts',
				'./post-message': {
					import: './src/post-message.ts',
					types: './src/post-message.ts',
				},
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord helpers',
				tags: ['discord'],
				app: {
					entry: './src/operator-app.ts',
				},
			},
		},
		files: {},
	})

	const withUsername = await getPackageCapability.handler(
		{ package_id: 'package-1' },
		createCallerContext(),
	)

	expect(withUsername).toMatchObject({
		package_id: 'package-1',
		kody_id: 'discord-gateway',
		name: '@kentcdodds/discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		has_app: true,
		source_id: 'source-1',
		source_listing_id: 'listing-1',
		listing_current: true,
		listing_kody_id: 'upstream-discord-gateway',
		created_at: '2026-04-25T00:00:00.000Z',
		updated_at: '2026-04-26T00:00:00.000Z',
		exports: [
			{
				subpath: '.',
				import_specifier: 'kody:@kentcdodds/discord-gateway',
				runtime_target: 'src/index.ts',
				external_invocation: {
					method: 'POST',
					url: 'https://heykody.dev/@kody/api/package-invocations/discord-gateway/__root__',
					path: '/@kody/api/package-invocations/discord-gateway/__root__',
					owner_username: 'kody',
					kody_id: 'discord-gateway',
					route_export_name: '__root__',
					normalized_export_name: '.',
					token_setup_url:
						'https://heykody.dev/account/package-invocation-tokens/new?packageKodyIds=discord-gateway&exportNames=.',
					source_guidance: expect.any(String),
				},
			},
			{
				subpath: './post-message',
				import_specifier: 'kody:@kentcdodds/discord-gateway/post-message',
				runtime_target: 'src/post-message.ts',
				types_path: 'src/post-message.ts',
				external_invocation: {
					method: 'POST',
					url: 'https://heykody.dev/@kody/api/package-invocations/discord-gateway/post-message',
					path: '/@kody/api/package-invocations/discord-gateway/post-message',
					owner_username: 'kody',
					kody_id: 'discord-gateway',
					route_export_name: 'post-message',
					normalized_export_name: './post-message',
					token_setup_url:
						'https://heykody.dev/account/package-invocation-tokens/new?packageKodyIds=discord-gateway&exportNames=post-message',
					source_guidance: expect.any(String),
				},
			},
		],
	})
	expect(
		mockModule.getSavedPackageWithCommunityProvenanceById,
	).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ userId: 'user-1', packageId: 'package-1' }),
	)
	expect(mockModule.loadPackageSourceBySourceId).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_DB: expect.anything() }),
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-1',
	})

	// Delegated package_scope loads and builds invocation URLs for the owner.
	mockModule.getSavedPackageWithCommunityProvenanceById.mockReset()
	mockModule.loadPackageSourceBySourceId.mockReset()
	mockModule.resolvePackageOwnerContext.mockClear()
	stubSavedPackage({
		userId: 'platform-owner',
		name: '@kody/discord-gateway',
		hasApp: false,
		sourceListingId: null,
		listingCurrent: null,
		listingKodyId: null,
	})
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: { id: 'source-1' },
		manifest: {
			name: '@kody/discord-gateway',
			exports: {
				'./post-message': './src/post-message.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord helpers',
			},
		},
		files: {},
	})

	const delegated = await getPackageCapability.handler(
		{ package_id: 'package-1', package_scope: 'kody' },
		createCallerContext({
			ownerUserId: 'platform-owner',
			ownerScope: 'kody',
			ownerEmail: 'platform@example.com',
			delegated: true,
		}),
	)

	expect(mockModule.resolvePackageOwnerContext).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({ userId: 'user-1' }),
		'kody',
	)
	expect(
		mockModule.getSavedPackageWithCommunityProvenanceById,
	).toHaveBeenCalledWith(
		expect.anything(),
		expect.objectContaining({
			userId: 'platform-owner',
			packageId: 'package-1',
		}),
	)
	expect(mockModule.loadPackageSourceBySourceId).toHaveBeenCalledWith(
		expect.objectContaining({ userId: 'platform-owner' }),
	)
	expect(delegated.exports[0]?.external_invocation).toMatchObject({
		owner_username: 'kody',
		url: 'https://heykody.dev/@kody/api/package-invocations/discord-gateway/post-message',
	})
})

test('getPackageCapability projects type_definition and description when source files are loaded', async () => {
	mockModule.getSavedPackageWithCommunityProvenanceById.mockReset()
	mockModule.loadPackageSourceBySourceId.mockReset()
	mockModule.getSavedPackageWithCommunityProvenanceById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/calendar',
		kodyId: 'calendar',
		description: 'Calendar helpers',
		tags: ['calendar'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		sourceListingId: null,
		listingCurrent: null,
		listingKodyId: null,
		createdAt: '2026-04-25T00:00:00.000Z',
		updatedAt: '2026-04-26T00:00:00.000Z',
	})
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: { id: 'source-1' },
		manifest: {
			name: '@kentcdodds/calendar',
			exports: {
				'./list-events': {
					import: './src/list-events.ts',
					types: './src/list-events.d.ts',
				},
			},
			kody: {
				id: 'calendar',
				description: 'Calendar helpers',
				tags: ['calendar'],
			},
		},
		files: {
			'src/list-events.ts':
				'export const ignored = "types file should be preferred"',
			'src/list-events.d.ts': `/**
 * List upcoming calendar events.
 */
export declare function listEvents(calendarId: string): Promise<string[]>
`,
		},
	})

	const result = await getPackageCapability.handler(
		{ package_id: 'package-1' },
		createCallerContext(),
	)

	expect(result.exports).toEqual([
		expect.objectContaining({
			subpath: './list-events',
			import_specifier: 'kody:@kentcdodds/calendar/list-events',
			runtime_target: 'src/list-events.ts',
			types_path: 'src/list-events.d.ts',
			description: 'List upcoming calendar events.',
			type_definition:
				'export declare function listEvents(calendarId: string): Promise<string[]>',
		}),
	])
	expect(mockModule.loadPackageSourceBySourceId).toHaveBeenCalledWith(
		expect.objectContaining({
			sourceId: 'source-1',
			userId: 'user-1',
		}),
	)
})

test('getPackageCapability leaves export contracts empty without projectable source', async () => {
	mockModule.getSavedPackageWithCommunityProvenanceById.mockReset()
	mockModule.loadPackageSourceBySourceId.mockReset()
	mockModule.getSavedPackageWithCommunityProvenanceById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/calendar',
		kodyId: 'calendar',
		description: 'Calendar helpers',
		tags: ['calendar'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		sourceListingId: null,
		listingCurrent: null,
		listingKodyId: null,
		createdAt: '2026-04-25T00:00:00.000Z',
		updatedAt: '2026-04-26T00:00:00.000Z',
	})
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: { id: 'source-1' },
		manifest: {
			name: '@kentcdodds/calendar',
			exports: {
				'./list-events': {
					import: './src/list-events.ts',
					types: './src/list-events.d.ts',
				},
			},
			kody: {
				id: 'calendar',
				description: 'Calendar helpers',
			},
		},
		// Same path search hydration avoids: projection without file text
		// cannot derive callable contracts even when the manifest lists types.
		files: undefined,
	})

	const missingFiles = await getPackageCapability.handler(
		{ package_id: 'package-1' },
		createCallerContext(),
	)
	expect(missingFiles.exports).toEqual([
		expect.objectContaining({
			subpath: './list-events',
			runtime_target: 'src/list-events.ts',
			types_path: 'src/list-events.d.ts',
			description: null,
			type_definition: null,
		}),
	])

	mockModule.getSavedPackageWithCommunityProvenanceById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/untyped-helpers',
		kodyId: 'untyped-helpers',
		description: 'Untyped helpers',
		tags: [],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		isPrivate: false,
		sourceListingId: null,
		listingCurrent: null,
		listingKodyId: null,
		createdAt: '2026-04-25T00:00:00.000Z',
		updatedAt: '2026-04-26T00:00:00.000Z',
	})
	mockModule.loadPackageSourceBySourceId.mockResolvedValue({
		source: { id: 'source-1' },
		manifest: {
			name: '@kentcdodds/untyped-helpers',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'untyped-helpers',
				description: 'Untyped helpers',
			},
		},
		files: {
			// Non-function exports are intentionally ignored by the projector.
			'src/index.ts': "export const VERSION = '1.0.0'\n",
		},
	})

	const untyped = await getPackageCapability.handler(
		{ package_id: 'package-1' },
		createCallerContext(),
	)
	expect(untyped.exports).toEqual([
		expect.objectContaining({
			subpath: '.',
			runtime_target: 'src/index.ts',
			description: null,
			type_definition: null,
		}),
	])
})
