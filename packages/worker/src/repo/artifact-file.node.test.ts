import { expect, test, vi } from 'vitest'
import { readArtifactFileAtCommit } from './artifact-file.ts'

const mocks = vi.hoisted(() => ({
	fetch: vi.fn(),
	init: vi.fn(),
	readBlob: vi.fn(),
	readMockArtifactSnapshot: vi.fn(),
	resolveExistingArtifactSourceRepo: vi.fn(),
}))

vi.mock('isomorphic-git', () => ({
	default: {
		fetch: (...args: Array<unknown>) => mocks.fetch(...args),
		init: (...args: Array<unknown>) => mocks.init(...args),
		readBlob: (...args: Array<unknown>) => mocks.readBlob(...args),
	},
}))

vi.mock('./artifacts.ts', () => {
	return {
		buildArtifactsGitAuth: () => ({ username: 'x', password: 'token' }),
		buildAuthenticatedArtifactsRemote: ({ remote }: { remote: string }) =>
			remote,
		isLoopbackArtifactsRemote: () => false,
		readMockArtifactSnapshot: (...args: Array<unknown>) =>
			mocks.readMockArtifactSnapshot(...args),
		resolveExistingArtifactSourceRepo: (...args: Array<unknown>) =>
			mocks.resolveExistingArtifactSourceRepo(...args),
	}
})

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
	expect(mocks.fetch).toHaveBeenCalledWith(
		expect.objectContaining({
			ref: 'abc123',
			depth: 1,
			singleBranch: true,
			tags: false,
		}),
	)
	expect(mocks.readBlob).toHaveBeenCalledWith(
		expect.objectContaining({
			oid: 'abc123',
			filepath: 'community-icon.png',
		}),
	)
})
