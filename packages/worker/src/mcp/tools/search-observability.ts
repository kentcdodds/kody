/**
 * Measurement-only Analytics Engine points for MCP `search` wall clock.
 *
 * Not a `recordUsage()` event and not a UWD surface. Search retrievers
 * already mint `dynamic_worker_day` with surface `retriever`; this dataset
 * answers "is search slow this hour?" and "which exclusive tile grew?".
 * No user, conversation, or query text.
 *
 * Production dataset `kody_mcp_search_events` (preview:
 * `kody_mcp_search_events_preview`). Binding `MCP_SEARCH_EVENTS` on origin
 * and platform (where MCP search runs). Recording is a no-op without the
 * binding and never throws.
 *
 * ```sql
 * SELECT
 *   quantile(0.5)(double1) AS p50_ms,
 *   quantile(0.95)(double1) AS p95_ms,
 *   avg(double2) AS avg_unaccounted_ms,
 *   SUM(_sample_interval) AS calls
 * FROM kody_mcp_search_events
 * WHERE timestamp > NOW() - INTERVAL '1' HOUR
 * ```
 */

import { type SearchPhaseTimings } from './search-types.ts'

export type SearchObservabilityMode = 'list' | 'entity' | 'entity-batch'

export type SearchObservabilityEnv = {
	MCP_SEARCH_EVENTS?: AnalyticsEngineDataset
}

export const searchObservabilityTelemetryIndex = 'mcp_search'

export type SearchObservabilityPoint = {
	outcome: 'success' | 'failure'
	mode: SearchObservabilityMode
	durationMs: number
	phaseTimings?: Partial<SearchPhaseTimings>
	task?: string
	intentConfidence?: number
	responseTrimmed?: boolean
	trimmedMatchCount?: number
	offline?: boolean
}

function numericPhase(
	phaseTimings: Partial<SearchPhaseTimings> | undefined,
	key: keyof SearchPhaseTimings,
): number {
	const value = phaseTimings?.[key]
	return typeof value === 'number' ? value : 0
}

/**
 * Record one search-duration data point. Synchronous, nonthrowing, and a
 * no-op when the dedicated Analytics Engine binding is absent.
 */
export function recordSearchObservabilityEvent(
	env: SearchObservabilityEnv,
	input: SearchObservabilityPoint,
): void {
	try {
		env.MCP_SEARCH_EVENTS?.writeDataPoint({
			indexes: [searchObservabilityTelemetryIndex],
			blobs: [
				input.outcome,
				input.mode,
				input.task ?? '',
				input.responseTrimmed ? 'trimmed' : 'intact',
				input.offline ? 'offline' : 'online',
			],
			doubles: [
				input.durationMs,
				numericPhase(input.phaseTimings, 'unaccountedMs'),
				numericPhase(input.phaseTimings, 'loadAndRankMs'),
				numericPhase(input.phaseTimings, 'waitingItemsMs'),
				numericPhase(input.phaseTimings, 'memoryEnrichmentMs'),
				numericPhase(input.phaseTimings, 'rowAndRegistryLoadMs'),
				numericPhase(input.phaseTimings, 'retrieversMs'),
				typeof input.intentConfidence === 'number'
					? input.intentConfidence
					: -1,
				input.trimmedMatchCount ?? 0,
			],
		})
	} catch (error) {
		console.warn('mcp-search-event-failed', error)
	}
}
