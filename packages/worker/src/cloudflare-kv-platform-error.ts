/**
 * Bare Cloudflare Workers KV binding failures. workerd throws
 * `KV ${op} failed: ${status} ${statusText}` (KODY-7W). HTTP 5xx / 429 are
 * transient platform blips; clients can retry. Match only this exact binding
 * sentence (optional `Error:` prefix) so wrapped recovery messages stay
 * Sentry-visible. Do not treat 4xx other than 429 as transient.
 */

const cloudflareKvTransientHttpErrorPattern =
	/^KV (?:PUT|GET|DELETE|LIST) failed: (?:5\d\d|429)\b/

function normalizeCloudflareKvTransientHttpErrorMessage(message: string) {
	return message.trim().replace(/^Error:\s*/i, '')
}

export function isCloudflareKvTransientHttpErrorMessage(message: string) {
	return cloudflareKvTransientHttpErrorPattern.test(
		normalizeCloudflareKvTransientHttpErrorMessage(message),
	)
}
