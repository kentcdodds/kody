import { parseSafe } from 'remix/data-schema'
import { EnvSchema, type AppEnv } from '#worker/env-schema.ts'

// Env binding objects are stable per isolate; parse them once per identity
// instead of running schema validation on every call.
const parsedEnvCache = new WeakMap<Env, AppEnv>()

export function getEnv(env: Env): AppEnv {
	const cached = parsedEnvCache.get(env)
	if (cached) return cached
	const parsed = parseEnv(env)
	parsedEnvCache.set(env, parsed)
	return parsed
}

function parseEnv(env: Env): AppEnv {
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

	return result.value
}
