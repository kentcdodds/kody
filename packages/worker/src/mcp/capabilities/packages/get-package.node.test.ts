import { beforeEach, expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageManifestBySourceId(...args),
}))

const { getPackageCapability } = await import('./get-package.ts')

// eslint-disable-next-line epic-web/prefer-dispose-in-tests -- this suite resets shared hoisted mocks between tests.
beforeEach(() => {
	mockModule.getSavedPackageById.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()
})

test('getPackageCapability returns ready-to-import package exports', async () => {
	mockModule.getSavedPackageById.mockResolvedValueOnce({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		createdAt: '2026-04-25T00:00:00.000Z',
		updatedAt: '2026-04-26T00:00:00.000Z',
	})
	mockModule.loadPackageManifestBySourceId.mockResolvedValueOnce({
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
	})

	const result = await getPackageCapability.handler(
		{ package_id: 'package-1' },
		{
			env: { APP_DB: {} } as Env,
			callerContext: {
				baseUrl: 'https://heykody.dev',
				user: {
					userId: 'user-1',
					email: 'me@kentcdodds.com',
					displayName: 'Kent',
				},
				homeConnectorId: null,
				remoteConnectors: null,
				storageContext: null,
				repoContext: null,
			},
		},
	)

	expect(result).toEqual({
		package_id: 'package-1',
		kody_id: 'discord-gateway',
		name: '@kentcdodds/discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		has_app: true,
		source_id: 'source-1',
		created_at: '2026-04-25T00:00:00.000Z',
		updated_at: '2026-04-26T00:00:00.000Z',
		exports: [
			{
				subpath: '.',
				import_specifier: 'kody:@kentcdodds/discord-gateway',
				runtime_target: 'src/index.ts',
				types_path: null,
				description: null,
				type_definition: null,
			},
			{
				subpath: './post-message',
				import_specifier: 'kody:@kentcdodds/discord-gateway/post-message',
				runtime_target: 'src/post-message.ts',
				types_path: 'src/post-message.ts',
				description: null,
				type_definition: null,
			},
		],
	})
	expect(mockModule.loadPackageManifestBySourceId).toHaveBeenCalledWith({
		env: { APP_DB: {} },
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-1',
	})
})
