import { toHex } from '@kody-internal/shared/hex.ts'
import { normalizeEmail } from '#worker/identity/normalize-email.ts'
import { getUniqueConstraintField } from '#worker/database-errors.ts'
import { createStableUserId } from '#worker/user-id.ts'

export type EmailClaimStatus = 'claimed' | 'released'

export type ActiveEmailClaim = {
	userId: number
	email: string
	status: EmailClaimStatus
	claimedAt: string
	releasedAt: string | null
}

export type FormerEmailClaim = {
	email: string
	claimedAt: string
}

export type AllocateSignupIdentityResult =
	| { ok: true; stableUserId: string }
	| { ok: false; reason: 'current_email' | 'former_email_claimed' }

export type ReleasableEmailClaimResult =
	| { ok: true; email: string }
	| {
			ok: false
			reason: 'current_email' | 'not_claimed' | 'already_released'
	  }

export type LegacyEmailHashReservation = {
	userId: number
	stableUserId: string
	email: string
	username: string
	createdAt: string
	emailVerifiedAt: string | null
}

export async function findActiveEmailClaim(
	db: D1Database,
	email: string,
): Promise<ActiveEmailClaim | null> {
	const normalized = normalizeEmail(email)
	if (!normalized) return null
	const row = await db
		.prepare(
			`SELECT user_id, email, status, claimed_at, released_at
			 FROM user_email_claims
			 WHERE email = ? AND status = 'claimed'`,
		)
		.bind(normalized)
		.first<{
			user_id: number
			email: string
			status: EmailClaimStatus
			claimed_at: string
			released_at: string | null
		}>()
	if (!row) return null
	return {
		userId: row.user_id,
		email: row.email,
		status: row.status,
		claimedAt: row.claimed_at,
		releasedAt: row.released_at,
	}
}

export async function listFormerEmailClaims(
	db: D1Database,
	input: { userId: number; currentEmail: string },
): Promise<Array<FormerEmailClaim>> {
	const currentEmail = normalizeEmail(input.currentEmail)
	const rows = await db
		.prepare(
			`SELECT email, claimed_at
			 FROM user_email_claims
			 WHERE user_id = ? AND status = 'claimed' AND email != ?
			 ORDER BY claimed_at ASC, email ASC`,
		)
		.bind(input.userId, currentEmail)
		.all<{ email: string; claimed_at: string }>()
	return (rows.results ?? []).map((row) => ({
		email: row.email,
		claimedAt: row.claimed_at,
	}))
}

export async function isEmailClaimReleased(db: D1Database, email: string) {
	const normalized = normalizeEmail(email)
	if (!normalized) return false
	const active = await findActiveEmailClaim(db, normalized)
	if (active) return false
	const released = await db
		.prepare(
			`SELECT 1 AS present
			 FROM user_email_claims
			 WHERE email = ? AND status = 'released'
			 LIMIT 1`,
		)
		.bind(normalized)
		.first<{ present: number }>()
	return Boolean(released)
}

/**
 * Accounts created before random id minting (and before explicit claim rows)
 * carry `stable_user_id = sha256(signup email)`. An account that changed email
 * before `user_email_claims` existed has no claim row for that signup address,
 * so the hash is the only record that it still reserves it. This lookup only
 * recognizes those legacy reservations; it never mints identity.
 */
export async function findLegacyEmailHashReservation(
	db: D1Database,
	email: string,
): Promise<LegacyEmailHashReservation | null> {
	const normalized = normalizeEmail(email)
	if (!normalized) return null
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(normalized),
	)
	const row = await db
		.prepare(
			`SELECT id, stable_user_id, email, username, created_at, email_verified_at
			 FROM users
			 WHERE stable_user_id = ?`,
		)
		.bind(toHex(new Uint8Array(digest)))
		.first<{
			id: number
			stable_user_id: string
			email: string
			username: string
			created_at: string
			email_verified_at: string | null
		}>()
	if (!row || normalizeEmail(row.email) === normalized) return null
	return {
		userId: row.id,
		stableUserId: row.stable_user_id,
		email: row.email,
		username: row.username,
		createdAt: row.created_at,
		emailVerifiedAt: row.email_verified_at,
	}
}

/**
 * True when another account currently uses this address as login, holds an
 * active former-email claim, or still holds a legacy email-hash reservation
 * ({@link findLegacyEmailHashReservation}) it has not released.
 */
export async function isEmailReservedForOtherAccount(
	db: D1Database,
	email: string,
	exceptUserId?: number,
) {
	const normalized = normalizeEmail(email)
	if (!normalized) return false

	const currentOwner = await db
		.prepare(`SELECT id FROM users WHERE email = ?`)
		.bind(normalized)
		.first<{ id: number }>()
	if (currentOwner && currentOwner.id !== exceptUserId) return true

	const active = await findActiveEmailClaim(db, normalized)
	if (active && active.userId !== exceptUserId) return true

	if (await isEmailClaimReleased(db, normalized)) return false

	const legacy = await findLegacyEmailHashReservation(db, normalized)
	return legacy !== null && legacy.userId !== exceptUserId
}

