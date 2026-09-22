import { installProgressWordHoldMs } from '#client/action-button-loader.tsx'
import { PACKAGE_TITLE_STATUS_SELECTOR } from '#universal/package-title-actions.tsx'

let progressTimer: ReturnType<typeof setInterval> | null = null

function isStatusControl(value: unknown): value is HTMLElement {
	return (
		value != null &&
		typeof value === 'object' &&
		'setAttribute' in value &&
		'getAttribute' in value &&
		'querySelector' in value
	)
}

function statusControl() {
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

/**
 * Reveal the spinner in the package-title status slot and set its tooltip to
 * the live install stage. Only the fork and verify controls host that slot.
 */
export function showPackageTitleInstallProgress(word: string) {
	const control = statusControl()
	if (!control) return
	const idle = control.getAttribute('data-package-title-idle')
	if (idle !== 'fork' && idle !== 'verify') return
	control.setAttribute('data-package-title-status', 'progress')
	control.setAttribute('aria-busy', 'true')
	control.setAttribute('aria-label', word)
	setHidden(control.querySelector('[data-title-status-icon]'), true)
	setHidden(control.querySelector('[data-title-status-spinner]'), false)
	const tooltip = control.querySelector('[data-title-status-tooltip]')
	if (tooltip) tooltip.textContent = word
	const live = control.querySelector('[data-title-status-live]')
	if (live) live.textContent = word
}

/** Stop the stage timer. Restore the idle icon when the install did not finish. */
export function stopPackageTitleInstallProgress(options?: {
	restore?: boolean
}) {
	if (progressTimer !== null) {
		clearInterval(progressTimer)
		progressTimer = null
	}
	if (options?.restore === false) return
	const control = statusControl()
	if (!control) return
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

/**
 * Walk the same install stages the old button loader named, holding on the
 * last word instead of looping.
 */
export function startPackageTitleInstallProgress(words: ReadonlyArray<string>) {
	stopPackageTitleInstallProgress({ restore: false })
	if (words.length === 0) return
	let index = 0
	showPackageTitleInstallProgress(words[0] ?? '')
	if (words.length === 1) return
	progressTimer = setInterval(() => {
		index += 1
		if (index >= words.length) {
			stopPackageTitleInstallProgress({ restore: false })
			return
		}
		showPackageTitleInstallProgress(words[index] ?? '')
		if (index >= words.length - 1) {
			if (progressTimer !== null) {
				clearInterval(progressTimer)
				progressTimer = null
			}
		}
	}, installProgressWordHoldMs)
}
