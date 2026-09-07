/**
 * Inbound MCP OAuth connections: unique-client counting and best-effort
 * labels. Source of truth is provider grants (`clientId`), not
 * `users.mcp_client_name` (first-touch) or `user_mcp_oauth_clients`
 * (user-minted confidential clients).
 */

import {
	type McpClientKind,
	mcpClientById,
} from '#universal/onboarding-mcp-clients.ts'

export type InboundMcpClientSignals = {
	clientId: string
	clientName?: string | null
	redirectUris?: ReadonlyArray<string>
	grantRedirectUri?: string | null
	clientUri?: string | null
}

export type LabeledInboundMcpClient = {
	kind: McpClientKind | null
	label: string
}

export type ConnectedMcpAgent = {
	clientId: string
	label: string
	kind: McpClientKind | null
	connectedAt: string | null
}

const truncatedClientIdLength = 8

/**
 * More specific name needles first so "Claude Code" does not collapse to
 * Claude Desktop.
 */
const clientNameKindRules = [
	{
		kind: 'claude-code',
		needles: ['claude code', 'claude-code', 'claudecode'],
	},
	{ kind: 'copilot-app', needles: ['copilot app', 'copilot-app'] },
	{ kind: 'grok-cli', needles: ['grok cli', 'grok-cli'] },
	{ kind: 'grok-bot', needles: ['grok bot', 'grok-bot', 'grokbot'] },
	{ kind: 'chatgpt', needles: ['chatgpt', 'chat gpt'] },
	{ kind: 'codex', needles: ['codex'] },
	{
		kind: 'claude-desktop',
		needles: ['claude desktop', 'claude.ai', 'claude'],
	},
	{ kind: 'cursor', needles: ['cursor'] },
	{ kind: 'gemini', needles: ['gemini'] },
	{ kind: 'grok', needles: ['grok'] },
	{ kind: 'copilot', needles: ['copilot', 'github copilot'] },
	{ kind: 'devin', needles: ['devin'] },
	{ kind: 'opencode', needles: ['opencode', 'open code'] },
	{ kind: 'openclaw', needles: ['openclaw', 'open claw'] },
] as const satisfies ReadonlyArray<{
	kind: McpClientKind
	needles: ReadonlyArray<string>
}>

const hostKindRules = [
	{ kind: 'chatgpt', hosts: ['chatgpt.com'] },
	{ kind: 'claude-desktop', hosts: ['claude.ai'] },
	{ kind: 'cursor', hosts: ['cursor.com', 'cursor.sh'] },
	{ kind: 'gemini', hosts: ['gemini.google.com', 'aistudio.google.com'] },
	{ kind: 'grok', hosts: ['grok.com', 'grok.x.ai'] },
	{ kind: 'copilot', hosts: ['github.com', 'githubcopilot.com'] },
	{ kind: 'devin', hosts: ['devin.ai', 'app.devin.ai'] },
	{ kind: 'opencode', hosts: ['opencode.ai'] },
	{ kind: 'openclaw', hosts: ['openclaw.ai'] },
] as const satisfies ReadonlyArray<{
	kind: McpClientKind
	hosts: ReadonlyArray<string>
}>

export function uniqueOAuthClientIds(
	grants: ReadonlyArray<{ clientId?: string | null }>,
): Array<string> {
	const ids = new Set<string>()
	for (const grant of grants) {
		const clientId = grant.clientId?.trim()
		if (clientId) ids.add(clientId)
	}
	return [...ids]
}

export function countUniqueOAuthClientIds(
	grants: ReadonlyArray<{ clientId?: string | null }>,
): number {
	return uniqueOAuthClientIds(grants).length
}

export function hasSecondConnectedMcpClient(uniqueClientCount: number) {
	return uniqueClientCount >= 2
}

export function oauthGrantCreatedAtIso(
	createdAt: number | null | undefined,
): string | null {
	if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
		return null
	}
	const milliseconds = createdAt > 1e12 ? createdAt : createdAt * 1000
	const date = new Date(milliseconds)
	return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

export function truncateClientIdLabel(clientId: string) {
	const trimmed = clientId.trim()
	if (trimmed.length <= truncatedClientIdLength) return trimmed
	return `${trimmed.slice(0, truncatedClientIdLength)}…`
}

export function labelInboundMcpClient(
	signals: InboundMcpClientSignals,
): LabeledInboundMcpClient {
	const clientId = signals.clientId.trim()
	const clientName = signals.clientName?.trim() || null
	const kind =
		kindFromClientName(clientName) ?? kindFromHosts(collectSignalHosts(signals))
	if (kind) {
		return { kind, label: mcpClientById(kind).label }
	}
	if (clientName) {
		return { kind: null, label: clientName }
	}
	const hostname = firstHostname(collectSignalHosts(signals))
	if (hostname) {
		return { kind: null, label: hostname }
	}
	return { kind: null, label: truncateClientIdLabel(clientId) }
}

function kindFromClientName(clientName: string | null): McpClientKind | null {
	if (!clientName) return null
	const normalized = clientName.toLowerCase()
	for (const rule of clientNameKindRules) {
		if (rule.needles.some((needle) => normalized.includes(needle))) {
			return rule.kind
		}
	}
	return null
}

function kindFromHosts(hosts: ReadonlyArray<string>): McpClientKind | null {
	for (const host of hosts) {
		for (const rule of hostKindRules) {
			if (
				rule.hosts.some((candidate) => hostEqualsOrSubdomain(host, candidate))
			) {
				return rule.kind
			}
		}
	}
	return null
}

function collectSignalHosts(signals: InboundMcpClientSignals): Array<string> {
	const hosts = new Array<string>()
	addHostname(hosts, hostnameFromPossiblyUrl(signals.clientId))
	addHostname(hosts, hostnameFromPossiblyUrl(signals.clientUri))
	addHostname(hosts, hostnameFromPossiblyUrl(signals.grantRedirectUri))
	for (const uri of signals.redirectUris ?? []) {
		addHostname(hosts, hostnameFromPossiblyUrl(uri))
	}
	return hosts
}

function firstHostname(hosts: ReadonlyArray<string>) {
	return hosts[0] ?? null
}

function addHostname(hosts: Array<string>, hostname: string | null) {
	if (!hostname || hosts.includes(hostname)) return
	hosts.push(hostname)
}

function hostnameFromPossiblyUrl(value: string | null | undefined) {
	const trimmed = value?.trim()
	if (!trimmed) return null
	try {
		const url = new URL(trimmed)
		return url.hostname.toLowerCase() || null
	} catch {
		return null
	}
}

function hostEqualsOrSubdomain(hostname: string, registered: string) {
	return hostname === registered || hostname.endsWith(`.${registered}`)
}
