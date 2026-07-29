import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import {
	adminPasswordSetupTokenExpiryMs,
	createPasswordResetToken,
} from '#worker/identity/password-reset-tokens.ts'
import { assignUserRole } from '#worker/identity/permissions-db.ts'
import {
	getAvailableGeneratedUsername,
	userExistsByUsername,
} from '#worker/identity/generated-username.ts'
import {
	getUsernameValidationError,
	normalizeUsername,
} from '#worker/identity/username.ts'
import { createStableUserIdFromEmail } from '#worker/user-id.ts'

const adminCreatedNoUsablePasswordHash = 'admin_created_no_usable_password'

export type AdminCreateUserErrorCode =
	| 'invalid_email'
	| 'invalid_username'
	| 'email_exists'
	| 'username_exists'
	| 'default_role_assignment_failed'
	| 'setup_token_failed'
	| 'create_failed'

export class AdminCreateUserError extends Error {
	readonly code: AdminCreateUserErrorCode

	constructor(code: AdminCreateUserErrorCode, message: string) {
		super(message)
		this.name = 'AdminCreateUserError'
		this.code = code
	}
}

export type AdminCreatedUser = {
	userId: number
	email: string
	username: string
	setupLink: string
	setupTokenExpiresAt: number
}

async function resolveUsername(input: {
	db: D1Database
	email: string
	username?: string | null
}) {
	const explicitUsername = normalizeUsername(input.username)
	if (!explicitUsername) {
		return getAvailableGeneratedUsername(input.db, input.email)
	}

	const usernameError = getUsernameValidationError(explicitUsername)
	if (usernameError) {
		throw new AdminCreateUserError('invalid_username', usernameError)
	}
	if (await userExistsByUsername(input.db, explicitUsername)) {
		throw new AdminCreateUserError(
			'username_exists',
			'Username already registered.',
		)
	}
	return explicitUsername
}

async function deleteUserBestEffort(db: D1Database, userId: number) {
	try {
		await db.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run()
	} catch (error) {
		console.error('Failed to roll back admin-created user:', error)
	}
}

function buildSetupLink(input: { origin: string; token: string }) {
	const setupUrl = new URL('/reset-password', input.origin)
	setupUrl.searchParams.set('token', input.token)
	return setupUrl.toString()
}

export async function adminCreateUserWithPasswordSetup(input: {
	db: D1Database
	email: string
	username?: string | null
	setupLinkOrigin: string | URL
	now?: Date
}) {
	const email = normalizeEmail(input.email)
	if (!email) {
		throw new AdminCreateUserError('invalid_email', 'Email is required.')
	}

	const existingUser = await input.db
		.prepare(`SELECT id FROM users WHERE email = ?`)
		.bind(email)
		.first<{ id: number }>()
	if (existingUser) {
		throw new AdminCreateUserError('email_exists', 'Email already registered.')
	}

	const username = await resolveUsername({
		db: input.db,
		email,
		username: input.username,
	})
	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const stableUserId = await createStableUserIdFromEmail(email)
	let userId: number | null = null

	try {
		const result = await input.db
			.prepare(
				`INSERT INTO users (username, email, password_hash, email_verified_at, stable_user_id, plan)
				 VALUES (?, ?, ?, ?, ?, 'free')`,
			)
			.bind(
				username,
				email,
				adminCreatedNoUsablePasswordHash,
				nowIso,
				stableUserId,
			)
			.run()
		const lastRowId = result.meta.last_row_id
		if (!Number.isSafeInteger(lastRowId) || lastRowId < 1) {
			throw new AdminCreateUserError(
				'create_failed',
				'Unable to create account.',
			)
		}
		userId = lastRowId
	} catch (error) {
		const uniqueField = getUniqueConstraintField(error)
		if (uniqueField === 'email') {
			throw new AdminCreateUserError(
				'email_exists',
				'Email already registered.',
			)
		}
		if (uniqueField === 'username') {
			throw new AdminCreateUserError(
				'username_exists',
				'Username already registered.',
			)
		}
		throw error
	}

	const { assigned } = await assignUserRole({
		db: input.db,
		userId,
		roleName: 'user',
	})
	if (!assigned) {
		await deleteUserBestEffort(input.db, userId)
		throw new AdminCreateUserError(
			'default_role_assignment_failed',
			'Unable to create account.',
		)
	}

	const setupTokenExpiresAt = now.getTime() + adminPasswordSetupTokenExpiryMs
	let resetToken: Awaited<ReturnType<typeof createPasswordResetToken>>
	try {
		resetToken = await createPasswordResetToken({
			db: input.db,
			userId,
			expiresAt: setupTokenExpiresAt,
		})
	} catch (error) {
		await deleteUserBestEffort(input.db, userId)
		throw new AdminCreateUserError(
			'setup_token_failed',
			error instanceof Error ? error.message : 'Unable to create setup link.',
		)
	}

	return {
		userId,
		email,
		username,
		setupTokenExpiresAt,
		setupLink: buildSetupLink({
			origin: new URL(input.setupLinkOrigin).origin,
			token: resetToken.token,
		}),
	} satisfies AdminCreatedUser
}
