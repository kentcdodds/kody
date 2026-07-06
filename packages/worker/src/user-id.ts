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

export async function resolveUserStableId(row: UserStableIdRow) {
	const stored = normalizeStableUserId(row.stable_user_id)
	return stored || (await createStableUserIdFromEmail(row.email))
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
		.catch(async () => {
			const legacyRow = await input.db
				.prepare(`SELECT email FROM users WHERE email = ?`)
				.bind(email)
				.first<{ email: string }>()
			return legacyRow
				? { ...legacyRow, stable_user_id: null as string | null }
				: null
		})
	return row
		? await resolveUserStableId(row)
		: await createStableUserIdFromEmail(email)
}

function withoutStableUserIdColumn(select: string) {
	return select.replace(/,\s*stable_user_id\b/g, '')
}

export async function findUserRowByStableUserId<
	T extends UserStableIdRow & { id: number },
>(input: {
	db: D1Database
	stableUserId: string
	select: string
}): Promise<T | null> {
	const stableUserId = normalizeStableUserId(input.stableUserId)
	if (!stableUserId) return null

	try {
		const storedRow = await input.db
			.prepare(`${input.select} WHERE stable_user_id = ?`)
			.bind(stableUserId)
			.first<T>()
		if (storedRow) return storedRow
	} catch {
		// Some legacy tests and pre-migration databases do not expose
		// stable_user_id; the scan below falls back to hashing the email.
	}

	let rows: D1Result<T>
	try {
		rows = await input.db.prepare(input.select).all<T>()
	} catch {
		rows = await input.db
			.prepare(withoutStableUserIdColumn(input.select))
			.all<T>()
	}
	for (const row of rows.results ?? []) {
		if ((await resolveUserStableId(row)) === stableUserId) return row
	}
	return null
}
