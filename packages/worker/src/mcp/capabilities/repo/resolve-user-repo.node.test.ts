import { ownerIdFromStored } from '@kody-internal/shared/owner-person-ids.ts'
import { expect, test, vi } from 'vitest'
import { McpCallerError } from '#mcp/caller-error.ts'

const mockModule = vi.hoisted(() => ({
	getUserRepoById: vi.fn(),
	getUserRepoByName: vi.fn(),
	getEntitySourceByEntity: vi.fn(),
}))

vi.mock('#worker/repo/user-repos.ts', () => ({
	getUserRepoById: (...args: Array<unknown>) =>
		mockModule.getUserRepoById(...args),
	getUserRepoByName: (...args: Array<unknown>) =>
		mockModule.getUserRepoByName(...args),
}))

vi.mock('#worker/repo/entity-sources.ts', () => ({
	getEntitySourceByEntity: (...args: Array<unknown>) =>
		mockModule.getEntitySourceByEntity(...args),
}))

const { resolveOwnedUserRepo } = await import('./resolve-user-repo.ts')

const userId = ownerIdFromStored('user-1')
const db = {} as D1Database

const userRepo = {
	id: '11111111-1111-4111-8111-111111111111',
	user_id: userId,
	name: 'notes',
	description: null,
	is_private: 1,
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z',
}

const source = {
	id: 'source-1',
	user_id: userId,
	entity_kind: 'repo' as const,
	entity_id: userRepo.id,
	repo_id: 'artifacts-notes',
	published_commit: null,
	indexed_commit: null,
	namespace: 'default',
	created_at: '2026-01-01T00:00:00.000Z',
	updated_at: '2026-01-01T00:00:00.000Z',
}

function resetMocks() {
	for (const fn of Object.values(mockModule)) fn.mockReset()
	mockModule.getEntitySourceByEntity.mockResolvedValue(source)
}

test('resolveOwnedUserRepo requires exactly one of repo_id or name', async () => {
	resetMocks()
	await expect(resolveOwnedUserRepo({ db, userId, args: {} })).rejects.toThrow(
		McpCallerError,
	)
	await expect(
		resolveOwnedUserRepo({
			db,
			userId,
			args: { repo_id: userRepo.id, name: 'notes' },
		}),
	).rejects.toThrow(/exactly one/)
})

test('resolveOwnedUserRepo resolves name and repo_id UUID', async () => {
	resetMocks()
	mockModule.getUserRepoByName.mockResolvedValue(userRepo)
	await expect(
		resolveOwnedUserRepo({ db, userId, args: { name: 'notes' } }),
	).resolves.toEqual({ userRepo, source })
	expect(mockModule.getUserRepoById).not.toHaveBeenCalled()

	resetMocks()
	mockModule.getUserRepoById.mockResolvedValue(userRepo)
	await expect(
		resolveOwnedUserRepo({ db, userId, args: { repo_id: userRepo.id } }),
	).resolves.toEqual({ userRepo, source })
	expect(mockModule.getUserRepoByName).not.toHaveBeenCalled()
})

test('resolveOwnedUserRepo treats repo_id path values as id-or-name', async () => {
	resetMocks()
	mockModule.getUserRepoById.mockResolvedValue(null)
	mockModule.getUserRepoByName.mockResolvedValue(userRepo)
	await expect(
		resolveOwnedUserRepo({ db, userId, args: { repo_id: 'notes' } }),
	).resolves.toEqual({ userRepo, source })
	expect(mockModule.getUserRepoById).toHaveBeenCalledWith(db, {
		userId,
		repoId: 'notes',
	})
	expect(mockModule.getUserRepoByName).toHaveBeenCalledWith(db, {
		userId,
		name: 'notes',
	})
})

test('resolveOwnedUserRepo prefers id when repo_id matches both', async () => {
	resetMocks()
	const byId = { ...userRepo, name: 'other' }
	mockModule.getUserRepoById.mockResolvedValue(byId)
	mockModule.getUserRepoByName.mockResolvedValue(userRepo)
	await expect(
		resolveOwnedUserRepo({ db, userId, args: { repo_id: userRepo.id } }),
	).resolves.toEqual({ userRepo: byId, source })
	expect(mockModule.getUserRepoByName).not.toHaveBeenCalled()
})

test('resolveOwnedUserRepo throws when neither id nor name matches', async () => {
	resetMocks()
	mockModule.getUserRepoById.mockResolvedValue(null)
	mockModule.getUserRepoByName.mockResolvedValue(null)
	await expect(
		resolveOwnedUserRepo({ db, userId, args: { repo_id: 'missing' } }),
	).rejects.toThrow(/Plain repo "missing" was not found/)
})
