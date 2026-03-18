import { type BuildAction } from 'remix/fetch-router'
import { type routes } from '#server/routes.ts'
import { type AppEnv } from '#types/env-schema.ts'

type HealthEnv = {
	APP_COMMIT_SHA: AppEnv['APP_COMMIT_SHA']
}

export function createHealthHandler(appEnv: HealthEnv) {
	return {
		middleware: [],
		async action() {
			const commitSha = appEnv.APP_COMMIT_SHA ?? null
			return Response.json(
				{ ok: true, commitSha },
				{
					headers: {
						'Cache-Control': 'no-store',
						'X-App-Commit-Sha': commitSha ?? 'unknown',
					},
				},
			)
		},
	} satisfies BuildAction<
		typeof routes.health.method,
		typeof routes.health.pattern
	>
}
