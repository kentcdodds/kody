import { getAppBaseUrl } from '#app/app-base-url.ts'

export function getHostedUiUrl(input: {
	appId: string
	requestUrl: string | URL
	env: {
		APP_BASE_URL?: string | null
	}
}) {
	const appBaseUrl = getAppBaseUrl({
		env: input.env,
		requestUrl: input.requestUrl,
	})
	return new URL(`/ui/${input.appId}`, appBaseUrl).toString()
}

export function buildSavedUiUrl(
	requestUrl: string | URL,
	appId: string,
	input?: {
		APP_BASE_URL?: string | null
	},
) {
	return getHostedUiUrl({
		appId,
		requestUrl,
		env: input ?? {},
	})
}