export async function resolveReleasableEmailClaim(input: {
	db: D1Database
	userId: number
	stableUserId: string
	currentEmail: string
	email: string
}): Promise<ReleasableEmailClaimResult> {
	const email = normalizeEmail(input.email)
	if (!email) return { ok: false, reason: 'not_claimed' }
	if (email === normalizeEmail(input.currentEmail)) {
		return { ok: false, reason: 'current_email' }
	}

	const active = await findActiveEmailClaim(input.db, email)
	if (active) {
		if (active.userId !== input.userId) {
			return { ok: false, reason: 'not_claimed' }
		}
		return { ok: true, email }
	}

	const ownReleased = await input.db
		.prepare(
			`SELECT 1 AS present
			 FROM user_email_claims
			 WHERE user_id = ? AND email = ? AND status = 'released'`,
		)
		.bind(input.userId, email)
		.first<{ present: number }>()
	if (ownReleased) return { ok: false, reason: 'already_released' }

	const legacy = await findLegacyEmailHashReservation(input.db, email)
	if (legacy?.stableUserId === input.stableUserId) {
		return { ok: true, email }
	}
	return { ok: false, reason: 'not_claimed' }
}

export async function claimAccountEmail(
	db: D1Database,
	input: { userId: number; email: string; now?: Date },
) {
	const email = normalizeEmail(input.email)
	if (!email) {
		throw new Error('Email is required to claim.')
	}
	const now = (input.now ?? new Date()).toISOString()
	const existing = await db
		.prepare(
			`SELECT id, user_id, status
			 FROM user_email_claims
			 WHERE user_id = ? AND email = ?`,
		)
		.bind(input.userId, email)
		.first<{ id: number; user_id: number; status: EmailClaimStatus }>()

	if (existing) {
		if (existing.status === 'claimed') return
		await db
			.prepare(
				`UPDATE user_email_claims
				 SET status = 'claimed',
				     claimed_at = ?,
				     released_at = NULL,
				     updated_at = ?
				 WHERE id = ?`,
			)
			.bind(now, now, existing.id)
			.run()
		return
	}

	try {
		await db
			.prepare(
				`INSERT INTO user_email_claims (user_id, email, status, claimed_at, updated_at)
				 VALUES (?, ?, 'claimed', ?, ?)`,
			)
			.bind(input.userId, email, now, now)
			.run()
	} catch (error) {
		if (getUniqueConstraintField(error) === 'email') {
			throw new EmailClaimConflictError(email)
		}
		throw error
	}
}

export async function releaseAccountEmailClaim(
	db: D1Database,
	input: { userId: number; email: string; now?: Date },
) {
	const email = normalizeEmail(input.email)
	if (!email) {
		throw new Error('Email is required to release.')
	}
	const now = (input.now ?? new Date()).toISOString()
	const existing = await db
		.prepare(
			`SELECT id, status
			 FROM user_email_claims
			 WHERE user_id = ? AND email = ?`,
		)
		.bind(input.userId, email)
		.first<{ id: number; status: EmailClaimStatus }>()

	if (existing) {
		if (existing.status === 'released') return
		await db
			.prepare(
				`UPDATE user_email_claims
				 SET status = 'released',
				     released_at = ?,
				     updated_at = ?
				 WHERE id = ?`,
			)
			.bind(now, now, existing.id)
			.run()
		return
	}

	await db
		.prepare(
			`INSERT INTO user_email_claims (
				user_id, email, status, claimed_at, released_at, updated_at
			 ) VALUES (?, ?, 'released', ?, ?, ?)`,
		)
		.bind(input.userId, email, now, now, now)
		.run()
}

export async function countRecentEmailClaimReleases(
	db: D1Database,
	input: { userId: number; windowSeconds: number; now?: Date },
) {
	const now = input.now ?? new Date()
	const since = new Date(
		now.getTime() - input.windowSeconds * 1000,
	).toISOString()
	const row = await db
		.prepare(
			`SELECT COUNT(*) AS count
			 FROM user_email_claims
			 WHERE user_id = ? AND status = 'released' AND released_at >= ?`,
		)
		.bind(input.userId, since)
		.first<{ count: number }>()
	return row?.count ?? 0
}

export async function allocateSignupIdentity(
	db: D1Database,
	email: string,
): Promise<AllocateSignupIdentityResult> {
	const normalized = normalizeEmail(email)
	if (!normalized) return { ok: false, reason: 'current_email' }

	const currentOwner = await db
		.prepare(`SELECT id FROM users WHERE email = ?`)
		.bind(normalized)
		.first<{ id: number }>()
	if (currentOwner) return { ok: false, reason: 'current_email' }

	if (await isEmailReservedForOtherAccount(db, normalized)) {
		return { ok: false, reason: 'former_email_claimed' }
	}
	return { ok: true, stableUserId: createStableUserId() }
}

export class EmailClaimConflictError extends Error {
	readonly email: string

	constructor(email: string) {
		super('Email claim is already held by another account.')
		this.name = 'EmailClaimConflictError'
		this.email = email
	}
}
