export type CommunityInstallUiState =
	| 'idle'
	| 'confirming'
	| 'submitting'
	| 'error'

export type CommunityInstallClickDecision = 'ignore' | 'submit' | 'confirm'

/**
 * The Install pill lives in the server frame, so it stays clickable while
 * the client is submitting, confirming, or waiting for a reload. Ignore
 * those clicks; use the in-memory trust flag (updated on 409) rather than
 * the frame's stale `data-trusted`.
 */
export function decideCommunityInstallClick(input: {
	installState: CommunityInstallUiState
	alreadyInstalled: boolean
	listingTrusted: boolean
}): CommunityInstallClickDecision {
	if (input.alreadyInstalled) return 'ignore'
	switch (input.installState) {
		case 'submitting':
		case 'confirming':
			return 'ignore'
		case 'idle':
		case 'error':
			return input.listingTrusted ? 'submit' : 'confirm'
		default: {
			const exhaustive: never = input.installState
			throw new Error(`Unhandled install state: ${String(exhaustive)}`)
		}
	}
}
