/**
 * Personal credentials (credentials plan v4 section 3.2, ADR 0068).
 *
 * A personal credential is a secret, OAuth connection, or MCP server in its
 * owner's personal org. The owner grants it to another org one org at a
 * time, and it then works only in the owner's own runs there, while the
 * owner still has a live binding to that org. Owners and Automation of the
 * org never use someone else's personal credential: no grant, role, or
 * package stamp reaches it.
 *
 * Backend only for now: placeholders keep resolving org credentials, and no
 * capability grants or lists these yet.
 */
import {
	personalOrgId,
	type OwnerId,
	type PersonId,
} from '@kody-internal/shared/owner-person-ids.ts'
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { AuthorizationError } from '#worker/authorization/authorize.ts'
import { isOrgActive, loadOrgBindingForOrg } from '#worker/orgs/repo.ts'
import {
	credentialPermissionFamily,
	getOrgCredential,
	listOrgCredentialsByIds,
	missingCredentialResource,
	type OrgCredential,
} from './credential-ids.ts'

export type PersonalCredential = OrgCredential & {
	ownerKind: 'user'
	ownerPersonId: PersonId
}

const notFoundMessage =
	'No personal credential with that id. Pass the credential_id of a secret, integration, or MCP server in your personal org.'

/**
 * The owner's credentials among `ids` that can be personal credentials now:
 * live, in an active personal org, not a vault binding, and for secrets a
 * user-scope entry that has not expired. Package and session secrets stay
 * with their package or session.
 */
async function loadPersonalCredentials(
	db: D1Database,
	ownerPersonId: PersonId,
	ids: ReadonlyArray<string>,
	now: Date,
): Promise<Map<string, OrgCredential>> {
	const ownerOrgId = personalOrgId(ownerPersonId)
	if (ids.length === 0 || !(await isOrgActive(db, ownerOrgId))) {
		return new Map()
	}
	const credentials = await listOrgCredentialsByIds(db, ownerOrgId, ids)
	const secretIds = [...credentials.values()]
		.filter((credential) => credential.kind === 'secret')
		.map((credential) => credential.id)
	const usableSecretIds = new Set<string>()
	const nowIso = now.toISOString()
	for (const chunk of chunkArray(secretIds, maxD1BoundParameters - 3)) {
		const result = await db
			.prepare(
				`SELECT e.id AS id FROM secret_entries e
				JOIN secret_buckets b ON b.id = e.bucket_id
				WHERE b.user_id = ? AND b.scope = 'user' AND b.binding_key = ''
					AND e.deleted_at IS NULL AND b.deleted_at IS NULL
					AND (e.expires_at IS NULL OR e.expires_at > ?)
					AND (b.expires_at IS NULL OR b.expires_at > ?)
					AND e.id IN (${chunk.map(() => '?').join(', ')})`,
			)
			.bind(ownerOrgId, nowIso, nowIso, ...chunk)
			.all<{ id: string }>()
		for (const row of result.results ?? []) usableSecretIds.add(row.id)
	}
	return new Map(
		[...credentials].filter(
			([id, credential]) =>
				credential.live &&
				credential.kind !== 'vault' &&
				(credential.kind !== 'secret' || usableSecretIds.has(id)),
		),
	)
}

/**
 * Grants the owner's personal credential to `orgId`. The owner must have a
 * live binding to that org, and the credential must be usable as a personal
 * credential (`loadPersonalCredentials`). Vault bindings are org
 * configuration, not credentials a person carries, so they cannot be granted.
 */
export async function grantPersonalCredentialToOrg(input: {
	db: D1Database
	ownerPersonId: PersonId
	credentialId: string
	orgId: OwnerId
	now?: Date
}): Promise<PersonalCredential> {
	const ownerOrgId = personalOrgId(input.ownerPersonId)
	if (input.orgId === ownerOrgId) {
		throw new McpCallerError(
			'A personal credential already works in your personal org; grant it to another org.',
		)
	}
	const now = input.now ?? new Date()
	const credential = (
		await loadPersonalCredentials(
			input.db,
			input.ownerPersonId,
			[input.credentialId],
			now,
		)
	).get(input.credentialId)
	if (!credential) throw new McpCallerError(notFoundMessage)
	const binding = await loadOrgBindingForOrg(
		input.db,
		input.ownerPersonId,
		input.orgId,
	)
	if (!binding) {
		throw new McpCallerError(
			'You can only grant a personal credential to an org you belong to.',
		)
	}
	await input.db
		.prepare(
			`INSERT INTO credential_org_grants (credential_id, user_id, org_id, created_at)
			VALUES (?, ?, ?, ?)
			ON CONFLICT (credential_id, org_id) DO NOTHING`,
		)
		.bind(credential.id, input.ownerPersonId, input.orgId, now.toISOString())
		.run()
	return {
		...credential,
		ownerKind: 'user',
		ownerPersonId: input.ownerPersonId,
	}
}

