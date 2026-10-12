/**
 * Which credentials can satisfy a package credential need for the actor
 * (ADR 0068 resolution rules). One module serves `packageGet` needs, the
 * scoped client, call maps, and enablements, so they never disagree.
 *
 * Candidates are credentials of the need's kind and provider that the actor
 * can Use in the run org: org credentials with Use, plus the actor's own
 * personal credentials granted to that org. A credential with no provider
 * never auto-resolves; it is still an explicit option of the same kind.
 * Nothing here reads a value.
 */
import {
	chunkArray,
	maxD1BoundParameters,
} from '@kody-internal/shared/chunk.ts'
import {
	personalOrgId,
	type OwnerId,
} from '@kody-internal/shared/owner-person-ids.ts'
import { type RequestContext } from '@kody-internal/shared/request-context.ts'
import {
	listScopeIncludes,
	loadResourceListScope,
} from '#worker/authorization/authorize.ts'
import { type PackageCredentialKind } from '#worker/package-registry/types.ts'
import { type CredentialNeed } from './credential-needs.ts'
import { listPersonalCredentialCandidates } from './personal-credentials.ts'

export type UsableCredential = {
	id: string
	name: string
	kind: PackageCredentialKind
	provider: string | null
	hosts: Array<string>
	scope: 'org' | 'personal'
}

type Row = {
	id: string
	name: string
	kind: string
	provider: string | null
	hosts_json: string
	url: string | null
}

const usableRowQueries = [
	{
		family: 'secret' as const,
		sql: (filter: (column: string) => string) =>
			`SELECT e.id AS id, e.name AS name, e.kind AS kind, e.provider AS provider,
				e.allowed_hosts AS hosts_json, NULL AS url
			FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
			WHERE b.user_id = ? AND b.scope = 'user' AND b.binding_key = ''
				AND e.deleted_at IS NULL AND b.deleted_at IS NULL
				AND (e.expires_at IS NULL OR e.expires_at > ?)
				AND (b.expires_at IS NULL OR b.expires_at > ?)${filter('e.id')}`,
		binds: (now: string) => [now, now],
	},
	{
		family: 'integration' as const,
		sql: (filter: (column: string) => string) =>
			`SELECT id, name, 'oauth' AS kind, provider,
				required_hosts_json AS hosts_json, NULL AS url
			FROM user_integrations
			WHERE user_id = ? AND deleted_at IS NULL AND connected_at IS NOT NULL${filter('id')}`,
		binds: () => [],
	},
	{
		family: 'integration' as const,
		sql: (filter: (column: string) => string) =>
			`SELECT id, name, 'mcp' AS kind, provider, '[]' AS hosts_json, url
			FROM mcp_server_settings
			WHERE user_id = ? AND deleted_at IS NULL AND enabled = 1${filter('id')}`,
		binds: () => [],
	},
]

const needKinds = new Set<string>([
	'secret',
	'oauth',
	'mcp',
	'url',
	'login',
	'signing',
] satisfies Array<PackageCredentialKind>)

function parseHosts(row: Row): Array<string> {
	if (row.url) {
		try {
			return [new URL(row.url).hostname]
		} catch {
			return []
		}
	}
	try {
		const parsed: unknown = JSON.parse(row.hosts_json)
		return Array.isArray(parsed)
			? parsed.filter((host): host is string => typeof host === 'string')
			: []
	} catch {
		return []
	}
}

async function loadRows(input: {
	db: D1Database
	ownerId: string
	ids: ReadonlyArray<string> | null
	now: string
}) {
	const rows: Array<Row & { family: 'secret' | 'integration' }> = []
	const chunks =
		input.ids === null
			? [null]
			: chunkArray([...new Set(input.ids)], maxD1BoundParameters - 3)
	for (const chunk of chunks) {
		if (chunk?.length === 0) continue
		const filter = (column: string) =>
			chunk ? ` AND ${column} IN (${chunk.map(() => '?').join(', ')})` : ''
		for (const query of usableRowQueries) {
			const result = await input.db
				.prepare(query.sql(filter))
				.bind(input.ownerId, ...query.binds(input.now), ...(chunk ?? []))
				.all<Row>()
			for (const row of result.results ?? []) {
				if (!needKinds.has(row.kind)) continue
				rows.push({ ...row, family: query.family })
			}
		}
	}
	return rows
}

function toUsable(
	row: Row,
	scope: UsableCredential['scope'],
): UsableCredential {
	return {
		id: row.id,
		name: row.name,
		kind: row.kind as PackageCredentialKind,
		provider: row.provider,
		hosts: parseHosts(row),
		scope,
	}
}

/**
 * Every credential the actor can Use in the run org, by kind: the org's own
 * credentials the actor holds Use on, and the actor's own personal
 * credentials granted to the org. In the actor's personal org, its
 * credentials are org credentials.
 */
export async function listUsableCredentials(input: {
	env: Env
	request: RequestContext
	now?: Date
}): Promise<Array<UsableCredential>> {
	const orgId = input.request.org.id
	const now = (input.now ?? new Date()).toISOString()
	const [secretScope, integrationScope, orgRows, personal] = await Promise.all([
		loadResourceListScope(input, 'secret:use', 'credential'),
		loadResourceListScope(input, 'integration:use', 'credential'),
		loadRows({ db: input.env.APP_DB, ownerId: orgId, ids: null, now }),
		listPersonalCredentialCandidates({
			db: input.env.APP_DB,
			actorPersonId: input.request.actor?.userId ?? null,
			orgId: orgId as OwnerId,
		}),
	])
	const usable = orgRows
		.filter((row) =>
			listScopeIncludes(
				row.family === 'secret' ? secretScope : integrationScope,
				row.id,
			),
		)
		.map((row) => toUsable(row, 'org'))
	const actor = input.request.actor?.userId
	if (actor && personal.length > 0) {
		const personalRows = await loadRows({
			db: input.env.APP_DB,
			ownerId: personalOrgId(actor),
			ids: personal.map((credential) => credential.id),
			now,
		})
		usable.push(...personalRows.map((row) => toUsable(row, 'personal')))
	}
	return usable.sort(
		(left, right) =>
			left.name.localeCompare(right.name) ||
			left.scope.localeCompare(right.scope),
	)
}

export type NeedResolution = {
	status: 'ready' | 'ambiguous' | 'unbound'
	/** The one candidate that resolves the need with no map entry. */
	autoPick: UsableCredential | null
	/** Credentials of the need's kind and provider. */
	candidates: Array<UsableCredential>
	/** What an explicit pick may name: candidates plus same-kind credentials with no provider. */
	options: Array<UsableCredential>
	/** Same-kind credentials with no provider, which a provider would let auto-resolve. */
	possibleMatches: Array<UsableCredential>
}

export function resolveNeedCandidates(
	need: Pick<CredentialNeed, 'kind' | 'provider'>,
	usable: ReadonlyArray<UsableCredential>,
): NeedResolution {
	const sameKind = usable.filter((credential) => credential.kind === need.kind)
	const candidates = sameKind.filter(
		(credential) => credential.provider === need.provider,
	)
	const possibleMatches = sameKind.filter(
		(credential) => credential.provider === null,
	)
	const [only] = candidates
	return {
		status:
			candidates.length === 0
				? 'unbound'
				: candidates.length === 1
					? 'ready'
					: 'ambiguous',
		autoPick: candidates.length === 1 && only ? only : null,
		candidates,
		options: [...candidates, ...possibleMatches],
		possibleMatches,
	}
}
