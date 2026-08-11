import { parseSafe } from 'remix/data-schema'
import { EnvSchema } from '#worker/env-schema.ts'

// Env binding objects are stable per isolate; validate them once per identity
// instead of running schema validation on every call.
const validatedEnvs = new WeakSet<Env>()

/**
 * Validate required bindings and config once, then hand back the original env
 * object. Returning the schema's parsed output here would silently drop every
 * binding the schema does not model (REPO_SESSION, OAUTH_PROVIDER, ASSETS,
 * ...), which is why this returns `env` itself: the schema is a gate, not a
 * transform. Consumers normalize scalar values (trim etc.) at the point of
 * use.
 */
export function getEnv(env: Env): Env {
	if (!validatedEnvs.has(env)) {
		validateEnv(env)
		validatedEnvs.add(env)
	}
	return env
}

function validateEnv(env: Env) {
	if (env.SENTRY_ENVIRONMENT === 'production' && !env.AUTH_RATE_LIMITER) {
		throw new Error(
			'Missing AUTH_RATE_LIMITER binding: production auth rate limiting must use the Cloudflare rate-limit binding, not the D1 fallback. Check the ratelimits block in packages/worker/wrangler.jsonc.',
		)
	}

	const result = parseSafe(EnvSchema, env)

	if (!result.success) {
		const message = result.issues
			.map((issue) => {
				const key =
					Array.isArray(issue.path) && issue.path.length > 0
						? issue.path.join('.')
						: 'env'
				return `${key}: ${issue.message}`
			})
			.join(', ')

		throw new Error(
			`Invalid environment variables: ${message}.\n\n💡 Tip: Check \`docs/contributing/environment-variables.md\` for details.`,
		)
	}
}
