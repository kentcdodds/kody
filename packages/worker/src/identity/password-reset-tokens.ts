import { toHex } from '@kody-internal/shared/hex.ts'

export const passwordResetTokenBytes = 32
export const passwordResetTokenExpiryMs = 60 * 60 * 1000
export const adminPasswordSetupTokenExpiryMs = 7 * 24 * 60 * 60 * 1000

export function generatePasswordResetToken() {
	const bytes = new Uint8Array(passwordResetTokenBytes)
	crypto.getRandomValues(bytes)
	return toHex(bytes)
}

export async function hashPasswordResetToken(token: string) {
	const data = new TextEncoder().encode(token)
	const digest = await crypto.subtle.digest('SHA-256', data)
	return toHex(new Uint8Array(digest))
}

export async function createPasswordResetToken(input: {
	db: D1Database
	userId: number
	expiresAt: number
}) {
	const token = generatePasswordResetToken()
	const tokenHash = await hashPasswordResetToken(token)

	await input.db
		.prepare(`DELETE FROM password_resets WHERE user_id = ?`)
		.bind(input.userId)
		.run()
	await input.db
		.prepare(
			`INSERT INTO password_resets (user_id, token_hash, expires_at)
			 VALUES (?, ?, ?)`,
		)
		.bind(input.userId, tokenHash, input.expiresAt)
		.run()

	return { token, tokenHash, expiresAt: input.expiresAt }
}
