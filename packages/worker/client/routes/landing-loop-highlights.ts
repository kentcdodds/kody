import { type HighlightedCode } from '#universal/highlighted-code.ts'
import { routes } from '#universal/routes.ts'
import { readJson } from '#client/routes/account-approval-shared.ts'

/**
 * Homepage loop reuses the How Kody works walkthrough tokens. Fetch them
 * with the transcript chunk so code beats paint highlighted, not plaintext.
 */
export async function fetchLandingLoopHighlights(signal?: AbortSignal) {
	try {
		const response = await fetch(
			routes.guideDetailApi.href({ slug: 'how-kody-works' }),
			{
				headers: { Accept: 'application/json' },
				signal,
			},
		)
		const payload = await readJson<{
			walkthroughHighlights?: Record<string, HighlightedCode>
		}>(response)
		if (!response.ok) return {}
		return payload?.walkthroughHighlights ?? {}
	} catch {
		return {}
	}
}
