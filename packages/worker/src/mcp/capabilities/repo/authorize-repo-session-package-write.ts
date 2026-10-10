import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { authorizePackageWrite } from '#worker/authorization/authorize.ts'
import { getEntitySourceByIdForUser } from '#worker/repo/entity-sources.ts'
import { getRepoSessionById } from '#worker/repo/repo-sessions.ts'

/**
 * package:write on the package behind a repo session. Plain repos and jobs
 * are not packages, so a profile does not narrow them.
 */
export async function authorizeRepoSessionPackageWrite(input: {
	env: Env
	request: RequestContext | null
	userId: OwnerId
	sessionId: string
	/**
	 * `repoDiscardSession` is idempotent. A missing catalog row is a
	 * successful no-op (`deleted: false`), so the write check only runs
	 * when the session still exists.
	 */
	allowMissingSession?: boolean
}): Promise<void> {
	const session = await getRepoSessionById(input.env, {
		userId: input.userId,
		sessionId: input.sessionId,
	})
	if (!session) {
		if (input.allowMissingSession) return
		throw new McpCallerError('Repo session was not found.')
	}
	const source = await getEntitySourceByIdForUser(input.env.APP_DB, {
		id: session.source_id,
		userId: input.userId,
	})
	if (!source) {
		throw new McpCallerError('Repo source was not found for this user.')
	}
	if (source.entity_kind !== 'package') return
	await authorizePackageWrite(
		{ env: input.env, request: input.request },
		{ id: source.entity_id, userId: source.user_id },
	)
}
