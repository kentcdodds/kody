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
	deleting_at: string | null
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
): Promise<McpUserContext | null> {
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
			`SELECT id, email, username, display_name, stable_user_id, deleting_at
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
		throw error
	}
}
