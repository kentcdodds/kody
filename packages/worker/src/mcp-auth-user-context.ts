import {
	personIdFromStored,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { getUserRolesAndPermissions } from '#worker/identity/permissions-db.ts'
import {
	displayNameFromEmail,
	getUsernameFormatValidationError,
} from '#worker/identity/username.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'
import {
	planOrgBindingFromGrantProps,
	type OrgBindingPlan,
} from '#worker/orgs/grant-binding.ts'
import { type OrgBinding } from '#worker/orgs/repo.ts'

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
	password_changed_at: string | null
}

export type McpAuthUserContext = {
	user: McpUserContext
	emailVerified: boolean
	suspended: boolean
	passwordChangedAt: string | null
}

function buildBaseUserFromGrant(
	grantProps: NonNullable<McpOAuthGrantProps>,
	userId: PersonId,
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
export function personIdFromGrantProps(
	grantProps: McpOAuthGrantProps,
): PersonId | null {
	if (!grantProps || typeof grantProps.userId !== 'string') {
		return null
	}
	const trimmedUserId = grantProps.userId.trim()
	if (!trimmedUserId) return null
	return personIdFromStored(trimmedUserId)
}

function grantUserStatement(env: Env, userId: PersonId) {
	return env.APP_DB.prepare(
		`SELECT id, email, username, display_name, stable_user_id,
			deleting_at, email_verified_at, suspended_at, password_changed_at
		 FROM users
		 WHERE stable_user_id = ?${andLiveDeletedAtSql()}`,
	).bind(userId)
}

async function contextFromGrantUserRow(input: {
	env: Env
	grantProps: NonNullable<McpOAuthGrantProps>
	userId: PersonId
	row: GrantUserRow | null
}): Promise<McpAuthUserContext | null> {
	const { row, userId } = input
	if (!row || row.deleting_at) return null
	const baseUser = buildBaseUserFromGrant(input.grantProps, userId)

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
		input.env.APP_DB,
		row.id,
	)

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
		passwordChangedAt: row.password_changed_at ?? null,
	}
}

export async function buildMcpUserContextFromGrantProps(
	env: Env,
	grantProps: McpOAuthGrantProps,
): Promise<McpAuthUserContext | null> {
	if (!grantProps) return null
	const userId = personIdFromGrantProps(grantProps)
	if (!userId) return null

	// Fail closed on transient D1 errors so a deleting or reassigned account can
	// never continue through stale OAuth grant metadata.
	try {
		const row = await grantUserStatement(env, userId).first<GrantUserRow>()
		return await contextFromGrantUserRow({ env, grantProps, userId, row })
	} catch (error) {
		console.error('Failed to load MCP auth user context:', error)
		throw error
	}
}

/**
 * {@link buildMcpUserContextFromGrantProps} plus the grant's org binding, read
 * in one D1 batch. A batch is a single transaction, so the user row every auth
 * gate checks and the membership row that decides the org role come from the
 * same snapshot: the overlap can never surface a membership that is older than
 * the identity it is paired with. `orgBinding` is null when the person is not
 * bound to the grant's org (or has no live personal-org membership).
 */
export async function buildMcpUserContextWithOrgBindingFromGrantProps(
	env: Env,
	grantProps: McpOAuthGrantProps,
): Promise<{
	context: McpAuthUserContext
	orgBinding: OrgBinding | null
} | null> {
	if (!grantProps) return null
	const userId = personIdFromGrantProps(grantProps)
	if (!userId) return null

	// Fail closed on transient D1 errors, same as the context-only loader.
	try {
		const plan: OrgBindingPlan = planOrgBindingFromGrantProps({
			db: env.APP_DB,
			personId: userId,
			grantProps,
		})
		const [userResult, ...bindingResults] = await env.APP_DB.batch([
			grantUserStatement(env, userId),
			...plan.statements,
		])
		const row = (userResult?.results[0] ?? null) as GrantUserRow | null
		const context = await contextFromGrantUserRow({
			env,
			grantProps,
			userId,
			row,
		})
		if (!context) return null
		const orgBinding = plan.resolve(
			bindingResults.map((result) => result.results[0] ?? null),
		)
		return { context, orgBinding }
	} catch (error) {
		console.error('Failed to load MCP auth user context:', error)
		throw error
	}
}
