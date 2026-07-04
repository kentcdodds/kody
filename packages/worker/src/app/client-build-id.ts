import { type AppEnv } from '#worker/env-schema.ts'

export function getClientBuildId(appEnv: Pick<AppEnv, 'APP_COMMIT_SHA'>) {
	const commitSha = appEnv.APP_COMMIT_SHA?.trim()
	return commitSha && commitSha.length > 0 ? commitSha : 'dev'
}

export function buildClientEntryHref(buildId: string) {
	const version = encodeURIComponent(buildId)
	return `/client-entry.js?v=${version}`
}

export function buildStylesheetHref(buildId: string) {
	const version = encodeURIComponent(buildId)
	return `/styles.css?v=${version}`
}
