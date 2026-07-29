import { normalizeEmail } from '#worker/identity/normalize-email.ts'

/**
 * Read-only "is this account's email verified?" check, split out from the app
 * layer's `#app/email-verification.ts` (which also mints and consumes
 * verification tokens and needs app-layer redirect/email helpers). MCP
 * capabilities, MCP auth, OAuth, and outbound email all gate on this without
 * needing the token pipeline.
 */
export async function isAccountEmailVerified(input: {
	db: D1Database
	email?: string | null
	stableUserId?: string | null
}) {
	const normalizedEmail =
		typeof input.email === 'string' ? normalizeEmail(input.email) : ''
	const stableUserId = input.stableUserId?.trim() ?? ''

	// When both are present (typical MCP grant props), require the pair so a
	// stale grant email that another verified account now owns cannot pass.
	if (normalizedEmail && stableUserId) {
		const row = await input.db
			.prepare(
				`SELECT email_verified_at FROM users
				 WHERE email = ? AND stable_user_id = ?`,
			)
			.bind(normalizedEmail, stableUserId)
			.first<{ email_verified_at: string | null }>()
		return Boolean(row?.email_verified_at)
	}

	// Browser sessions carry email only.
	if (normalizedEmail) {
		const row = await input.db
			.prepare(`SELECT email_verified_at FROM users WHERE email = ?`)
			.bind(normalizedEmail)
			.first<{ email_verified_at: string | null }>()
		return Boolean(row?.email_verified_at)
	}

	// Package-runtime / grant contexts with only the stable id.
	if (!stableUserId) return false
	const row = await input.db
		.prepare(`SELECT email_verified_at FROM users WHERE stable_user_id = ?`)
		.bind(stableUserId)
		.first<{ email_verified_at: string | null }>()
	return Boolean(row?.email_verified_at)
}

export const emailVerificationRequiredMessage =
	'Account email is not verified. Open the verification link sent to your account email, or resend it from /pending-verification or /account.'

export async function assertAccountEmailVerified(input: {
	db: D1Database
	email?: string | null
	stableUserId?: string | null
}) {
	if (!(await isAccountEmailVerified(input))) {
		throw new Error(emailVerificationRequiredMessage)
	}
}
