import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	prepareCommunityFork: vi.fn(),
	persistPreparedCommunityFork: vi.fn(),
	runRepoChecks: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
}))

vi.mock('./service.ts', () => ({
	prepareCommunityFork: mockModule.prepareCommunityFork,
	persistPreparedCommunityFork: mockModule.persistPreparedCommunityFork,
}))

vi.mock('#worker/repo/checks.ts', async (importOriginal) => {
	const actual = await importOriginal<typeof import('#worker/repo/checks.ts')>()
	return {
		...actual,
		runRepoChecks: mockModule.runRepoChecks,
	}
})

vi.mock('#worker/package-registry/service.ts', () => ({
	refreshSavedPackageProjection: mockModule.refreshSavedPackageProjection,
}))

import { installCommunityListing } from './install.ts'

const env = { APP_DB: {} as D1Database } as Env
const files = {
	'package.json': '{"name":"@userb/demo"}',
	'src/index.ts': 'export default async function main() {}',
}
const crossScopeReferences = [
	{ file: 'src/index.ts', specifier: 'kody:@usera/' },
]
const forkFields = {
	forkId: 'fork-1',
	packageId: 'package-1',
	sourceId: 'source-1',
	targetKodyId: 'demo',
	targetName: '@userb/demo',
	originCommit: 'commit-1',
}

function preparedFork(overrides: { crossScopeReferences?: unknown } = {}) {
	return {
		env,
		baseUrl: 'https://kody.test',
		userId: 'user-b',
		listingId: 'listing-1',
		listingName: '@owner/demo',
		listingKodyId: 'demo',
		originCommit: 'commit-1',
		actor: 'human' as const,
		packageId: 'package-1',
		targetKodyId: 'demo',
		targetName: '@userb/demo',
		files,
		crossScopeReferences: [],
		...overrides,
	}
}

function forkResult(overrides: { crossScopeReferences?: unknown } = {}) {
	return {
		...forkFields,
		crossScopeReferences: [],
		filesCount: 2,
		files,
		...overrides,
	}
}

function install(overrides: { waitUntil?: () => void } = {}) {
	return installCommunityListing({
		env,
		baseUrl: 'https://kody.test',
		userId: 'user-b',
		userEmail: 'userb@example.com',
		expectedPackageScope: 'userb',
		listingId: 'listing-1',
		expectedPinnedCommit: 'commit-1',
		...overrides,
	})
}

function mockCleanInstall() {
	mockModule.prepareCommunityFork.mockResolvedValue(preparedFork())
	mockModule.persistPreparedCommunityFork.mockResolvedValue(forkResult())
	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }],
	})
	mockModule.refreshSavedPackageProjection.mockResolvedValue(undefined)
}

async function waitFor(condition: () => boolean) {
	for (let attempt = 0; attempt < 50 && !condition(); attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
	expect(condition()).toBe(true)
}

test('install publishes clean forks, keeps failed checks inert, and propagates errors', async () => {
	mockCleanInstall()
	await expect(install()).resolves.toEqual({
		status: 'installed',
		...forkFields,
	})
	// The user's trust/acknowledgement decision is pinned to the commit they
	// saw, so a concurrent republish cannot swap in unreviewed content.
	expect(mockModule.prepareCommunityFork).toHaveBeenCalledWith(
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
			requirePackageDocs: false,
		}),
	)
	// The checks workspace serves the fork's rewritten snapshot files.
	const workspace = mockModule.runRepoChecks.mock.calls[0]?.[0]?.workspace
	await expect(workspace.readFile('package.json')).resolves.toBe(
		files['package.json'],
	)
	await expect(workspace.readFile('/src/index.ts')).resolves.toBe(
		files['src/index.ts'],
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
		sourceFiles: files,
		waitUntil: undefined,
	})

	const waitUntil = vi.fn()
	await install({ waitUntil })
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenLastCalledWith(
		expect.objectContaining({ waitUntil, sourceFiles: files }),
	)

	mockModule.prepareCommunityFork.mockResolvedValue(
		preparedFork({ crossScopeReferences }),
	)
	mockModule.persistPreparedCommunityFork.mockResolvedValue(
		forkResult({ crossScopeReferences }),
	)
	const failedCheck = {
		kind: 'bundle',
		ok: false,
		message: 'unresolved kody import',
	}
	mockModule.runRepoChecks.mockResolvedValue({
		ok: false,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }, failedCheck],
	})
	mockModule.refreshSavedPackageProjection.mockClear()
	await expect(install()).resolves.toEqual({
		status: 'adaptation_required',
		...forkFields,
		failedChecks: [failedCheck],
		crossScopeReferences,
	})
	expect(mockModule.refreshSavedPackageProjection).not.toHaveBeenCalled()

	mockModule.prepareCommunityFork.mockRejectedValueOnce(
		new Error('banned from community participation'),
	)
	await expect(install()).rejects.toThrow('banned from community participation')

	mockCleanInstall()
	mockModule.refreshSavedPackageProjection.mockRejectedValue(
		new Error('saved_packages entitlement exceeded'),
	)
	await expect(install()).rejects.toThrow('saved_packages entitlement exceeded')
})

test('install overlaps Artifacts persist with publish checks', async () => {
	mockCleanInstall()
	const persistGate = Promise.withResolvers<void>()
	const checksGate = Promise.withResolvers<void>()
	const started: Array<string> = []
	mockModule.persistPreparedCommunityFork.mockImplementation(async () => {
		started.push('persist')
		await persistGate.promise
		return forkResult()
	})
	mockModule.runRepoChecks.mockImplementation(async () => {
		started.push('checks')
		await checksGate.promise
		return { ok: true, results: [] }
	})
	const installPromise = install()
	await waitFor(() => started.includes('persist') && started.includes('checks'))
	persistGate.resolve()
	checksGate.resolve()
	await expect(installPromise).resolves.toMatchObject({ status: 'installed' })

	const checksFailPersistGate = Promise.withResolvers<void>()
	let persistStarted = false
	let persistFinished = false
	mockModule.persistPreparedCommunityFork.mockImplementation(async () => {
		persistStarted = true
		await checksFailPersistGate.promise
		persistFinished = true
		return forkResult()
	})
	mockModule.runRepoChecks.mockRejectedValue(
		new Error('isolated check isolate reset'),
	)
	mockModule.refreshSavedPackageProjection.mockClear()
	const checksThrowPromise = install()
	await waitFor(() => persistStarted)
	expect(persistFinished).toBe(false)
	checksFailPersistGate.resolve()
	await expect(checksThrowPromise).rejects.toThrow(
		'isolated check isolate reset',
	)
	expect(persistFinished).toBe(true)
	expect(mockModule.refreshSavedPackageProjection).not.toHaveBeenCalled()

	const persistFailChecksGate = Promise.withResolvers<void>()
	let checksStarted = false
	let checksFinished = false
	mockModule.persistPreparedCommunityFork.mockRejectedValue(
		new Error('artifact bootstrap failed'),
	)
	mockModule.runRepoChecks.mockImplementation(async () => {
		checksStarted = true
		await persistFailChecksGate.promise
		checksFinished = true
		return { ok: true, results: [] }
	})
	const persistThrowPromise = install()
	await waitFor(() => checksStarted)
	expect(checksFinished).toBe(false)
	persistFailChecksGate.resolve()
	await expect(persistThrowPromise).rejects.toThrow('artifact bootstrap failed')
	expect(checksFinished).toBe(true)
})
