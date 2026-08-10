import { resolvePlanWrite, type PlanName } from '#universal/plans.ts'

export type InviteRecord = {
	code: string
	created_by: number | null
	note: string
	max_uses: number
	use_count: number
	expires_at: string | null
	revoked_at: string | null
	created_at: string
	plan: string
}

export type InviteConsumeFailureReason =
	| 'missing'
	| 'not_found'
	| 'revoked'
	| 'expired'
	| 'exhausted'

export type InviteConsumeResult =
	| { ok: true; invite: InviteRecord }
	| { ok: false; reason: InviteConsumeFailureReason }

const inviteCodePattern = /^[A-Z0-9][A-Z0-9-]{2,62}[A-Z0-9]$/

export function normalizeInviteCode(value: unknown) {
	if (typeof value !== 'string') return null
	const normalized = value.trim().toUpperCase()
	if (!normalized) return null
	return normalized
}

export function isValidInviteCode(value: string) {
	return inviteCodePattern.test(value)
}

export function generateInviteCode() {
	const bytes = new Uint8Array(12)
	crypto.getRandomValues(bytes)
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'))
		.join('')
		.toUpperCase()
	return `KODY-${hex.slice(0, 6)}-${hex.slice(6, 12)}-${hex.slice(12, 18)}-${hex.slice(18, 24)}`
}

export async function getInviteByCode(db: D1Database, code: string) {
	return db
		.prepare(
			`SELECT code, created_by, note, max_uses, use_count, expires_at, revoked_at, created_at, plan
			 FROM invites
			 WHERE code = ?`,
		)
		.bind(code)
		.first<InviteRecord>()
}

export async function listInvites(db: D1Database) {
	const result = await db
		.prepare(
			`SELECT code, created_by, note, max_uses, use_count, expires_at, revoked_at, created_at, plan
			 FROM invites
			 ORDER BY created_at DESC, code ASC
			 LIMIT 200`,
		)
		.all<InviteRecord>()
	return result.results ?? []
}

export async function createInvite(input: {
	db: D1Database
	code?: string | null
	createdBy: number
	note?: string | null
	maxUses: number
	expiresAt?: string | null
	plan?: PlanName | null
}) {
	const code = normalizeInviteCode(input.code) ?? generateInviteCode()
	if (!isValidInviteCode(code)) {
		throw new Error(
			'Invite code must be 4 to 64 characters and contain only letters, numbers, and hyphens.',
		)
	}
	if (!Number.isSafeInteger(input.maxUses) || input.maxUses < 1) {
		throw new Error('Max uses must be at least 1.')
	}

	await input.db
		.prepare(
			`INSERT INTO invites (code, created_by, note, max_uses, expires_at, plan)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			code,
			input.createdBy,
			input.note?.trim() ?? '',
			input.maxUses,
			input.expiresAt ?? null,
			resolvePlanWrite(input.plan),
		)
		.run()

	const invite = await getInviteByCode(input.db, code)
	if (!invite) throw new Error('Invite was not created.')
	return invite
}

export async function revokeInvite(input: {
	db: D1Database
	code: string
	now?: Date
}) {
	const now = input.now ?? new Date()
	const result = await input.db
		.prepare(
			`UPDATE invites
			 SET revoked_at = COALESCE(revoked_at, ?)
			 WHERE code = ?`,
		)
		.bind(now.toISOString(), input.code)
		.run()
	return (result.meta.changes ?? 0) > 0
}

export async function releaseInviteUse(input: {
	db: D1Database
	code: string
}) {
	await input.db
		.prepare(
			`UPDATE invites
			 SET use_count = use_count - 1
			 WHERE code = ? AND use_count > 0`,
		)
		.bind(input.code)
		.run()
}

export async function consumeInviteCode(input: {
	db: D1Database
	code: unknown
	now?: Date
}): Promise<InviteConsumeResult> {
	const code = normalizeInviteCode(input.code)
	if (!code) return { ok: false, reason: 'missing' }

	const now = input.now ?? new Date()
	const nowIso = now.toISOString()
	const result = await input.db
		.prepare(
			`UPDATE invites
			 SET use_count = use_count + 1
			 WHERE code = ?
			   AND revoked_at IS NULL
			   AND (expires_at IS NULL OR expires_at > ?)
			   AND use_count < max_uses`,
		)
		.bind(code, nowIso)
		.run()

	if ((result.meta.changes ?? 0) > 0) {
		const invite = await getInviteByCode(input.db, code)
		if (!invite) return { ok: false, reason: 'not_found' }
		return { ok: true, invite }
	}

	const invite = await getInviteByCode(input.db, code)
	if (!invite) return { ok: false, reason: 'not_found' }
	if (invite.revoked_at) return { ok: false, reason: 'revoked' }
	if (invite.expires_at && Date.parse(invite.expires_at) <= now.getTime()) {
		return { ok: false, reason: 'expired' }
	}
	if (invite.use_count >= invite.max_uses) {
		return { ok: false, reason: 'exhausted' }
	}
	return { ok: false, reason: 'not_found' }
}

export function getInviteFailureMessage(reason: InviteConsumeFailureReason) {
	switch (reason) {
		case 'missing':
			return 'Invite code is required.'
		case 'not_found':
			return 'Invite code is invalid.'
		case 'revoked':
			return 'Invite code has been revoked.'
		case 'expired':
			return 'Invite code has expired.'
		case 'exhausted':
			return 'Invite code has already been used.'
		default: {
			const unreachable: never = reason
			return unreachable
		}
	}
}
