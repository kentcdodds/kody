// soft-delete-read-filter: opt-out
// Sign-in reads tombstoned users so a proven login can offer restore.
// Live account reads stay on the deleted_at IS NULL path.

import { createCookie } from 'remix/cookie'
import { parsePersonId } from '@kody-internal/shared/owner-person-ids.ts'
import { isWithinSoftDeleteRestoreWindow } from '#worker/soft-delete/window.ts'

const accountRestoreMaxAgeSeconds = 60 * 10

export type SoftDeletedSignIn =
	| { kind: 'live' }
	| { kind: 'restore'; deletedAt: string }
	| { kind: 'expired' }

type TombstonedUserRow = {
	id: number
	username: string
	stable_user_id: string | null
	deleted_at: string | null
}

export async function readSoftDeletedSignIn(
	db: D1Database,
	email: string,
	now: Date = new Date(),
): Promise<SoftDeletedSignIn> {
	const row = await db
		.prepare(
			`SELECT id, username, stable_user_id, deleted_at
			 FROM "users"
			 WHERE "email" = ?`,
		)
		.bind(email)
		.first<TombstonedUserRow>()
	const deletedAt = row?.deleted_at
	if (deletedAt == null || deletedAt === '') return { kind: 'live' }
	if (!isWithinSoftDeleteRestoreWindow(deletedAt, now))
		return { kind: 'expired' }
	return { kind: 'restore', deletedAt }
}

export async function readTombstonedUserByEmail(
	db: D1Database,
	email: string,
): Promise<TombstonedUserRow | null> {
	return db
		.prepare(
			`SELECT id, username, stable_user_id, deleted_at
			 FROM "users"
			 WHERE "email" = ?`,
		)
		.bind(email)
		.first<TombstonedUserRow>()
}

export type AccountRestoreProof = {
	stableUserId: string
	email: string
	rememberMe: boolean
}

type StoredAccountRestoreProof = AccountRestoreProof & {
	v: 1
	issuedAt: number
}

let restoreCookie: ReturnType<typeof createCookie> | null = null
let restoreSecret: string | null = null

export function setAccountRestoreSecret(secret: string) {
	if (!secret) {
		throw new Error('Missing COOKIE_SECRET for account restore signing.')
	}
	if (restoreCookie && restoreSecret === secret) return
	restoreSecret = secret
	restoreCookie = createCookie('kody_account_restore', {
		httpOnly: true,
		sameSite: 'Lax',
		path: '/',
		maxAge: accountRestoreMaxAgeSeconds,
		secrets: [secret],
	})
}

function getRestoreCookie() {
	if (!restoreCookie) {
		throw new Error(
			'Account restore cookie not configured. Call setAccountRestoreSecret.',
		)
	}
	return restoreCookie
}

function isStoredAccountRestoreProof(
	value: unknown,
): value is StoredAccountRestoreProof {
	if (!value || typeof value !== 'object') return false
	const record = value as Record<string, unknown>
	return (
		record.v === 1 &&
		parsePersonId(record.stableUserId) !== null &&
		typeof record.email === 'string' &&
		record.email.length > 0 &&
		typeof record.rememberMe === 'boolean' &&
		typeof record.issuedAt === 'number' &&
		Number.isFinite(record.issuedAt) &&
		record.issuedAt > 0
	)
}

export async function issueAccountRestoreCookie(input: {
	secret: string
	email: string
	stableUserId: string
	rememberMe: boolean
	secure: boolean
}) {
	setAccountRestoreSecret(input.secret)
	return createAccountRestoreCookie(
		{
			email: input.email,
			stableUserId: input.stableUserId,
			rememberMe: input.rememberMe,
		},
		input.secure,
	)
}

export async function createAccountRestoreCookie(
	proof: AccountRestoreProof,
	secure: boolean,
	issuedAt = Date.now(),
) {
	return getRestoreCookie().serialize(
		JSON.stringify({
			...proof,
			v: 1,
			issuedAt,
		} satisfies StoredAccountRestoreProof),
		{ secure },
	)
}

export async function destroyAccountRestoreCookie(secure: boolean) {
	return getRestoreCookie().serialize('', {
		secure,
		maxAge: 0,
		expires: new Date(0),
	})
}

export async function readAccountRestoreProof(
	request: Request,
	now = Date.now(),
): Promise<AccountRestoreProof | null> {
	const cookieHeader = request.headers.get('Cookie')
	if (!cookieHeader) return null
	const stored = await getRestoreCookie().parse(cookieHeader)
	if (!stored || typeof stored !== 'string') return null
	try {
		const parsed: unknown = JSON.parse(stored)
		if (!isStoredAccountRestoreProof(parsed)) return null
		if (now - parsed.issuedAt > accountRestoreMaxAgeSeconds * 1000) return null
		return {
			stableUserId: parsed.stableUserId,
			email: parsed.email,
			rememberMe: parsed.rememberMe,
		}
	} catch {
		return null
	}
}
