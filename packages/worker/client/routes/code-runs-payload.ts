import { parsePublicCodeRunsWindow } from '#universal/code-runs.ts'
import { type CodeRunsLoaderData } from '#universal/loader-data.ts'
import { routes } from '#universal/routes.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'

export const codeRunsApiPath = routes.codeRunsApi.href()

export async function fetchCodeRunsPayload(signal?: AbortSignal) {
	try {
		const response = await fetch(codeRunsApiPath, {
			headers: { Accept: 'application/json' },
			signal,
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
