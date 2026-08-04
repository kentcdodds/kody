import { McpCallerError } from '#mcp/caller-error.ts'
import { getEntitySourceByEntity } from '#worker/repo/entity-sources.ts'
import { type EntitySourceRow } from '#worker/repo/types.ts'
import {
	getUserRepoById,
	getUserRepoByName,
	type UserRepoRecord,
} from '#worker/repo/user-repos.ts'

export type UserRepoIdentity = {
	repo_id?: string
	name?: string
}

function requireExactlyOneUserRepoIdentity(input: UserRepoIdentity) {
	const count =
		(input.repo_id !== undefined ? 1 : 0) + (input.name !== undefined ? 1 : 0)
	if (count !== 1) {
		throw new McpCallerError('Provide exactly one of `repo_id` or `name`.')
	}
}

export async function resolveOwnedUserRepo(input: {
	db: D1Database
	userId: string
	args: UserRepoIdentity
}): Promise<{ userRepo: UserRepoRecord; source: EntitySourceRow }> {
	requireExactlyOneUserRepoIdentity(input.args)
	const userRepo =
		input.args.repo_id !== undefined
			? await getUserRepoById(input.db, {
					userId: input.userId,
					repoId: input.args.repo_id,
				})
			: await getUserRepoByName(input.db, {
					userId: input.userId,
					name: input.args.name ?? '',
				})
	if (!userRepo) {
		const missingId = input.args.repo_id ?? input.args.name
		throw new McpCallerError(`Plain repo "${missingId}" was not found.`)
	}
	const source = await getEntitySourceByEntity(input.db, {
		userId: input.userId,
		entityKind: 'repo',
		entityId: userRepo.id,
	})
	if (!source) {
		throw new McpCallerError('Repo source was not found for this user.')
	}
	return { userRepo, source }
}
