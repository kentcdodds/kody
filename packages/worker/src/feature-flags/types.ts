/**
 * Shared admin feature-flag shapes used by the worker service and client
 * loader/route types. Kept dependency-free so the client tsconfig can include
 * it without pulling in D1-typed modules.
 */

import { type FeatureFlagSuccessMetric } from './registry.ts'

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
 * month to date. `overrideUsers` (hand-picked, selection-biased) and
 * `mixedUsers` (saw both values inside the window) are excluded from the
 * cohorts and reported separately.
 */
export type AdminFeatureFlagMetricReadout =
	| { status: 'unavailable'; reason: string }
	| {
			status: 'ok'
			windowStart: string
			windowEnd: string
			on: FeatureFlagMetricCohort
			off: FeatureFlagMetricCohort
			overrideUsers: number
			mixedUsers: number
	  }

export type AdminFeatureFlag = {
	key: string
	description: string | null
	defaultEnabled: boolean | null
	stale: boolean
	successMetric: FeatureFlagSuccessMetric | null
	metricReadout?: AdminFeatureFlagMetricReadout
	global: {
		enabled: boolean
		rolloutPercent: number | null
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
