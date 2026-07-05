import {
	permissionAccesses,
	permissionActions,
	permissionEntities,
	roleNames,
	type PermissionString,
	type RoleName,
} from '#app/permissions.ts'

export type SessionInfo = {
	email: string
	emailVerified: boolean
	username: string
	roles: Array<RoleName>
	permissions: Array<PermissionString>
}

export type SessionStatus = 'idle' | 'loading' | 'ready'

let sessionRefreshHandler: (() => void) | null = null

export function setSessionRefreshHandler(handler: (() => void) | null) {
	sessionRefreshHandler = handler
}

export function queueSessionRefresh() {
	sessionRefreshHandler?.()
}

export function getSessionDisplayName(session: SessionInfo | null) {
	return session?.username || session?.email || ''
}

export async function fetchSessionInfo(
	signal?: AbortSignal,
): Promise<SessionInfo | null> {
	try {
		const response = await fetch('/session', {
			headers: { Accept: 'application/json' },
			credentials: 'include',
			signal,
		})
		if (signal?.aborted) return null
		const payload = await response.json().catch(() => null)
		const email =
			response.ok && payload?.ok && typeof payload?.session?.email === 'string'
				? payload.session.email.trim()
				: ''
		const username =
			response.ok &&
			payload?.ok &&
			typeof payload?.session?.username === 'string'
				? payload.session.username.trim()
				: ''
		const roles = readRoleNames(payload?.session?.roles)
		const permissions = readPermissionStrings(payload?.session?.permissions)
		const emailVerified = payload?.session?.emailVerified === true
		return email ? { email, emailVerified, username, roles, permissions } : null
	} catch {
		return null
	}
}

function isRoleName(value: string): value is RoleName {
	return (roleNames as ReadonlyArray<string>).includes(value)
}

function isPermissionString(value: string): value is PermissionString {
	const parts = value.split(':')
	if (parts.length !== 3) return false
	const action = parts[0]
	const entity = parts[1]
	const access = parts[2]
	if (!action || !entity || !access) return false
	return (
		(permissionActions as ReadonlyArray<string>).includes(action) &&
		(permissionEntities as ReadonlyArray<string>).includes(entity) &&
		(permissionAccesses as ReadonlyArray<string>).includes(access)
	)
}

function readRoleNames(value: unknown) {
	if (!Array.isArray(value)) return []
	return value.filter(
		(entry): entry is RoleName =>
			typeof entry === 'string' && isRoleName(entry),
	)
}

function readPermissionStrings(value: unknown) {
	if (!Array.isArray(value)) return []
	return value.filter(
		(entry): entry is PermissionString =>
			typeof entry === 'string' && isPermissionString(entry),
	)
}
