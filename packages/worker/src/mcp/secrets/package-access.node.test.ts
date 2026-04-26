import { expect, test, vi } from 'vitest'
import { parsePackageAccessRequiredMessage } from './errors.ts'

const mockModule = vi.hoisted(() => ({
	getSavedPackageById: vi.fn(),
	loadPackageManifestBySourceId: vi.fn(),
	resolveSecret: vi.fn(),
}))

vi.mock('#worker/package-registry/repo.ts', () => ({
	getSavedPackageById: (...args: Array<unknown>) =>
		mockModule.getSavedPackageById(...args),
}))

vi.mock('#worker/package-registry/source.ts', () => ({
	loadPackageManifestBySourceId: (...args: Array<unknown>) =>
		mockModule.loadPackageManifestBySourceId(...args),
}))

vi.mock('./service.ts', () => ({
	resolveSecret: (...args: Array<unknown>) => mockModule.resolveSecret(...args),
}))

const {
	buildPackageApprovalErrorForMounts,
	isPackageSecretAccessUnavailableError,
	PackageSecretMountError,
	resolvePackageMountedSecret,
} = await import('./package-access.ts')

test('resolvePackageMountedSecret rejects calls without package appId context', async () => {
	await expect(
		resolvePackageMountedSecret({
			env: {} as Env,
			packageId: 'pkg-1',
			alias: 'discordBotToken',
			callerContext: {
				baseUrl: 'https://example.com',
				user: { userId: 'user-1', email: 'user@example.com', displayName: 'User' },
				homeConnectorId: null,
				remoteConnectors: null,
				repoContext: null,
				storageContext: {
					sessionId: null,
					appId: null,
					storageId: 'pkg-1',
				},
			},
		}),
	).rejects.toThrow(
		'Package secret access is only available inside server-side package runtime contexts.',
	)
})

test('resolvePackageMountedSecret rejects mismatched package appId context', async () => {
	await expect(
		resolvePackageMountedSecret({
			env: {} as Env,
			packageId: 'pkg-1',
			alias: 'discordBotToken',
			callerContext: {
				baseUrl: 'https://example.com',
				user: { userId: 'user-1', email: 'user@example.com', displayName: 'User' },
				homeConnectorId: null,
				remoteConnectors: null,
				repoContext: null,
				storageContext: {
					sessionId: null,
					appId: 'pkg-2',
					storageId: 'pkg-1',
				},
			},
		}),
	).rejects.toThrow(
		'Package secret access is only available inside server-side package runtime contexts.',
	)
})

test('resolvePackageMountedSecret resolves mounted secret when package appId matches', async () => {
	mockModule.getSavedPackageById.mockResolvedValueOnce({
		id: 'pkg-1',
		kodyId: 'discord-gateway',
		name: '@kentcdodds/discord-gateway',
		sourceId: 'source-1',
	})
	mockModule.loadPackageManifestBySourceId.mockResolvedValueOnce({
		manifest: {
			name: '@kentcdodds/discord-gateway',
			exports: {
				'.': './src/index.ts',
			},
			kody: {
				id: 'discord-gateway',
				description: 'Discord gateway',
				secretMounts: {
					discordBotToken: {
						name: 'discordBotTokenKentPersonalAutomation',
						scope: 'user',
					},
				},
			},
		},
	})
	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'bot-token',
		scope: 'user',
		allowedPackages: ['pkg-1'],
	})

	await expect(
		resolvePackageMountedSecret({
			env: { APP_DB: {} as D1Database } as Env,
			packageId: 'pkg-1',
			alias: 'discordBotToken',
			callerContext: {
				baseUrl: 'https://example.com',
				user: { userId: 'user-1', email: 'user@example.com', displayName: 'User' },
				homeConnectorId: null,
				remoteConnectors: null,
				repoContext: null,
				storageContext: {
					sessionId: null,
					appId: 'pkg-1',
					storageId: 'pkg-1',
				},
			},
		}),
	).resolves.toMatchObject({
		alias: 'discordBotToken',
		name: 'discordBotTokenKentPersonalAutomation',
		value: 'bot-token',
		scope: 'user',
		packageId: 'pkg-1',
		kodyId: 'discord-gateway',
	})

	expect(mockModule.resolveSecret).toHaveBeenCalledWith(
		expect.objectContaining({
			userId: 'user-1',
			name: 'discordBotTokenKentPersonalAutomation',
			scope: 'user',
			storageContext: {
				sessionId: null,
				appId: 'pkg-1',
				storageId: 'pkg-1',
			},
		}),
	)
})

test('package access helpers treat missing approvals consistently', () => {
	expect(buildPackageApprovalErrorForMounts({ entries: [] })).toBeNull()
	const approvalMessage = buildPackageApprovalErrorForMounts({
		entries: [
			{
				secretName: 'discordBotTokenKentPersonalAutomation',
				packageId: 'pkg-1',
				kodyId: 'discord-gateway',
				approvalUrl: 'https://example.com/account/secrets/user/discordBotToken',
			},
		],
	})
	expect(approvalMessage).toBeTypeOf('string')
	expect(parsePackageAccessRequiredMessage(approvalMessage ?? '')).toEqual({
		secretName: 'discordBotTokenKentPersonalAutomation',
		packageName: 'discord-gateway',
	})
	expect(approvalMessage).toContain(
		'https://example.com/account/secrets/user/discordBotToken',
	)
	expect(
		isPackageSecretAccessUnavailableError(
			new PackageSecretMountError('Package "discord-gateway" does not declare secret mount "discordBotToken".'),
		),
	).toBe(true)
})

test('findMissingPackageApprovals reads saved package metadata without loading manifest', async () => {
	mockModule.getSavedPackageById.mockResolvedValueOnce({
		id: 'pkg-1',
		kodyId: 'discord-gateway',
		name: '@kentcdodds/discord-gateway',
		sourceId: 'source-1',
	})
	mockModule.resolveSecret.mockResolvedValueOnce({
		found: true,
		value: 'bot-token',
		scope: 'user',
		allowedPackages: [],
	})

	const { findMissingPackageApprovals } = await import('./package-access.ts')
	const entries = await findMissingPackageApprovals({
		env: { APP_DB: {} as D1Database } as Env,
		baseUrl: 'https://example.com',
		userId: 'user-1',
		packageId: 'pkg-1',
		mounts: {
			discordBotToken: {
				name: 'discordBotTokenKentPersonalAutomation',
				scope: 'user',
			},
		},
		storageContext: {
			sessionId: null,
			appId: 'pkg-1',
			storageId: 'pkg-1',
		},
	})

	expect(entries).toHaveLength(1)
	expect(entries[0]).toMatchObject({
		secretName: 'discordBotTokenKentPersonalAutomation',
		packageId: 'pkg-1',
		kodyId: 'discord-gateway',
	})
	expect(mockModule.loadPackageManifestBySourceId).not.toHaveBeenCalled()
})
