import { getUserRolesAndPermissions } from '#app/permissions-db.ts'
import {
	displayNameFromEmail,
	getUsernameFormatValidationError,
} from '#app/username.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'

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
 * `userId` (`users.stable_user_id`). Grant email/username/displayName are only
 * a fallback when D1 is unavailable; a successful lookup refreshes those
 * fields from the authoritative row so a stale grant email that another
 * account now owns can never attach that other account's roles.
 */
export async function buildMcpUserContextFromGrantProps(
	env: Env,
	grantProps: McpOAuthGrantProps,
): Promise<McpUserContext | null> {
	if (!grantProps || typeof grantProps.userId !== 'string') {
		return null
	}
	const userId = grantProps.userId.trim()
	if (!userId) return null

	const baseUser = buildBaseUserFromGrant(grantProps, userId)

	// A transient D1 failure must not take MCP auth down. Roles and
	// permissions are optional on the context; falling back to the base
	// grant-props user means no elevated permissions this request.
	try {
		const row = await env.APP_DB.prepare(
			`SELECT id, email, username, display_name, stable_user_id
			 FROM users
			 WHERE stable_user_id = ?`,
		)
			.bind(userId)
			.first<GrantUserRow>()
		if (!row) return baseUser

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

		const { roles, permissions } = await getUserRolesAndPermissions(
			env.APP_DB,
			row.id,
		)

		return {
			userId,
			email,
			displayName,
			...(username ? { username } : {}),
			roles,
			permissions,
		}
	} catch (error) {
		console.error('Failed to load roles for MCP user context:', error)
		return baseUser
	}
}
