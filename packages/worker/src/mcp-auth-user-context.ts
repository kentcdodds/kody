import { getUserRolesAndPermissions } from '#app/permissions-db.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'

type McpOAuthGrantProps = {
	userId?: unknown
	email?: unknown
	username?: unknown
	displayName?: unknown
} | null

function buildDisplayNameFromEmail(email: string) {
	return email.split('@')[0] || 'user'
}

export async function buildMcpUserContextFromGrantProps(
	env: Env,
	grantProps: McpOAuthGrantProps,
): Promise<McpUserContext | null> {
	if (!grantProps || typeof grantProps.userId !== 'string') {
		return null
	}

	const email =
		typeof grantProps.email === 'string' ? grantProps.email.trim() : ''
	const displayName =
		typeof grantProps.displayName === 'string'
			? grantProps.displayName
			: email
				? buildDisplayNameFromEmail(email)
				: 'user'

	const user: McpUserContext = {
		userId: grantProps.userId,
		email,
		displayName,
		...(typeof grantProps.username === 'string'
			? { username: grantProps.username }
			: {}),
	}

	if (!email) {
		return user
	}

	// A transient D1 failure must not take MCP auth down. Roles and
	// permissions are optional on the context; falling back to the base
	// grant-props user simply means no elevated permissions this request.
	try {
		const db = createDb(env.APP_DB)
		const userRecord = await db.findOne(usersTable, {
			where: { email },
		})
		if (!userRecord) {
			return user
		}

		const { roles, permissions } = await getUserRolesAndPermissions(
			env.APP_DB,
			userRecord.id,
		)

		return {
			...user,
			roles,
			permissions,
		}
	} catch (error) {
		console.error('Failed to load roles for MCP user context:', error)
		return user
	}
}
