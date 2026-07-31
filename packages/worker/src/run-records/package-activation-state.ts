/**
 * Per-user package-activation counters and milestones stored in the RunLog DO.
 *
 * Same semantics as `#worker/usage/activation.ts`, but without `user_id` —
 * the Durable Object identity is the user scope. High-frequency HTTP surfaces
 * do not count; activation means an unattended capability succeeded twice for
 * the same package.
 */

import { type RunSurface } from './types.ts'

export type ActivationMilestone = 'package_run_succeeded' | 'package_activated'

export const activationMilestoneValues = [
	'package_run_succeeded',
	'package_activated',
] as const satisfies ReadonlyArray<ActivationMilestone>

export type PackageRunSuccessRecord = {
	packageId: string
	successCount: number
	updatedAt: string
}

export type ActivationMilestoneRecord = {
	milestone: ActivationMilestone
	reachedAt: string
	packageId: string | null
}

/**
 * Snapshot imported from D1 `user_package_run_successes` /
 * `user_activation_milestones` into the per-user RunLog DO. Applied exactly
 * once per user (`activation_initialized`): legacy counts add to any
 * post-cutover increments, and milestone rows keep the first-writer
 * `reached_at`.
 */
export type ActivationStateImport = {
	packageRunSuccesses: Array<PackageRunSuccessRecord>
	milestones: Array<ActivationMilestoneRecord>
}

const activationExcludedSurfaces = new Set<RunSurface>(['webhook', 'app_fetch'])

/**
 * Surfaces that count toward package activation. Omitting `surface` keeps the
 * prior "any package-scoped success" behavior for callers that have not wired
 * the field yet.
 */
export function countsTowardPackageActivation(
	surface: RunSurface | string | null | undefined,
): boolean {
	if (surface == null) return true
	return !activationExcludedSurfaces.has(surface as RunSurface)
}
