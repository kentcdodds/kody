import { type AdminInvitesLoaderData } from '#app/loader-data.ts'

type InviteRow = {
	code: string
	created_by: number | null
	created_by_email: string | null
	note: string
	max_uses: number
	use_count: number
	expires_at: string | null
	revoked_at: string | null
	created_at: string
}

export async function loadAdminInvitesData(
	env: Env,
): Promise<AdminInvitesLoaderData> {
	const result = await env.APP_DB.prepare(
		`SELECT i.code,
		        i.created_by,
		        u.email AS created_by_email,
		        i.note,
		        i.max_uses,
		        i.use_count,
		        i.expires_at,
		        i.revoked_at,
		        i.created_at
		 FROM invites i
		 LEFT JOIN users u ON u.id = i.created_by
		 ORDER BY i.created_at DESC, i.code ASC
		 LIMIT 200`,
	).all<InviteRow>()

	return {
		ok: true,
		invites: (result.results ?? []).map((row) => ({
			code: row.code,
			createdBy: row.created_by,
			createdByEmail: row.created_by_email,
			note: row.note,
			maxUses: row.max_uses,
			useCount: row.use_count,
			expiresAt: row.expires_at,
			revokedAt: row.revoked_at,
			createdAt: row.created_at,
		})),
	}
}
