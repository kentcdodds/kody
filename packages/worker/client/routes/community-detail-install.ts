export type CommunityInstallUiState = 'idle' | 'submitting' | 'error'

export type CommunityInstallClickDecision = 'ignore' | 'submit'

/**
 * The fork control lives in the server frame, so it stays clickable while
 * the client is submitting or waiting for a reload. Ignore those clicks.
 * Another-account listings warn in the control's tooltip; the click itself
 * starts the fork.
 */
export function decideCommunityInstallClick(input: {
	installState: CommunityInstallUiState
	alreadyInstalled: boolean
}): CommunityInstallClickDecision {
	if (input.alreadyInstalled) return 'ignore'
	switch (input.installState) {
		case 'submitting':
			return 'ignore'
		case 'idle':
		case 'error':
			return 'submit'
		default: {
			const exhaustive: never = input.installState
			throw new Error(`Unhandled install state: ${String(exhaustive)}`)
		}
	}
}
