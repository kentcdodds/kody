export type CommunityInstallUiState = 'idle' | 'submitting' | 'error'

export type CommunityInstallClickDecision = 'ignore' | 'arm' | 'submit'

const CONFIRM_FORK_LABEL = 'Confirm fork'

type ConfirmControl = {
	getAttribute(name: string): string | null
	setAttribute(name: string, value: string): void
	querySelector(selector: string): { textContent: string | null } | null
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

export function isCommunityInstallConfirmArmed(input: {
	confirmed: boolean
	confirmedListingId: string | null
	listingId: string | null
}): boolean {
	return (
		input.confirmed &&
		input.confirmedListingId != null &&
		input.confirmedListingId === input.listingId
	)
}

export function shouldResetInstallConfirm(input: {
	confirmedListingId: string | null
	listingId: string | null
}): boolean {
	if (input.confirmedListingId == null) return false
	return input.confirmedListingId !== input.listingId
}

type InstallConfirmFlag = {
	readonly doubleCheck: boolean
	reset(): void
	arm(): void
}

/**
 * While the other-account fork icon is armed, a page-level click outside
 * that control clears it even when the click never moves focus. The listener
 * exists only for the armed window. It is attached after the arming click so
 * capture on that click cannot clear the flag it just set.
 */
export function createPackageTitleInstallArm(input: {
	confirm: InstallConfirmFlag
	getListingId(): string | null
	setListingId(listingId: string | null): void
}) {
	let listening = false

	function stopOutsideClick() {
		if (!listening || typeof document === 'undefined') return
		listening = false
		document.removeEventListener('click', handleOutsideClick, true)
	}

	function reset() {
		input.confirm.reset()
		input.setListingId(null)
		stopOutsideClick()
	}

	function armedControl() {
		const listingId = input.getListingId()
		if (!listingId || typeof document === 'undefined') return null
		for (const control of document.querySelectorAll(
			'[data-community-install]',
		)) {
			if (control.getAttribute('data-package-title-listing') === listingId) {
				return control
			}
		}
		return null
	}

	function disarm() {
		if (!input.confirm.doubleCheck) return
		const control = armedControl()
		reset()
		if (control) paintPackageTitleInstallConfirm(control, false)
	}

	function handleOutsideClick(event: Event) {
		const target = event.target
		const element =
			target instanceof Element
				? target
				: target instanceof Node
					? target.parentElement
					: null
		if (element?.closest('[data-community-install]')) return
		disarm()
	}

	function startOutsideClick() {
		if (listening || typeof document === 'undefined') return
		listening = true
		document.addEventListener('click', handleOutsideClick, true)
	}

	function arm(control: Element, listingId: string | null) {
		input.confirm.arm()
		input.setListingId(listingId)
		paintPackageTitleInstallConfirm(control, true)
		if (control instanceof HTMLElement) control.focus()
		startOutsideClick()
	}

	return { reset, disarm, arm }
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
