export type CommunityInstallUiState = 'idle' | 'submitting' | 'error'

export type CommunityInstallClickDecision = 'ignore' | 'arm' | 'submit'

export const CONFIRM_FORK_LABEL = 'Confirm fork'

type ConfirmControl = {
	getAttribute(name: string): string | null
	setAttribute(name: string, value: string): void
	querySelector(selector: string): { textContent: string } | null
}

/**
 * The fork control lives in the server frame, so it stays clickable while
 * the client is submitting or waiting for a reload. Ignore those clicks.
 * Official `@kody/*` listings fork on the first click. Another-account
 * listings use the same git-fork icon and `createDoubleCheck` (first click
 * arms, blur cancels, second click starts the fork).
 */
export function decideCommunityInstallClick(input: {
	installState: CommunityInstallUiState
	alreadyInstalled: boolean
	requiresConfirm: boolean
	confirmed: boolean
}): CommunityInstallClickDecision {
	if (input.alreadyInstalled) return 'ignore'
	switch (input.installState) {
		case 'submitting':
			return 'ignore'
		case 'idle':
		case 'error':
			if (input.requiresConfirm && !input.confirmed) return 'arm'
			return 'submit'
		default: {
			const exhaustive: never = input.installState
			throw new Error(`Unhandled install state: ${String(exhaustive)}`)
		}
	}
}

export function paintPackageTitleInstallConfirm(
	control: ConfirmControl,
	armed: boolean,
) {
	const idleLabel = control.getAttribute('data-title-idle-label') ?? 'Fork'
	const idleTooltip =
		control.getAttribute('data-title-idle-tooltip') ?? idleLabel
	control.setAttribute('aria-label', armed ? CONFIRM_FORK_LABEL : idleLabel)
	const tooltip = control.querySelector('[data-title-status-tooltip]')
	if (tooltip) {
		tooltip.textContent = armed ? CONFIRM_FORK_LABEL : idleTooltip
	}
}

/**
 * A shell snapshot for the listing that is already installing must leave
 * `installState` as `submitting`. The frame control stays clickable, and
 * idle would start a second POST beside the one still in flight.
 * `releasedProgress` is true only when that snapshot is a different listing.
 */
export function shouldResetInstallOnShellSnapshot(input: {
	installState: CommunityInstallUiState
	releasedProgress: boolean
}): boolean {
	if (input.releasedProgress) return true
	return input.installState !== 'submitting'
}
