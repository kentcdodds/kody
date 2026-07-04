import {
	destroyAuthCookie,
	isSecureRequest,
	readAuthSessionResult,
} from '#app/auth-session.ts'
import { getUserRolesAndPermissions } from '#app/permissions-db.ts'
import { createDb, usersTable } from '#worker/db.ts'

import { type PermissionString, type RoleName } from '#app/permissions.ts'

export type SessionInfo = {
	email: string
	username: string
	roles: Array<RoleName>
	permissions: Array<PermissionString>
}

export type LoadedSessionResult = {
	session: SessionInfo | null
	setCookie?: string | undefined
}

export async function loadSessionInfo(
	request: Request,
	env: Env,
): Promise<LoadedSessionResult> {
	const { session, setCookie } = await readAuthSessionResult(request)
	if (!session) {
		return { session: null, setCookie: setCookie ?? undefined }
	}

	const userId = /^\d+$/.test(session.id) ? Number(session.id) : NaN
	const db = createDb(env.APP_DB)
	const userRecord =
		Number.isSafeInteger(userId) && userId > 0
			? await db.findOne(usersTable, { where: { id: userId } })
			: null

	if (!userRecord) {
		return {
			session: null,
			setCookie: await destroyAuthCookie(isSecureRequest(request)),
		}
	}

	const { roles, permissions } = await getUserRolesAndPermissions(
		env.APP_DB,
		userId,
	)

	return {
		session: {
			email: userRecord.email,
			username: userRecord.username,
			roles,
			permissions,
		},
		setCookie: setCookie ?? undefined,
	}
}
