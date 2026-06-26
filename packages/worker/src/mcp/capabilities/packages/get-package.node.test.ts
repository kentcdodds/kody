import { expect, test, vi } from 'vitest'

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

test('getPackageCapability returns ready-to-import package exports', async () => {
	mockModule.getSavedPackageById.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()
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
					username: 'kentcdodds',
					displayName: 'Kent',
				},
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
				external_invocation: {
					method: 'POST',
					url: 'https://heykody.dev/@kentcdodds/api/package-invocations/discord-gateway/__root__',
					path: '/@kentcdodds/api/package-invocations/discord-gateway/__root__',
					owner_username: 'kentcdodds',
					kody_id: 'discord-gateway',
					route_export_name: '__root__',
					normalized_export_name: '.',
					token_setup_url:
						'https://heykody.dev/account/package-invocation-tokens/new?packageKodyIds=discord-gateway&exportNames=.',
					source_guidance:
						'If the package invocation token is scoped to allowedSources, include JSON "source" with the exact allowed source label. Otherwise omit "source" or send null.',
				},
			},
			{
				subpath: './post-message',
				import_specifier: 'kody:@kentcdodds/discord-gateway/post-message',
				runtime_target: 'src/post-message.ts',
				types_path: 'src/post-message.ts',
				description: null,
				type_definition: null,
				external_invocation: {
					method: 'POST',
					url: 'https://heykody.dev/@kentcdodds/api/package-invocations/discord-gateway/post-message',
					path: '/@kentcdodds/api/package-invocations/discord-gateway/post-message',
					owner_username: 'kentcdodds',
					kody_id: 'discord-gateway',
					route_export_name: 'post-message',
					normalized_export_name: './post-message',
					token_setup_url:
						'https://heykody.dev/account/package-invocation-tokens/new?packageKodyIds=discord-gateway&exportNames=post-message',
					source_guidance:
						'If the package invocation token is scoped to allowedSources, include JSON "source" with the exact allowed source label. Otherwise omit "source" or send null.',
				},
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

test('getPackageCapability keeps package details when no public username is available', async () => {
	mockModule.getSavedPackageById.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()
	mockModule.getSavedPackageById.mockResolvedValueOnce({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		createdAt: '2026-04-25T00:00:00.000Z',
		updatedAt: '2026-04-26T00:00:00.000Z',
	})
	mockModule.loadPackageManifestBySourceId.mockResolvedValueOnce({
		source: { id: 'source-1' },
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'./post-message': './src/post-message.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord helpers',
			},
		},
	})

	const appDb = {
		prepare: () => ({
			bind: () => ({
				first: async () => null,
			}),
		}),
	} as unknown as D1Database
	const result = await getPackageCapability.handler(
		{ package_id: 'package-1' },
		{
			env: { APP_DB: appDb } as Env,
			callerContext: {
				baseUrl: 'https://heykody.dev',
				user: {
					userId: 'user-1',
					email: 'me@kentcdodds.com',
					displayName: 'Kent',
				},
				remoteConnectors: null,
				storageContext: null,
				repoContext: null,
			},
		},
	)

	expect(result.exports).toEqual([
		expect.objectContaining({
			subpath: './post-message',
			external_invocation: null,
		}),
	])
})
