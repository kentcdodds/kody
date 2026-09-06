import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { userExistsByUsername } from '#worker/identity/generated-username.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { loadReservedUsernameRecord } from '#worker/identity/reserved-username-settings.ts'
import { isReservedUsernameToken } from '#worker/identity/reserved-usernames.ts'
import {
	getUsernameFormatValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import {
	allocateSignupIdentity,
	claimAccountEmail,
} from '#worker/identity/email-claims.ts'
import { unusablePasswordHash } from '#worker/identity/usable-password.ts'

export type PlatformAccountCreateErrorCode =
	| 'invalid_email'
	| 'invalid_username'
	| 'email_exists'
	| 'username_exists'
	| 'create_failed'

export class PlatformAccountCreateError extends Error {
	readonly code: PlatformAccountCreateErrorCode

	constructor(code: PlatformAccountCreateErrorCode, message: string) {
		super(message)
		this.name = 'PlatformAccountCreateError'
		this.code = code
	}
}

export type CreatedPlatformAccount = {
	userId: number
	email: string
	username: string
	stableUserId: string
}

/**
 * Create a platform account that owns official packages.
 *
 * Platform accounts may only claim usernames from the reserved denylist, so
 * they never collide with a signable-up username and person users can never
 * squat a platform scope.
 */
export async function createPlatformAccount(input: {
	db: D1Database
	env?: Pick<Env, 'BUNDLE_ARTIFACTS_KV'>
	email: string
	username: string
	now?: Date
}) {
	const email = normalizeEmail(input.email)
	if (!email) {
		throw new PlatformAccountCreateError('invalid_email', 'Email is required.')
	}

	const username = normalizeUsername(input.username)
	const formatError = getUsernameFormatValidationError(username)
	if (formatError) {
		throw new PlatformAccountCreateError('invalid_username', formatError)
	}
	const reservedOverrides = input.env
		? await loadReservedUsernameRecord(input.env)
		: undefined
	if (!isReservedUsernameToken(username, reservedOverrides)) {
		throw new PlatformAccountCreateError(
			'invalid_username',
			'Platform accounts may only claim reserved usernames.',
		)
	}

	const existingUser = await input.db
		.prepare(`SELECT id FROM users WHERE email = ?`)
		.bind(email)
		.first<{ id: number }>()
	if (existingUser) {
		throw new PlatformAccountCreateError(
			'email_exists',
			'Email already registered.',
		)
	}
	if (await userExistsByUsername(input.db, username)) {
		throw new PlatformAccountCreateError(
			'username_exists',
			'Username already registered.',
		)
	}

	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const allocated = await allocateSignupIdentity(input.db, email)
	if (!allocated.ok) {
		throw new PlatformAccountCreateError(
			'email_exists',
			'Email already registered.',
		)
	}
	const stableUserId = allocated.stableUserId

	try {
		const result = await input.db
			.prepare(
				`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, account_type, plan)
				 VALUES (?, ?, ?, ?, ?, 'platform', 'free')`,
			)
			.bind(
				username,
				email,
				unusablePasswordHash.platformAccount,
				nowIso,
				stableUserId,
			)
			.run()
		const lastRowId = result.meta.last_row_id
		if (!Number.isSafeInteger(lastRowId) || lastRowId < 1) {
			throw new PlatformAccountCreateError(
				'create_failed',
				'Unable to create platform account.',
			)
		}
		await claimAccountEmail(input.db, {
			userId: lastRowId,
			email,
			now,
		})
		return {
			userId: lastRowId,
			email,
			username,
			stableUserId,
		} satisfies CreatedPlatformAccount
	} catch (error) {
		if (error instanceof PlatformAccountCreateError) throw error
		const uniqueField = getUniqueConstraintField(error)
		if (uniqueField === 'email') {
			throw new PlatformAccountCreateError(
				'email_exists',
				'Email already registered.',
			)
		}
		if (uniqueField === 'username') {
			throw new PlatformAccountCreateError(
				'username_exists',
				'Username already registered.',
			)
		}
		throw error
	}
}
