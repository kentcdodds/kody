/**
 * Typed registry of feature flags. Flags are created and removed only via
 * code review by editing `featureFlagDefinitions`. The database stores
 * runtime state (global toggles/rollouts and per-user overrides), not which
 * flags exist. Removing a key from this array leaves any leftover DB rows
 * visible as "stale" in the admin UI until an operator deletes them.
 *
 * Flags should declare a `successMetric`: the usage metric the flag is
 * expected to move, reviewed in the same PR that creates the flag. Flags
 * with one get exposure recording and an on/off cohort readout on the admin
 * surfaces (see `docs/contributing/architecture/feature-flags.md`). The
 * field stays optional for flags that are genuinely unmeasurable (such as
 * the permanent `demo-indicator`), and the admin UI and MCP list surface a
 * notice strongly recommending one everywhere else.
 */

import { type UsageEventType } from '#worker/usage/event-types.ts'

export type FeatureFlagSuccessMetricMeasure =
	| 'event_count'
	| 'error_rate'
	| 'avg_duration_ms'

export type FeatureFlagSuccessMetric = {
	/** The metered usage event stream this flag is expected to move. */
	eventType: UsageEventType
	/** Which aggregate of that stream the flag is judged against. */
	measure: FeatureFlagSuccessMetricMeasure
	/** The direction the flag is supposed to push the measure. */
	goal: 'increase' | 'decrease'
	/** One human sentence stating the hypothesis behind the flag. */
	hypothesis: string
}

export type FeatureFlagDefinition = {
	key: string
	description: string
	defaultEnabled: boolean
	successMetric?: FeatureFlagSuccessMetric
}

export const featureFlagDefinitions = [
	{
		key: 'demo-indicator',
		defaultEnabled: false,
		description:
			'Reserved for exercising the feature flag system end-to-end. When enabled it shows a small demo indicator in the app UI. Safe to toggle.',
		// Intentionally no successMetric: this permanent flag exists to
		// exercise the flag system itself (including the "no success metric"
		// admin notice), not to move a product metric.
	},
	{
		key: 'execute-pre-exec-typecheck',
		defaultEnabled: false,
		description:
			'Runs the pre-execution TypeScript checker for ad hoc execute modules before sandbox execution. Keep off globally during rollout and enable with per-user overrides.',
		successMetric: {
			eventType: 'execute',
			measure: 'error_rate',
			goal: 'decrease',
			hypothesis:
				'Typechecking execute modules before sandbox execution should catch type errors early and lower the execute error rate.',
		},
	},
] as const satisfies ReadonlyArray<FeatureFlagDefinition>

export type FeatureFlagKey = (typeof featureFlagDefinitions)[number]['key']

export const featureFlagKeys: ReadonlyArray<FeatureFlagKey> =
	featureFlagDefinitions.map((definition) => definition.key)

const featureFlagDefinitionByKey = new Map<
	FeatureFlagKey,
	FeatureFlagDefinition
>(
	featureFlagDefinitions.map((definition) => [
		definition.key,
		definition as FeatureFlagDefinition,
	]),
)

/**
 * Registry flags that declare a success metric. Only these flags get
 * exposure recording and admin metric readouts.
 */
export const measuredFeatureFlagDefinitions: ReadonlyArray<
	FeatureFlagDefinition & { successMetric: FeatureFlagSuccessMetric }
> = featureFlagDefinitions.flatMap((definition) =>
	'successMetric' in definition ? [definition] : [],
)

export const measuredFeatureFlagKeys: ReadonlySet<FeatureFlagKey> = new Set(
	measuredFeatureFlagDefinitions.map(
		(definition) => definition.key as FeatureFlagKey,
	),
)

/**
 * Shared notice shown by the admin UI and the `admin_feature_flag_list`
 * capability for registry flags that do not declare a success metric.
 */
export const missingSuccessMetricNotice =
	'No success metric declared. Strongly recommended: add a successMetric to this flag in packages/worker/src/feature-flags/registry.ts so exposures are recorded and the on/off cohort readout can show whether the flag is moving the metric it exists for.'

export function isFeatureFlagKey(value: string): value is FeatureFlagKey {
	return featureFlagDefinitionByKey.has(value as FeatureFlagKey)
}

export function getFeatureFlagDefinition(
	key: FeatureFlagKey,
): FeatureFlagDefinition {
	const definition = featureFlagDefinitionByKey.get(key)
	if (!definition) {
		throw new Error(`Unknown feature flag key: ${key}`)
	}
	return definition
}
