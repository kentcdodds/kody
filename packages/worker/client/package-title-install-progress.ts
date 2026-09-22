import { PACKAGE_TITLE_STATUS_SELECTOR } from '#universal/package-title-actions.tsx'

/**
 * The stages a one-click community install walks: fork the snapshot, run the
 * package checks, then refresh the saved-package projection. The title spinner
 * holds on the last word instead of looping.
 */
export const installProgressWords = [
	'Forking',
	'Copying',
	'Checking',
	'Bundling',
	'Publishing',
	'Wiring',
] as const

export const installProgressWordHoldMs = 2600

const listingAttribute = 'data-package-title-listing'

type StatusControl = HTMLElement

type ProgressRun = {
	listingId: string | null
	control: StatusControl
	timer: ReturnType<typeof setInterval> | null
}

let activeRun: ProgressRun | null = null
/** Control painted by show() when no run is active, so stop() can restore it. */
let shownControl: StatusControl | null = null

function isStatusControl(value: unknown): value is StatusControl {
	return (
		value != null &&
		typeof value === 'object' &&
		'setAttribute' in value &&
		'getAttribute' in value &&
		'querySelector' in value
	)
}

function queryStatusControl() {
	if (typeof document === 'undefined') return null
	const control = document.querySelector(PACKAGE_TITLE_STATUS_SELECTOR)
	return isStatusControl(control) ? control : null
}

function setHidden(element: unknown, hidden: boolean) {
	if (
		element == null ||
		typeof element !== 'object' ||
		!('hidden' in element)
	) {
		return
	}
	;(element as { hidden: boolean }).hidden = hidden
}

function canHostProgress(control: StatusControl) {
	const idle = control.getAttribute('data-package-title-idle')
	return idle === 'fork' || idle === 'verify'
}

/**
 * A run may only paint the control captured when it started. After navigation
 * that node is either detached or stamped with another listing; touching the
 * document's current status control would spin the destination listing.
 */
function controlStillOwnsRun(run: ProgressRun) {
	if ('isConnected' in run.control && run.control.isConnected === false) {
		return false
	}
	if (run.listingId === null) return true
	const stamped = run.control.getAttribute(listingAttribute)
	if (!stamped) return true
	return stamped === run.listingId
}

function paintProgress(control: StatusControl, word: string) {
	if (!canHostProgress(control)) return false
	control.setAttribute('data-package-title-status', 'progress')
	control.setAttribute('aria-busy', 'true')
	control.setAttribute('aria-label', word)
	setHidden(control.querySelector('[data-title-status-icon]'), true)
	setHidden(control.querySelector('[data-title-status-spinner]'), false)
	const tooltip = control.querySelector('[data-title-status-tooltip]')
	if (tooltip) tooltip.textContent = word
	const live = control.querySelector('[data-title-status-live]')
	if (live) live.textContent = word
	return true
}

function restoreControl(control: StatusControl) {
	if (control.getAttribute('data-package-title-status') !== 'progress') return
	const idle = control.getAttribute('data-package-title-idle')
	if (idle) control.setAttribute('data-package-title-status', idle)
	control.removeAttribute('aria-busy')
	const label = control.getAttribute('data-title-idle-label') ?? ''
	if (label) control.setAttribute('aria-label', label)
	setHidden(control.querySelector('[data-title-status-icon]'), false)
	setHidden(control.querySelector('[data-title-status-spinner]'), true)
	const tooltip = control.querySelector('[data-title-status-tooltip]')
	const idleTooltip = control.getAttribute('data-title-idle-tooltip') ?? label
	if (tooltip) tooltip.textContent = idleTooltip
	const live = control.querySelector('[data-title-status-live]')
	if (live) live.textContent = ''
}

function finishRun(run: ProgressRun, restore: boolean) {
	if (run.timer !== null) {
		clearInterval(run.timer)
		run.timer = null
	}
	if (activeRun === run) activeRun = null
	if (!restore || !controlStillOwnsRun(run)) return
	restoreControl(run.control)
}

/**
 * Reveal the spinner in the package-title status slot and set its tooltip to
 * the live install stage. Only the fork and verify controls host that slot.
 * An active run paints the control it captured, never a freshly queried one.
 */
export function showPackageTitleInstallProgress(word: string) {
	const control = activeRun?.control ?? queryStatusControl()
	if (!control) return
	if (activeRun && !controlStillOwnsRun(activeRun)) return
	if (!paintProgress(control, word)) return
	if (!activeRun) shownControl = control
}

/**
 * Stop the stage timer. When `listingId` is set, a run for a different listing
 * is left alone so a late response cannot clear the listing now on screen.
 * Restore the captured control unless the install finished and the frame is
 * about to replace it.
 */
export function stopPackageTitleInstallProgress(options?: {
	restore?: boolean
	listingId?: string | null
}) {
	if (!activeRun) {
		const control = shownControl
		shownControl = null
		if (options?.restore === false || !control) return
		restoreControl(control)
		return
	}
	if (
		options &&
		'listingId' in options &&
		activeRun.listingId !== options.listingId
	) {
		return
	}
	const run = activeRun
	shownControl = null
	finishRun(run, options?.restore !== false)
}

/**
 * Navigation left the listing that owns the active run. `null` means this page
 * has no listing id yet (left package pages, or the destination id is still
 * unknown), so any run is restored and cleared. Returns whether a run ended.
 */
export function releasePackageTitleInstallProgress(
	listingId: string | null,
): boolean {
	if (!activeRun) return false
	if (listingId !== null && activeRun.listingId === listingId) return false
	finishRun(activeRun, true)
	shownControl = null
	return true
}

/**
 * Walk the same install stages the old button loader named, holding on the
 * last word instead of looping. The control is captured once; later ticks
 * never query the document. Starting another listing restores the previous
 * control first.
 */
export function startPackageTitleInstallProgress(
	words: ReadonlyArray<string>,
	listingId?: string | null,
) {
	if (activeRun) finishRun(activeRun, true)
	shownControl = null
	if (words.length === 0) return
	const control = queryStatusControl()
	if (!control || !canHostProgress(control)) return
	const run: ProgressRun = {
		listingId: listingId ?? null,
		control,
		timer: null,
	}
	activeRun = run
	paintProgress(control, words[0] ?? '')
	if (words.length === 1) return
	let index = 0
	run.timer = setInterval(() => {
		if (activeRun !== run) return
		if (!controlStillOwnsRun(run)) {
			finishRun(run, false)
			return
		}
		index += 1
		if (index >= words.length) {
			if (run.timer !== null) {
				clearInterval(run.timer)
				run.timer = null
			}
			return
		}
		paintProgress(run.control, words[index] ?? '')
		if (index >= words.length - 1 && run.timer !== null) {
			clearInterval(run.timer)
			run.timer = null
		}
	}, installProgressWordHoldMs)
}
