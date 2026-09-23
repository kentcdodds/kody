/**
 * Shared admin feature-flag shapes used by the worker service and client
 * loader/route types. Kept dependency-free so the universal layer can ship
 * them without pulling in D1-typed modules.
 */

import { type FeatureFlagSuccessMetric } from './registry.ts'
import { type FeatureFlagAudience } from './audiences.ts'

/**
 * One exposure cohort's aggregates over the flag's declared usage metric.
 * `errorRate` and `avgDurationMs` are null when the cohort has no events.
 */
export type FeatureFlagMetricCohort = {
	users: number
	eventCount: number
	errorCount: number
	errorRate: number | null
	avgDurationMs: number | null
}

/**
 * On/off cohort comparison for a flag's declared success metric, computed
 * from recorded exposures joined with usage events over the current UTC
 * month to date. Users with any `override`-sourced exposure are excluded
 * from on/off (selection bias) and aggregated into `override`. Users who
 * saw both fair values inside the window are counted as `mixedUsers` but
 * still assigned to on/off by their latest fair exposure.
 */
export type AdminFeatureFlagMetricReadout =
	| { status: 'unavailable'; reason: string }
	| {
			status: 'ok'
			windowStart: string
			windowEnd: string
			on: FeatureFlagMetricCohort
			off: FeatureFlagMetricCohort
			/** Usage for override-sourced users (excluded from on/off). */
			override: FeatureFlagMetricCohort
			overrideUsers: number
			mixedUsers: number
	  }

export type AdminFeatureFlag = {
	key: string
	description: string | null
	defaultEnabled: boolean | null
	defaultAudience: FeatureFlagAudience | null
	stale: boolean
	successMetric: FeatureFlagSuccessMetric | null
	metricReadout?: AdminFeatureFlagMetricReadout
	global: {
		enabled: boolean
		rolloutPercent: number | null
		audience: FeatureFlagAudience
		note: string
		updatedByStableUserId: string | null
		updatedAt: string
	} | null
	overrides: Array<{
		stableUserId: string
		username: string
		enabled: boolean
		updatedAt: string
	}>
}
