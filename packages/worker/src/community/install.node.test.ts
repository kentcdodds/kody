import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	forkCommunityListing: vi.fn(),
	runRepoChecks: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
}))

vi.mock('./service.ts', () => ({
	forkCommunityListing: (...args: Array<unknown>) =>
		mockModule.forkCommunityListing(...args),
}))

vi.mock('#worker/repo/checks.ts', () => ({
	runRepoChecks: (...args: Array<unknown>) => mockModule.runRepoChecks(...args),
}))

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: (...args: Array<unknown>) =>
		mockModule.refreshSavedPackageProjection(...args),
}))

import { installCommunityListing } from './install.ts'

const env = { APP_DB: {} as D1Database } as Env

function forkResult() {
	return {
		forkId: 'fork-1',
		packageId: 'package-1',
		sourceId: 'source-1',
		targetKodyId: 'demo',
		targetName: '@userb/demo',
		originCommit: 'commit-1',
		crossScopeReferences: [],
		filesCount: 2,
		files: {
			'package.json': '{"name":"@userb/demo"}',
			'src/index.ts': 'export default async function main() {}',
		},
	}
}

function installInput() {
	return {
		env,
		baseUrl: 'https://kody.test',
		userId: 'user-b',
		userEmail: 'userb@example.com',
		expectedPackageScope: 'userb',
		listingId: 'listing-1',
		expectedPinnedCommit: 'commit-1',
	}
}

test('install publishes clean forks, keeps failed checks inert, and propagates errors', async () => {
	mockModule.forkCommunityListing.mockResolvedValue(forkResult())
	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }],
	})
	mockModule.refreshSavedPackageProjection.mockResolvedValue(undefined)

	const installed = await installCommunityListing(installInput())
	expect(installed).toEqual({
		status: 'installed',
		forkId: 'fork-1',
		packageId: 'package-1',
		sourceId: 'source-1',
		targetKodyId: 'demo',
		targetName: '@userb/demo',
		originCommit: 'commit-1',
	})
	// The user's trust/acknowledgement decision is pinned to the commit they
	// saw, so a concurrent republish cannot swap in unreviewed content.
	expect(mockModule.forkCommunityListing).toHaveBeenCalledWith(
		expect.objectContaining({ expectedPinnedCommit: 'commit-1' }),
	)
	expect(mockModule.runRepoChecks).toHaveBeenCalledWith(
		expect.objectContaining({
			manifestPath: 'package.json',
			sourceRoot: '/',
			env,
			baseUrl: 'https://kody.test',
			userId: 'user-b',
			expectedPackageScope: 'userb',
		}),
	)
	// The checks workspace serves the fork's rewritten snapshot files.
	const workspace = mockModule.runRepoChecks.mock.calls[0]?.[0]?.workspace
	await expect(workspace.readFile('package.json')).resolves.toBe(
		'{"name":"@userb/demo"}',
	)
	await expect(workspace.readFile('/src/index.ts')).resolves.toBe(
		'export default async function main() {}',
	)
	await expect(workspace.readFile('missing.ts')).resolves.toBeNull()
	await expect(workspace.glob('**/*')).resolves.toEqual([
		{ path: 'package.json', type: 'file' },
		{ path: 'src/index.ts', type: 'file' },
	])
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalledWith({
		env,
		baseUrl: 'https://kody.test',
		userId: 'user-b',
		userEmail: 'userb@example.com',
		packageId: 'package-1',
		sourceId: 'source-1',
	})

	mockModule.forkCommunityListing.mockResolvedValue({
		...forkResult(),
		crossScopeReferences: [{ file: 'src/index.ts', specifier: 'kody:@usera/' }],
	})
	mockModule.runRepoChecks.mockResolvedValue({
		ok: false,
		results: [
			{ kind: 'manifest', ok: true, message: 'ok' },
			{ kind: 'bundle', ok: false, message: 'unresolved kody import' },
		],
	})
	mockModule.refreshSavedPackageProjection.mockClear()

	const adaptationRequired = await installCommunityListing(installInput())
	expect(adaptationRequired).toEqual({
		status: 'adaptation_required',
		forkId: 'fork-1',
		packageId: 'package-1',
		sourceId: 'source-1',
		targetKodyId: 'demo',
		targetName: '@userb/demo',
		originCommit: 'commit-1',
		failedChecks: [
			{ kind: 'bundle', ok: false, message: 'unresolved kody import' },
		],
		crossScopeReferences: [{ file: 'src/index.ts', specifier: 'kody:@usera/' }],
	})
	expect(mockModule.refreshSavedPackageProjection).not.toHaveBeenCalled()

	mockModule.forkCommunityListing.mockRejectedValueOnce(
		new Error('banned from community participation'),
	)
	await expect(installCommunityListing(installInput())).rejects.toThrow(
		'banned from community participation',
	)

	mockModule.forkCommunityListing.mockResolvedValue(forkResult())
	mockModule.runRepoChecks.mockResolvedValue({ ok: true, results: [] })
	mockModule.refreshSavedPackageProjection.mockRejectedValue(
		new Error('saved_packages entitlement exceeded'),
	)
	await expect(installCommunityListing(installInput())).rejects.toThrow(
		'saved_packages entitlement exceeded',
	)
})
