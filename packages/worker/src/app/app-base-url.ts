export function getAppBaseUrl(input: {
	env: {
		APP_BASE_URL?: string | null
	}
	requestUrl: string | URL
}) {
	const configuredBaseUrl = input.env.APP_BASE_URL?.trim()
	if (configuredBaseUrl) {
		try {
			return new URL(configuredBaseUrl).origin
		} catch {
			// Runtime env validation should already catch this; fall back defensively.
		}
	}

	return new URL(input.requestUrl).origin
}
