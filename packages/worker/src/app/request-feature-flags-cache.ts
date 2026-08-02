/**
 * Per-request feature-flag evaluation cache.
 *
 * Used by `loadSessionInfo` (SSR app shell + `/session` refresh) so flag
 * evaluation happens at most once per HTTP request. API handlers that only
 * need auth should keep using `loadResolvedRequestAuth` /
 * `readAuthenticatedAppUser` and will not hit this path.
 *
 * Evaluation also records success-metric exposures for measured flags (see
 * `#worker/feature-flags/exposure.ts`), which is why authenticated
 * evaluation needs the caller's stable user id alongside the numeric one.
 *
 * On evaluation failure for an authenticated user, every flag is forced off
 * (fail closed) so a default-on registry flag cannot bypass a kill switch when
 * D1 is unavailable. Anonymous requests still use registry defaults.
 */

import { recordFeatureFlagExposures } from '#worker/feature-flags/exposure.ts'
import {
	featureFlagDefinitions,
	featureFlagKeys,
	type FeatureFlagKey,
} from '#worker/feature-flags/registry.ts'
import { getFeatureFlagEvaluationsForUser } from '#worker/feature-flags/service.ts'

export type EvaluatedFeatureFlags = Record<FeatureFlagKey, boolean>

export type FeatureFlagRequestUser = {
	userId: number
	stableUserId: string
}

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
	user: FeatureFlagRequestUser | null,
): Promise<EvaluatedFeatureFlags> {
	if (user === null) {
		return defaultFeatureFlags()
	}
	try {
		const evaluations = await getFeatureFlagEvaluationsForUser(
			env.APP_DB,
			user.userId,
		)
		await recordFeatureFlagExposures(env, {
			stableUserId: user.stableUserId,
			evaluations,
		})
		const flags = {} as EvaluatedFeatureFlags
		for (const key of featureFlagKeys) {
			flags[key] = evaluations[key].enabled
		}
		return flags
	} catch (error) {
		console.error('Failed to load feature flags for authenticated user:', error)
		return disabledFeatureFlags()
	}
}

export function loadRequestFeatureFlags(
	request: Request,
	env: Env,
	user: FeatureFlagRequestUser | null,
): Promise<EvaluatedFeatureFlags> {
	let promise = requestFeatureFlagsStore.get(request)
	if (!promise) {
		promise = resolveRequestFeatureFlags(env, user)
		requestFeatureFlagsStore.set(request, promise)
	}
	return promise
}

/** True when this request already resolved (and recorded) feature-flag exposures. */
export function hasResolvedRequestFeatureFlags(request: Request): boolean {
	return requestFeatureFlagsStore.has(request)
}
