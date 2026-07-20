import { toHex } from '@kody-internal/shared/hex.ts'

export async function createStableUserIdFromEmail(email: string) {
	const normalized = email.trim().toLowerCase()
	const data = new TextEncoder().encode(normalized)
	const hash = await crypto.subtle.digest('SHA-256', data)
	return toHex(new Uint8Array(hash))
}

export type UserStableIdRow = {
	email: string
	stable_user_id?: string | null
}

export function normalizeStableUserId(value: string | null | undefined) {
	return value?.trim() ?? ''
}

export function resolveUserStableId(row: UserStableIdRow) {
	const stored = normalizeStableUserId(row.stable_user_id)
	if (!stored) {
		throw new Error('users.stable_user_id must be materialized.')
	}
	return stored
}

export async function resolveUserStableIdByEmail(input: {
	db: D1Database
	email: string
}) {
	const email = input.email.trim().toLowerCase()
	const row = await input.db
		.prepare(`SELECT email, stable_user_id FROM users WHERE email = ?`)
		.bind(email)
		.first<{ email: string; stable_user_id: string | null }>()
	return row
		? await resolveUserStableId(row)
		: await createStableUserIdFromEmail(email)
}

/** Resolve a users row from a stable user id with one indexed point read. */
export async function findUserRowByStableUserId<
	T extends UserStableIdRow & { id: number },
>(input: {
	db: D1Database
	stableUserId: string
	select: string
}): Promise<T | null> {
	const stableUserId = normalizeStableUserId(input.stableUserId)
	if (!stableUserId) return null

	return await input.db
		.prepare(`${input.select} WHERE stable_user_id = ?`)
		.bind(stableUserId)
		.first<T>()
}
