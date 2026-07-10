import { expect, test, vi } from 'vitest'
import { readArtifactFileAtCommit } from './artifact-file.ts'

const mocks = vi.hoisted(() => ({
	clone: vi.fn(),
	readBlob: vi.fn(),
	readMockArtifactSnapshot: vi.fn(),
	resolveExistingArtifactSourceRepo: vi.fn(),
}))

vi.mock('isomorphic-git', () => ({
	default: {
		clone: (...args: Array<unknown>) => mocks.clone(...args),
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
	expect(mocks.clone).toHaveBeenCalledWith(
		expect.objectContaining({
			ref: 'main',
			singleBranch: true,
			noCheckout: true,
		}),
	)
	expect(mocks.readBlob).toHaveBeenCalledWith(
		expect.objectContaining({
			oid: 'abc123',
			filepath: 'community-icon.png',
		}),
	)
})
