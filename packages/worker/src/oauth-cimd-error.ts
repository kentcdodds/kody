/**
 * CIMD lookup failures the OAuth provider already maps to unknown-client /
 * invalid_client. Probe traffic, mistyped client_id URLs, ChatGPT's
 * path-less `/oauth/client.json`, and metadata fetch timeouts are caller or
 * upstream outcomes — not platform defects. Keep the exact prefixes so
 * wrapped recovery messages stay Sentry-visible.
 */
export const cimdMetadataResolutionFailedMessagePrefix =
	'CIMD metadata resolution failed ('

export const cimdFetchFailedMessagePrefix = 'CIMD fetch failed for '

export function isCimdUnknownClientSentryMessage(message: string) {
	return (
		message.startsWith(cimdMetadataResolutionFailedMessagePrefix) ||
		message.startsWith(cimdFetchFailedMessagePrefix)
	)
}
