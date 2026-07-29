/**
 * Typed registry of feature flags. Flags are created and removed only via
 * code review by editing `featureFlagDefinitions`. The database stores
 * runtime state (global toggles/rollouts and per-user overrides), not which
 * flags exist. Removing a key from this array leaves any leftover DB rows
 * visible as "stale" in the admin UI until an operator deletes them.
 */

export type FeatureFlagDefinition = {
	key: string
	description: string
	defaultEnabled: boolean
}

export const featureFlagDefinitions = [
	{
		key: 'demo-indicator',
		defaultEnabled: false,
		description:
			'Reserved for exercising the feature flag system end-to-end. When enabled it shows a small demo indicator in the app UI. Safe to toggle.',
	},
	{
		key: 'execute-pre-exec-typecheck',
		defaultEnabled: false,
		description:
			'Runs the pre-execution TypeScript checker for ad hoc execute modules before sandbox execution. Keep off globally during rollout and enable with per-user overrides.',
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
