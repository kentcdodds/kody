import { toHex } from '@kody-internal/shared/hex.ts'
import { normalizeRedirectTo } from '#universal/safe-redirect.ts'
import { AccountDeletionInProgressError } from '#worker/account/deletion-state.ts'

const verificationTokenBytes = 32
export const verificationTokenExpiryMs = 24 * 60 * 60 * 1000

export function generateVerificationToken() {
	const bytes = new Uint8Array(verificationTokenBytes)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

export async function hashVerificationToken(token: string) {
	const data = new TextEncoder().encode(token)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return toHex(new Uint8Array(digest))
}

/** Builds `/verify-email` with token and an optional safe post-verify resume target. */
export function buildEmailVerificationUrl(input: {
	appBaseUrl: string
	token: string
	redirectTo?: string | null
}) {
	const verificationUrl = new URL('/verify-email', input.appBaseUrl)
	verificationUrl.searchParams.set('token', input.token)
	const safeRedirectTo = normalizeRedirectTo(input.redirectTo)
	if (safeRedirectTo) {
		verificationUrl.searchParams.set('redirectTo', safeRedirectTo)
	}
	return verificationUrl
}

export async function insertEmailVerificationToken(input: {
	db: D1Database
	userId: number
	now?: Date
}) {
	const token = generateVerificationToken()
	const tokenHash = await hashVerificationToken(token)
	const now = input.now ?? new Date()
	const expiresAt = now.getTime() + verificationTokenExpiryMs
	const inserted = await input.db
		.prepare(
			`INSERT INTO email_verifications (user_id, token_hash, expires_at)
			 SELECT id, ?, ?
			 FROM users
			 WHERE id = ? AND deleting_at IS NULL`,
		)
		.bind(tokenHash, expiresAt, input.userId)
		.run()
	if ((inserted.meta.changes ?? 0) !== 1) {
		throw new AccountDeletionInProgressError()
	}
	return { token, tokenHash, expiresAt }
}

export async function discardEmailVerificationToken(
	db: D1Database,
	tokenHash: string,
) {
	await db
		.prepare(`DELETE FROM email_verifications WHERE token_hash = ?`)
		.bind(tokenHash)
		.run()
		.catch(() => undefined)
}

export async function retireOtherEmailVerificationTokens(
	db: D1Database,
	userId: number,
	tokenHash: string,
) {
	await db
		.prepare(
			`DELETE FROM email_verifications WHERE user_id = ? AND token_hash != ?`,
		)
		.bind(userId, tokenHash)
		.run()
		.catch((error) => {
			console.warn('email-verification-token-cleanup-failed', error)
		})
}

export async function deleteEmailVerificationsForUser(
	db: D1Database,
	userId: number,
) {
	await db
		.prepare(`DELETE FROM email_verifications WHERE user_id = ?`)
		.bind(userId)
		.run()
}
