/**
 * Editing where a Key or an OAuth connection may be sent. Only the website
 * edits these: an agent that could add a host could send the value anywhere.
 * Every change is committed together with its audit event.
 */
import { type OwnerId } from '@kody-internal/shared/owner-person-ids.ts'
import { safeParseHost } from '@kody-internal/shared/url-hosts.ts'
import { McpCallerError } from '#mcp/caller-error.ts'
import { normalizeAllowedHosts } from '#mcp/secrets/allowed-hosts.ts'
import { classifyApprovalHosts } from '#mcp/secrets/approval-host-shape.ts'
import {
	type OrgAuditWriter,
	runAppDbBatchWithOrgAudit,
} from '#worker/orgs/org-audit.ts'
import { getOrgCredential, type OrgCredential } from './credential-ids.ts'

export const credentialHostsMax = 20

export type CredentialHostSettings = {
	/** Hosts the credential's manager can add or remove. */
	hosts: Array<string>
	/** Hosts the credential always allows: its API base URL and a built-in app's hosts. */
	fixedHosts: Array<string>
}

export type ParsedCredentialHosts =
	| { ok: true; hosts: Array<string> }
	| { ok: false; error: string }

const otherSchemePattern = /^[a-z][a-z0-9+.-]*:\/\//

function parseCredentialHost(
	raw: string,
): { ok: true; host: string } | { ok: false; error: string } {
	const entry = raw.trim().toLowerCase()
	if (entry.startsWith('http://')) {
		return {
			ok: false,
			error: `"${raw.trim()}": Kody sends credentials only over HTTPS. Enter the host without http://.`,
		}
	}
	if (!entry.startsWith('https://') && otherSchemePattern.test(entry)) {
		return {
			ok: false,
			error: `"${raw.trim()}": enter a host name such as api.example.com.`,
		}
	}
	const host = entry.replace(/^https:\/\//, '').replace(/\/$/, '')
	if (host.includes('*')) {
		return {
			ok: false,
			error: `"${raw.trim()}": wildcards are not supported. List each host.`,
		}
	}
	if (/[:/?#@\s\\]/.test(host)) {
		return {
			ok: false,
			error: `"${raw.trim()}": enter just the host name, with no port, path, or query.`,
		}
	}
	const { valid, rejected } = classifyApprovalHosts([host])
	const accepted = valid[0]
	if (!accepted || rejected.length > 0) {
		return {
			ok: false,
			error: `"${raw.trim()}" is not a valid host name.`,
		}
	}
	if (
		accepted === 'localhost' ||
		accepted.endsWith('.localhost') ||
		/^[\d.]+$/.test(accepted) ||
		accepted.startsWith('[')
	) {
		return {
			ok: false,
			error: `"${raw.trim()}": enter a public host name, not localhost or an IP address.`,
		}
	}
	return { ok: true, host: accepted }
}

/**
 * Validates hosts typed on the website: public host names only, `https://`
 * optional, nothing that would send a credential over plain HTTP. Returns
 * the lowercased, deduplicated, sorted list.
 */
export function parseCredentialHostsInput(
	raw: ReadonlyArray<unknown>,
): ParsedCredentialHosts {
	const hosts: Array<string> = []
	for (const value of raw) {
		if (typeof value !== 'string') {
			return { ok: false, error: 'Hosts must be text.' }
		}
		if (!value.trim()) continue
		const parsed = parseCredentialHost(value)
		if (!parsed.ok) return parsed
		hosts.push(parsed.host)
	}
	const normalized = normalizeAllowedHosts(hosts)
	if (normalized.length > credentialHostsMax) {
		return {
			ok: false,
			error: `A credential can allow at most ${credentialHostsMax} hosts.`,
		}
	}
	return { ok: true, hosts: normalized }
}

function parseHostList(json: string | null | undefined) {
	try {
		const parsed: unknown = JSON.parse(json ?? '[]')
		return Array.isArray(parsed)
			? normalizeAllowedHosts(
					parsed.filter((value): value is string => typeof value === 'string'),
				)
			: []
	} catch {
		return []
	}
}

type IntegrationHostsRow = {
	required_hosts_json: string
	api_base_url: string | null
	app_hosts_json: string | null
}

type HostSettingsRead =
	| {
			kind: 'integration'
			stored: Array<string>
			settings: CredentialHostSettings
	  }
	| { kind: 'secret'; stored: Array<string>; settings: CredentialHostSettings }

async function readHostSettings(
	db: D1Database,
	orgId: OwnerId,
	credential: OrgCredential,
): Promise<HostSettingsRead | { refused: string }> {
	switch (credential.kind) {
		case 'integration': {
			const row = await db
				.prepare(
					`SELECT i.required_hosts_json AS required_hosts_json,
						COALESCE(a.api_base_url, p.api_base_url) AS api_base_url,
						p.required_hosts_json AS app_hosts_json
					FROM user_integrations i
					LEFT JOIN user_oauth_apps a
						ON a.user_id = i.user_id AND a.slug = i.app_slug AND a.deleted_at IS NULL
					LEFT JOIN platform_oauth_apps p ON p.slug = i.platform_app_slug
					WHERE i.id = ? AND i.user_id = ? AND i.deleted_at IS NULL`,
				)
				.bind(credential.id, orgId)
				.first<IntegrationHostsRow>()
			if (!row) return { refused: 'No credential with that id in this org.' }
			const apiHost = row.api_base_url ? safeParseHost(row.api_base_url) : null
			const fixedHosts = normalizeAllowedHosts([
				...parseHostList(row.app_hosts_json),
				...(apiHost ? [apiHost] : []),
			])
			const stored = parseHostList(row.required_hosts_json)
			return {
				kind: 'integration',
				stored,
				settings: {
					hosts: stored.filter((host) => !fixedHosts.includes(host)),
					fixedHosts,
				},
			}
		}
		case 'secret': {
			const row = await db
				.prepare(
					`SELECT e.kind AS kind, e.allowed_hosts AS allowed_hosts
					FROM secret_entries e JOIN secret_buckets b ON b.id = e.bucket_id
					WHERE e.id = ? AND b.user_id = ? AND b.scope IN ('user', 'package')
						AND e.deleted_at IS NULL AND b.deleted_at IS NULL`,
				)
				.bind(credential.id, orgId)
				.first<{ kind: string; allowed_hosts: string }>()
			if (!row) return { refused: 'No credential with that id in this org.' }
			if (row.kind !== 'secret') {
				return {
					refused:
						'URL, login, and signing credentials take their hosts with their value. Set them again from the credential creation page.',
				}
			}
			const stored = parseHostList(row.allowed_hosts)
			return {
				kind: 'secret',
				stored,
				settings: { hosts: stored, fixedHosts: [] },
			}
		}
		case 'mcp-server':
			return {
				refused: 'An MCP server connects only to its server URL.',
			}
		case 'vault':
			return {
				refused: 'A vault takes its hosts from each item it resolves.',
			}
		default: {
			const exhaustive: never = credential.kind
			throw new Error(`Unhandled credential kind: ${String(exhaustive)}`)
		}
	}
}

/**
 * The hosts the website can edit for `credential`, or null when its kind
 * takes hosts some other way (or it is gone).
 */
export async function readCredentialHostSettings(input: {
	db: D1Database
	orgId: OwnerId
	credential: OrgCredential
}): Promise<CredentialHostSettings | null> {
	const read = await readHostSettings(input.db, input.orgId, input.credential)
	return 'refused' in read ? null : read.settings
}

function sameHosts(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
	return (
		left.length === right.length &&
		left.every((host, index) => host === right[index])
	)
}

/**
 * Replaces the editable hosts of one Key or OAuth connection of `orgId`. A
 * connection keeps its fixed hosts whatever is submitted. The caller has
 * already authorized the manager's write permission and parsed `hosts` with
 * `parseCredentialHostsInput`.
 */
export async function updateCredentialHosts(input: {
	db: D1Database
	orgId: OwnerId
	credentialId: string
	hosts: Array<string>
	audit: OrgAuditWriter
}): Promise<CredentialHostSettings & { changed: boolean }> {
	const credential = await getOrgCredential(
		input.db,
		input.orgId,
		input.credentialId,
	)
	if (!credential?.live) {
		throw new McpCallerError('No credential with that id in this org.')
	}
	const read = await readHostSettings(input.db, input.orgId, credential)
	if ('refused' in read) throw new McpCallerError(read.refused)
	const editable = normalizeAllowedHosts(input.hosts).filter(
		(host) => !read.settings.fixedHosts.includes(host),
	)
	if (editable.length === 0 && read.settings.fixedHosts.length === 0) {
		throw new McpCallerError(
			'Keep at least one host. To stop using this credential, delete it instead.',
		)
	}
	if (editable.length > credentialHostsMax) {
		throw new McpCallerError(
			`A credential can allow at most ${credentialHostsMax} hosts.`,
		)
	}
	const settings = { hosts: editable, fixedHosts: read.settings.fixedHosts }
	if (sameHosts(editable, read.settings.hosts)) {
		return { ...settings, changed: false }
	}
	const after =
		read.kind === 'integration'
			? normalizeAllowedHosts([
					...editable,
					...read.stored.filter((host) =>
						read.settings.fixedHosts.includes(host),
					),
				])
			: editable
	const now = new Date().toISOString()
	const statement =
		read.kind === 'integration'
			? input.db
					.prepare(
						`UPDATE user_integrations SET required_hosts_json = ?, updated_at = ?
						WHERE id = ? AND user_id = ? AND deleted_at IS NULL`,
					)
					.bind(JSON.stringify(after), now, credential.id, input.orgId)
			: input.db
					.prepare(
						`UPDATE secret_entries SET allowed_hosts = ?, updated_at = ?
						WHERE id = ? AND kind = 'secret' AND deleted_at IS NULL`,
					)
					.bind(JSON.stringify(after), now, credential.id)
	const { changed } = await runAppDbBatchWithOrgAudit({
		appDb: input.db,
		audit: input.audit,
		statements: [statement],
		onlyIfChanged: true,
		event: {
			orgId: input.orgId,
			action: 'credential.hosts_updated',
			resourceType: 'credential',
			resourceId: credential.id,
			details: {
				credentialKind: credential.kind,
				name: credential.name,
				hosts: { before: read.stored, after },
			},
		},
	})
	if (!changed) {
		throw new McpCallerError('No credential with that id in this org.')
	}
	return { ...settings, changed: true }
}
