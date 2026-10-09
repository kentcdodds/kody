import {
	normalizeConnectionProfileGrants,
	parseConnectionProfileGrantsJson,
	serializeConnectionProfileGrants,
	type ConnectionProfileGrant,
} from '#universal/connection-profiles/grants.ts'
import {
	connectionProfileNameErrorMessage,
	getConnectionProfileNameValidationError,
	normalizeConnectionProfileName,
} from '#universal/connection-profiles/names.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { getSavedPackageById } from '#worker/package-registry/repo.ts'
import { andLiveDeletedAtSql } from '#worker/soft-delete/live-sql.ts'

export type ConnectionProfileRecord = {
	id: string
	userId: string
	/** Org this profile narrows. Profiles stay an org-bound layer, not scopes. */
	orgId: string
	name: string
	grants: Array<ConnectionProfileGrant>
	createdAt: string
	updatedAt: string
}

type ConnectionProfileRow = {
	id: string
	user_id: string
	org_id: string | null
	name: string
	grants_json: string
	created_at: string
	updated_at: string
}

function mapRow(row: ConnectionProfileRow): ConnectionProfileRecord {
	return {
		id: row.id,
		userId: row.user_id,
		orgId: row.org_id?.trim() || row.user_id,
		name: row.name,
		grants: parseConnectionProfileGrantsJson(row.grants_json),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	}
}

function newProfileId() {
	return crypto.randomUUID()
}

async function assertProfilePackageGrantsOwned(input: {
	db: D1Database
	userId: string
	grants: ReadonlyArray<ConnectionProfileGrant>
}) {
	for (const grant of input.grants) {
		if (grant.resourceType !== 'package') continue
		const saved = await getSavedPackageById(input.db, {
			userId: input.userId,
			packageId: grant.resourceId,
		})
		if (!saved) {
			throw new McpCallerError(
				`Package "${grant.resourceId}" was not found for this account.`,
			)
		}
	}
}

export async function listConnectionProfiles(input: {
	db: D1Database
	userId: string
}): Promise<Array<ConnectionProfileRecord>> {
	const result = await input.db
		.prepare(
			`SELECT id, user_id, org_id, name, grants_json, created_at, updated_at
			 FROM connection_profiles
			 WHERE user_id = ?
			${andLiveDeletedAtSql()} ORDER BY name COLLATE NOCASE ASC`,
		)
		.bind(input.userId)
		.all<ConnectionProfileRow>()
	return (result.results ?? []).map(mapRow)
}

export async function getConnectionProfileByName(input: {
	db: D1Database
	userId: string
	name: string
	orgId?: string
}): Promise<ConnectionProfileRecord | null> {
	const name = normalizeConnectionProfileName(input.name)
	if (!name) return null
	const orgId = input.orgId?.trim()
	// Always filter by user_id: uniqueness is still (user_id, name). Org id
	// narrows further when the caller knows which org the profile belongs to.
	const row = orgId
		? await input.db
				.prepare(
					`SELECT id, user_id, org_id, name, grants_json, created_at, updated_at
					 FROM connection_profiles
					 WHERE user_id = ? AND org_id = ? AND name = ?${andLiveDeletedAtSql()}
					 LIMIT 1`,
				)
				.bind(input.userId, orgId, name)
				.first<ConnectionProfileRow>()
		: await input.db
				.prepare(
					`SELECT id, user_id, org_id, name, grants_json, created_at, updated_at
					 FROM connection_profiles
					 WHERE user_id = ? AND name = ?${andLiveDeletedAtSql()}
					 LIMIT 1`,
				)
				.bind(input.userId, name)
				.first<ConnectionProfileRow>()
	return row ? mapRow(row) : null
}

export async function getConnectionProfileById(input: {
	db: D1Database
	userId: string
	profileId: string
}): Promise<ConnectionProfileRecord | null> {
	const row = await input.db
		.prepare(
			`SELECT id, user_id, org_id, name, grants_json, created_at, updated_at
			 FROM connection_profiles
			 WHERE user_id = ? AND id = ?
			 ${andLiveDeletedAtSql()} LIMIT 1`,
		)
		.bind(input.userId, input.profileId)
		.first<ConnectionProfileRow>()
	return row ? mapRow(row) : null
}

