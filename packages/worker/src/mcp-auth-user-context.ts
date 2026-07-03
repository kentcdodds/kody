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
}
