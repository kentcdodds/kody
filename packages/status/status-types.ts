/**
 * Shared types for the kody status worker: probe outcomes, per-component
 * state, and the snapshot shape the public page renders.
 */

import { type ProviderIncident } from './provider-incidents.ts'

export type { ProviderIncident }

export const statusComponents = [
	{ id: 'app', name: 'App & API' },
	{ id: 'mcp', name: 'MCP endpoint' },
	{ id: 'package_apps', name: 'Package apps' },
	{ id: 'app_db', name: 'Primary database' },
	{ id: 'audit_db', name: 'Audit database' },
	{ id: 'kv', name: 'Key-value storage' },
	{ id: 'assets', name: 'Asset storage' },
] as const

export type StatusComponentId = (typeof statusComponents)[number]['id']

export const statusComponentIds = statusComponents.map(
	(component) => component.id,
)

export function statusComponentName(id: StatusComponentId): string {
	const component = statusComponents.find((entry) => entry.id === id)
	return component?.name ?? id
}

export type ProbeOutcome = {
	component: StatusComponentId
	ok: boolean
	latencyMs: number | null
	detail: string | null
}

export type ComponentStatus = 'operational' | 'down' | 'unknown'

export type IncidentView = {
	id: number
	component: StatusComponentId
	componentName: string
	startedAt: string
	resolvedAt: string | null
	detail: string | null
}

export type ComponentDayStat = {
	day: string
	total: number
	failed: number
}

export type ComponentSnapshot = {
	id: StatusComponentId
	name: string
	status: ComponentStatus
	latencyMs: number | null
	uptimePct: number | null
	days: Array<ComponentDayStat>
}

export type StatusSnapshot = {
	generatedAt: string
	overallStatus: ComponentStatus
	components: Array<ComponentSnapshot>
	openIncidents: Array<IncidentView>
	recentIncidents: Array<IncidentView>
	/**
	 * Cloudflare Statuspage incidents that affect products kody runs on.
	 * Null when the feed is unavailable or the cache is too stale — the page
	 * omits the provider section in that case (fail-soft).
	 */
	providerIncidents: Array<ProviderIncident> | null
	/** Latest `commitSha` reported by production `GET /health` (main worker). */
	productionCommit: string | null
}
