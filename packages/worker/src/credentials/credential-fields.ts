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
import { normalizeHost } from '#mcp/secrets/allowed-hosts.ts'
import {
	type OrgAuditWriter,
	recordOrgAuditEvent,
} from '#worker/orgs/org-audit.ts'
import { getOrgCredential, type OrgCredential } from './credential-ids.ts'
import { credentialHostsAllow } from './credential-request.ts'
import { loginExchangeSchema } from './login-resolver.ts'

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

export const optInStoredCredentialKinds = ['url', 'login', 'signing'] as const

export type OptInStoredCredentialKind =
	(typeof optInStoredCredentialKinds)[number]

function normalizeCredentialHost(host: string) {
	const wildcard = host.trim().startsWith('*.')
	const bare = normalizeHost(wildcard ? host.trim().slice(2) : host)
	if (!bare || bare.includes('*') || !bare.includes('.')) return null
	return wildcard ? `*.${bare}` : bare
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
				message: `"${host}" is not a host. Use an exact host or one wildcard level such as *.example.com.`,
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

/**
 * Checks the value against the kind before it is stored, so a misconfigured
 * credential fails at write time instead of at first use. Messages never
 * repeat the value.
 */
export function assertOptInCredentialValue(input: {
	kind: OptInStoredCredentialKind
	value: string
	hosts: ReadonlyArray<string>
}) {
	switch (input.kind) {
		case 'url': {
			let url: URL
			try {
				url = new URL(input.value.trim())
			} catch {
				throw new McpCallerError('A url credential value is a whole URL.')
			}
			if (url.protocol !== 'https:') {
				throw new McpCallerError('A url credential value must use https://.')
			}
			if (url.username || url.password) {
				throw new McpCallerError(
					'A url credential cannot carry a username or password in its URL.',
				)
			}
			if (!credentialHostsAllow(input.hosts, url.hostname)) {
				throw new McpCallerError(
					"A url credential value's host must be one of its hosts.",
				)
			}
			return
		}
		case 'login': {
			let parsed: unknown
			try {
				parsed = JSON.parse(input.value)
			} catch {
				parsed = null
			}
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw new McpCallerError(
					'A login credential value is a JSON object of its login fields, for example {"username":"…","password":"…"}.',
				)
			}
			return
		}
		case 'signing':
			return
		default: {
			const exhaustive: never = input.kind
			throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
		}
	}
}

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

export type CredentialFieldsUpdate = {
	provider?: string | null
	inject?: CredentialInject
}

export type CredentialFields = {
	credential: OrgCredential
	provider: string | null
	inject: CredentialInject
}

async function readFields(
	db: D1Database,
	credential: OrgCredential,
): Promise<CredentialFields> {
	const row = await db
		.prepare(
			`SELECT provider, inject_json FROM ${fieldTables[credential.kind]} WHERE id = ?`,
		)
		.bind(credential.id)
		.first<{ provider: string | null; inject_json: string }>()
	const inject = credentialInjectSchema.safeParse(
		JSON.parse(row?.inject_json ?? 'null'),
	)
	return {
		credential,
		provider: row?.provider ?? null,
		inject: inject.success ? inject.data : defaultCredentialInject,
	}
}

/**
 * Sets `provider` and/or `inject` on one credential of `orgId` and audits the
 * edit. The caller has already authorized the manager's write permission.
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
	await input.db
		.prepare(
			`UPDATE ${fieldTables[credential.kind]} SET provider = ?, inject_json = ?
			WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(provider, JSON.stringify(inject), credential.id)
		.run()
	await recordOrgAuditEvent(input.audit, {
		orgId: input.orgId,
		action: 'credential.fields_updated',
		resourceType: 'credential',
		resourceId: credential.id,
		details: {
			credentialKind: credential.kind,
			provider: { before: before.provider, after: provider },
			inject: { before: before.inject, after: inject },
		},
	})
	return { credential, provider, inject }
}

/**
 * Stores the kind of a user-scope secret entry that was just written with
 * its value, and audits it. An opt-in kind stores its hosts and login
 * exchange; going back to a Key clears them, so a Key's hosts only ever come
 * from the approval flow.
 */
export async function setStoredCredentialKind(input: {
	db: D1Database
	orgId: OwnerId
	credentialId: string
	kind: 'secret' | OptInStoredCredentialKind
	hosts: ReadonlyArray<string>
	loginExchange: z.infer<typeof loginExchangeSchema> | null
	audit: OrgAuditWriter
}) {
	const hosts = input.kind === 'secret' ? [] : input.hosts
	const exchange = input.kind === 'login' ? input.loginExchange : null
	await input.db
		.prepare(
			`UPDATE secret_entries SET kind = ?, allowed_hosts = ?, config_json = ?
			WHERE id = ? AND deleted_at IS NULL`,
		)
		.bind(
			input.kind,
			JSON.stringify(hosts),
			exchange ? JSON.stringify(exchange) : null,
			input.credentialId,
		)
		.run()
	await recordOrgAuditEvent(input.audit, {
		orgId: input.orgId,
		action: 'credential.kind_set',
		resourceType: 'credential',
		resourceId: input.credentialId,
		details: {
			kind: input.kind,
			hosts,
			loginExchangeHost: exchange ? new URL(exchange.url).hostname : null,
		},
	})
}

export async function readCredentialFields(input: {
	db: D1Database
	credential: OrgCredential
}) {
	return await readFields(input.db, input.credential)
}

export type StoredCredentialPlacement = {
	id: string
	kind: 'secret' | OptInStoredCredentialKind
	allowedHosts: Array<string>
	loginExchange: z.infer<typeof loginExchangeSchema> | null
}

/**
 * The kind, hosts, and login exchange of `orgId`'s live user-scope secret
 * `name`, never its value. Null when there is no such secret.
 */
export async function readStoredCredentialPlacement(input: {
	db: D1Database
	orgId: OwnerId
	name: string
}): Promise<StoredCredentialPlacement | null> {
	const row = await input.db
		.prepare(
			`SELECT e.id AS id, e.kind AS kind, e.allowed_hosts AS allowed_hosts,
				e.config_json AS config_json
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
		}>()
	if (!row) return null
	const kind = (['secret', ...optInStoredCredentialKinds] as const).find(
		(candidate) => candidate === row.kind,
	)
	if (!kind) throw new Error(`Unknown stored credential kind: ${row.kind}`)
	const hosts = z.array(z.string()).safeParse(JSON.parse(row.allowed_hosts))
	const exchange = row.config_json
		? loginExchangeSchema.safeParse(JSON.parse(row.config_json))
		: null
	return {
		id: row.id,
		kind,
		allowedHosts: hosts.success ? hosts.data : [],
		loginExchange: exchange?.success ? exchange.data : null,
	}
}
