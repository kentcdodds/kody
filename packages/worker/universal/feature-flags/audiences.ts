/**
 * Audiences a feature flag's global state may target. Distinct from site-banner
 * audiences (`site-banners.ts`): flag audiences only constrain flag evaluation.
 *
 * `everyone` — no extra gate (default).
 * `experiments_opt_in` — only users with `users.experiments_opt_in = 1`
 *   (set from `/account/experiments`). Per-user overrides still win.
 */

const featureFlagAudiences = ['everyone', 'experiments_opt_in'] as const

export type FeatureFlagAudience = (typeof featureFlagAudiences)[number]

export const defaultFeatureFlagAudience =
	'everyone' satisfies FeatureFlagAudience

export function isFeatureFlagAudience(
	value: unknown,
): value is FeatureFlagAudience {
	return (
		typeof value === 'string' &&
		(featureFlagAudiences as ReadonlyArray<string>).includes(value)
	)
}
