const DEFAULT_APP_BASE_URL = 'https://heykody.dev'

/**
 * Resolve the public app origin for request-scoped work.
 *
 * Prefer the request origin when a real request URL is available so MCP OAuth
 * metadata and app links match the host the client actually connected to.
 * Fall back to `APP_BASE_URL`, then the production default, for background work
 * (workflows, email, etc.) that has no inbound request.
 */
export function getAppBaseUrl(input: {
	env: {
		APP_BASE_URL?: string | null
	}
	requestUrl?: string | URL | null
}) {
	if (input.requestUrl != null && input.requestUrl !== '') {
		try {
			return new URL(input.requestUrl).origin
		} catch {
			// Fall through to configured / default origin.
		}
	}

	const configuredBaseUrl = input.env.APP_BASE_URL?.trim()
	if (configuredBaseUrl) {
		try {
			return new URL(configuredBaseUrl).origin
		} catch {
			// Runtime env validation should already catch this; fall back defensively.
		}
	}

	return DEFAULT_APP_BASE_URL
}
