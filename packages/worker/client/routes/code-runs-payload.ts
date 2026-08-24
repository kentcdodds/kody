import { parsePublicCodeRunsWindow } from '#universal/code-runs.ts'
import { type CodeRunsLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'

export const codeRunsApiPath = routes.codeRunsApi.href()

/** Retry after `updateAt` when origin still returns the same cached triple. */
export const codeRunsWindowRefreshRetryMs = 60_000

export async function fetchCodeRunsPayload(
	signal?: AbortSignal,
	init?: { cache?: RequestCache },
) {
	try {
		const response = await fetch(codeRunsApiPath, {
			headers: { Accept: 'application/json' },
			signal,
			cache: init?.cache,
		})
		const payload = await readJson<CodeRunsLoaderData>(response)
		if (!response.ok || payload?.ok !== true) return null
		return {
			ok: true as const,
			window: parsePublicCodeRunsWindow(payload.window),
		}
	} catch {
		return null
	}
}
