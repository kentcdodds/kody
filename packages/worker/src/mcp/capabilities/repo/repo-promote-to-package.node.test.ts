import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'
import { createMcpCallerContext } from '#mcp/context.ts'

vi.mock('./resolve-user-repo.ts', () => ({
	resolveOwnedUserRepo: vi.fn(async () => ({
		userRepo: {
			id: 'repo-1',
			userId: 'user-1',
			name: 'notes',
			description: null,
			createdAt: '2026-01-01T00:00:00.000Z',
			updatedAt: '2026-01-01T00:00:00.000Z',
		},
		source: {
			id: 'source-1',
			user_id: 'user-1',
			entity_kind: 'repo',
			entity_id: 'repo-1',
			repo_id: 'repo-artifacts-1',
			published_commit: null,
			indexed_commit: null,
			manifest_path: 'package.json',
			source_root: '/',
			last_external_check_at: null,
			external_check_until: null,
			created_at: '2026-01-01T00:00:00.000Z',
			updated_at: '2026-01-01T00:00:00.000Z',
		},
	})),
}))

vi.mock('#worker/repo/artifacts.ts', () => ({
	resolveArtifactSourceHead: vi.fn(async () => ({
		branch: 'main',
		commit: 'commit-1',
	})),
}))

vi.mock('#worker/repo/artifact-file.ts', () => ({
	readArtifactFileAtCommit: vi.fn(async () => null),
}))

const { repoPromoteToPackageCapability } =
	await import('./repo-promote-to-package.ts')

test('repo_promote_to_package rejects repos without package.json at HEAD', async () => {
	const ctx = {
		env: { APP_DB: {} as D1Database } as Env,
		callerContext: createMcpCallerContext({
			user: { userId: 'user-1', email: 'user@test.invalid' },
			baseUrl: 'https://kody.test',
		}),
	}
	await expect(
		repoPromoteToPackageCapability.handler({ name: 'notes' }, ctx),
	).rejects.toThrow(McpCallerError)
})
