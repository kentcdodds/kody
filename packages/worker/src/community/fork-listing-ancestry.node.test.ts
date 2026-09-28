import { beforeEach, expect, test, vi } from 'vitest'
import { listingPinIsAncestorOfForkTip } from './fork-listing-ancestry.ts'

const mocks = vi.hoisted(() => ({
	addRemote: vi.fn(),
	fetch: vi.fn(),
	init: vi.fn(),
	log: vi.fn(),
	resolveExistingArtifactSourceRepo: vi.fn(),
	isLoopbackArtifactsRemote: vi.fn(() => false),
}))

vi.mock('isomorphic-git', () => ({
	default: {
		addRemote: (...args: Array<unknown>) => mocks.addRemote(...args),
		fetch: (...args: Array<unknown>) => mocks.fetch(...args),
		init: (...args: Array<unknown>) => mocks.init(...args),
		log: (...args: Array<unknown>) => mocks.log(...args),
	},
}))

vi.mock('isomorphic-git/http/web', () => ({
	default: {},
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	buildArtifactsGitAuth: () => ({ username: 'x', password: 'token' }),
	buildAuthenticatedArtifactsRemote: ({ remote }: { remote: string }) => remote,
	isLoopbackArtifactsRemote: (...args: Array<unknown>) =>
		mocks.isLoopbackArtifactsRemote(...args),
	resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
		mocks.resolveExistingArtifactSourceRepo(...args),
}))

// Answers are cached per isolate, so each case uses its own repo id.
beforeEach(() => {
	vi.clearAllMocks()
})

function readyRepo() {
	return {
		info: vi.fn(async () => ({
			remote: 'https://artifacts.example.test/package.git',
			defaultBranch: 'main',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'token',
		})),
	}
}

test('listing pin ancestry walks the origin absorb marker and treats missing history as not-ancestor', async () => {
	expect(
		await listingPinIsAncestorOfForkTip({
			env: {} as Env,
			repoId: 'repo-1',
			listingPinnedCommit: 'commit-same',
			forkTip: 'commit-same',
		}),
	).toBe(true)

	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue(readyRepo())
	mocks.log.mockResolvedValue([
		{ oid: 'commit-tip' },
		{ oid: 'commit-pin' },
		{ oid: 'commit-root' },
	])
	expect(
		await listingPinIsAncestorOfForkTip({
			env: {} as Env,
			repoId: 'repo-1',
			listingPinnedCommit: 'commit-pin',
			forkTip: 'commit-tip',
		}),
	).toBe(true)
	expect(mocks.fetch).toHaveBeenCalledWith(
		expect.objectContaining({
			ref: 'commit-tip',
			depth: Number.POSITIVE_INFINITY,
			singleBranch: true,
			tags: false,
		}),
	)

	mocks.log.mockResolvedValue([{ oid: 'commit-tip' }, { oid: 'commit-root' }])
	expect(
		await listingPinIsAncestorOfForkTip({
			env: {} as Env,
			repoId: 'repo-1',
			listingPinnedCommit: 'commit-new',
			forkTip: 'commit-tip',
		}),
	).toBe(false)

	mocks.isLoopbackArtifactsRemote.mockReturnValueOnce(true)
	expect(
		await listingPinIsAncestorOfForkTip({
			env: {} as Env,
			repoId: 'repo-loopback',
			listingPinnedCommit: 'commit-pin',
			forkTip: 'commit-tip',
		}),
	).toBe(null)

	mocks.resolveExistingArtifactSourceRepo.mockResolvedValueOnce(null)
	expect(
		await listingPinIsAncestorOfForkTip({
			env: {} as Env,
			repoId: 'missing',
			listingPinnedCommit: 'commit-pin',
			forkTip: 'commit-tip',
		}),
	).toBe(null)
})

test('listing pin ancestry reuses definite answers without refetching the origin graph', async () => {
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue(readyRepo())
	mocks.log.mockResolvedValue([{ oid: 'commit-tip' }, { oid: 'commit-pin' }])
	const input = {
		env: {} as Env,
		repoId: 'repo-reuse',
		listingPinnedCommit: 'commit-pin',
		forkTip: 'commit-tip',
	}

	const concurrent = await Promise.all([
		listingPinIsAncestorOfForkTip(input),
		listingPinIsAncestorOfForkTip(input),
	])
	expect(concurrent).toEqual([true, true])
	expect(await listingPinIsAncestorOfForkTip(input)).toBe(true)
	expect(mocks.fetch).toHaveBeenCalledTimes(1)

	mocks.log.mockResolvedValue([{ oid: 'commit-tip' }])
	const notAncestor = { ...input, listingPinnedCommit: 'commit-other' }
	expect(await listingPinIsAncestorOfForkTip(notAncestor)).toBe(false)
	expect(await listingPinIsAncestorOfForkTip(notAncestor)).toBe(false)
	expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

test('listing pin ancestry retries after an unreadable graph instead of caching null', async () => {
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValueOnce(null)
	const input = {
		env: {} as Env,
		repoId: 'repo-flaky',
		listingPinnedCommit: 'commit-pin',
		forkTip: 'commit-tip',
	}
	expect(await listingPinIsAncestorOfForkTip(input)).toBe(null)

	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue(readyRepo())
	mocks.log.mockResolvedValue([{ oid: 'commit-tip' }, { oid: 'commit-pin' }])
	expect(await listingPinIsAncestorOfForkTip(input)).toBe(true)
	expect(mocks.resolveExistingArtifactSourceRepo).toHaveBeenCalledTimes(2)
})
