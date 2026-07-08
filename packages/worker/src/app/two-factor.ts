import { generateTOTP, getTOTPAuthUri, verifyTOTP } from '@epic-web/totp'

/**
 * Epic Stack-style verification rows: an active `2fa` row for a user is the
 * "two-factor enabled" flag, and a `2fa-verify` row holds a pending setup
 * that only becomes active once the user proves they scanned the secret.
 */
export const twoFactorVerificationType = '2fa'
export const twoFactorSetupVerificationType = '2fa-verify'

export type TwoFactorVerificationType =
	| typeof twoFactorVerificationType
	| typeof twoFactorSetupVerificationType

type VerificationRow = {
	secret: string
	algorithm: string
	digits: number
	period: number
	char_set: string
}

function getTwoFactorTarget(userId: number) {
	return String(userId)
}

export async function findTwoFactorVerification(
	db: D1Database,
	userId: number,
	type: TwoFactorVerificationType,
) {
	return db
		.prepare(
			`SELECT secret, algorithm, digits, period, char_set
			 FROM verifications
			 WHERE target = ? AND type = ?
			 AND (expires_at IS NULL OR expires_at > ?)`,
		)
		.bind(getTwoFactorTarget(userId), type, Date.now())
		.first<VerificationRow>()
}

export async function isTwoFactorEnabled(db: D1Database, userId: number) {
	const verification = await findTwoFactorVerification(
		db,
		userId,
		twoFactorVerificationType,
	)
	return verification !== null
}

/**
 * Creates (or replaces) a pending two-factor setup and returns the otpauth
 * URI for the user's authenticator app. The setup only activates after
 * `confirmTwoFactorSetup`, so abandoning it never locks the user out.
 */
export async function createTwoFactorSetup(input: {
	db: D1Database
	userId: number
	accountName: string
	issuer: string
}) {
	const { otp: _otp, ...config } = await generateTOTP()
	await input.db
		.prepare(
			`INSERT INTO verifications (
				type, target, secret, algorithm, digits, period, char_set, expires_at
			) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
			ON CONFLICT (target, type) DO UPDATE SET
				secret = excluded.secret,
				algorithm = excluded.algorithm,
				digits = excluded.digits,
				period = excluded.period,
				char_set = excluded.char_set,
				expires_at = NULL,
				created_at = CURRENT_TIMESTAMP`,
		)
		.bind(
			twoFactorSetupVerificationType,
			getTwoFactorTarget(input.userId),
			config.secret,
			config.algorithm,
			config.digits,
			config.period,
			config.charSet,
		)
		.run()

	const otpUri = getTOTPAuthUri({
		secret: config.secret,
		algorithm: config.algorithm,
		digits: config.digits,
		period: config.period,
		accountName: input.accountName,
		issuer: input.issuer,
	})
	return { otpUri, secret: config.secret }
}

export async function verifyTwoFactorCode(input: {
	db: D1Database
	userId: number
	code: string
	type: TwoFactorVerificationType
}) {
	const verification = await findTwoFactorVerification(
		input.db,
		input.userId,
		input.type,
	)
	if (!verification) return false

	const result = await verifyTOTP({
		otp: input.code,
		secret: verification.secret,
		algorithm: verification.algorithm,
		digits: verification.digits,
		period: verification.period,
		charSet: verification.char_set,
	})
	return result !== null
}

/**
 * Promotes the pending `2fa-verify` row to the active `2fa` type in place so
 * the exact secret the user scanned stays the active secret. Returns whether
 * a pending row was actually promoted (false when the setup vanished, e.g.
 * a concurrent cancel).
 *
 * The active-row delete (needed to satisfy the UNIQUE(target, type)
 * constraint before promoting) is conditional on a pending row existing so
 * that a concurrent duplicate confirm can never delete the active factor
 * without promoting a replacement.
 */
export async function confirmTwoFactorSetup(db: D1Database, userId: number) {
	const target = getTwoFactorTarget(userId)
	const [, promotion] = await db.batch([
		db
			.prepare(
				`DELETE FROM verifications WHERE target = ? AND type = ?
				 AND EXISTS (
					SELECT 1 FROM verifications WHERE target = ? AND type = ?
				 )`,
			)
			.bind(
				target,
				twoFactorVerificationType,
				target,
				twoFactorSetupVerificationType,
			),
		db
			.prepare(
				`UPDATE verifications SET type = ? WHERE target = ? AND type = ?`,
			)
			.bind(twoFactorVerificationType, target, twoFactorSetupVerificationType),
	])
	return (promotion?.meta.changes ?? 0) > 0
}

export async function cancelTwoFactorSetup(db: D1Database, userId: number) {
	await db
		.prepare(`DELETE FROM verifications WHERE target = ? AND type = ?`)
		.bind(getTwoFactorTarget(userId), twoFactorSetupVerificationType)
		.run()
}

export async function disableTwoFactor(db: D1Database, userId: number) {
	// Also drop any pending setup so a stale scanned secret can't be
	// re-activated later without going through the full setup flow.
	await db
		.prepare(`DELETE FROM verifications WHERE target = ? AND type IN (?, ?)`)
		.bind(
			getTwoFactorTarget(userId),
			twoFactorVerificationType,
			twoFactorSetupVerificationType,
		)
		.run()
}
