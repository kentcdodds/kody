import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	prepareCommunityFork: vi.fn(),
	persistPreparedCommunityFork: vi.fn(),
	runRepoChecks: vi.fn(),
	refreshSavedPackageProjection: vi.fn(),
}))

vi.mock('./service.ts', () => ({
	prepareCommunityFork: (...args: Array<unknown>) =>
		mockModule.prepareCommunityFork(...args),
	persistPreparedCommunityFork: (...args: Array<unknown>) =>
		mockModule.persistPreparedCommunityFork(...args),
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

function preparedFork() {
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
		files: {
			'package.json': '{"name":"@userb/demo"}',
			'src/index.ts': 'export default async function main() {}',
		},
		crossScopeReferences: [],
	}
}

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
		files: preparedFork().files,
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
	const prepared = preparedFork()
	mockModule.prepareCommunityFork.mockResolvedValue(prepared)
	mockModule.persistPreparedCommunityFork.mockResolvedValue(forkResult())
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
		sourceFiles: prepared.files,
		waitUntil: undefined,
	})

	const waitUntil = vi.fn()
	mockModule.prepareCommunityFork.mockResolvedValue(preparedFork())
	mockModule.persistPreparedCommunityFork.mockResolvedValue(forkResult())
	mockModule.runRepoChecks.mockResolvedValue({
		ok: true,
		results: [{ kind: 'manifest', ok: true, message: 'ok' }],
	})
	mockModule.refreshSavedPackageProjection.mockClear()
	await installCommunityListing({ ...installInput(), waitUntil })
	expect(mockModule.refreshSavedPackageProjection).toHaveBeenCalledWith(
		expect.objectContaining({ waitUntil, sourceFiles: prepared.files }),
	)

	mockModule.prepareCommunityFork.mockResolvedValue({
		...preparedFork(),
		crossScopeReferences: [{ file: 'src/index.ts', specifier: 'kody:@usera/' }],
	})
	mockModule.persistPreparedCommunityFork.mockResolvedValue({
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

	mockModule.prepareCommunityFork.mockRejectedValueOnce(
		new Error('banned from community participation'),
	)
	await expect(installCommunityListing(installInput())).rejects.toThrow(
		'banned from community participation',
	)

	mockModule.prepareCommunityFork.mockResolvedValue(preparedFork())
	mockModule.persistPreparedCommunityFork.mockResolvedValue(forkResult())
	mockModule.runRepoChecks.mockResolvedValue({ ok: true, results: [] })
	mockModule.refreshSavedPackageProjection.mockRejectedValue(
		new Error('saved_packages entitlement exceeded'),
	)
	await expect(installCommunityListing(installInput())).rejects.toThrow(
		'saved_packages entitlement exceeded',
	)
})

test('install overlaps Artifacts persist with publish checks', async () => {
	let resolvePersist: (() => void) | undefined
	const persistGate = new Promise<void>((resolve) => {
		resolvePersist = resolve
	})
	let resolveChecks: (() => void) | undefined
	const checksGate = new Promise<void>((resolve) => {
		resolveChecks = resolve
	})
	const started: Array<string> = []
	mockModule.prepareCommunityFork.mockResolvedValue(preparedFork())
	mockModule.persistPreparedCommunityFork.mockImplementation(async () => {
		started.push('persist')
		await persistGate
		return forkResult()
	})
	mockModule.runRepoChecks.mockImplementation(async () => {
		started.push('checks')
		await checksGate
		return { ok: true, results: [] }
	})
	mockModule.refreshSavedPackageProjection.mockResolvedValue(undefined)

	const installPromise = installCommunityListing(installInput())
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (started.includes('persist') && started.includes('checks')) break
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
	expect(started).toEqual(expect.arrayContaining(['persist', 'checks']))
	resolvePersist?.()
	resolveChecks?.()
	await expect(installPromise).resolves.toMatchObject({ status: 'installed' })

	let persistFinished = false
	let persistStarted = false
	const checksFailPersistGate = new Promise<void>((resolve) => {
		resolvePersist = resolve
	})
	mockModule.prepareCommunityFork.mockResolvedValue(preparedFork())
	mockModule.persistPreparedCommunityFork.mockImplementation(async () => {
		persistStarted = true
		await checksFailPersistGate
		persistFinished = true
		return forkResult()
	})
	mockModule.runRepoChecks.mockRejectedValue(
		new Error('isolated check isolate reset'),
	)
	mockModule.refreshSavedPackageProjection.mockClear()
	const checksThrowPromise = installCommunityListing(installInput())
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (persistStarted) break
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
	expect(persistStarted).toBe(true)
	expect(persistFinished).toBe(false)
	resolvePersist?.()
	await expect(checksThrowPromise).rejects.toThrow(
		'isolated check isolate reset',
	)
	expect(persistFinished).toBe(true)
	expect(mockModule.refreshSavedPackageProjection).not.toHaveBeenCalled()

	let checksFinished = false
	let checksStarted = false
	const persistFailChecksGate = new Promise<void>((resolve) => {
		resolveChecks = resolve
	})
	mockModule.prepareCommunityFork.mockResolvedValue(preparedFork())
	mockModule.persistPreparedCommunityFork.mockRejectedValue(
		new Error('artifact bootstrap failed'),
	)
	mockModule.runRepoChecks.mockImplementation(async () => {
		checksStarted = true
		await persistFailChecksGate
		checksFinished = true
		return { ok: true, results: [] }
	})
	const persistThrowPromise = installCommunityListing(installInput())
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (checksStarted) break
		await new Promise((resolve) => setTimeout(resolve, 0))
	}
	expect(checksStarted).toBe(true)
	expect(checksFinished).toBe(false)
	resolveChecks?.()
	await expect(persistThrowPromise).rejects.toThrow('artifact bootstrap failed')
	expect(checksFinished).toBe(true)
})
