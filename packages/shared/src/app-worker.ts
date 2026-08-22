/**
 * Cross-worker contract between the main `kody` Worker and the Remix/content
 * Worker (`packages/app-worker`, script `kody-app`).
 *
 * The main Worker reaches this Worker over a plain HTTP service binding
 * (`APP_SURFACE`). After MCP, OAuth, maintenance, and runtime-owned routes,
 * remaining requests (Remix pages, blog, guides, static assets) are forwarded
 * wholesale. Durable Object access uses cross-script bindings, not RPC.
 */

/** Healthcheck endpoint served by the app-surface Worker. */
export const appWorkerHealthPath = '/__app/health'

/** Internal JSON body for one official guide (`coding_guide_get`). */
export function appWorkerGuidePath(guideId: string) {
	return `/__app/guides/${encodeURIComponent(guideId)}`
}

export type AppWorkerHealth = {
	status: 'ok'
	commitSha: string | null
	cookieSecretConfigured: boolean
}

export type AppWorkerGuideBody = {
	title: string
	body: string
}

export function buildAppWorkerHealth(input: {
	commitSha: string | undefined
	cookieSecretConfigured: boolean
}): AppWorkerHealth {
	const trimmed = input.commitSha?.trim()
	return {
		status: 'ok',
		commitSha: trimmed ? trimmed : null,
		cookieSecretConfigured: input.cookieSecretConfigured,
	}
}
