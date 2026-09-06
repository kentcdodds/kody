export type CommunityInstallUiState =
	| 'idle'
	| 'confirming'
	| 'submitting'
	| 'error'

export type CommunityInstallClickDecision = 'ignore' | 'submit' | 'confirm'

/**
 * The Install pill lives in the server frame, so it stays clickable while
 * the client is submitting, confirming, or waiting for a reload. Ignore
 * those clicks. Official `@kody/*` listings install on the first click;
 * third-party listings still take one generic confirm.
 */
export function decideCommunityInstallClick(input: {
	installState: CommunityInstallUiState
	alreadyInstalled: boolean
	official?: boolean
}): CommunityInstallClickDecision {
	if (input.alreadyInstalled) return 'ignore'
	switch (input.installState) {
		case 'submitting':
		case 'confirming':
			return 'ignore'
		case 'idle':
		case 'error':
			return input.official ? 'submit' : 'confirm'
		default: {
			const exhaustive: never = input.installState
			throw new Error(`Unhandled install state: ${String(exhaustive)}`)
		}
	}
}
