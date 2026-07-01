/**
 * Runtime deployment posture detection.
 *
 * Production wrangler env sets `SENTRY_ENVIRONMENT: 'production'`; the preview
 * and e2e-test environments set `'preview'` / `'test'`; `npm run dev` sets
 * `WRANGLER_IS_LOCAL_DEV=true`. Anything that should never be reachable in a
 * real deployment (developer tooling routes, signup) must fail closed: it is
 * only enabled when we can positively confirm a non-production runtime.
 */
type DeploymentEnvLike = {
	WRANGLER_IS_LOCAL_DEV?: string | undefined
	SENTRY_ENVIRONMENT?: string | undefined
}

export function isNonProductionRuntime(env: DeploymentEnvLike): boolean {
	if (env.WRANGLER_IS_LOCAL_DEV === 'true') return true
	const sentryEnv = env.SENTRY_ENVIRONMENT
	return sentryEnv === 'test' || sentryEnv === 'preview'
}
