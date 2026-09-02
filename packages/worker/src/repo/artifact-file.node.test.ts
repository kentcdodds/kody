import { expect, test, vi } from 'vitest'
import {
	readArtifactFileAtCommit,
	readArtifactTreeAtCommit,
} from './artifact-file.ts'

const mocks = vi.hoisted(() => ({
	addRemote: vi.fn(),
	fetch: vi.fn(),
	init: vi.fn(),
	readBlob: vi.fn(),
	walk: vi.fn(),
	TREE: vi.fn((input: { ref: string }) => input),
	resolveExistingArtifactSourceRepo: vi.fn(),
	isLoopbackArtifactsRemote: vi.fn(() => false),
	readArtifactSourceSnapshot: vi.fn(),
}))

vi.mock('isomorphic-git', () => ({
	default: {
		addRemote: (...args: Array<unknown>) => mocks.addRemote(...args),
		fetch: (...args: Array<unknown>) => mocks.fetch(...args),
		init: (...args: Array<unknown>) => mocks.init(...args),
		readBlob: (...args: Array<unknown>) => mocks.readBlob(...args),
		walk: (...args: Array<unknown>) => mocks.walk(...args),
		TREE: (...args: Array<unknown>) => mocks.TREE(...args),
	},
}))

vi.mock('./artifacts.ts', () => {
	return {
		buildArtifactsGitAuth: () => ({ username: 'x', password: 'token' }),
		buildAuthenticatedArtifactsRemote: ({ remote }: { remote: string }) =>
			remote,
		isLoopbackArtifactsRemote: (...args: Array<unknown>) =>
			mocks.isLoopbackArtifactsRemote(...args),
		resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
			mocks.resolveExistingArtifactSourceRepo(...args),
	}
})

vi.mock('./artifact-source-snapshot.ts', () => ({
	readArtifactSourceSnapshot: (...args: Array<unknown>) =>
		mocks.readArtifactSourceSnapshot(...args),
}))

test('reads binary artifact files from an exact pinned commit', async () => {
	const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			remote: 'https://artifacts.example.test/package.git',
			defaultBranch: 'main',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'token',
		})),
	})
	mocks.readBlob.mockResolvedValue({ blob: bytes })

	const result = await readArtifactFileAtCommit({
		env: {} as Env,
		repoId: 'package-1',
		commit: 'abc123',
		filePath: 'community-icon.png',
	})

	expect(result).toEqual(bytes)
	expect(mocks.init).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/repo',
		}),
	)
	expect(mocks.addRemote).toHaveBeenCalledWith(
		expect.objectContaining({
			dir: '/repo',
			remote: 'origin',
			url: 'https://artifacts.example.test/package.git',
		}),
	)
	expect(mocks.fetch).toHaveBeenCalledWith(
		expect.objectContaining({
			remote: 'origin',
			ref: 'abc123',
			depth: 1,
			singleBranch: true,
			tags: false,
		}),
	)
	expect(mocks.addRemote.mock.invocationCallOrder[0]).toBeLessThan(
		mocks.fetch.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
	)
	expect(mocks.readBlob).toHaveBeenCalledWith(
		expect.objectContaining({
			oid: 'abc123',
			filepath: 'community-icon.png',
		}),
	)

	const httpError = Object.assign(
		new Error('HTTP Error: 500 Internal Server Error'),
		{
			code: 'HttpError',
			name: 'HttpError',
			data: {
				statusCode: 500,
				statusMessage: 'Internal Server Error',
				response: '',
			},
		},
	)
	mocks.fetch.mockReset()
	mocks.fetch.mockRejectedValueOnce(httpError).mockResolvedValueOnce(undefined)
	mocks.readBlob.mockResolvedValue({ blob: bytes })
	await expect(
		readArtifactFileAtCommit({
			env: {} as Env,
			repoId: 'package-1',
			commit: 'abc123',
			filePath: 'community-icon.png',
		}),
	).resolves.toEqual(bytes)
	expect(mocks.fetch).toHaveBeenCalledTimes(2)
})

