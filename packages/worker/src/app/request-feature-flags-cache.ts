/**
 * Per-request feature-flag evaluation cache.
 *
 * Used by `loadSessionInfo` (SSR app shell + `/session` refresh) so flag
 * evaluation happens at most once per HTTP request. Authenticated HTML pages
 * start this load from `readAuthenticatedAppUser` as soon as the user id is
 * known so `renderAppPage` awaits an already-in-flight promise while the
 * handler loads page data. MCP, package-app, and JSON API auth paths do not
 * start this load. Anonymous callers still receive registry defaults without
 * touching D1.
 *
 * Evaluation also records success-metric exposures for measured flags (see
 * `#worker/feature-flags/exposure.ts`), which is why authenticated
 * evaluation needs the caller's stable user id alongside the numeric one.
 *
 * On evaluation failure for an authenticated user, every flag is forced off
 * (fail closed) so a default-on registry flag cannot bypass a kill switch when
 * D1 is unavailable. Anonymous requests still use registry defaults.
 */

import { parsePackageAppRequestHost } from '#worker/app-base-url.ts'
import { recordFeatureFlagExposures } from '#worker/feature-flags/exposure.ts'
import { getFeatureFlagEvaluationsForUser } from '#worker/feature-flags/service.ts'
import { isPackageAppRequestPath } from '#worker/package-runtime/package-app-serve.ts'
import { wantsJson } from '#worker/utils.ts'
import {
	featureFlagDefinitions,
	featureFlagKeys,
	type FeatureFlagKey,
} from '#universal/feature-flags/registry.ts'

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

function shouldPrefetchRequestFeatureFlags(request: Request, env: Env) {
	if (
		typeof env.APP_DB?.prepare !== 'function' ||
		typeof env.APP_DB.batch !== 'function'
	) {
		return false
	}
	if (wantsJson(request)) return false
	const accept = request.headers.get('Accept')
	if (accept && !accept.includes('text/html') && !accept.includes('*/*')) {
		return false
	}
	let url: URL
	try {
		url = new URL(request.url)
	} catch {
		return false
	}
	if (url.pathname.endsWith('.json')) return false
	if (url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) return false
	if (isPackageAppRequestPath(url.pathname)) return false
	if (parsePackageAppRequestHost({ env, url })) return false
	return true
}

/**
 * Start flag evaluation for an authenticated first-party HTML render so
 * `loadSessionInfo` can await an already-in-flight promise. No-ops for MCP,
 * JSON, package-app, and test stubs whose D1 fake has no `prepare`/`batch`.
 */
export function prefetchRequestFeatureFlagsForHtmlPage(
	request: Request,
	env: Env,
	user: FeatureFlagRequestUser,
): void {
	if (!shouldPrefetchRequestFeatureFlags(request, env)) return
	// Overlap flag evaluation with page-data loading. `loadSessionInfo`
	// awaits the same cached promise; the rejection handler is so a
	// prefetch that never reaches a render cannot become unhandled.
	void loadRequestFeatureFlags(request, env, user).then(undefined, () => {})
}

/** True when this request already resolved (and recorded) feature-flag exposures. */
export function hasResolvedRequestFeatureFlags(request: Request): boolean {
	return requestFeatureFlagsStore.has(request)
}
