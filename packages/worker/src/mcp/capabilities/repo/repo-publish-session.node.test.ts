import { expect, test, vi } from 'vitest'
import { createMcpCallerContext } from '#mcp/context.ts'
import { CommunityActionError } from '#worker/community/errors.ts'

const mockModule = vi.hoisted(() => ({
	repoSessionRpc: vi.fn(),
	getMcpUserPackageScope: vi.fn(),
	rebuildPublishedPackageArtifactsViaRepoSession: vi.fn(),
	getEntitySourceByIdForUser: vi.fn(),
	absorbCommunityForkUpstream: vi.fn(),
}))

vi.mock('#worker/repo/repo-session-rpc.ts', () => ({
	repoSessionRpc: (...args: Array<unknown>) =>
		mockModule.repoSessionRpc(...args),
}))

vi.mock('#worker/package-registry/user-scope.ts', () => ({
	getMcpUserPackageScope: (...args: Array<unknown>) =>
		mockModule.getMcpUserPackageScope(...args),
}))

vi.mock('./package-artifact-rebuild.ts', () => ({
	rebuildPublishedPackageArtifactsViaRepoSession: (...args: Array<unknown>) =>
		mockModule.rebuildPublishedPackageArtifactsViaRepoSession(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByIdForUser: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByIdForUser(...args),
}))

vi.mock('#worker/community/service.ts', () => ({
	absorbCommunityForkUpstream: (...args: Array<unknown>) =>
		mockModule.absorbCommunityForkUpstream(...args),
}))

const { repoPublishSessionCapability } =
	await import('./repo-publish-session.ts')

function createCtx() {
	return {
		env: { APP_DB: {} } as Env,
		callerContext: createMcpCallerContext({
			user: {
				userId: 'user-1',
				email: 'user@test.invalid',
				displayName: 'User',
				username: 'user',
			},
			baseUrl: 'https://kody.test',
		}),
	}
}

function resetMocks() {
	for (const fn of Object.values(mockModule)) {
		fn.mockReset()
	}
	mockModule.getMcpUserPackageScope.mockResolvedValue('user')
	mockModule.rebuildPublishedPackageArtifactsViaRepoSession.mockResolvedValue(
		undefined,
	)
	mockModule.getEntitySourceByIdForUser.mockResolvedValue({
		id: 'source-1',
		entity_id: 'package-1',
	})
	mockModule.absorbCommunityForkUpstream.mockResolvedValue(undefined)
	mockModule.repoSessionRpc.mockReturnValue({
		getSessionInfo: vi.fn(async () => ({
			entity_type: 'package',
			source_id: 'source-1',
		})),
		publishSession: vi.fn(async () => ({
			status: 'ok',
			sessionId: 'session-1',
			publishedCommit: 'commit-1',
			message: 'Published session to repo-artifacts-1.',
		})),
	})
}

test('repoPublishSession keeps a successful publish when fork absorb fails and stays quiet for self-authored packages', async () => {
	const published = {
		status: 'ok',
		session_id: 'session-1',
		published_commit: 'commit-1',
		message: 'Published session to repo-artifacts-1.',
	}
	const cases = [
		{
			absorbError: new Error('origin listing is gone'),
			expected: {
				...published,
				notice:
					'Published, but the behind-upstream banner did not clear: origin listing is gone. Retry repoPublishSession with absorbed_upstream_commit.',
			},
		},
		{
			absorbError: new CommunityActionError(
				'Package "demo" is self-authored and has no catalog entry to absorb.',
			),
			expected: published,
		},
	]
	for (const { absorbError, expected } of cases) {
		resetMocks()
		mockModule.absorbCommunityForkUpstream.mockRejectedValue(absorbError)

		const result = await repoPublishSessionCapability.handler(
			{ session_id: 'session-1', absorbed_upstream_commit: 'origin-head' },
			createCtx(),
		)

		expect(result).toEqual(expected)
		expect(mockModule.absorbCommunityForkUpstream).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: 'user-1',
				packageId: 'package-1',
				originCommit: 'origin-head',
			}),
		)
	}
})
