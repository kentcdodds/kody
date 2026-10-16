import {
	serializePackageAppOauthScopes,
	type PackageAppOauthScope,
} from '#app/package-app-oauth-scopes.ts'

export type PackageAppOauthGrant = {
	id: string
	personId: string
	orgUsername: string
	kodyId: string
	scopes: Array<PackageAppOauthScope>
	createdAt: string
}

function parseScopes(raw: string): Array<PackageAppOauthScope> {
	return raw
		.split(/\s+/)
		.filter(
			(part): part is PackageAppOauthScope =>
				part === 'profile' || part === 'email',
		)
}

export async function findLivePackageAppOauthGrant(input: {
	db: D1Database
	personId: string
	orgUsername: string
	kodyId: string
}): Promise<PackageAppOauthGrant | null> {
	const row = await input.db
		.prepare(
			`SELECT id, person_id, org_username, kody_id, scopes, created_at
			 FROM package_app_oauth_grants
			 WHERE person_id = ? AND org_username = ? AND kody_id = ?
			   AND revoked_at IS NULL
			 LIMIT 1`,
		)
		.bind(input.personId, input.orgUsername, input.kodyId)
		.first<{
			id: string
			person_id: string
			org_username: string
			kody_id: string
			scopes: string
			created_at: string
		}>()
	if (!row) return null
	return {
		id: row.id,
		personId: row.person_id,
		orgUsername: row.org_username,
		kodyId: row.kody_id,
		scopes: parseScopes(row.scopes),
		createdAt: row.created_at,
	}
}

export function grantCoversScopes(
	grant: PackageAppOauthGrant,
	requested: ReadonlyArray<PackageAppOauthScope>,
) {
	const have = new Set(grant.scopes)
	return requested.every((scope) => have.has(scope))
}

export async function upsertPackageAppOauthGrant(input: {
	db: D1Database
	personId: string
	orgUsername: string
	kodyId: string
	scopes: ReadonlyArray<PackageAppOauthScope>
	now?: Date
}) {
	const now = (input.now ?? new Date()).toISOString()
	const scopes = serializePackageAppOauthScopes(input.scopes)
	const existing = await findLivePackageAppOauthGrant({
		db: input.db,
		personId: input.personId,
		orgUsername: input.orgUsername,
		kodyId: input.kodyId,
	})
	if (existing) {
		const merged = serializePackageAppOauthScopes([
			...existing.scopes,
			...input.scopes,
		])
		await input.db
			.prepare(`UPDATE package_app_oauth_grants SET scopes = ? WHERE id = ?`)
			.bind(merged, existing.id)
			.run()
		return existing.id
	}
	const id = crypto.randomUUID()
	await input.db
		.prepare(
			`INSERT INTO package_app_oauth_grants
			 (id, person_id, org_username, kody_id, scopes, created_at)
			 VALUES (?, ?, ?, ?, ?, ?)`,
		)
		.bind(id, input.personId, input.orgUsername, input.kodyId, scopes, now)
		.run()
	return id
}

export async function revokePackageAppOauthGrantsForPersonApp(input: {
	db: D1Database
	personId: string
	orgUsername: string
	kodyId: string
	now?: Date
}) {
	const now = (input.now ?? new Date()).toISOString()
	await input.db
		.prepare(
			`UPDATE package_app_oauth_grants
			 SET revoked_at = ?
			 WHERE person_id = ? AND org_username = ? AND kody_id = ?
			   AND revoked_at IS NULL`,
		)
		.bind(now, input.personId, input.orgUsername, input.kodyId)
		.run()
}