test('retries packfile corruption on readBlob after fetch and does not retry missing files (KODY-CLOUDFLARE-56)', async () => {
	const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			remote: 'https://artifacts.example.test/package.git',
			defaultBranch: 'main',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'token',
		})),
	})
	mocks.fetch.mockReset()
	mocks.fetch.mockResolvedValue(undefined)
	mocks.init.mockClear()
	mocks.addRemote.mockClear()

	const packCorruption = Object.assign(
		new Error(
			`An internal error caused this command to fail.\n\nIf you're using an application that depends on isomorphic-git, please report this error to that application's developers.\n\nIf you're a developer and you believe this is a bug in isomorphic-git, please file an issue at https://github.com/isomorphic-git/isomorphic-git/issues with a minimal reproduction, version and environment details, and this error message: Packfile payload corrupted: calculated abc but expected def. The packfile may have been tampered with.`,
		),
		{ code: 'InternalError', name: 'InternalError' },
	)
	mocks.readBlob
		.mockRejectedValueOnce(packCorruption)
		.mockResolvedValueOnce({ blob: bytes })

	await expect(
		readArtifactFileAtCommit({
			env: {} as Env,
			repoId: 'package-1',
			commit: 'abc123',
			filePath: 'community-icon.png',
		}),
	).resolves.toEqual(bytes)

	// Fresh workspace + fetch on each attempt (corruption on read must re-fetch).
	expect(mocks.fetch).toHaveBeenCalledTimes(2)
	expect(mocks.init).toHaveBeenCalledTimes(2)
	expect(mocks.readBlob).toHaveBeenCalledTimes(2)

	mocks.fetch.mockClear()
	mocks.init.mockClear()
	const missing = Object.assign(
		new Error('Could not find community-icon.png'),
		{
			code: 'NotFoundError',
			name: 'NotFoundError',
		},
	)
	mocks.readBlob.mockReset()
	mocks.readBlob.mockRejectedValue(missing)

	await expect(
		readArtifactFileAtCommit({
			env: {} as Env,
			repoId: 'package-1',
			commit: 'abc123',
			filePath: 'community-icon.png',
		}),
	).resolves.toBeNull()

	expect(mocks.fetch).toHaveBeenCalledTimes(1)
	expect(mocks.readBlob).toHaveBeenCalledTimes(1)
})

test('readArtifactTreeAtCommit walks the fetched commit tree', async () => {
	mocks.isLoopbackArtifactsRemote.mockReturnValue(false)
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			remote: 'https://artifacts.example.test/package.git',
			defaultBranch: 'main',
		})),
		createToken: vi.fn(async () => ({
			plaintext: 'token',
		})),
	})
	mocks.fetch.mockReset()
	mocks.fetch.mockResolvedValue(undefined)
	mocks.walk.mockImplementation(
		async (input: {
			map: (
				filepath: string,
				entries: Array<{
					type: () => Promise<string>
					content: () => Promise<Uint8Array>
				} | null>,
			) => Promise<void>
		}) => {
			await input.map('.', [null])
			await input.map('src', [
				{
					type: async () => 'tree',
					content: async () => new Uint8Array(),
				},
			])
			await input.map('README.md', [
				{
					type: async () => 'blob',
					content: async () => new TextEncoder().encode('# Hello\n'),
				},
			])
			await input.map('__proto__', [
				{
					type: async () => 'blob',
					content: async () => new TextEncoder().encode('not proto\n'),
				},
			])
		},
	)

	const tree = await readArtifactTreeAtCommit({
		env: {} as Env,
		repoId: 'package-1',
		commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	})
	expect(tree?.['README.md']).toBe('# Hello\n')
	expect(Object.hasOwn(tree ?? {}, '__proto__')).toBe(true)
	expect(tree?.['__proto__']).toBe('not proto\n')
	expect(mocks.TREE).toHaveBeenCalledWith({
		ref: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
	})
	expect(mocks.fetch).toHaveBeenCalledWith(
		expect.objectContaining({
			ref: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
			depth: 1,
		}),
	)
})

test('readArtifactTreeAtCommit returns null when a loopback snapshot is missing', async () => {
	mocks.isLoopbackArtifactsRemote.mockReturnValue(true)
	mocks.resolveExistingArtifactSourceRepo.mockResolvedValue({
		info: vi.fn(async () => ({
			remote: 'http://127.0.0.1/package.git',
			defaultBranch: 'main',
		})),
	})
	mocks.readArtifactSourceSnapshot.mockResolvedValueOnce(null)
	await expect(
		readArtifactTreeAtCommit({
			env: {} as Env,
			repoId: 'package-1',
			commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
		}),
	).resolves.toBeNull()

	mocks.readArtifactSourceSnapshot.mockResolvedValueOnce({ files: {} })
	await expect(
		readArtifactTreeAtCommit({
			env: {} as Env,
			repoId: 'package-1',
			commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
		}),
	).resolves.toEqual({})
	mocks.isLoopbackArtifactsRemote.mockReturnValue(false)
})
