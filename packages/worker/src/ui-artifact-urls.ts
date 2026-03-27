import { getAppBaseUrl } from '#app/app-base-url.ts'

export function getHostedUiUrl(input: {
	appId: string
	requestUrl: string | URL
	env: {
		APP_BASE_URL?: string | null
	}
	params?: Record<string, unknown> | null
}) {
	const appBaseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	const url = new URL(`/ui/${input.appId}`, appBaseUrl)
	if (input.params && Object.keys(input.params).length > 0) {
		url.searchParams.set('params', JSON.stringify(input.params))
	}
	return url.toString()
}

export function buildSavedUiUrl(
	requestUrl: string | URL,
	appId: string,
	input?: {
		APP_BASE_URL?: string | null
		params?: Record<string, unknown> | null
	},
) {
	return getHostedUiUrl({
		appId,
		requestUrl,
		env: input ?? {},
		params: input?.params ?? null,
	})
}