export async function createConnectionProfile(input: {
	db: D1Database
	userId: string
	/** Org this profile is bound to. Defaults to the caller's personal org. */
	orgId?: string
	name: string
	grants?: unknown
}): Promise<ConnectionProfileRecord> {
	const name = normalizeConnectionProfileName(input.name)
	const nameError = getConnectionProfileNameValidationError(name)
	if (nameError) {
		throw new McpCallerError(connectionProfileNameErrorMessage(nameError))
	}
	let grants: Array<ConnectionProfileGrant>
	try {
		grants = normalizeConnectionProfileGrants(input.grants ?? [])
	} catch (error) {
		throw new McpCallerError(
			error instanceof Error ? error.message : String(error),
		)
	}
	await assertProfilePackageGrantsOwned({
		db: input.db,
		userId: input.userId,
		grants,
	})
	const id = newProfileId()
	const now = new Date().toISOString()
	const orgId = input.orgId?.trim() || input.userId
	try {
		await input.db
			.prepare(
				`INSERT INTO connection_profiles (
					id, user_id, org_id, name, grants_json, created_at, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?)`,
			)
			.bind(
				id,
				input.userId,
				orgId,
				name,
				serializeConnectionProfileGrants(grants),
				now,
				now,
			)
			.run()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/UNIQUE/i.test(message)) {
			throw new McpCallerError(
				`A connection profile named "${name}" already exists.`,
			)
		}
		throw error
	}
	const created = await getConnectionProfileById({
		db: input.db,
		userId: input.userId,
		profileId: id,
	})
	if (!created) throw new Error('Failed to load created connection profile.')
	return created
}

export async function updateConnectionProfile(input: {
	db: D1Database
	userId: string
	profileId: string
	name?: string
	grants?: unknown
}): Promise<ConnectionProfileRecord> {
	const existing = await getConnectionProfileById({
		db: input.db,
		userId: input.userId,
		profileId: input.profileId,
	})
	if (!existing) {
		throw new McpCallerError('Connection profile not found.')
	}
	const name =
		input.name === undefined
			? existing.name
			: normalizeConnectionProfileName(input.name)
	if (input.name !== undefined) {
		const nameError = getConnectionProfileNameValidationError(name)
		if (nameError) {
			throw new McpCallerError(connectionProfileNameErrorMessage(nameError))
		}
	}
	let grants: Array<ConnectionProfileGrant>
	if (input.grants === undefined) {
		grants = existing.grants
	} else {
		try {
			grants = normalizeConnectionProfileGrants(input.grants)
		} catch (error) {
			throw new McpCallerError(
				error instanceof Error ? error.message : String(error),
			)
		}
		await assertProfilePackageGrantsOwned({
			db: input.db,
			userId: input.userId,
			grants,
		})
	}
	const now = new Date().toISOString()
	try {
		await input.db
			.prepare(
				`UPDATE connection_profiles
				 SET name = ?, grants_json = ?, updated_at = ?
				 WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
			)
			.bind(
				name,
				serializeConnectionProfileGrants(grants),
				now,
				input.userId,
				input.profileId,
			)
			.run()
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error)
		if (/UNIQUE/i.test(message)) {
			throw new McpCallerError(
				`A connection profile named "${name}" already exists.`,
			)
		}
		throw error
	}
	const updated = await getConnectionProfileById({
		db: input.db,
		userId: input.userId,
		profileId: input.profileId,
	})
	if (!updated) throw new Error('Failed to load updated connection profile.')
	return updated
}

export async function deleteConnectionProfile(input: {
	db: D1Database
	userId: string
	profileId: string
}): Promise<void> {
	const result = await input.db
		.prepare(
			`DELETE FROM connection_profiles WHERE user_id = ? AND id = ?${andLiveDeletedAtSql()}`,
		)
		.bind(input.userId, input.profileId)
		.run()
	if ((result.meta?.changes ?? 0) === 0) {
		throw new McpCallerError('Connection profile not found.')
	}
}

/**
 * Resolve grants for a named profile. Missing profile → empty allowlist (deny
 * all), never unlimited. Callers that want unlimited must pass no profile name.
 */
export async function resolveConnectionProfileGrants(input: {
	db: D1Database
	userId: string
	profileName: string
}): Promise<Array<ConnectionProfileGrant>> {
	const profile = await getConnectionProfileByName({
		db: input.db,
		userId: input.userId,
		name: input.profileName,
	})
	return profile?.grants ?? []
}
