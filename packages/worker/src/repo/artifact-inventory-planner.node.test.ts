import { expect, test, vi } from 'vitest'

const mockModule = vi.hoisted(() => ({
	listRepos: vi.fn(),
	listEntitySourcesByUser: vi.fn(),
	listRepoSessionsByUser: vi.fn(),
}))

vi.mock('./artifacts.ts', () => ({
	resolveArtifactsNamespace: (_env: Env, namespace?: string | null) =>
		namespace?.trim() || 'production',
	getArtifactsBinding: () => ({
		list: (...args: Array<unknown>) => mockModule.listRepos(...args),
	}),
}))

vi.mock('./entity-sources.ts', () => ({
	listEntitySourcesByUser: (...args: Array<unknown>) =>
		mockModule.listEntitySourcesByUser(...args),
}))

vi.mock('./repo-sessions.ts', () => ({
	listRepoSessionsByUser: (...args: Array<unknown>) =>
		mockModule.listRepoSessionsByUser(...args),
}))

const { planArtifactRepoInventory } =
	await import('./artifact-inventory-planner.ts')

test('artifact inventory planner classifies repos without deleting anything', async () => {
	mockModule.listEntitySourcesByUser.mockResolvedValue([
		{ repo_id: 'package-current' },
	])
	mockModule.listRepoSessionsByUser.mockResolvedValue([
		{ session_repo_name: 'legacy-session-fork' },
		{ session_repo_name: 'package-current' },
	])
	mockModule.listRepos.mockResolvedValue({
		total: 5,
		cursor: undefined,
		repos: [
			repo({ name: 'package-current' }),
			repo({ name: 'legacy-session-fork' }),
			repo({ name: 'package-old' }),
			repo({ name: 'random-fork', source: 'package-current' }),
			repo({ name: 'handmade-repo' }),
		],
	})

	const plan = await planArtifactRepoInventory({
		env: { APP_DB: {} } as Env,
		userId: 'user-1',
		namespace: 'production',
		sampleLimit: 10,
	})

	expect(plan).toMatchObject({
		namespace: 'production',
		totalListed: 5,
		totalAvailable: 5,
		truncated: false,
		counts: {
			referenced_source_root: 1,
			referenced_legacy_session_fork: 1,
			unreferenced_source_like_root: 1,
			unreferenced_fork: 1,
			unknown_unreferenced: 1,
		},
		deleteCandidateCount: 3,
	})
	expect(plan.samples.map((entry) => entry.classification)).toEqual([
		'referenced_source_root',
		'referenced_legacy_session_fork',
		'unreferenced_source_like_root',
		'unreferenced_fork',
		'unknown_unreferenced',
	])
})

function repo(input: { name: string; source?: string | null }) {
	return {
		id: `id-${input.name}`,
		name: input.name,
		description: null,
		defaultBranch: 'main',
		createdAt: '2026-06-01T00:00:00.000Z',
		updatedAt: '2026-06-01T00:00:00.000Z',
		lastPushAt: null,
		source: input.source ?? null,
		readOnly: false,
	}
}
