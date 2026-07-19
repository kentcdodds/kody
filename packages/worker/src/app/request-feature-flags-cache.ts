/**
 * Per-request feature-flag evaluation cache.
 *
 * Used by `loadSessionInfo` (SSR app shell + `/session` refresh) so flag
 * evaluation happens at most once per HTTP request. API handlers that only
 * need auth should keep using `loadResolvedRequestAuth` /
 * `readAuthenticatedAppUser` and will not hit this path.
 *
 * On evaluation failure for an authenticated user, every flag is forced off
 * (fail closed) so a default-on registry flag cannot bypass a kill switch when
 * D1 is unavailable. Anonymous requests still use registry defaults.
 */

import {
	featureFlagDefinitions,
	featureFlagKeys,
	type FeatureFlagKey,
} from '#worker/feature-flags/registry.ts'
import { getFeatureFlagsForUser } from '#worker/feature-flags/service.ts'

export type EvaluatedFeatureFlags = Record<FeatureFlagKey, boolean>

const requestFeatureFlagsStore = new WeakMap<
	Request,
	Promise<EvaluatedFeatureFlags>
>()

function defaultFeatureFlags(): EvaluatedFeatureFlags {
	const flags = {} as EvaluatedFeatureFlags
	for (const definition of featureFlagDefinitions) {
		flags[definition.key] = definition.defaultEnabled
	}
	return flags
}

function disabledFeatureFlags(): EvaluatedFeatureFlags {
	const flags = {} as EvaluatedFeatureFlags
	for (const key of featureFlagKeys) {
		flags[key] = false
	}
	return flags
}

async function resolveRequestFeatureFlags(
	env: Env,
	userId: number | null,
): Promise<EvaluatedFeatureFlags> {
	if (userId === null) {
		return defaultFeatureFlags()
	}
	try {
		return await getFeatureFlagsForUser(env.APP_DB, userId)
	} catch (error) {
		console.error('Failed to load feature flags for authenticated user:', error)
		return disabledFeatureFlags()
	}
}

export function loadRequestFeatureFlags(
	request: Request,
	env: Env,
	userId: number | null,
): Promise<EvaluatedFeatureFlags> {
	let promise = requestFeatureFlagsStore.get(request)
	if (!promise) {
		promise = resolveRequestFeatureFlags(env, userId)
		requestFeatureFlagsStore.set(request, promise)
	}
	return promise
}
