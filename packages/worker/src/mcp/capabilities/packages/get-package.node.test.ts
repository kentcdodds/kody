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

function createCallerContext(input?: {
	includeUsername?: boolean
	username?: string | null
}) {
	const appDb = {
		prepare: () => ({
			bind: () => ({
				first: async () => {
					if (input?.includeUsername === false) return null
					return { username: input?.username ?? 'kody' }
				},
			}),
		}),
	} as unknown as D1Database

	const user: {
		userId: string
		email: string
		displayName: string
		username?: string
	} = {
		userId: 'user-1',
		email: 'kody@example.com',
		displayName: 'Kody',
	}
	if (input?.includeUsername !== false) {
		user.username = input?.username ?? 'kody'
	}

	return {
		env: { APP_DB: appDb } as Env,
		callerContext: {
			baseUrl: 'https://heykody.dev',
			user,
			remoteConnectors: null,
			storageContext: null,
			repoContext: null,
		},
	}
}

test('getPackageCapability returns export metadata and omits external invocation without a public username', async () => {
	mockModule.getSavedPackageById.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: true,
		hidden: false,
		createdAt: '2026-04-25T00:00:00.000Z',
		updatedAt: '2026-04-26T00:00:00.000Z',
	})
	mockModule.loadPackageManifestBySourceId.mockResolvedValue({
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
	expect(mockModule.loadPackageManifestBySourceId).toHaveBeenCalledWith({
		env: expect.objectContaining({ APP_DB: expect.anything() }),
		baseUrl: 'https://heykody.dev',
		userId: 'user-1',
		sourceId: 'source-1',
	})

	mockModule.getSavedPackageById.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()
	mockModule.getSavedPackageById.mockResolvedValue({
		id: 'package-1',
		userId: 'user-1',
		name: '@kentcdodds/discord-gateway',
		kodyId: 'discord-gateway',
		description: 'Discord helpers',
		tags: ['discord'],
		searchText: null,
		sourceId: 'source-1',
		hasApp: false,
		hidden: false,
		createdAt: '2026-04-25T00:00:00.000Z',
		updatedAt: '2026-04-26T00:00:00.000Z',
	})
	mockModule.loadPackageManifestBySourceId.mockResolvedValue({
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

	const withoutUsername = await getPackageCapability.handler(
		{ package_id: 'package-1' },
		createCallerContext({ includeUsername: false }),
	)

	expect(withoutUsername.exports).toEqual([
		expect.objectContaining({
			subpath: './post-message',
			external_invocation: null,
		}),
	])
})
