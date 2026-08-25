const noStoreHeaders = { 'Cache-Control': 'no-store' } as const

export type HighlightHealthEnv = {
	APP_COMMIT_SHA?: string
}

export function handleHighlightHealthRequest(
	request: Request,
	env: HighlightHealthEnv,
): Response | null {
	const url = new URL(request.url)
	if (url.pathname !== '/health') return null
	return Response.json(
		{ ok: true, commit: env.APP_COMMIT_SHA ?? null },
		{ headers: noStoreHeaders },
	)
}
