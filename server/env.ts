import { parseSafe } from 'remix/data-schema'
import { EnvSchema, type AppEnv } from '#types/env-schema.ts'

export function getEnv(env: Env): AppEnv {
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
			`Invalid environment variables: ${message}.\n\n💡 Tip: Check \`docs/environment-variables.md\` for details.`,
		)
	}

	return result.value
}
