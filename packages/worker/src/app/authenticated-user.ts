import {
	readAuthSessionResult,
	setAuthSessionSecret,
} from '#app/auth-session.ts'
import { getUsernameValidationError } from '#app/username.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'
import { type McpUserContext } from '@kody-internal/shared/chat.ts'

export type AuthenticatedAppUser = {
	sessionUserId: string
	userId: number
	username: string
	email: string
	displayName: string
	mcpUser: McpUserContext
	artifactOwnerIds: Array<string>
}

function buildDisplayName(email: string) {
	return email.split('@')[0] || 'user'
}

function getDisplayName(input: { email: string; username: string }) {
	return getUsernameValidationError(input.username)
		? buildDisplayName(input.email)
		: input.username
}

export async function readAuthenticatedAppUser(request: Request, env: Env) {
	setAuthSessionSecret(env.COOKIE_SECRET)
	const { session } = await readAuthSessionResult(request)
	if (!session) return null

	const userId = /^\d+$/.test(session.id) ? Number(session.id) : NaN
	if (!Number.isSafeInteger(userId) || userId <= 0) return null

	const db = createDb(env.APP_DB)
	const userRecord = await db.findOne(usersTable, {
		where: { id: userId },
	})
	if (!userRecord) return null

	const emailBasedUserId = await createStableUserIdFromEmail(userRecord.email)
	const displayName = getDisplayName({
		email: userRecord.email,
		username: userRecord.username,
	})

	return {
		sessionUserId: session.id,
		userId,
		username: userRecord.username,
		email: userRecord.email,
		displayName,
		artifactOwnerIds: Array.from(
			new Set([session.id, emailBasedUserId].filter(Boolean)),
		),
		mcpUser: {
			userId: emailBasedUserId,
			email: userRecord.email,
			displayName,
		},
	} satisfies AuthenticatedAppUser
}
