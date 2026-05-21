import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	listSavedPackagesByUserId: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	listSavedPackagesByUserId: (...args: Array<unknown>) =>
		mockModule.listSavedPackagesByUserId(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageManifestBySourceId(...args),
}))

const { listPackageSubscriptionsCapability } =
	await import('./list-package-subscriptions.ts')

function createCallerContext() {
	return {
		env: { APP_DB: {} } as Env,
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
	}
}

test('listPackageSubscriptionsCapability filters, sorts, and skips broken manifests', async () => {
	mockModule.listSavedPackagesByUserId.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()

	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([
		{
			id: 'package-1',
			userId: 'user-1',
			name: '@kentcdodds/discord-general-chat',
			kodyId: 'discord-general-chat',
			description: 'General Discord thread chat subscriber',
			tags: ['discord'],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			createdAt: '2026-04-25T00:00:00.000Z',
			updatedAt: '2026-04-25T00:00:00.000Z',
		},
		{
			id: 'package-2',
			userId: 'user-1',
			name: '@kentcdodds/other',
			kodyId: 'other',
			description: 'Non-subscriber package',
			tags: [],
			searchText: null,
			sourceId: 'source-2',
			hasApp: false,
			createdAt: '2026-04-25T00:00:00.000Z',
			updatedAt: '2026-04-25T00:00:00.000Z',
		},
	])
	mockModule.loadPackageManifestBySourceId.mockImplementationOnce(async () => ({
		source: { id: 'source-1' },
		manifest: {
			name: '@kentcdodds/discord-general-chat',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'discord-general-chat',
				description: 'General Discord thread chat subscriber',
				subscriptions: {
					'discord.message.created': {
						handler: './src/handle-discord-message-created.ts',
						description: 'General chat handler',
						filters: {
							channelIds: ['123'],
						},
					},
				},
			},
		},
	}))
	mockModule.loadPackageManifestBySourceId.mockImplementationOnce(async () => ({
		source: { id: 'source-2' },
		manifest: {
			name: '@kentcdodds/other',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'other',
				description: 'Other package',
			},
		},
	}))

	const filtered = await listPackageSubscriptionsCapability.handler(
		{ topic: 'discord.message.created' },
		createCallerContext(),
	)
	expect(filtered).toEqual({
		subscriptions: [
			{
				package_id: 'package-1',
				kody_id: 'discord-general-chat',
				name: '@kentcdodds/discord-general-chat',
				topic: 'discord.message.created',
				handler: './src/handle-discord-message-created.ts',
				description: 'General chat handler',
				filters: {
					channelIds: ['123'],
				},
			},
		],
	})

	mockModule.listSavedPackagesByUserId.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([
		{
			id: 'package-1',
			userId: 'user-1',
			name: '@kentcdodds/z-package',
			kodyId: 'z-package',
			description: 'Z package',
			tags: [],
			searchText: null,
			sourceId: 'source-1',
			hasApp: false,
			createdAt: '2026-04-25T00:00:00.000Z',
			updatedAt: '2026-04-25T00:00:00.000Z',
		},
		{
			id: 'package-2',
			userId: 'user-1',
			name: '@kentcdodds/a-package',
			kodyId: 'a-package',
			description: 'A package',
			tags: [],
			searchText: null,
			sourceId: 'source-2',
			hasApp: false,
			createdAt: '2026-04-25T00:00:00.000Z',
			updatedAt: '2026-04-25T00:00:00.000Z',
		},
	])
	mockModule.loadPackageManifestBySourceId.mockImplementationOnce(async () => ({
		source: { id: 'source-1' },
		manifest: {
			name: '@kentcdodds/z-package',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'z-package',
				description: 'Z package',
				subscriptions: {
					'discord.reaction.created': {
						handler: './src/reaction.ts',
					},
				},
			},
		},
	}))
	mockModule.loadPackageManifestBySourceId.mockImplementationOnce(async () => ({
		source: { id: 'source-2' },
		manifest: {
			name: '@kentcdodds/a-package',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'a-package',
				description: 'A package',
				subscriptions: {
					'discord.message.created': {
						handler: './src/message.ts',
						description: 'Message handler',
						filters: { channelIds: ['123'] },
					},
				},
			},
		},
	}))

	const sorted = await listPackageSubscriptionsCapability.handler(
		{},
		createCallerContext(),
	)
	expect(sorted).toEqual({
		subscriptions: [
			{
				package_id: 'package-2',
				kody_id: 'a-package',
				name: '@kentcdodds/a-package',
				topic: 'discord.message.created',
				handler: './src/message.ts',
				description: 'Message handler',
				filters: { channelIds: ['123'] },
			},
			{
				package_id: 'package-1',
				kody_id: 'z-package',
				name: '@kentcdodds/z-package',
				topic: 'discord.reaction.created',
				handler: './src/reaction.ts',
				description: null,
				filters: null,
			},
		],
	})

	const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
	mockModule.listSavedPackagesByUserId.mockReset()
	mockModule.loadPackageManifestBySourceId.mockReset()
	mockModule.listSavedPackagesByUserId.mockResolvedValueOnce([
		{
			id: 'package-1',
			userId: 'user-1',
			name: '@kentcdodds/ok-package',
			kodyId: 'ok-package',
			description: 'OK package',
			tags: [],
			searchText: null,
			sourceId: 'source-ok',
			hasApp: false,
			createdAt: '2026-04-25T00:00:00.000Z',
			updatedAt: '2026-04-25T00:00:00.000Z',
		},
		{
			id: 'package-2',
			userId: 'user-1',
			name: '@kentcdodds/bad-package',
			kodyId: 'bad-package',
			description: 'Bad package',
			tags: [],
			searchText: null,
			sourceId: 'source-bad',
			hasApp: false,
			createdAt: '2026-04-25T00:00:00.000Z',
			updatedAt: '2026-04-25T00:00:00.000Z',
		},
	])
	mockModule.loadPackageManifestBySourceId.mockImplementationOnce(async () => ({
		source: { id: 'source-ok' },
		manifest: {
			name: '@kentcdodds/ok-package',
			exports: { '.': './src/index.ts' },
			kody: {
				id: 'ok-package',
				description: 'OK package',
				subscriptions: {
					'discord.message.created': {
						handler: './src/message.ts',
					},
				},
			},
		},
	}))
	mockModule.loadPackageManifestBySourceId.mockImplementationOnce(async () => {
		throw new Error('manifest unavailable')
	})

	try {
		const resilient = await listPackageSubscriptionsCapability.handler(
			{},
			createCallerContext(),
		)
		expect(resilient).toEqual({
			subscriptions: [
				{
					package_id: 'package-1',
					kody_id: 'ok-package',
					name: '@kentcdodds/ok-package',
					topic: 'discord.message.created',
					handler: './src/message.ts',
					description: null,
					filters: null,
				},
			],
		})
		expect(warnSpy).toHaveBeenCalledWith(
			'Failed to load package manifest for subscriptions',
			{
				sourceId: 'source-bad',
				packageId: 'package-2',
				error: expect.any(Error),
			},
		)
	} finally {
		warnSpy.mockRestore()
	}
})