/** Removes one org grant of the owner's personal credential. */
export async function revokePersonalCredentialOrgGrant(input: {
	db: D1Database
	ownerPersonId: PersonId
	credentialId: string
	orgId: OwnerId
}): Promise<boolean> {
	const result = await input.db
		.prepare(
			`DELETE FROM credential_org_grants
			WHERE credential_id = ? AND user_id = ? AND org_id = ?`,
		)
		.bind(input.credentialId, input.ownerPersonId, input.orgId)
		.run()
	return (result.meta.changes ?? 0) > 0
}

/** Org access ended: the person's personal credentials stop working there. */
export async function deletePersonalCredentialOrgGrantsForMember(input: {
	db: D1Database
	orgId: OwnerId
	personId: string
}): Promise<number> {
	const result = await input.db
		.prepare(
			`DELETE FROM credential_org_grants WHERE org_id = ? AND user_id = ?`,
		)
		.bind(input.orgId, input.personId)
		.run()
	return result.meta.changes ?? 0
}

/**
 * The actor's own personal credentials granted to `orgId` and still usable
 * (`loadPersonalCredentials`), while the actor still has a live binding to
 * it. Nobody else's personal credentials are ever candidates, whatever the
 * actor's role.
 */
export async function listPersonalCredentialCandidates(input: {
	db: D1Database
	actorPersonId: PersonId | null
	orgId: OwnerId
	now?: Date
}): Promise<Array<PersonalCredential>> {
	const actor = input.actorPersonId
	if (!actor || input.orgId === personalOrgId(actor)) return []
	if (!(await loadOrgBindingForOrg(input.db, actor, input.orgId))) return []
	const rows = await input.db
		.prepare(
			`SELECT credential_id FROM credential_org_grants
			WHERE org_id = ? AND user_id = ? ORDER BY credential_id`,
		)
		.bind(input.orgId, actor)
		.all<{ credential_id: string }>()
	const ids = (rows.results ?? []).map((row) => row.credential_id)
	const credentials = await loadPersonalCredentials(
		input.db,
		actor,
		ids,
		input.now ?? new Date(),
	)
	return ids.flatMap((id) => {
		const credential = credentials.get(id)
		if (!credential) return []
		return [{ ...credential, ownerKind: 'user' as const, ownerPersonId: actor }]
	})
}

/**
 * Use check for a personal credential in a run of `orgId`: it passes only
 * for the owner, through a live org grant. Throws the same denial whether
 * the credential is missing, someone else's, or not granted to the org.
 */
export async function authorizePersonalCredentialUse(input: {
	db: D1Database
	actorPersonId: PersonId | null
	orgId: OwnerId
	credentialId: string
	now?: Date
}): Promise<PersonalCredential> {
	const candidates = await listPersonalCredentialCandidates(input)
	const credential = candidates.find(
		(candidate) => candidate.id === input.credentialId,
	)
	if (credential) return credential
	// Only the actor's own personal org is read, so the denial says nothing
	// about anyone else's credentials.
	const own = input.actorPersonId
		? await getOrgCredential(
				input.db,
				personalOrgId(input.actorPersonId),
				input.credentialId,
			)
		: null
	const family = credentialPermissionFamily(own?.kind ?? 'secret')
	throw new AuthorizationError({
		code: 'missing_permission',
		permission: `${family}:use`,
		orgId: input.orgId,
		resource: missingCredentialResource(input.orgId, input.credentialId),
		message:
			'Not allowed to use this personal credential in this org. Only its owner can, after granting it to the org.',
	})
}
