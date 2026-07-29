import { isSessionInvalidatedByStoredPasswordChange } from '#app/request-auth-cache.ts'
import { resolveDisplayName } from '#worker/identity/username.ts'
import { createDb, usersTable } from '#worker/db.ts'
import { resolveUserStableId } from '#worker/user-id.ts'

/**
 * The account a hosted package app runs on behalf of.
 *
 * Package apps only ever serve their owner, so this is intentionally a much
 * narrower identity than `AuthenticatedAppUser`: no roles, no permissions, and
 * nothing that would let the package-app origin act on first-party surfaces.
 */
export type PackageAppOwner = {
	/** Stable (hashed) user id used for every userId-scoped read. */
	userId: string
	username: string
	email: string
	displayName: string
}

/**
 * Resolve a package-app owner from a package-app session payload.
 *
 * Fails closed exactly like browser session resolution: unknown accounts,
 * accounts being deleted, suspended accounts, and sessions issued at or before
 * a password change are all refused.
 */
export async function resolvePackageAppOwnerByUserId(input: {
	env: Env
	userId: string
	issuedAt: number
}): Promise<PackageAppOwner | null> {
	const userId = /^\d+$/.test(input.userId) ? Number(input.userId) : NaN
	if (!Number.isSafeInteger(userId) || userId <= 0) return null

	const db = createDb(input.env.APP_DB)
	const userRecord = await db.findOne(usersTable, { where: { id: userId } })
	if (!userRecord) return null
	if (userRecord.deleting_at || userRecord.suspended_at) return null

	// Shared with browser session resolution so a password reset can never revoke
	// one session flavor and leave the other alive.
	if (
		isSessionInvalidatedByStoredPasswordChange({
			issuedAt: input.issuedAt,
			storedPasswordChangedAt: userRecord.password_changed_at,
		})
	) {
		return null
	}

	return {
		userId: resolveUserStableId(userRecord),
		username: userRecord.username,
		email: userRecord.email,
		displayName: resolveDisplayName({
			email: userRecord.email,
			username: userRecord.username,
		}),
	}
}
