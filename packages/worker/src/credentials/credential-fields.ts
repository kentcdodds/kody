/**
 * The fields a credential owns for the opt-in types (ADR 0068): its provider,
 * how a scoped client places it (`inject`), and, for the `url`, `login`, and
 * `signing` kinds, its kind, hosts, and login exchange. Key placeholders
 * ignore `provider` and `inject` and keep their own placement.
 *
 * Only the credential's manager edits these, and every edit is audited. Hosts
 * are set only together with a new value: whoever supplies the value decides
 * where it may go, and an existing value's hosts keep the approval flow.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { z } from 'zod'
import { McpCallerError } from '#mcp/caller-error.ts'
import {
	type OrgAuditWriter,
	runAppDbBatchWithOrgAudit,
} from '#worker/orgs/org-audit.ts'
import { getOrgCredential, type OrgCredential } from './credential-ids.ts'
import { credentialHostsAllow } from './credential-request.ts'
import { loginExchangeSchema } from './login-resolver.ts'
import {
	assertOptInCredentialValue,
	type OptInStoredCredentialKind,
	optInStoredCredentialKinds,
} from './opt-in-credential-value.ts'

/** RFC 9110 token characters for HTTP field names. */
const httpFieldNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

export const credentialProviderSchema = z
	.string()
	.regex(
		/^[a-z0-9-]{1,64}$/,
		'A provider is a slug: lowercase letters, numbers, and hyphens (for example "github").',
	)

export const credentialInjectSchema = z.discriminatedUnion('kind', [
	z.strictObject({
		kind: z.literal('header'),
		name: z.string().regex(httpFieldNamePattern),
		format: z
			.string()
			.max(200)
			.refine((format) => format.split('{value}').length === 2, {
				message: 'An inject format holds "{value}" exactly once.',
			}),
	}),
	z.strictObject({
		kind: z.literal('basic'),
		valueAs: z.enum(['username', 'password']),
		other: z.string().max(200).default(''),
	}),
	z.strictObject({
		kind: z.literal('query'),
		param: z.string().min(1).max(100),
	}),
])

export type CredentialInject = z.infer<typeof credentialInjectSchema>

export const defaultCredentialInject: CredentialInject = {
	kind: 'header',
	name: 'Authorization',
	format: 'Bearer {value}',
}

export { type OptInStoredCredentialKind, optInStoredCredentialKinds }

const hostLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?'
const bareHostPattern = new RegExp(
	`^(?:\\*\\.)?${hostLabel}(?:\\.${hostLabel})+$`,
)

/**
 * A bare host or one wildcard level, lowercased. Anything URL-shaped (scheme,
 * port, path, userinfo) is refused rather than reduced to its hostname, so a
 * host list never looks narrower than what it allows.
 */
function normalizeCredentialHost(host: string) {
	const candidate = host.trim().toLowerCase()
	return bareHostPattern.test(candidate) ? candidate : null
}

/** Exact hosts or one wildcard level (`*.example.com`). */
export const credentialHostsSchema = z
	.array(z.string().min(1).max(253))
	.min(1)
	.max(20)
	.superRefine((hosts, ctx) => {
		for (const host of hosts) {
			if (normalizeCredentialHost(host)) continue
			ctx.addIssue({
				code: 'custom',
				message: `"${host}" is not a bare host. Use an exact host such as api.example.com or one wildcard level such as *.example.com, with no scheme, port, or path.`,
			})
		}
	})

/** Lowercased, deduplicated hosts from input `credentialHostsSchema` accepted. */
export function normalizeCredentialHosts(hosts: ReadonlyArray<string>) {
	return [
		...new Set(
			hosts
				.map(normalizeCredentialHost)
				.filter((host): host is string => host !== null),
		),
	]
}

export { loginExchangeSchema }
export { assertOptInCredentialValue }

export function assertLoginExchangeOnHosts(input: {
	exchangeUrl: string
	hosts: ReadonlyArray<string>
}) {
	let url: URL
	try {
		url = new URL(input.exchangeUrl)
	} catch {
		throw new McpCallerError('The login exchange url is not a valid URL.')
	}
	if (url.protocol !== 'https:') {
		throw new McpCallerError('The login exchange url must use https://.')
	}
	if (url.username || url.password) {
		throw new McpCallerError(
			'The login exchange url cannot carry a username or password.',
		)
	}
	if (!credentialHostsAllow(input.hosts, url.hostname)) {
		throw new McpCallerError(
			"The login exchange url's host must be one of the credential's hosts.",
		)
	}
}

const fieldTables = {
	secret: 'secret_entries',
	integration: 'user_integrations',
	'mcp-server': 'mcp_server_settings',
	vault: 'secret_provider_bindings',
} as const satisfies Record<OrgCredential['kind'], string>

const storedKindValues = ['secret', ...optInStoredCredentialKinds] as const

export type StoredCredentialKindValue = (typeof storedKindValues)[number]

function parseStoredKind(value: unknown): StoredCredentialKindValue {
	const kind = storedKindValues.find((candidate) => candidate === value)
	if (!kind) throw new Error(`Unknown stored credential kind: ${String(value)}`)
	return kind
}

/**
 * A login credential's session token is placed by header or query only; the
 * login resolver has no Basic placement, so refuse it at write time.
 */
