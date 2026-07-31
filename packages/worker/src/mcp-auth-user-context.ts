import { getUserRolesAndPermissions } from '#worker/identity/permissions-db.ts'
import {
	displayNameFromEmail,
	getUsernameFormatValidationError,
} from '#worker/identity/username.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { type RemoteConnectorRef } from '@kody-internal/shared/remote-connectors.ts'
import { PromiseLruCache } from '#worker/package-registry/published-package-cache.ts'
import { listAttachedRemoteConnectorRefs } from './remote-connector/settings-service.ts'

type McpOAuthGrantProps = {
	userId?: unknown
	email?: unknown
	username?: unknown
	displayName?: unknown
} | null

type GrantUserRow = {
	id: number
	email: string
	username: string | null
	display_name: string | null
	stable_user_id: string
	deleting_at: string | null
	email_verified_at: string | null
	suspended_at: string | null
}

export type McpAuthUserContext = {
	user: McpUserContext
	emailVerified: boolean
	suspended: boolean
	remoteConnectors: ReadonlyArray<RemoteConnectorRef>
}

export const attachedRemoteConnectorRefsCacheTtlMs = 30_000
const attachedRemoteConnectorRefsCacheLimit = 200
const attachedRemoteConnectorRefsCaches = new WeakMap<
	D1Database,
	PromiseLruCache<ReadonlyArray<RemoteConnectorRef>>
>()

function listAttachedRemoteConnectorRefsCached(input: {
	env: Pick<Env, 'APP_DB'>
	userId: string
}) {
	let cache = attachedRemoteConnectorRefsCaches.get(input.env.APP_DB)
	if (!cache) {
		cache = new PromiseLruCache<ReadonlyArray<RemoteConnectorRef>>({
			ttlMs: attachedRemoteConnectorRefsCacheTtlMs,
			limit: attachedRemoteConnectorRefsCacheLimit,
		})
		attachedRemoteConnectorRefsCaches.set(input.env.APP_DB, cache)
	}
	return cache.getOrCreate({
		cacheKey: input.userId,
		create: async () =>
			Object.freeze(await listAttachedRemoteConnectorRefs(input)),
	})
}

function buildBaseUserFromGrant(
	grantProps: NonNullable<McpOAuthGrantProps>,
	userId: string,
): McpUserContext {
	const email =
		typeof grantProps.email === 'string' ? grantProps.email.trim() : ''
	const displayName =
		typeof grantProps.displayName === 'string'
			? grantProps.displayName
			: email
				? displayNameFromEmail(email)
				: 'user'

	return {
		userId,
		email,
		displayName,
		...(typeof grantProps.username === 'string'
			? { username: grantProps.username }
			: {}),
	}
}

/**
 * Build the MCP caller user context from OAuth grant props.
 *
 * Account identity and RBAC always resolve through the grant's stable
 * `userId` (`users.stable_user_id`). D1 lookup failures fail closed; grant
 * profile fields only fill missing values after the authoritative row resolves.
 */
export async function buildMcpUserContextFromGrantProps(
	env: Env,
	grantProps: McpOAuthGrantProps,
): Promise<McpAuthUserContext | null> {
	if (!grantProps || typeof grantProps.userId !== 'string') {
		return null
	}
	const userId = grantProps.userId.trim()
	if (!userId) return null

	const baseUser = buildBaseUserFromGrant(grantProps, userId)

	// Fail closed on transient D1 errors so a deleting or reassigned account can
	// never continue through stale OAuth grant metadata.
	try {
		const row = await env.APP_DB.prepare(
			`SELECT id, email, username, display_name, stable_user_id,
				deleting_at, email_verified_at, suspended_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
			.bind(userId)
			.first<GrantUserRow>()
		if (!row || row.deleting_at) return null

		const email = row.email.trim().toLowerCase()
		const usernameCandidate = row.username?.trim() ?? ''
		const username =
			usernameCandidate && !getUsernameFormatValidationError(usernameCandidate)
				? usernameCandidate
				: undefined
		const displayName =
			row.display_name?.trim() ||
			username ||
			(email ? displayNameFromEmail(email) : baseUser.displayName)

		const [{ roles, permissions }, remoteConnectors] = await Promise.all([
			getUserRolesAndPermissions(env.APP_DB, row.id),
			listAttachedRemoteConnectorRefsCached({ env, userId }),
		])

		return {
			user: {
				userId,
				email,
				displayName,
				...(username ? { username } : {}),
				roles,
				permissions,
			},
			emailVerified: Boolean(row.email_verified_at),
			suspended: Boolean(row.suspended_at),
			remoteConnectors,
		}
	} catch (error) {
		console.error('Failed to load MCP auth user context:', error)
		throw error
	}
}