export function assertInjectFitsKind(input: {
	kind: StoredCredentialKindValue
	inject: CredentialInject
}) {
	if (input.kind === 'login' && input.inject.kind === 'basic') {
		throw new McpCallerError(
			'A login credential places its session token in a header or query parameter, not basic auth.',
		)
	}
}

function parseInject(injectJson: string | null | undefined): CredentialInject {
	const inject = credentialInjectSchema.safeParse(
		JSON.parse(injectJson ?? 'null'),
	)
	return inject.success ? inject.data : defaultCredentialInject
}

export type CredentialFieldsUpdate = {
	provider?: string | null
	inject?: CredentialInject
}

export type CredentialFields = {
	credential: OrgCredential
	provider: string | null
	inject: CredentialInject
}

async function readFields(db: D1Database, credential: OrgCredential) {
	const isSecret = credential.kind === 'secret'
	const row = await db
		.prepare(
			`SELECT provider, inject_json${isSecret ? ', kind' : ''}
			FROM ${fieldTables[credential.kind]} WHERE id = ?`,
		)
		.bind(credential.id)
		.first<{ provider: string | null; inject_json: string; kind?: string }>()
	return {
		credential,
		provider: row?.provider ?? null,
		inject: parseInject(row?.inject_json),
		storedKind: isSecret ? parseStoredKind(row?.kind) : null,
	}
}

/**
 * Sets `provider` and/or `inject` on one credential of `orgId`, committed
 * together with its audit event. The caller has already authorized the
 * manager's write permission.
 */
export async function updateCredentialFields(input: {
	db: D1Database
	orgId: OwnerId
	credentialId: string
	update: CredentialFieldsUpdate
	audit: OrgAuditWriter
}): Promise<CredentialFields> {
	const credential = await getOrgCredential(
		input.db,
		input.orgId,
		input.credentialId,
	)
	if (!credential?.live) {
		throw new McpCallerError('No credential with that id in this org.')
	}
	if (credential.kind === 'vault') {
		throw new McpCallerError(
			'A vault binding takes its placement from each reference; it has no provider or inject to set.',
		)
	}
	const before = await readFields(input.db, credential)
	const provider =
		input.update.provider === undefined
			? before.provider
			: input.update.provider
	const inject = input.update.inject ?? before.inject
	if (
		credential.kind !== 'secret' &&
		JSON.stringify(inject) !== JSON.stringify(defaultCredentialInject)
	) {
		throw new McpCallerError(
			'OAuth connections and MCP servers always send their token as `Authorization: Bearer {value}`; only provider can change.',
		)
	}
	if (before.storedKind) {
		assertInjectFitsKind({ kind: before.storedKind, inject })
	}
	await runAppDbBatchWithOrgAudit({
		appDb: input.db,
		audit: input.audit,
		statements: [
			input.db
				.prepare(
					`UPDATE ${fieldTables[credential.kind]} SET provider = ?, inject_json = ?
					WHERE id = ? AND deleted_at IS NULL`,
				)
				.bind(provider, JSON.stringify(inject), credential.id),
		],
		event: {
			orgId: input.orgId,
			action: 'credential.fields_updated',
			resourceType: 'credential',
			resourceId: credential.id,
			details: {
				credentialKind: credential.kind,
				provider: { before: before.provider, after: provider },
				inject: { before: before.inject, after: inject },
			},
		},
	})
	return { credential, provider, inject }
}

export async function readCredentialFields(input: {
	db: D1Database
	credential: OrgCredential
}): Promise<CredentialFields> {
	const { credential, provider, inject } = await readFields(
		input.db,
		input.credential,
	)
	return { credential, provider, inject }
}

export type StoredCredentialPlacement = {
	id: string
	kind: StoredCredentialKindValue
	allowedHosts: Array<string>
	loginExchange: z.infer<typeof loginExchangeSchema> | null
	provider: string | null
	inject: CredentialInject
}

/**
 * The kind, hosts, login exchange, provider, and inject of `orgId`'s live
 * user-scope secret `name`, never its value. Null when there is no such
 * secret.
 */
export async function readStoredCredentialPlacement(input: {
	db: D1Database
	orgId: OwnerId
	name: string
}): Promise<StoredCredentialPlacement | null> {
	const row = await input.db
		.prepare(
			`SELECT e.id AS id, e.kind AS kind, e.allowed_hosts AS allowed_hosts,
				e.config_json AS config_json, e.provider AS provider,
				e.inject_json AS inject_json
			FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
			WHERE b.user_id = ? AND b.scope = 'user' AND b.binding_key = ''
				AND e.name = ? AND e.deleted_at IS NULL AND b.deleted_at IS NULL`,
		)
		.bind(input.orgId, input.name)
		.first<{
			id: string
			kind: string
			allowed_hosts: string
			config_json: string | null
			provider: string | null
			inject_json: string
		}>()
	if (!row) return null
	const hosts = z.array(z.string()).safeParse(JSON.parse(row.allowed_hosts))
	const exchange = row.config_json
		? loginExchangeSchema.safeParse(JSON.parse(row.config_json))
		: null
	return {
		id: row.id,
		kind: parseStoredKind(row.kind),
		allowedHosts: hosts.success ? hosts.data : [],
		loginExchange: exchange?.success ? exchange.data : null,
		provider: row.provider,
		inject: parseInject(row.inject_json),
	}
}
